// Room.js
// 방(대전) 하나의 상태를 담는 클래스입니다.
// Java로 치면 그냥 필드 + 생성자만 있는 간단한 클래스라고 생각하시면 됩니다.
// DB에 저장하지 않고, 서버가 켜져있는 동안 메모리(RAM)에만 존재합니다.

const { GENERATE_MAP } = require("./elementTable");

class Room {
  constructor(roomId, hostSocketId) {
    this.roomId = roomId;
    this.hostSocketId = hostSocketId; // 방장 (게임 시작 버튼을 누를 수 있는 사람)
    this.status = "waiting"; // waiting(대기중) | playing(게임중) | ended(종료)

    // players: 이 방에 들어온 사람들의 목록
    // 지금 단계에서는 닉네임/HP 정도만 가지고 있고,
    // 나중에 카드/코스트/필드 등을 여기에 계속 추가해나갈 예정입니다.
    this.players = [];

    this.turnOrder = []; // 턴 순서 (socketId 배열)
    this.currentTurnIndex = 0;

    // 카드 인스턴스에 고유 id를 붙이기 위한 카운터
    // (같은 카드 "화염구"를 여러 장 들고 있어도 서로 구분할 수 있어야 하기 때문)
    this.instanceCounter = 0;

    // 공격이 들어가서 방어 응답을 기다리는 중이면 여기에 정보가 채워짐, 없으면 null
    // { attackerSocketId, defenderSocketId, cardId, cost, element, attackPower, attackTerrainBonus }
    this.pendingDefense = null;

    // ---- 필드 시스템 (5단계, 2026-08-25 추가) ----
    // 지형: 1슬롯 교체형. 새 지형 카드가 나오면 기존 지형은 그냥 사라짐 (중첩 불가)
    // null이면 무속성(지형 없음) 상태
    this.terrain = null; // { cardId, cardName, element, synergyBonus }

    // 효과: 다슬롯 누적형. 여러 효과가 동시에 존재 가능, 각자 남은 턴 수를 따로 관리
    this.effects = []; // [{ instanceId, cardId, cardName, element, tickDamage, remainingTurns }]

    // 카드를 뽑아올 덱 (cardId 문자열 배열). 게임 시작 시 dealHandsToRoom()에서 채워짐.
    // 카드를 한 장 쓸 때마다 여기서 한 장을 뽑아 손패를 항상 5장으로 유지함 (6단계, 2026-08-25 추가)
    this.deck = [];

    // 다중 대상 공격(흙먼지폭풍 등) 진행 중일 때 남은 대상을 담아두는 큐 (8단계 Phase 3, 2026-08-26)
    // { attackerSocketId, cardId, cost, element, attackPower, attackTerrainBonus, armorPiercing,
    //   lifestealPercent, healOnUse, appliedStatuses, remainingTargets: [socketId, ...] } | null
    this.pendingMultiTarget = null;
  }

  // 플레이어 추가
  addPlayer(socketId, nickname) {
    this.players.push({
      socketId,
      nickname,
      hp: 100,
      maxHp: 100,
      isAlive: true,
      hand: [], // { instanceId, cardId } 배열. 게임 시작 시 채워짐
      // 코스트는 "공격용"과 "방어용"이 서로 다른 자원 풀입니다 (전투 시스템 개편, 2026-08-25).
      // 게임 시작 시 resetAllCosts()로 채워짐
      attackCost: 0,
      maxAttackCost: 3, // 매 턴 지급되는 공격 코스트 (지금은 전원 고정 3)
      defenseCost: 0,
      maxDefenseCost: 3, // 매 턴 지급되는 방어 코스트 (지금은 전원 고정 3)
      // 지속상태 목록 (8단계 Phase 2, 2026-08-26 추가) - { type, amount, remainingTurns }
      // type: stun(기절)/attackLock(공격봉쇄)/defenseLock(방어봉쇄)/dot(화상)/attackBuff/defBuff
      // 같은 type이 여러 개 동시에 쌓일 수 있음(필드 효과처럼 인스턴스별로 따로 관리)
      statuses: [],
    });
  }

  // 플레이어 제거 (나가기/연결끊김)
  removePlayer(socketId) {
    this.players = this.players.filter((p) => p.socketId !== socketId);
  }

  getPlayer(socketId) {
    return this.players.find((p) => p.socketId === socketId);
  }

  isEmpty() {
    return this.players.length === 0;
  }

