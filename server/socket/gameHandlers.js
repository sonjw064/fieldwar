// gameHandlers.js
// "게임 진행(턴)"과 관련된 Socket.io 이벤트를 처리합니다.
// 방 생성/입장은 roomHandlers.js가 담당하고, 여기서는 게임이 시작된 이후만 다룹니다.

const { rooms } = require("./roomHandlers");
const { isCounter, GENERATE_MAP } = require("../game/elementTable");

// 카드 정의 데이터 (Spring Boot로 치면 application.yml에 둔 고정 마스터 데이터를
// 서버 시작 시 한 번 읽어서 메모리에 올려두는 것과 비슷합니다)
const cardPool = require("../data/cards.json");
const cardsById = {};
cardPool.forEach((card) => {
  cardsById[card.id] = card;
});

const HAND_SIZE = 5; // 손패 상한 (임시 수치, 나중에 조정 가능)
const COPIES_PER_CARD = 6; // 카드 한 종류당 덱에 몇 장씩 들어가는지 (임시 수치)

// 방어 속성이 공격 속성을 상극(카운터)할 때 방어력에 더해주는 고정 보너스
// (전투 시스템 개편, 2026-08-25 — combat_mechanic_update_prompt.md 기준, 개발자와 상의해서 +5로 확정)
const COUNTER_BONUS = 5;

