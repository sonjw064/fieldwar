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

// 지형 감면 + 필드효과 감면(예: 청량한안개) - 상대가 걸어둔 코스트 증가(costUp 상태, 예: 얽힌덤불)
// = 이 카드를 지금 낼 때 실제로 드는 코스트. 지형 카드는 항상 무료라 예외 처리.
// (8단계 Phase 3, 2026-08-26 — game:playCard/game:confirmDefense/game:playFieldCard, getHandView 공용)
function computeEffectiveCost(room, socketId, card) {
  if (card.type === "terrain") return 0;
  const reduction = room.getTerrainCostReduction(card.element) + room.getEffectCostReduction(card.element);
  const increase = room.getStatusTotal(socketId, "costUp");
  return Math.max(0, card.cost - reduction + increase);
}

// 특정 플레이어의 손패를, 카드 상세 정보(이름/타입/데미지 등)까지 합쳐서 반환
// (클라이언트는 cardId가 아니라 이 정보를 그대로 화면에 그리면 됨)
// effectiveCost: 지금 이 순간 기준으로 실제로 드는 코스트 (8단계 Phase 3, 2026-08-26 추가)
function getHandView(room, socketId) {
  const player = room.getPlayer(socketId);
  if (!player) return [];
  return player.hand.map((c) => {
    const card = cardsById[c.cardId];
    return {
      instanceId: c.instanceId,
      ...card,
      effectiveCost: computeEffectiveCost(room, socketId, card),
    };
  });
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

// 특정 대상 한 명에게 공격을 "시작"함 (pendingDefense 세팅 + defenseRequest/attackAnnounced 방송).
// 단일 대상 공격은 이 함수를 1번, 다중 대상 공격(흙먼지폭풍 등)은 대상마다 순서대로 여러 번 호출함
// (8단계 Phase 3, 2026-08-26 — 새 이벤트를 만들지 않고 기존 단일 대상 흐름을 재사용하기 위함)
function beginAttackOnTarget(io, roomId, room, attackInfo, targetSocketId) {
  const attacker = room.getPlayer(attackInfo.attackerSocketId);
  const target = room.getPlayer(targetSocketId);
  const card = cardsById[attackInfo.cardId];

  room.setPendingDefense({ ...attackInfo, defenderSocketId: targetSocketId });

  // 방어자에게만 "방어할 카드를 선택하세요" 요청을 따로 보냄
  io.to(targetSocketId).emit("game:defenseRequest", {
    attackerSocketId: attacker.socketId,
    attackerNickname: attacker.nickname,
    cardId: card.id,
    cardName: card.name,
    cost: attackInfo.cost,
    element: attackInfo.element,
    attackPower: attackInfo.attackPower,
    attackTerrainBonus: attackInfo.attackTerrainBonus,
    attackEffectBonus: attackInfo.attackEffectBonus || 0,
  });

  // 공격 카드를 방 전체(공격자/방어자/구경하는 다른 플레이어 모두)에게 화면 중앙 연출용으로 방송
  io.to(roomId).emit("game:attackAnnounced", {
    attackerSocketId: attacker.socketId,
    attackerNickname: attacker.nickname,
    defenderSocketId: targetSocketId,
    defenderNickname: target.nickname,
    cardId: card.id,
    cardName: card.name,
    cost: attackInfo.cost,
    element: attackInfo.element,
    attackPower: attackInfo.attackPower,
    attackTerrainBonus: attackInfo.attackTerrainBonus,
    attackEffectBonus: attackInfo.attackEffectBonus || 0,
  });
}

// 턴을 넘기고(advanceTurn) 필드 효과/지속상태를 발동시킨 뒤(tickEffects/tickPlayerStatuses) 결과를
// 방 전체에 알리는 공용 로직. game:endTurn(정상적인 턴 종료)과, finalizeDefense에서 반격 피해로
// 공격자가 자기 턴 도중 사망해서 강제로 턴을 넘겨야 하는 경우(8단계 Phase 1) 양쪽에서 재사용합니다.
// 게임이 끝났으면 true, 아니면 false를 반환 (호출부에서 이후 처리 분기에 사용)
function advanceTurnAndTick(io, roomId, room) {
  // 기절 상태라 건너뛴 사람이 있으면 각각 방송 (8단계 Phase 2, 2026-08-26)
  const skippedStunned = room.advanceTurn();
  skippedStunned.forEach(({ socketId, remainingTurns }) => {
    const player = room.getPlayer(socketId);
    io.to(roomId).emit("game:playerStunned", {
      socketId,
      nickname: player ? player.nickname : "",
      remainingTurns,
    });
    console.log(`[기절] 방 ${roomId}, ${socketId} 턴 건너뜀 (남은 기절 ${remainingTurns}턴)`);
  });

  const tickedEffects = room.tickEffects();
  if (tickedEffects.length > 0) {
    io.to(roomId).emit("game:effectsTicked", { effects: tickedEffects });
    console.log(`[효과 발동] 방 ${roomId}`, tickedEffects);
  }

  // 화상(DoT) 등 개인 지속상태 발동 (8단계 Phase 2, 2026-08-26)
  const dotTicks = room.tickPlayerStatuses();
  if (dotTicks.length > 0) {
    const dotTicksWithName = dotTicks.map((t) => {
      const p = room.getPlayer(t.socketId);
      return { ...t, nickname: p ? p.nickname : "" };
    });
    io.to(roomId).emit("game:statusesTicked", { dotTicks: dotTicksWithName });
    console.log(`[상태 발동] 방 ${roomId}`, dotTicksWithName);
  }

  const ended = maybeEndGame(io, roomId, room);

  io.to(roomId).emit("room:updated", room.toPublicView());

  if (!ended) {
    io.to(roomId).emit("game:turnChanged", {
      currentTurnSocketId: room.getCurrentTurnSocketId(),
    });
    console.log(`[턴 변경] 방 ${roomId}, 다음 턴: ${room.getCurrentTurnSocketId()}`);
  }

  return ended;
}

// 지금까지 쌓인 방어 카드들(appliedDefenses)을 바탕으로 전투를 확정하고 방 전체에 알림.
// 방어 카드를 0장 냈으면(방어 포기) defended=false로, 1장 이상 냈으면 defended=true로 계산됩니다.
// game:confirmDefense가 고른 카드를 전부 적용한 직후 호출해서 확정합니다.
//
// 8단계 Phase 1(2026-08-26, 즉시효과 메커닉)에서 추가된 것: 관통 피해(armorPiercing, 방어력을
// 무시하고 추가로 들어감), 흡혈(lifestealPercent, 실제 피해 기준으로 공격자 회복), 카드 사용 시
// 고정 회복(healOnUse, playCard 시점에 이미 적용되어 있음 - 여기선 로그/emit용으로만 참조),
// 방어 성공 시 회복(healOnDefend), 방어 성공 시 반격 피해(counterDamage).
function finalizeDefense(io, roomId, room) {
  const {
    attackerSocketId,
    defenderSocketId,
    cardId,
    attackPower,
    attackTerrainBonus,
    attackEffectBonus,
    appliedDefenses,
    appliedStatuses,
    armorPiercing,
    lifestealPercent,
    healOnUse,
  } = room.pendingDefense;
  const card = cardsById[cardId];

  const defensePowerUsed = appliedDefenses.reduce((sum, d) => sum + d.effectiveDefensePower, 0);
  const piercingDamage = armorPiercing || 0;
  const rawDamage = Math.max(0, attackPower - defensePowerUsed) + piercingDamage;
  // 방어자가 damageReduction 상태(대지의보호막/대지의성채 등)를 갖고 있으면 마지막에 추가로 경감
  // (8단계 Phase 3, 2026-08-26) - 방어 카드를 냈는지와 무관하게 항상 적용되는 "받는 피해 감소" 효과
  const damageReductionTotal = room.getStatusTotal(defenderSocketId, "damageReduction");
  const damageDealt = Math.max(0, rawDamage - damageReductionTotal);
  const damageReductionApplied = Math.min(damageReductionTotal, rawDamage);
  const defended = appliedDefenses.length > 0;

  let defenderPlayer = room.applyDamage(defenderSocketId, damageDealt);

  // 방어 성공 시 회복 (치유의물결/정화의물/해일의성채 등) - 방어 도중 이미 죽었으면 되살리지 않음
  const healOnDefendTotal = appliedDefenses.reduce((sum, d) => sum + (d.healOnDefend || 0), 0);
  if (healOnDefendTotal > 0 && defenderPlayer.isAlive) {
    defenderPlayer = room.healPlayer(defenderSocketId, healOnDefendTotal);
  }

  // 흡혈 (흡수의물결) - 실제로 들어간 피해(damageDealt) 기준으로 계산
  const lifestealHeal = lifestealPercent > 0 ? Math.floor((damageDealt * lifestealPercent) / 100) : 0;
  if (lifestealHeal > 0) {
    room.healPlayer(attackerSocketId, lifestealHeal);
  }

  // 방어 성공 시 반격 피해 (화염반사/불꽃되받기/화염의성벽 등)
  const counterDamageTotal = appliedDefenses.reduce((sum, d) => sum + (d.counterDamage || 0), 0);
  let attackerPlayer = room.getPlayer(attackerSocketId);
  if (counterDamageTotal > 0) {
    attackerPlayer = room.applyDamage(attackerSocketId, counterDamageTotal);
  }

  room.clearPendingDefense();

  // 아직 이 카드로 안 맞은 다중 대상이 남아있는지 미리 확인해둠 (아래 combatResult에 실어서
  // 클라이언트가 "더 이어질 예정"인지 알 수 있게 함 - 8단계 Phase 3, 2026-08-26)
  const hasMoreTargets = room.hasMoreMultiTargets();

  io.to(roomId).emit("game:combatResult", {
    attackerSocketId,
    defenderSocketId,
    cardId,
    cardName: card.name,
    defended,
    attackPower,
    attackTerrainBonus: attackTerrainBonus || 0,
    attackEffectBonus: attackEffectBonus || 0,
    appliedDefenses, // [{ cardId, cardName, element, defensePower, counterBonus, terrainBonus, effectiveDefensePower, counterDamage, healOnDefend }]
    defensePowerUsed,
    armorPiercing: piercingDamage,
    damageDealt,
    damageReductionApplied,
    hasMoreTargets,
    defenderHp: defenderPlayer.hp,
    defenderIsAlive: defenderPlayer.isAlive,
    attackerHp: attackerPlayer.hp,
    attackerIsAlive: attackerPlayer.isAlive,
    healOnUse: healOnUse || 0,
    lifestealHeal,
    healOnDefend: healOnDefendTotal,
    counterDamage: counterDamageTotal,
    appliedStatuses: appliedStatuses || [], // [{ targetSocketId, type, amount, remainingTurns }] (8단계 Phase 2)
  });

  // 방어자는 카드를 냈든 안냈든 손패가 바뀌었을 수 있으니 갱신본을 보내줌
  sendHandUpdate(io, room, defenderSocketId);

  let ended = maybeEndGame(io, roomId, room);

  // 반격 피해로 공격자가 "자기 턴 도중" 죽어버리면 턴이 그대로 멈춰버리므로(다음 사람이 턴을
  // 넘길 방법이 없음), 게임이 끝난 게 아니라면 자동으로 다음 턴으로 넘겨줌
  if (!ended && counterDamageTotal > 0 && !attackerPlayer.isAlive && room.getCurrentTurnSocketId() === attackerSocketId) {
    room.clearMultiTargetQueue(); // 공격자가 자기 턴 도중 사망 - 다중 대상 카드였다면 남은 대상 처리를 중단함
    ended = advanceTurnAndTick(io, roomId, room); // room:updated/turnChanged까지 여기서 처리됨
  } else if (!ended && room.hasMoreMultiTargets()) {
    // 다중 대상 카드(흙먼지폭풍 등)의 다음 대상에게 이어서 공격 (8단계 Phase 3, 2026-08-26)
    const nextTargetSocketId = room.popNextMultiTarget();
    beginAttackOnTarget(io, roomId, room, room.pendingMultiTarget, nextTargetSocketId);
    io.to(roomId).emit("room:updated", room.toPublicView());
  } else {
    room.clearMultiTargetQueue(); // 시퀀스 자연 종료(대상 소진) 또는 단일 대상 공격 - 없어도 무해하지만 명시적으로 정리
    io.to(roomId).emit("room:updated", room.toPublicView());
  }

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

    advanceTurnAndTick(io, roomId, room);
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
    // 공격봉쇄(attackLock) 상태면 공격 카드를 낼 수 없음 (8단계 Phase 2, 2026-08-26)
    if (room.hasActiveStatus(socket.id, "attackLock")) {
      socket.emit("error", { code: "ATTACK_LOCKED", message: "공격 카드를 사용할 수 없는 상태입니다." });
      return;
    }

    // 다중 대상 카드(흙먼지폭풍 등)는 targetSocketId를 무시하고 생존한 상대 전원을 대상으로 함.
    // 아니면 기존처럼 특정 대상 한 명을 검증함 (8단계 Phase 3, 2026-08-26)
    let targets;
    if (card.multiTarget) {
      targets = room.getAlivePlayers().map((p) => p.socketId).filter((id) => id !== socket.id);
      if (targets.length === 0) {
        socket.emit("error", { code: "INVALID_TARGET", message: "공격할 대상이 없습니다." });
        return;
      }
    } else {
      const target = room.getPlayer(targetSocketId);
      if (!target || !target.isAlive) {
        socket.emit("error", { code: "INVALID_TARGET", message: "대상을 찾을 수 없거나 이미 쓰러졌습니다." });
        return;
      }
      if (targetSocketId === socket.id) {
        socket.emit("error", { code: "CANNOT_TARGET_SELF", message: "자기 자신을 공격할 수 없습니다." });
        return;
      }
      targets = [targetSocketId];
    }

    // 지형 감면/필드효과 감면/상대가 건 코스트증가까지 반영한 실제 코스트 (8단계 Phase 3, 2026-08-26)
    const effectiveCost = computeEffectiveCost(room, socket.id, card);
    if (attacker.attackCost < effectiveCost) {
      socket.emit("error", {
        code: "INSUFFICIENT_COST",
        message: `공격 코스트가 부족합니다. (필요: ${effectiveCost}, 보유: ${attacker.attackCost})`,
      });
      return;
    }

    room.removeCardFromHand(socket.id, cardInstanceId);
    room.spendAttackCost(socket.id, effectiveCost);
    drawReplacementCard(room, socket.id); // 쓴 카드만큼 덱에서 한 장 보충 (손패 항상 5장 유지)
    sendHandUpdate(io, room, socket.id);

    // 필드에 깔린 지형이 이 카드의 속성을 상생하면 공격력에 보너스가 붙음 (5단계, 2026-08-25)
    const attackTerrainBonus = room.getTerrainSynergyBonus(card.element);
    // 자신에게 걸려있는 공격력 버프 합산 (8단계 Phase 2, 2026-08-26)
    const attackBuffTotal = room.getStatusTotal(socket.id, "attackBuff");
    // 필드효과(작열의기운 등)가 같은 속성 공격 카드에 주는 피해 보너스 (8단계 Phase 3, 2026-08-26)
    const attackEffectBonus = room.getEffectDamageBonus(card.element);
    const effectiveAttackPower = card.attackPower + attackTerrainBonus + attackBuffTotal + attackEffectBonus;

    // 카드 사용 즉시 고정 회복되는 카드(치유의파동/해일 등) - 피해량과 무관하게 지금 바로 적용
    // (8단계 Phase 1, 2026-08-26)
    if (card.healOnUse) {
      room.healPlayer(socket.id, card.healOnUse);
    }

    // CC(기절/방어봉쇄)/화상(DoT)은 각 대상에게, 자기 버프는 자신에게 - 카드를 낸 즉시 무조건 적용됨
    // (전투 결과와 무관, 8단계 Phase 2, 2026-08-26). 지금 카드 구성상 다중 대상 카드에는 ccEffect/
    // dotDamage가 없어서 실질적으로 안 걸리지만, targets.forEach로 돌게 해서 나중에 다중대상+CC
    // 조합 카드가 추가돼도 바로 동작하도록 구조를 열어둠 (8단계 Phase 3, 2026-08-26)
    const appliedStatuses = [];
    targets.forEach((tId) => {
      if (card.ccEffect) {
        room.addStatus(tId, { type: card.ccEffect, amount: 0, remainingTurns: card.ccDuration });
        appliedStatuses.push({ targetSocketId: tId, type: card.ccEffect, amount: 0, remainingTurns: card.ccDuration });
      }
      if (card.dotDamage) {
        room.addStatus(tId, { type: "dot", amount: card.dotDamage, remainingTurns: card.dotDuration });
        appliedStatuses.push({ targetSocketId: tId, type: "dot", amount: card.dotDamage, remainingTurns: card.dotDuration });
      }
    });
    if (card.attackBuffAmount) {
      room.addStatus(socket.id, { type: "attackBuff", amount: card.attackBuffAmount, remainingTurns: card.attackBuffDuration });
      appliedStatuses.push({ targetSocketId: socket.id, type: "attackBuff", amount: card.attackBuffAmount, remainingTurns: card.attackBuffDuration });
    }
    if (card.defBuffAmount) {
      room.addStatus(socket.id, { type: "defBuff", amount: card.defBuffAmount, remainingTurns: card.defBuffDuration });
      appliedStatuses.push({ targetSocketId: socket.id, type: "defBuff", amount: card.defBuffAmount, remainingTurns: card.defBuffDuration });
    }

    const attackInfo = {
      attackerSocketId: socket.id,
      cardId: card.id,
      cost: effectiveCost,
      element: card.element,
      attackPower: effectiveAttackPower,
      attackTerrainBonus,
      attackEffectBonus,
      armorPiercing: card.armorPiercing || 0,
      lifestealPercent: card.lifestealPercent || 0,
      healOnUse: card.healOnUse || 0,
      appliedStatuses,
    };

    // 다중 대상이면 큐에 담아두고 첫 대상부터, 아니면 그 한 명에게 바로 공격 시작
    // (8단계 Phase 3, 2026-08-26 — beginAttackOnTarget이 pendingDefense 세팅 + 방송을 전담함)
    if (card.multiTarget) {
      room.setMultiTargetQueue({ ...attackInfo, remainingTargets: [...targets] });
      const firstTarget = room.popNextMultiTarget();
      beginAttackOnTarget(io, roomId, room, room.pendingMultiTarget, firstTarget);
    } else {
      beginAttackOnTarget(io, roomId, room, attackInfo, targets[0]);
    }

    io.to(roomId).emit("room:updated", room.toPublicView());

    const targetDescription = card.multiTarget ? "전원" : room.getPlayer(targets[0]).nickname;
    console.log(`[공격] 방 ${roomId}, ${attacker.nickname} -> ${targetDescription} (${card.name})`);
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

    // 방어봉쇄(defenseLock) 상태면 카드를 내서 방어할 수 없음(포기, 즉 빈 배열은 여전히 허용됨)
    // (8단계 Phase 2, 2026-08-26)
    if (ids.length > 0 && room.hasActiveStatus(socket.id, "defenseLock")) {
      socket.emit("error", { code: "DEFENSE_LOCKED", message: "방어 카드를 사용할 수 없는 상태입니다." });
      return;
    }

    // 1단계: 먼저 전부 유효한 카드인지만 확인 (하나라도 문제가 있으면 아무 것도 반영하지 않고 거부)
    // effectiveCost: 지형 감면/필드효과 감면/상대가 건 코스트증가까지 반영한 실제 코스트 (8단계 Phase 3)
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
      const effectiveCost = computeEffectiveCost(room, socket.id, card);
      resolvedCards.push({ instanceId, card, effectiveCost });
      totalCost += effectiveCost;
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
    resolvedCards.forEach(({ instanceId, card, effectiveCost }) => {
      room.removeCardFromHand(socket.id, instanceId);
      room.spendDefenseCost(socket.id, effectiveCost);
      drawReplacementCard(room, socket.id); // 쓴 카드만큼 덱에서 한 장 보충 (손패 항상 5장 유지)

      const counterBonus = isCounter(card.element, attackInfo.element) ? COUNTER_BONUS : 0;
      const terrainBonus = room.getTerrainSynergyBonus(card.element);
      // 자신에게 걸려있는 방어력 버프 합산 (8단계 Phase 2, 2026-08-26)
      const defBuffTotal = room.getStatusTotal(socket.id, "defBuff");
      const effectiveDefensePower = card.defensePower + counterBonus + terrainBonus + defBuffTotal;

      room.addAppliedDefense({
        cardId: card.id,
        cardName: card.name,
        element: card.element,
        defensePower: card.defensePower,
        counterBonus,
        terrainBonus,
        effectiveDefensePower,
        counterDamage: card.counterDamage || 0,
        healOnDefend: card.healOnDefend || 0,
      });

      // 방어 성공 시 CC(공격자에게)/자기 버프(자신에게) 즉시 적용 (8단계 Phase 2, 2026-08-26)
      if (card.ccEffect) {
        room.addStatus(attackInfo.attackerSocketId, { type: card.ccEffect, amount: 0, remainingTurns: card.ccDuration });
        room.addAppliedStatus({
          targetSocketId: attackInfo.attackerSocketId,
          type: card.ccEffect,
          amount: 0,
          remainingTurns: card.ccDuration,
        });
      }
      if (card.attackBuffAmount) {
        room.addStatus(socket.id, { type: "attackBuff", amount: card.attackBuffAmount, remainingTurns: card.attackBuffDuration });
        room.addAppliedStatus({
          targetSocketId: socket.id,
          type: "attackBuff",
          amount: card.attackBuffAmount,
          remainingTurns: card.attackBuffDuration,
        });
      }
      if (card.defBuffAmount) {
        room.addStatus(socket.id, { type: "defBuff", amount: card.defBuffAmount, remainingTurns: card.defBuffDuration });
        room.addAppliedStatus({
          targetSocketId: socket.id,
          type: "defBuff",
          amount: card.defBuffAmount,
          remainingTurns: card.defBuffDuration,
        });
      }
      // 방어 성공 시 받는 피해 감소(대지의보호막/대지의성채 등) 자신에게 적용 (8단계 Phase 3, 2026-08-26)
      if (card.damageReductionAmount) {
        room.addStatus(socket.id, {
          type: "damageReduction",
          amount: card.damageReductionAmount,
          remainingTurns: card.damageReductionDuration,
        });
        room.addAppliedStatus({
          targetSocketId: socket.id,
          type: "damageReduction",
          amount: card.damageReductionAmount,
          remainingTurns: card.damageReductionDuration,
        });
      }

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
        counterDamage: card.counterDamage || 0,
        healOnDefend: card.healOnDefend || 0,
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
    // (개발자와 상의해서 결정: 자기 턴에 능동적으로 내는 카드라 공격 코스트 풀을 쓰기로 함)
    // 효과 카드도 지형 감면/필드효과 감면/코스트증가가 반영된 effectiveCost로 계산함 (8단계 Phase 3)
    const effectiveCost = computeEffectiveCost(room, socket.id, card);
    if (card.type === "effect") {
      if (player.attackCost < effectiveCost) {
        socket.emit("error", {
          code: "INSUFFICIENT_COST",
          message: `공격 코스트가 부족합니다. (필요: ${effectiveCost}, 보유: ${player.attackCost})`,
        });
        return;
      }
      room.spendAttackCost(socket.id, effectiveCost);
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
        costReduction: card.costReduction || 0, // 8단계 Phase 3, 2026-08-26
        description: card.description, // 필드 상태바가 문구를 직접 조립하지 않고 그대로 보여줄 수 있게
      });
    } else {
      room.addEffect({
        instanceId: cardInstanceId,
        cardId: card.id,
        cardName: card.name,
        element: card.element,
        tickDamage: card.tickDamage,
        remainingTurns: card.durationTurns,
        costReductionAmount: card.costReductionAmount || 0, // 8단계 Phase 3, 2026-08-26 (청량한안개 등)
        damageBonusAmount: card.damageBonusAmount || 0, // 8단계 Phase 3, 2026-08-26 (작열의기운 등)
        description: card.description,
      });

      // 상대 전원(자신 제외)에게 카드 코스트 증가를 거는 효과 (얽힌덤불 등)
      if (card.costUpAmount) {
        room.getAlivePlayers().forEach((p) => {
          if (p.socketId !== socket.id) {
            room.addStatus(p.socketId, { type: "costUp", amount: card.costUpAmount, remainingTurns: card.durationTurns });
          }
        });
      }
      // 자신의 최대 공격 코스트를 늘리는 효과 (정기서린땅)
      if (card.maxAttackCostBuffAmount) {
        room.addStatus(socket.id, {
          type: "maxAttackCostBuff",
          amount: card.maxAttackCostBuffAmount,
          remainingTurns: card.durationTurns,
        });
      }
    }

    // 지형/효과 카드가 각각 무슨 효과를 주는지 알 수 있도록 상세 정보를 같이 보냄
    // description을 그대로 실어서, 클라이언트가 종류별 문구를 직접 조립하지 않아도 되게 함 (8단계 Phase 3)
    io.to(roomId).emit("game:fieldCardPlayed", {
      playerSocketId: socket.id,
      playerNickname: player.nickname,
      cardId: card.id,
      cardName: card.name,
      fieldType: card.type,
      element: card.element,
      description: card.description,
      durationTurns: card.type === "effect" ? card.durationTurns : undefined,
    });
    io.to(roomId).emit("room:updated", room.toPublicView());

    console.log(`[필드 카드] 방 ${roomId}, ${player.nickname} -> ${card.name} (${card.type})`);
  });
}

module.exports = { registerGameHandlers };