  // ---- 게임 시작: 턴 순서를 정하고 상태를 playing으로 전환 ----
  startGame() {
    this.status = "playing";
    // 지금은 단순하게 "입장한 순서 그대로" 턴 순서로 사용
    // (나중에 셔플하고 싶으면 여기서 배열을 섞으면 됩니다)
    this.turnOrder = this.players.map((p) => p.socketId);
    this.currentTurnIndex = 0;
    this.resetAllCosts();
  }

  // 전원의 공격/방어 코스트를 각각의 max값으로 리셋.
  // 설계 결정: "턴이 바뀔 때마다" 리셋하되, "지금 턴인 사람만"이 아니라 "전원"을 리셋합니다.
  // - 방어 코스트: 방어는 자기 턴이 아닐 때도 발생하므로, 상대 턴에 방어할 때도 이번 턴에 채워진
  //   방어 코스트를 쓸 수 있어야 합니다.
  // - 공격 코스트: 어차피 공격은 자기 턴에만 쓸 수 있어서(게임 로직상 막혀있음) 전원을 리셋해도
  //   무해하고, 로직을 하나로 통일할 수 있어 더 단순합니다.
  // 8단계 Phase 3(2026-08-26): 정기서린땅 등으로 얻은 maxAttackCostBuff 상태가 있으면
  // 기본 maxAttackCost에 더해서 채워줌 (base 값 자체는 건드리지 않고, 매번 다시 계산함)
  resetAllCosts() {
    this.players.forEach((p) => {
      p.attackCost = p.maxAttackCost + this.getStatusTotal(p.socketId, "maxAttackCostBuff");
      p.defenseCost = p.maxDefenseCost;
    });
  }

  // 공격 코스트를 amount만큼 소모. 부족하면 false를 반환하고 아무 것도 하지 않음
  spendAttackCost(socketId, amount) {
    const player = this.getPlayer(socketId);
    if (!player || player.attackCost < amount) return false;
    player.attackCost -= amount;
    return true;
  }

  // 방어 코스트를 amount만큼 소모. 부족하면 false를 반환하고 아무 것도 하지 않음
  spendDefenseCost(socketId, amount) {
    const player = this.getPlayer(socketId);
    if (!player || player.defenseCost < amount) return false;
    player.defenseCost -= amount;
    return true;
  }

  // 현재 턴인 사람의 socketId 반환
  getCurrentTurnSocketId() {
    return this.turnOrder[this.currentTurnIndex];
  }

  // 다음 턴으로 넘김 (죽은 사람은 건너뜀).
  // 8단계 Phase 2(2026-08-26): 기절(stun) 상태인 사람도 이 턴은 행동할 수 없으므로 건너뛰고,
  // 그 사람의 기절 남은 턴을 1 줄임(0 이하면 제거). 기절은 다른 지속상태(attackLock/defenseLock/
  // dot/버프)와 달리 "전역 턴마다 차감"이 아니라 "그 사람 차례에 도달했을 때만" 소모되는데,
  // 안 그러면 애초에 턴을 건너뛴다는 효과 자체가 성립하지 않기 때문 (tickPlayerStatuses()는
  // stun을 건드리지 않고 그냥 지나감 - 그쪽 설명 참고).
  // 건너뛴 사람 목록을 반환({ socketId, remainingTurns }[]) - 호출부에서 로그/방송에 사용
  advanceTurn() {
    const total = this.turnOrder.length;
    if (total === 0) return [];

    const skipped = [];
    let nextIndex = this.currentTurnIndex;
    for (let i = 0; i < total; i++) {
      nextIndex = (nextIndex + 1) % total;
      const candidateId = this.turnOrder[nextIndex];
      const candidatePlayer = this.getPlayer(candidateId);
      if (!candidatePlayer || !candidatePlayer.isAlive) continue; // 죽은/나간 사람은 그냥 건너뜀

      const stunIndex = candidatePlayer.statuses.findIndex((s) => s.type === "stun");
      if (stunIndex !== -1) {
        const stun = candidatePlayer.statuses[stunIndex];
        stun.remainingTurns -= 1;
        skipped.push({ socketId: candidatePlayer.socketId, remainingTurns: stun.remainingTurns });
        if (stun.remainingTurns <= 0) candidatePlayer.statuses.splice(stunIndex, 1);
        continue; // 기절 상태라 이번 차례는 주지 않고 계속 다음 후보를 찾음
      }

      this.currentTurnIndex = nextIndex;
      this.resetAllCosts();
      return skipped;
    }
    return skipped; // 전원이 죽었거나 기절 상태인 극단적인 경우 (기존에도 처리 안 하던 엣지케이스)
  }

  // ---- 카드 인스턴스 id 발급 (1씩 증가) ----
  _nextInstanceId() {
    this.instanceCounter += 1;
    return this.instanceCounter;
  }