// 카드 id로 이루어진 덱을 하나 만들고 섞어서 반환 (Fisher-Yates 셔플)
function buildShuffledDeck() {
  const deck = [];
  cardPool.forEach((card) => {
    for (let i = 0; i < COPIES_PER_CARD; i++) {
      deck.push(card.id);
    }
  });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// 방에 있는 모든 플레이어에게 덱에서 카드를 HAND_SIZE장씩 랜덤 분배.
// 다 나눠주고 남은 카드는 room.deck에 저장해서, 이후 카드를 쓸 때마다 거기서 한 장씩 뽑아 씀
function dealHandsToRoom(room) {
  const deck = buildShuffledDeck();
  room.players.forEach((player) => {
    const cardIds = [];
    for (let i = 0; i < HAND_SIZE; i++) {
      cardIds.push(deck.pop());
    }
    room.setHand(player.socketId, cardIds);
  });
  room.setDeck(deck);
}

// 카드를 한 장 사용해서 손패가 줄어들었을 때, 덱에서 한 장을 뽑아 채워줌 (손패 항상 5장 유지, 6단계)
// 덱이 바닥나면 새로 셔플해서 다시 채움 - 게임이 카드 부족으로 멈추지 않도록 함
function drawReplacementCard(room, socketId) {
  if (room.deck.length === 0) {
    room.setDeck(buildShuffledDeck());
  }
  room.drawCardForPlayer(socketId);
}

// 특정 플레이어의 손패를, 카드 상세 정보(이름/타입/데미지 등)까지 합쳐서 반환
// (클라이언트는 cardId가 아니라 이 정보를 그대로 화면에 그리면 됨)
function getHandView(room, socketId) {
  const player = room.getPlayer(socketId);
  if (!player) return [];
  return player.hand.map((c) => ({
    instanceId: c.instanceId,
    ...cardsById[c.cardId],
  }));
}

// 해당 소켓에게 최신 손패를 보내줌 (본인에게만 보내는 비공개 정보)
function sendHandUpdate(io, room, socketId) {
  io.to(socketId).emit("game:handUpdated", { hand: getHandView(room, socketId) });
}

// 생존자가 1명 이하로 남았는지 확인하고, 그렇다면 게임을 종료 처리 + game:over 방송.
// 전투 종료 시점(resolveCombat)과 효과 카드 틱(game:endTurn) 양쪽에서 공통으로 씀.
// 게임이 끝났으면 true, 아니면 false를 반환
function maybeEndGame(io, roomId, room) {
  if (room.status !== "playing") return false;
  const alivePlayers = room.getAlivePlayers();
  if (alivePlayers.length > 1) return false;

  room.status = "ended";
  const winner = alivePlayers[0] || null;
  io.to(roomId).emit("game:over", {
    winnerSocketId: winner ? winner.socketId : null,
    winnerNickname: winner ? winner.nickname : null,
  });
  return true;
}

// 지금까지 쌓인 방어 카드들(appliedDefenses)을 바탕으로 전투를 확정하고 방 전체에 알림.
// 방어 카드를 0장 냈으면(방어 포기) defended=false로, 1장 이상 냈으면 defended=true로 계산됩니다.
// game:confirmDefense가 고른 카드를 전부 적용한 직후 호출해서 확정합니다.
function finalizeDefense(io, roomId, room) {
  const { attackerSocketId, defenderSocketId, cardId, attackPower, attackTerrainBonus, appliedDefenses } =
    room.pendingDefense;
  const card = cardsById[cardId];

  const defensePowerUsed = appliedDefenses.reduce((sum, d) => sum + d.effectiveDefensePower, 0);
  const damageDealt = Math.max(0, attackPower - defensePowerUsed);
  const defended = appliedDefenses.length > 0;

  const defenderPlayer = room.applyDamage(defenderSocketId, damageDealt);
  room.clearPendingDefense();

  io.to(roomId).emit("game:combatResult", {
    attackerSocketId,
    defenderSocketId,
    cardId,
    cardName: card.name,
    defended,
    attackPower,
    attackTerrainBonus: attackTerrainBonus || 0,
    appliedDefenses, // [{ cardId, cardName, element, defensePower, counterBonus, terrainBonus, effectiveDefensePower }]
    defensePowerUsed,
    damageDealt,
    defenderHp: defenderPlayer.hp,
    defenderIsAlive: defenderPlayer.isAlive,
  });

  // 방어자는 카드를 냈든 안냈든 손패가 바뀌었을 수 있으니 갱신본을 보내줌
  sendHandUpdate(io, room, defenderSocketId);

  maybeEndGame(io, roomId, room);

  io.to(roomId).emit("room:updated", room.toPublicView());

  console.log(
    `[전투 결과] 방 ${roomId}, ${attackerSocketId} -> ${defenderSocketId}, ` +
      `방어카드 ${appliedDefenses.length}장, 피해=${damageDealt}`
  );
}

function registerGameHandlers(io, socket) {
  // ---- 게임 시작 (방장만 가능) ----
  socket.on("game:start", ({ roomId }) => {
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit("error", { code: "ROOM_NOT_FOUND", message: "존재하지 않는 방입니다." });
      return;
    }
    if (room.hostSocketId !== socket.id) {
      socket.emit("error", { code: "NOT_HOST", message: "방장만 게임을 시작할 수 있습니다." });
      return;
    }
    if (room.status !== "waiting") {
      socket.emit("error", { code: "ALREADY_STARTED", message: "이미 시작된 게임입니다." });
      return;
    }
    if (room.players.length < 2) {
      socket.emit("error", { code: "NOT_ENOUGH_PLAYERS", message: "2명 이상 모여야 시작할 수 있습니다." });
      return;
    }

    room.startGame();
    dealHandsToRoom(room);

    io.to(roomId).emit("room:updated", room.toPublicView());
    io.to(roomId).emit("game:turnChanged", {
      currentTurnSocketId: room.getCurrentTurnSocketId(),
    });

    // 손패는 각자에게만 보이는 정보이므로 전원에게 개별로 보내줌
    room.players.forEach((player) => {
      sendHandUpdate(io, room, player.socketId);
    });

    console.log(`[게임 시작] 방 ${roomId}, 첫 턴: ${room.getCurrentTurnSocketId()}`);
  });

  // ---- 턴 종료 (현재 턴인 사람만 가능) ----
  socket.on("game:endTurn", ({ roomId }) => {
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit("error", { code: "ROOM_NOT_FOUND", message: "존재하지 않는 방입니다." });
      return;
    }
    if (room.status !== "playing") {
      socket.emit("error", { code: "GAME_NOT_STARTED", message: "아직 게임이 시작되지 않았습니다." });
      return;
    }
    if (room.getCurrentTurnSocketId() !== socket.id) {
      socket.emit("error", { code: "NOT_YOUR_TURN", message: "당신의 턴이 아닙니다." });
      return;
    }
    if (room.pendingDefense) {
      socket.emit("error", {
        code: "PENDING_DEFENSE_EXISTS",
        message: "방어 결과가 나올 때까지 턴을 종료할 수 없습니다.",
      });
      return;
    }

    room.advanceTurn();

    // 턴이 넘어갈 때마다 필드에 걸린 효과 카드들을 발동시킴 (전원에게 피해 + 잔여 턴 감소)
    const tickedEffects = room.tickEffects();
    if (tickedEffects.length > 0) {
      io.to(roomId).emit("game:effectsTicked", { effects: tickedEffects });
      console.log(`[효과 발동] 방 ${roomId}`, tickedEffects);
    }

    // 효과 피해로 인해 게임이 끝났을 수도 있으니 먼저 확인
    const ended = maybeEndGame(io, roomId, room);

    io.to(roomId).emit("room:updated", room.toPublicView());

    if (!ended) {
      io.to(roomId).emit("game:turnChanged", {
        currentTurnSocketId: room.getCurrentTurnSocketId(),
      });
      console.log(`[턴 변경] 방 ${roomId}, 다음 턴: ${room.getCurrentTurnSocketId()}`);
    }
  });

  // ---- 공격 카드 사용 (현재 턴인 사람만, 방어 대기 중이 아닐 때만) ----
  socket.on("game:playCard", ({ roomId, cardInstanceId, targetSocketId }) => {
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit("error", { code: "ROOM_NOT_FOUND", message: "존재하지 않는 방입니다." });
      return;
    }
    if (room.status !== "playing") {
      socket.emit("error", { code: "GAME_NOT_STARTED", message: "아직 게임이 시작되지 않았습니다." });
      return;
    }
    if (room.getCurrentTurnSocketId() !== socket.id) {
      socket.emit("error", { code: "NOT_YOUR_TURN", message: "당신의 턴이 아닙니다." });
      return;
    }
    if (room.pendingDefense) {
      socket.emit("error", {
        code: "PENDING_DEFENSE_EXISTS",
        message: "이전 공격의 방어 결과가 나올 때까지 기다려주세요.",
      });
      return;
    }

    const target = room.getPlayer(targetSocketId);
    if (!target || !target.isAlive) {
      socket.emit("error", { code: "INVALID_TARGET", message: "대상을 찾을 수 없거나 이미 쓰러졌습니다." });
      return;
    }
    if (targetSocketId === socket.id) {
      socket.emit("error", { code: "CANNOT_TARGET_SELF", message: "자기 자신을 공격할 수 없습니다." });
      return;
    }

    // 손패에서 카드를 찾되, 아직 실제로 빼지는 않고 우선 유효성만 확인
    const attacker = room.getPlayer(socket.id);
    const handCard = attacker.hand.find((c) => c.instanceId === cardInstanceId);
    if (!handCard) {
      socket.emit("error", { code: "CARD_NOT_FOUND", message: "해당 카드를 가지고 있지 않습니다." });
      return;
    }
    const card = cardsById[handCard.cardId];
    if (!card || card.type !== "attack") {
      socket.emit("error", { code: "CARD_NOT_ATTACK", message: "공격 카드가 아닙니다." });
      return;
    }
    if (attacker.attackCost < card.cost) {
      socket.emit("error", {
        code: "INSUFFICIENT_COST",
        message: `공격 코스트가 부족합니다. (필요: ${card.cost}, 보유: ${attacker.attackCost})`,
      });
      return;
    }

    room.removeCardFromHand(socket.id, cardInstanceId);
    room.spendAttackCost(socket.id, card.cost);
    drawReplacementCard(room, socket.id); // 쓴 카드만큼 덱에서 한 장 보충 (손패 항상 5장 유지)
    sendHandUpdate(io, room, socket.id);

    // 필드에 깔린 지형이 이 카드의 속성을 상생하면 공격력에 보너스가 붙음 (5단계, 2026-08-25)
    const attackTerrainBonus = room.getTerrainSynergyBonus(card.element);
    const effectiveAttackPower = card.attackPower + attackTerrainBonus;

    room.setPendingDefense({
      attackerSocketId: socket.id,
      defenderSocketId: targetSocketId,
      cardId: card.id,
      cost: card.cost,
      element: card.element,
      attackPower: effectiveAttackPower,
      attackTerrainBonus,
    });

    // 방어자에게만 "방어할 카드를 선택하세요" 요청을 따로 보냄
    // element/attackPower도 같이 보내서, 방어 카드를 고를 때 참고할 수 있게 함
    io.to(targetSocketId).emit("game:defenseRequest", {
      attackerSocketId: socket.id,
      attackerNickname: attacker.nickname,
      cardId: card.id,
      cardName: card.name,
      cost: card.cost,
      element: card.element,
      attackPower: effectiveAttackPower,
      attackTerrainBonus,
    });

    // 공격 카드를 방 전체(공격자/방어자/구경하는 다른 플레이어 모두)에게 화면 중앙 연출용으로 방송.
    // 방어가 끝날 때까지(game:combatResult가 올 때까지) 계속 보여줄 수 있도록 필요한 정보를 다 담아 보냄
    io.to(roomId).emit("game:attackAnnounced", {
      attackerSocketId: socket.id,
      attackerNickname: attacker.nickname,
      defenderSocketId: targetSocketId,
      defenderNickname: target.nickname,
      cardId: card.id,
      cardName: card.name,
      cost: card.cost,
      element: card.element,
      attackPower: effectiveAttackPower,
      attackTerrainBonus,
    });

    io.to(roomId).emit("room:updated", room.toPublicView());

    console.log(`[공격] 방 ${roomId}, ${attacker.nickname} -> ${target.nickname} (${card.name})`);
  });

  // ---- 방어 카드 선택 확정 (방어 대상인 사람만) ----
  // 2026-08-27 재설계: 카드를 누를 때마다 바로 서버에 반영하던 방식(game:defend)은
  // "코스트가 부족해서 카드가 비활성화되면 더 이상 아무것도 못 누르고 멈추는" 문제가 있었습니다.
  // 그래서 카드 선택은 클라이언트에서만 하고(서버에 아무 영향 없음, 자유롭게 골랐다 취소했다 가능),
  // "사용" 버튼을 눌러 이 이벤트로 고른 카드 목록을 한 번에 보내면 그때 전부 검증 후 한꺼번에 적용합니다.
  // cardInstanceIds가 빈 배열이면 방어 포기(공격력 그대로 피해)와 같습니다.
  socket.on("game:confirmDefense", ({ roomId, cardInstanceIds }) => {
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit("error", { code: "ROOM_NOT_FOUND", message: "존재하지 않는 방입니다." });
      return;
    }
    if (!room.pendingDefense || room.pendingDefense.defenderSocketId !== socket.id) {
      socket.emit("error", { code: "NOT_DEFENDER", message: "지금 방어할 차례가 아닙니다." });
      return;
    }

    const defender = room.getPlayer(socket.id);
    const attackInfo = room.pendingDefense;
    const ids = Array.isArray(cardInstanceIds) ? cardInstanceIds : [];

    // 1단계: 먼저 전부 유효한 카드인지만 확인 (하나라도 문제가 있으면 아무 것도 반영하지 않고 거부)
    const resolvedCards = [];
    let totalCost = 0;
    for (const instanceId of ids) {
      const handCard = defender.hand.find((c) => c.instanceId === instanceId);
      if (!handCard) {
        socket.emit("error", { code: "CARD_NOT_FOUND", message: "해당 카드를 가지고 있지 않습니다." });
        return;
      }
      const card = cardsById[handCard.cardId];
      if (!card || card.type !== "defense") {
        socket.emit("error", { code: "CARD_NOT_DEFENSE", message: "방어 카드가 아닙니다." });
        return;
      }
      resolvedCards.push({ instanceId, card });
      totalCost += card.cost;
    }

    if (totalCost > defender.defenseCost) {
      socket.emit("error", {
        code: "INSUFFICIENT_COST",
        message: `방어 코스트가 부족합니다. (필요: ${totalCost}, 보유: ${defender.defenseCost})`,
      });
      return;
    }

    // 2단계: 전부 유효하므로 순서대로 적용 (코스트 매칭 방식 폐기 - 방어력 대 공격력 수치 비교만 함,
    // 상극이면 방어력에 고정 보너스를 더함)
    resolvedCards.forEach(({ instanceId, card }) => {
      room.removeCardFromHand(socket.id, instanceId);
      room.spendDefenseCost(socket.id, card.cost);
      drawReplacementCard(room, socket.id); // 쓴 카드만큼 덱에서 한 장 보충 (손패 항상 5장 유지)

      const counterBonus = isCounter(card.element, attackInfo.element) ? COUNTER_BONUS : 0;
      const terrainBonus = room.getTerrainSynergyBonus(card.element);
      const effectiveDefensePower = card.defensePower + counterBonus + terrainBonus;

      room.addAppliedDefense({
        cardId: card.id,
        cardName: card.name,
        element: card.element,
        defensePower: card.defensePower,
        counterBonus,
        terrainBonus,
        effectiveDefensePower,
      });

      // 방 전체에 "방어 카드가 하나 더 겹쳐졌다"는 걸 방송 (연출용 - 카드마다 하나씩 순서대로 쌓임)
      io.to(roomId).emit("game:defenseCardApplied", {
        defenderSocketId: socket.id,
        cardId: card.id,
        cardName: card.name,
        cost: card.cost,
        element: card.element,
        defensePower: card.defensePower,
        counterBonus,
        terrainBonus,
        effectiveDefensePower,
      });
    });

    sendHandUpdate(io, room, socket.id);
    io.to(roomId).emit("room:updated", room.toPublicView());

    // 고른 카드까지만 반영하고 바로 확정 (더 필요한지 자동 판단 없이, 사용자가 "사용"을 누른 시점이 곧 확정)
    finalizeDefense(io, roomId, room);
  });

  // ---- 필드 카드 사용 (지형 or 효과) ----
  // 대상 지정이 필요 없다는 점이 game:playCard(공격 카드)와 다름
  socket.on("game:playFieldCard", ({ roomId, cardInstanceId }) => {
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit("error", { code: "ROOM_NOT_FOUND", message: "존재하지 않는 방입니다." });
      return;
    }
    if (room.status !== "playing") {
      socket.emit("error", { code: "GAME_NOT_STARTED", message: "아직 게임이 시작되지 않았습니다." });
      return;
    }
    if (room.getCurrentTurnSocketId() !== socket.id) {
      socket.emit("error", { code: "NOT_YOUR_TURN", message: "당신의 턴이 아닙니다." });
      return;
    }
    if (room.pendingDefense) {
      socket.emit("error", {
        code: "PENDING_DEFENSE_EXISTS",
        message: "이전 공격의 방어 결과가 나올 때까지 기다려주세요.",
      });
      return;
    }

    const player = room.getPlayer(socket.id);
    const handCard = player.hand.find((c) => c.instanceId === cardInstanceId);
    if (!handCard) {
      socket.emit("error", { code: "CARD_NOT_FOUND", message: "해당 카드를 가지고 있지 않습니다." });
      return;
    }
    const card = cardsById[handCard.cardId];
    if (!card || (card.type !== "terrain" && card.type !== "effect")) {
      socket.emit("error", { code: "CARD_NOT_FIELD", message: "필드 카드(지형/효과)가 아닙니다." });
      return;
    }

    // 지형 카드는 코스트를 소모하지 않지만, 효과 카드는 공격 코스트 풀에서 소모함
    // (개발자와 상의해서 결정: 자기 턴에 능동적으로 내는 카드라 공격 카드와 같은 풀을 쓰기로 함)
    if (card.type === "effect") {
      if (player.attackCost < card.cost) {
        socket.emit("error", {
          code: "INSUFFICIENT_COST",
          message: `공격 코스트가 부족합니다. (필요: ${card.cost}, 보유: ${player.attackCost})`,
        });
        return;
      }
      room.spendAttackCost(socket.id, card.cost);
    }

    room.removeCardFromHand(socket.id, cardInstanceId);
    drawReplacementCard(room, socket.id); // 쓴 카드만큼 덱에서 한 장 보충 (손패 항상 5장 유지)
    sendHandUpdate(io, room, socket.id);

    // 지형이 상생하는 속성 (예: 화속성 지형 -> 화생토 -> 토속성이 강화됨). 로그/필드 표시줄에 보여주기 위해 미리 계산
    const boostedElement = card.type === "terrain" ? GENERATE_MAP[card.element] : null;

    if (card.type === "terrain") {
      room.setTerrain({
        cardId: card.id,
        cardName: card.name,
        element: card.element,
        synergyBonus: card.synergyBonus,
        boostedElement,
      });
    } else {
      room.addEffect({
        instanceId: cardInstanceId,
        cardId: card.id,
        cardName: card.name,
        element: card.element,
        tickDamage: card.tickDamage,
        remainingTurns: card.durationTurns,
      });
    }

    // 지형/효과 카드가 각각 무슨 효과를 주는지 알 수 있도록 상세 정보를 같이 보냄
    io.to(roomId).emit("game:fieldCardPlayed", {
      playerSocketId: socket.id,
      playerNickname: player.nickname,
      cardId: card.id,
      cardName: card.name,
      fieldType: card.type,
      element: card.element,
      synergyBonus: card.type === "terrain" ? card.synergyBonus : undefined,
      boostedElement: card.type === "terrain" ? boostedElement : undefined,
      tickDamage: card.type === "effect" ? card.tickDamage : undefined,
      durationTurns: card.type === "effect" ? card.durationTurns : undefined,
    });
    io.to(roomId).emit("room:updated", room.toPublicView());

    console.log(`[필드 카드] 방 ${roomId}, ${player.nickname} -> ${card.name} (${card.type})`);
  });
}

module.exports = { registerGameHandlers };
