// roomHandlers.js
// "방 생성 / 입장 / 퇴장 / 재접속"과 관련된 Socket.io 이벤트를 처리합니다.
// Spring Boot의 @RestController 하나가
// 여러 개의 @PostMapping을 갖고 있는 것과 비슷한 느낌으로 보시면 됩니다.
// 다만 여기서는 socket.on("이벤트이름", 콜백함수) 형태로 등록합니다.

const Room = require("../game/Room");
const { rooms, generateRoomId } = require("../game/roomStore");
const {
  advanceTurnAndTick,
  finalizeDefense,
  sendHandUpdate,
  maybeEndGame,
  resendDefenseRequestIfPending,
} = require("./gameHandlers");

// ---- 재접속(reconnect) 처리 (2026-08-27 추가) ----
// Socket.io는 연결이 끊기면 socket.id 자체가 사라지고, 재연결해도 완전히 새로운 socket.id를
// 받습니다. 그래서 "같은 사람이 돌아왔다"를 알아보려면 별도의 식별자가 필요한데, 그게 클라이언트가
// localStorage에 저장해두고 재접속할 때마다 같이 보내주는 "token"입니다.
//
// 게임 진행 중(room.status === "playing")에 연결이 끊기면, 그 자리에서 바로 내쫓는 대신
// GRACE_PERIOD_MS 동안 "연결 끊김(connected:false)" 상태로만 표시해두고 자리(손패/HP/턴 순서)를
// 비워두지 않습니다. 그 사이에 token을 들고 room:rejoin으로 돌아오면 예전 상태 그대로 이어서
// 할 수 있고, 끝내 안 돌아오면 그때 진짜로 내보냅니다.
//
// 대기실(waiting)에서 끊기는 건 유예 없이 바로 내보냅니다 - 아직 카드/HP 등 잃을 게 없고,
// 방장이 "게임 시작"을 누를 때 유령 플레이어가 자리를 차지하고 있으면 안 되기 때문입니다.
const GRACE_PERIOD_MS = 60 * 1000;

// key: token, value: { timeoutHandle, roomId } - 유예시간이 끝나면 실제로 내보낼 때 씀
const disconnectTimers = new Map();

// io: 서버 전체 (모든 연결된 클라이언트에게 방송할 때 사용)
// socket: 지금 막 연결된 "이 클라이언트 한 명"
function registerRoomHandlers(io, socket) {
  // ---- 방 생성 ----
  socket.on("room:create", ({ nickname, token }) => {
    if (!nickname || nickname.trim() === "") {
      socket.emit("error", { code: "INVALID_NICKNAME", message: "닉네임을 입력해주세요." });
      return;
    }

    const roomId = generateRoomId();
    const room = new Room(roomId, socket.id);
    room.addPlayer(socket.id, nickname.trim(), token);
    rooms.set(roomId, room);

    // 이 소켓을 해당 방(room)에 실제로 "구독"시킴
    // 이후 io.to(roomId).emit(...) 하면 이 방에 있는 사람들에게만 전달됨
    socket.join(roomId);
    socket.data.roomId = roomId; // 나중에 연결이 끊겼을 때 어느 방 소속인지 알기 위해 저장
    socket.data.token = token; // 재접속 시 이 소켓이 누구였는지 알기 위해 저장

    socket.emit("room:created", { roomId });
    io.to(roomId).emit("room:updated", room.toPublicView());

    console.log(`[방 생성] ${nickname} -> 방 ${roomId}`);
  });

  // ---- 방 입장 ----
  socket.on("room:join", ({ roomId, nickname, token }) => {
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit("error", { code: "ROOM_NOT_FOUND", message: "존재하지 않는 방입니다." });
      return;
    }
    if (room.status !== "waiting") {
      socket.emit("error", { code: "GAME_ALREADY_STARTED", message: "이미 시작된 게임입니다." });
      return;
    }
    if (room.players.length >= 6) {
      socket.emit("error", { code: "ROOM_FULL", message: "방 인원이 가득 찼습니다." });
      return;
    }

    room.addPlayer(socket.id, nickname.trim(), token);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.token = token;

    io.to(roomId).emit("room:updated", room.toPublicView());
    console.log(`[방 입장] ${nickname} -> 방 ${roomId}`);
  });

  // ---- 재접속: 페이지 새로고침/와이파이 끊김 등으로 연결이 끊겼다가 돌아왔을 때 ----
  // 클라이언트는 localStorage에 저장해뒀던 { roomId, token }을 보내옵니다.
  socket.on("room:rejoin", ({ roomId, token }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit("room:rejoinFailed", { message: "방이 더 이상 존재하지 않습니다." });
      return;
    }

    const player = room.findPlayerByToken(token);
    if (!player) {
      socket.emit("room:rejoinFailed", { message: "이 방에서 회원님의 자리를 찾을 수 없습니다." });
      return;
    }

    const oldSocketId = player.socketId;

    // 유예시간 타이머가 아직 돌고 있었다면 취소 (돌아왔으니 강제 퇴장시킬 필요 없음)
    const timer = disconnectTimers.get(token);
    if (timer) {
      clearTimeout(timer.timeoutHandle);
      disconnectTimers.delete(token);
    }

    room.reassignSocketId(oldSocketId, socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.token = token;

    socket.emit("room:rejoined", { roomId, status: room.status });
    if (room.status === "playing") {
      sendHandUpdate(io, room, socket.id); // 손패는 본인만 봐야 하는 정보라 따로 다시 보내줌
    }
    io.to(roomId).emit("room:updated", room.toPublicView());
    if (room.status === "playing") {
      // 클라이언트는 원래 game:turnChanged를 받았을 때만 로비 화면 -> 게임판 화면으로 전환합니다
      // (게임이 시작된 이후로는 room:updated만으로는 화면을 안 바꿈). 재접속은 방금 페이지를
      // 새로 열어서 로비 화면부터 시작하는 상태라, 같은 전환 로직을 타도록 이 이벤트를
      // 본인에게만 다시 보내줍니다 (턴이 실제로 바뀐 건 아니라서 방 전체에 방송하지는 않음).
      // room:updated(손패 포함) 뒤에 보내야 화면을 그릴 때 필요한 정보가 이미 다 갖춰져 있음
      socket.emit("game:turnChanged", { currentTurnSocketId: room.getCurrentTurnSocketId() });
      // 하필 재접속한 사람이 지금 방어를 기다리던 대상이었다면, "방어하세요" 요청도 다시 보내줌
      resendDefenseRequestIfPending(io, room, socket.id);
    }

    console.log(`[재접속] ${player.nickname} -> 방 ${roomId} (${oldSocketId} -> ${socket.id})`);
  });

  // ---- 방 퇴장 (본인이 명시적으로 나가는 경우) ----
  socket.on("room:leave", () => {
    leaveCurrentRoom(io, socket, { immediate: true });
  });

  // ---- 연결이 끊겼을 때 (브라우저 닫기, 새로고침, 와이파이 끊김 등) ----
  socket.on("disconnect", () => {
    leaveCurrentRoom(io, socket, { immediate: false });
  });
}