  // 해당 플레이어의 손패를 cardId 배열로 통째로 세팅 (게임 시작 시 랜덤 분배용)
  // instanceId는 여기서 자동으로 붙여줌
  setHand(socketId, cardIds) {
    const player = this.getPlayer(socketId);
    if (!player) return;
    player.hand = cardIds.map((cardId) => ({
      instanceId: `${cardId}-${this._nextInstanceId()}`,
      cardId,
    }));
  }

  // 손패에서 카드 한 장을 instanceId로 찾아서 제거하고, 제거한 카드를 반환 (없으면 null)
  removeCardFromHand(socketId, instanceId) {
    const player = this.getPlayer(socketId);
    if (!player) return null;
    const index = player.hand.findIndex((c) => c.instanceId === instanceId);
    if (index === -1) return null;
    const [removed] = player.hand.splice(index, 1);
    return removed;
  }

  // ---- 덱 / 카드 뽑기 ----
  // 덱 전체를 교체 (게임 시작 시 초기 세팅, 또는 덱이 바닥나서 재보충할 때 사용)
  setDeck(cardIds) {
    this.deck = cardIds;
  }

  // 덱 맨 위에서 카드 하나를 뽑아 지정한 플레이어의 손패에 추가.
  // 덱이 비어있으면 아무 것도 하지 않고 null 반환 (재보충은 호출하는 쪽 책임 - gameHandlers.js)
  drawCardForPlayer(socketId) {
    if (this.deck.length === 0) return null;
    const cardId = this.deck.pop();
    const player = this.getPlayer(socketId);
    if (!player) return null;
    const card = { instanceId: `${cardId}-${this._nextInstanceId()}`, cardId };
    player.hand.push(card);
    return card;
  }

  // ---- 방어 대기 상태 관리 ----
  // data.appliedDefenses는 이번 방어 판정 동안 낸 방어 카드들을 순서대로 쌓아두는 배열입니다.
  // (2026-08-27: 방어자가 한 번의 방어에 여러 장을 낼 수 있게 되면서 추가됨)
  // data.appliedStatuses는 이번 전투 중 CC/DoT/버프가 누구에게 부여됐는지 쌓아두는 배열입니다.
  // (8단계 Phase 2, 2026-08-26 추가 - 로그/방송용. 상태 자체는 addStatus()로 이미 즉시 적용되어 있음)
  setPendingDefense(data) {
    this.pendingDefense = { appliedDefenses: [], appliedStatuses: [], ...data };
  }

  clearPendingDefense() {
    this.pendingDefense = null;
  }

  // 지금 진행 중인 방어 판정에 방어 카드 한 장의 결과를 추가로 쌓음
  addAppliedDefense(entry) {
    if (!this.pendingDefense) return;
    this.pendingDefense.appliedDefenses.push(entry);
  }

  // 지금 진행 중인 전투에 새로 부여된 상태 하나를 기록 (로그/방송용)
  addAppliedStatus(entry) {
    if (!this.pendingDefense) return;
    this.pendingDefense.appliedStatuses.push(entry);
  }

  // ---- 다중 대상 공격 큐 (8단계 Phase 3, 2026-08-26) ----
  // 흙먼지폭풍 등 여러 명을 동시에 대상으로 하는 공격 카드를 순차적으로 처리하기 위한 큐.
  // 기존 단일 대상 공격→방어→finalizeDefense 사이클을 대상 한 명씩 재사용하는 방식이라
  // pendingDefense와는 별개로 "이번 카드로 아직 안 맞은 사람들"만 여기 담아둠
  setMultiTargetQueue(data) {
    this.pendingMultiTarget = { ...data };
  }

  // 큐에서 다음 대상을 하나 꺼냄 (없으면 null)
  popNextMultiTarget() {
    if (!this.pendingMultiTarget || this.pendingMultiTarget.remainingTargets.length === 0) return null;
    return this.pendingMultiTarget.remainingTargets.shift();
  }

  hasMoreMultiTargets() {
    return !!this.pendingMultiTarget && this.pendingMultiTarget.remainingTargets.length > 0;
  }

  clearMultiTargetQueue() {
    this.pendingMultiTarget = null;
  }

  // HP를 amount만큼 깎고, 0 이하가 되면 사망 처리. 변경된 플레이어를 반환
  applyDamage(socketId, amount) {
    const player = this.getPlayer(socketId);
    if (!player) return null;
    player.hp = Math.max(0, player.hp - amount);
    if (player.hp === 0) {
      player.isAlive = false;
    }
    return player;
  }

  getAlivePlayers() {
    return this.players.filter((p) => p.isAlive);
  }

