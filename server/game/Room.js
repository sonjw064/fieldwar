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
  resetAllCosts() {
    this.players.forEach((p) => {
      p.attackCost = p.maxAttackCost;
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

  // 다음 턴으로 넘김 (죽은/나간 사람은 건너뛰도록 구조만 잡아둠)
  advanceTurn() {
    const total = this.turnOrder.length;
    if (total === 0) return;

    let nextIndex = this.currentTurnIndex;
    for (let i = 0; i < total; i++) {
      nextIndex = (nextIndex + 1) % total;
      const candidateId = this.turnOrder[nextIndex];
      const candidatePlayer = this.getPlayer(candidateId);
      // 살아있는 플레이어를 찾을 때까지 건너뜀 (지금은 전원 isAlive=true라 바로 걸림)
      if (candidatePlayer && candidatePlayer.isAlive) {
        this.currentTurnIndex = nextIndex;
        this.resetAllCosts();
        return;
      }
    }
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
  setPendingDefense(data) {
    this.pendingDefense = { appliedDefenses: [], ...data };
  }

  clearPendingDefense() {
    this.pendingDefense = null;
  }

  // 지금 진행 중인 방어 판정에 방어 카드 한 장의 결과를 추가로 쌓음
  addAppliedDefense(entry) {
    if (!this.pendingDefense) return;
    this.pendingDefense.appliedDefenses.push(entry);
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
        maxAttackCost: p.maxAttackCost,
        defenseCost: p.defenseCost,
        maxDefenseCost: p.maxDefenseCost,
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
      })),
    };
  }
}

module.exports = Room;