// immediate: true면 예전처럼 그 자리에서 바로 완전히 내보냄 (본인이 명시적으로 나가기를
// 눌렀거나, 아직 게임이 시작 전인 대기실 상태). false면 게임 진행 중(playing)에 한해 유예시간을
// 두고 "연결 끊김"으로만 표시해뒀다가, 시간 안에 재접속 안 하면 그때 완전히 내보냄
function leaveCurrentRoom(io, socket, { immediate }) {
  const roomId = socket.data.roomId;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) return;

  const token = socket.data.token;
  const shouldGracePeriod = !immediate && room.status === "playing" && token;

  socket.leave(roomId);
  socket.data.roomId = null;

  if (shouldGracePeriod) {
    room.markDisconnected(socket.id);
    io.to(roomId).emit("room:updated", room.toPublicView());
    console.log(`[연결 끊김] 방 ${roomId}, ${socket.id} (${GRACE_PERIOD_MS / 1000}초 안에 재접속하면 이어서 가능)`);

    const timeoutHandle = setTimeout(() => {
      disconnectTimers.delete(token);
      forceRemovePlayer(io, roomId, socket.id);
    }, GRACE_PERIOD_MS);
    disconnectTimers.set(token, { timeoutHandle, roomId });
    return;
  }

  forceRemovePlayer(io, roomId, socket.id);
}

// 실제로 방에서 완전히 내보냄 (기존 room:leave/disconnect 처리와 동일 + 재접속 유예시간이 끝났을 때).
// 게임 진행 중이었다면, 이 사람 때문에 게임이 멈추지 않도록 밀린 턴/방어를 강제로 정리합니다.
function forceRemovePlayer(io, roomId, socketId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const player = room.getPlayer(socketId);
  if (!player) return; // 이미 재접속했거나 다른 경로로 빠졌으면 할 일 없음

  if (room.status === "playing") {
    // 이 사람의 방어를 기다리고 있었다면: 무방비로 방어 포기 처리 (finalizeDefense가
    // "0장 방어 = 전액 피해"를 그대로 계산해줌 - 다중 대상 공격의 다음 대상으로도 알아서 이어짐)
    if (room.pendingDefense && room.pendingDefense.defenderSocketId === socketId) {
      finalizeDefense(io, roomId, room);
    } else if (room.getCurrentTurnSocketId() === socketId && !room.pendingDefense) {
      // 아무도 안 기다리는데(pendingDefense 없음) 이 사람 턴이었다면: 강제로 다음 사람에게 턴을 넘김
      // (안 그러면 사라진 사람의 턴에서 게임이 영원히 멈춤 - 재접속 기능을 넣기 전부터 있던 버그).
      // pendingDefense가 남아있는데 그게 다른 사람(공격자가 아닌 이 사람)을 기다리는 중이라면,
      // 여기서 턴을 넘기면 "방어 대기 중에는 턴 종료 불가" 규칙이 깨지므로 넘기지 않고 그냥 내보내기만
      // 함 - 그 방어가 나중에 확정될 때 finalizeDefense의 안전장치가 대신 턴을 정리해줌
      advanceTurnAndTick(io, roomId, room);
    }
  }

  room.removePlayer(socketId);

  // 방금 제거로 생존자가 1명만 남았을 수 있음 (위의 finalizeDefense/advanceTurnAndTick 호출은
  // 제거되기 "전" 시점 기준이라 이 케이스를 못 잡음 - 예: 2인전에서 방어자가 방어에는 성공했지만
  // 그대로 접속 종료 유예시간이 끝나 나가버리면, 남은 1명이 승자가 되어야 함)
  if (room.status === "playing") maybeEndGame(io, roomId, room);

  if (room.isEmpty()) {
    // 방에 아무도 없으면 통째로 삭제 (메모리 누수 방지)
    rooms.delete(roomId);
    console.log(`[방 삭제] 방 ${roomId} (인원 0명)`);
    return;
  }

  // 방장이 나갔다면 다음 사람에게 방장 위임
  if (room.hostSocketId === socketId) {
    room.hostSocketId = room.players[0].socketId;
  }
  io.to(roomId).emit("room:updated", room.toPublicView());
  console.log(`[퇴장] 방 ${roomId}, ${player.nickname}`);
}

module.exports = { registerRoomHandlers };