  // HP를 amount만큼 회복시킴 (maxHp 초과 불가). 이미 죽은 사람은 회복해도 되살아나지 않도록 무시함
  // (8단계 Phase 1, 2026-08-26 — 흡혈/고정회복/방어 성공 시 회복 카드에서 사용)
  healPlayer(socketId, amount) {
    const player = this.getPlayer(socketId);
    if (!player || !player.isAlive || amount <= 0) return player;
    player.hp = Math.min(player.maxHp, player.hp + amount);
    return player;
  }

  // ---- 지속상태 (CC/DoT/버프디버프) - 8단계 Phase 2, 2026-08-26 추가 ----
  // 상태 하나를 추가 (같은 type이 여러 개 쌓여도 됨 - 필드 효과와 같은 방식)
  addStatus(socketId, status) {
    const player = this.getPlayer(socketId);
    if (!player) return;
    player.statuses.push({ ...status });
  }

  // 특정 type의 상태가 하나라도 활성 상태인지 (attackLock/defenseLock/stun 체크용)
  hasActiveStatus(socketId, type) {
    const player = this.getPlayer(socketId);
    return !!player && player.statuses.some((s) => s.type === type);
  }

  // 특정 type의 상태들의 amount 합산 (attackBuff/defBuff 계산용)
  getStatusTotal(socketId, type) {
    const player = this.getPlayer(socketId);
    if (!player) return 0;
    return player.statuses
      .filter((s) => s.type === type)
      .reduce((sum, s) => sum + s.amount, 0);
  }

  // 턴이 넘어갈 때 호출: dot(화상) 상태는 데미지를 주고, stun을 제외한 모든 상태의 남은 턴을
  // 1씩 줄인 뒤 0 이하가 된 상태는 제거함. stun은 advanceTurn()이 그 사람 차례에 도달했을 때만
  // 소모하므로 여기서는 건드리지 않음(그대로 두면 필터 조건(remainingTurns > 0)에 걸려도 살아남음).
  // 화상으로 입은 피해 목록을 반환 (호출한 쪽에서 로그 방송용으로 사용)
  tickPlayerStatuses() {
    const dotTicks = [];
    this.players.forEach((p) => {
      p.statuses.forEach((s) => {
        if (s.type === "stun") return; // 기절은 advanceTurn()에서만 차감됨
        if (s.type === "dot" && p.isAlive) {
          this.applyDamage(p.socketId, s.amount);
          dotTicks.push({ socketId: p.socketId, damage: s.amount, remainingTurns: s.remainingTurns - 1 });
        }
        s.remainingTurns -= 1;
      });
      p.statuses = p.statuses.filter((s) => s.remainingTurns > 0);
    });
    return dotTicks;
  }

  // ---- 필드: 지형 ----
  // 지형 카드 설치. 슬롯이 1개뿐이라 기존 지형은 그냥 덮어써짐 (중첩 불가 규칙)
  setTerrain(terrainInfo) {
    this.terrain = terrainInfo; // { cardId, element, synergyBonus }
  }

  // cardElement 속성의 카드가 지금 깔린 지형의 보너스를 받는지 확인.
  // 지형은 "자기 자신과 같은 속성"이거나 "자기가 상생하는 속성"의 카드를 강화함
  // (7단계 카드 설계 개편, 2026-08-27 — 기존에는 상생 대상만 강화했으나, 새 지형 카드들이
  //  "자기 속성 + 상생 대상 속성"을 동시에 강화하는 걸로 설계돼서 기존 지형 카드도 같이 확장 적용됨)
  // 받으면 보너스 수치를, 안 받으면(지형이 없거나 둘 다 아니면) 0을 반환
  getTerrainSynergyBonus(cardElement) {
    if (!this.terrain) return 0;
    const boostedElement = GENERATE_MAP[this.terrain.element];
    if (cardElement === this.terrain.element || cardElement === boostedElement) {
      return this.terrain.synergyBonus;
    }
    return 0;
  }

  // 지형의 코스트 감면 확인 (8단계 Phase 3, 2026-08-26 — 이슬맺힌안개숲 등).
  // 상생 대상까지는 확장하지 않음 - 카드 설명이 "같은 속성"만 명시하고 있음
  getTerrainCostReduction(cardElement) {
    if (!this.terrain || cardElement !== this.terrain.element) return 0;
    return this.terrain.costReduction || 0;
  }

