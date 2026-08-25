// roomHandlers.js
// "방 생성 / 입장 / 퇴장"과 관련된 Socket.io 이벤트를 처리합니다.
// Spring Boot의 @RestController 하나가
// 여러 개의 @PostMapping을 갖고 있는 것과 비슷한 느낌으로 보시면 됩니다.
// 다만 여기서는 socket.on("이벤트이름", 콜백함수) 형태로 등록합니다.

const Room = require("../game/Room");

// 모든 방을 저장하는 저장소 (DB 대신 메모리에 저장)
// key: roomId, value: Room 인스턴스
const rooms = new Map();

// 4자리 숫자 방 코드를 랜덤 생성 (예: 3821)
function generateRoomId() {
  let id;
  do {
    id = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(id));
  return id;
}

// io: 서버 전체 (모든 연결된 클라이언트에게 방송할 때 사용)
// socket: 지금 막 연결된 "이 클라이언트 한 명"
function registerRoomHandlers(io, socket) {
  // ---- 방 생성 ----
  socket.on("room:create", ({ nickname }) => {
    if (!nickname || nickname.trim() === "") {
      socket.emit("error", { code: "INVALID_NICKNAME", message: "닉네임을 입력해주세요." });
      return;
    }

    const roomId = generateRoomId();
    const room = new Room(roomId, socket.id);
    room.addPlayer(socket.id, nickname.trim());
    rooms.set(roomId, room);

    // 이 소켓을 해당 방(room)에 실제로 "구독"시킴
    // 이후 io.to(roomId).emit(...) 하면 이 방에 있는 사람들에게만 전달됨
    socket.join(roomId);
    socket.data.roomId = roomId; // 나중에 연결이 끊겼을 때 어느 방 소속인지 알기 위해 저장

    socket.emit("room:created", { roomId });
    io.to(roomId).emit("room:updated", room.toPublicView());

    console.log(`[방 생성] ${nickname} -> 방 ${roomId}`);
  });

  // ---- 방 입장 ----
  socket.on("room:join", ({ roomId, nickname }) => {
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

    room.addPlayer(socket.id, nickname.trim());
    socket.join(roomId);
    socket.data.roomId = roomId;

    io.to(roomId).emit("room:updated", room.toPublicView());
    console.log(`[방 입장] ${nickname} -> 방 ${roomId}`);
  });

  // ---- 방 퇴장 ----
  socket.on("room:leave", () => {
    leaveCurrentRoom(io, socket);
  });

  // ---- 연결이 끊겼을 때 (브라우저 닫기, 새로고침 등) ----
  socket.on("disconnect", () => {
    leaveCurrentRoom(io, socket);
  });
}

function leaveCurrentRoom(io, socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (!room) return;

  room.removePlayer(socket.id);
  socket.leave(roomId);
  socket.data.roomId = null;

  if (room.isEmpty()) {
    // 방에 아무도 없으면 통째로 삭제 (메모리 누수 방지)
    rooms.delete(roomId);
    console.log(`[방 삭제] 방 ${roomId} (인원 0명)`);
  } else {
    // 방장이 나갔다면 다음 사람에게 방장 위임
    if (room.hostSocketId === socket.id) {
      room.hostSocketId = room.players[0].socketId;
    }
    io.to(roomId).emit("room:updated", room.toPublicView());
  }
}

module.exports = { registerRoomHandlers, rooms };