  // 필드효과의 코스트 감면 합산 (8단계 Phase 3, 2026-08-26 — 청량한안개 등).
  // 필드 카드는 전원에게 공평하게 적용된다는 기존 원칙대로, 대상을 가리지 않고 element만 일치하면 적용됨
  getEffectCostReduction(cardElement) {
    return this.effects
      .filter((e) => e.element === cardElement)
      .reduce((sum, e) => sum + (e.costReductionAmount || 0), 0);
  }

  // 필드효과의 공격력 보너스 합산 (8단계 Phase 3, 2026-08-26 — 작열의기운 등).
  // 지형 synergyBonus와 비슷하지만 상생 대상까지는 확장하지 않음 - 카드 설명이 "같은 속성"만 명시.
  // 전원에게 공평하게 적용되는 원칙은 동일함
  getEffectDamageBonus(cardElement) {
    return this.effects
      .filter((e) => e.element === cardElement)
      .reduce((sum, e) => sum + (e.damageBonusAmount || 0), 0);
  }

  // ---- 필드: 효과 ----
  // 효과 카드 추가 (누적형이라 기존 효과는 그대로 두고 새로 추가만 함)
  addEffect(effectInfo) {
    this.effects.push(effectInfo); // { instanceId, cardId, element, tickDamage, remainingTurns }
  }

  // 턴이 넘어갈 때 호출: 모든 효과를 한 번씩 발동시켜 생존자 전원에게 피해를 주고,
  // 남은 턴 수를 하나씩 줄인 뒤 0이 된 효과는 제거함.
  // 무엇이 발동됐는지 목록을 반환 (호출한 쪽에서 브로드캐스트용으로 사용)
  tickEffects() {
    const ticked = [];
    this.effects.forEach((eff) => {
      const affectedSocketIds = [];
      this.players.forEach((p) => {
        if (p.isAlive) {
          this.applyDamage(p.socketId, eff.tickDamage);
          affectedSocketIds.push(p.socketId);
        }
      });
      ticked.push({ cardId: eff.cardId, cardName: eff.cardName, tickDamage: eff.tickDamage, affectedSocketIds });
      eff.remainingTurns -= 1;
    });
    this.effects = this.effects.filter((eff) => eff.remainingTurns > 0);
    return ticked;
  }

  // 클라이언트에게 보내도 안전한 정보만 추려서 반환
  // (나중에 손패처럼 "본인만 봐야 하는 정보"가 생기면 이 함수를 손봐야 합니다)
  toPublicView() {
    return {
      roomId: this.roomId,
      hostSocketId: this.hostSocketId,
      status: this.status,
      players: this.players.map((p) => ({
        socketId: p.socketId,
        nickname: p.nickname,
        hp: p.hp,
        maxHp: p.maxHp,
        isAlive: p.isAlive,
        // 카드 내용은 비공개, 장수만 공개 (상대 손패가 몇 장인지는 다들 볼 수 있게)
        handCount: p.hand.length,
        // 코스트는 대부분의 카드 게임에서 마나처럼 공개 정보이므로 그대로 노출
        attackCost: p.attackCost,
        // maxAttackCostBuff 등으로 실제로 늘어난 값을 그대로 노출 (8단계 Phase 3, 2026-08-26)
        // - 안 그러면 클라이언트 코스트 점(pip) 렌더링이 attackCost > maxAttackCost로 어긋남
        maxAttackCost: p.maxAttackCost + this.getStatusTotal(p.socketId, "maxAttackCostBuff"),
        defenseCost: p.defenseCost,
        maxDefenseCost: p.maxDefenseCost,
        // 지속상태(기절/봉쇄/화상/버프)도 전원에게 공개되는 정보 (8단계 Phase 2, 2026-08-26)
        statuses: p.statuses.map((s) => ({ type: s.type, amount: s.amount, remainingTurns: s.remainingTurns })),
      })),
      // 게임 중일 때만 의미있는 값이지만, 항상 같이 내려줘도 무방
      currentTurnSocketId: this.status === "playing" ? this.getCurrentTurnSocketId() : null,
      // 공격 카드는 이미 공개적으로 사용된 것이므로 누가 누구를 공격 중인지는 전원에게 공개
      pendingDefense: this.pendingDefense,
      // 필드 상태도 전원에게 공평하게 적용되는 공개 정보
      terrain: this.terrain,
      effects: this.effects.map((e) => ({
        cardId: e.cardId,
        cardName: e.cardName,
        tickDamage: e.tickDamage,
        remainingTurns: e.remainingTurns,
        // 카드 설명을 그대로 보여줘서, 종류가 늘어도 클라이언트가 문구를 직접 조립할 필요가 없게 함
        // (8단계 Phase 3, 2026-08-26)
        description: e.description,
      })),
    };
  }
}

module.exports = Room;
