// Room.js
// 방(대전) 하나의 상태를 담는 클래스입니다.
// Java로 치면 그냥 필드 + 생성자만 있는 간단한 클래스라고 생각하시면 됩니다.
// DB에 저장하지 않고, 서버가 켜져있는 동안 메모리(RAM)에만 존재합니다.

const { GENERATE_MAP } = require("./elementTable");

// 코스트 점(pip) UI가 감당할 수 있는 상한. 공격 코스트는 2026-08-28 개편으로 매 턴 "초기화"되지
// 않고 안 쓴 만큼 계속 쌓이는데(아래 rechargeAttackCostsForRound 참고), 아무리 안 써도 이 값을 넘지
// 못하게 막음. 정기서린땅 같은 "충전량 증가" 효과가 겹쳐도 마찬가지 (개발자 요청, 2026-08-27 / 2026-08-28)
const MAX_COST_CAP = 7;

// 공격 코스트 재충전량 (2026-08-28 개편 / 2026-08-29 라운드 단위로 조정). 예전에는 매 턴
// maxAttackCost(3)로 통째로 초기화됐지만, 이제는 안 쓴 코스트가 이월되고 "전체 턴 순서가 한
// 바퀴 돌 때마다" 전원에게 이만큼씩만 충전됩니다(rechargeAttackCostsForRound 참고).
// 정기서린땅(maxAttackCostBuff 상태)이 걸려 있으면 그 수치만큼 충전량이 더 늘어납니다.
const ATTACK_COST_RECHARGE_PER_TURN = 1;

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

    // 공격 코스트 충전용 "라운드" 카운터 (2026-08-29). advanceTurn()이 턴 순서를 몇 칸
    // 지나왔는지 누적하다가, turnOrder.length 만큼(= 전체 순서가 한 바퀴) 채워지면 그때
    // 전원의 공격 코스트를 충전하고 이 값을 0으로 되돌립니다. (기절로 건너뛴 칸도 한 칸으로 셈)
    this.turnStepCount = 0;

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
  // token: 재접속(reconnect) 판별용 비밀 값 (재접속 처리, 2026-08-27 추가). 클라이언트가
  // localStorage에 저장해뒀다가 재접속 시 다시 보내줌 - socket.id는 재연결마다 바뀌지만
  // token은 브라우저에 남아있는 한 그대로라서, "같은 사람이 돌아왔다"를 판별하는 열쇠로 씀.
  // 절대로 다른 플레이어에게 공개되면 안 됨(toPublicView()에 포함시키지 않도록 주의)
  addPlayer(socketId, nickname, token) {
    this.players.push({
      socketId,
      nickname,
      token,
      connected: true, // 재접속 처리(2026-08-27): 지금 이 사람이 실제로 연결되어 있는지
      hp: 100,
      maxHp: 100,
      isAlive: true,
      hand: [], // { instanceId, cardId } 배열. 게임 시작 시 채워짐
      // 코스트는 "공격용"과 "방어용"이 서로 다른 자원 풀입니다 (전투 시스템 개편, 2026-08-25).
      // - 방어 코스트: 매 턴 maxDefenseCost로 통째로 초기화됨 (안 쓰면 사라짐)
      // - 공격 코스트: 개편(2026-08-28~29)으로 "초기화"가 아니라 "누적 + 라운드마다 소량 충전"으로 바뀜.
      //   안 쓴 코스트는 이월되고, 전체 턴 순서가 한 바퀴 돌 때마다 전원에게 ATTACK_COST_RECHARGE_PER_TURN
      //   (+ maxAttackCostBuff)만큼만 충전되며 MAX_COST_CAP을 넘지 않음. 게임 시작 시 값은 maxAttackCost.
      attackCost: 0, // initCosts()에서 maxAttackCost로 채워짐
      maxAttackCost: 3, // 게임 시작 시 지급되는 공격 코스트(기준값). 이후엔 이 값으로 리셋되는 게 아니라 위 설명대로 충전됨
      defenseCost: 0, // 매 턴 maxDefenseCost로 초기화됨
      maxDefenseCost: 3, // 매 턴 지급되는 방어 코스트 (지금은 전원 고정 3)
      // 지속상태 목록 (8단계 Phase 2, 2026-08-26 추가) - { type, amount, remainingTurns }
      // type: stun(기절)/attackLock(공격봉쇄)/defenseLock(방어봉쇄)/dot(화상)/attackBuff/defBuff
      // 같은 type이 여러 개 동시에 쌓일 수 있음(필드 효과처럼 인스턴스별로 따로 관리)
      statuses: [],
      // 손패 시스템 개편(2026-08-27): 손패가 이미 최대치(MAX_HAND_SIZE)일 때 새 카드를 뽑으면,
      // 바로 손패에 넣는 대신 여기 잠깐 보관해두고 본인이 "어떤 카드와 바꿀지"(또는 안 바꿀지)
      // 정할 때까지 기다립니다. { instanceId, cardId } | null
      pendingSwapCard: null,
    });
  }

  // token으로 플레이어 찾기 (재접속 시 "이 사람이 누구였는지" 알아낼 때 씀)
  findPlayerByToken(token) {
    if (!token) return null;
    return this.players.find((p) => p.token === token) || null;
  }

  // 연결이 끊긴 것으로 표시만 함 (removePlayer처럼 배열에서 빼지는 않음 - 손패/HP/턴 순서를
  // 그대로 보존해뒀다가 재접속하면 이어서 할 수 있도록). 방어 대기 등은 건드리지 않고, 호출하는
  // 쪽(roomHandlers.js)이 유예시간 타이머를 관리함
  markDisconnected(socketId) {
    const player = this.getPlayer(socketId);
    if (player) player.connected = false;
  }

  markConnected(socketId) {
    const player = this.getPlayer(socketId);
    if (player) player.connected = true;
  }

  // 재접속 성공 시: 예전 socket.id를 가리키던 모든 자리를 새 socket.id로 바꿔치기.
  // socket.id는 연결마다 새로 발급되는 값이라, 재접속하면 이 방 상태 곳곳(턴 순서, 방장,
  // 진행 중인 공격/방어 대상)에 남아있는 "옛 주소"를 전부 "새 주소"로 갱신해줘야 함
  reassignSocketId(oldSocketId, newSocketId) {
    const player = this.getPlayer(oldSocketId);
    if (!player) return null;
    player.socketId = newSocketId;
    player.connected = true;

    if (this.hostSocketId === oldSocketId) this.hostSocketId = newSocketId;

    this.turnOrder = this.turnOrder.map((id) => (id === oldSocketId ? newSocketId : id));

    if (this.pendingDefense) {
      if (this.pendingDefense.attackerSocketId === oldSocketId) {
        this.pendingDefense.attackerSocketId = newSocketId;
      }
      if (this.pendingDefense.defenderSocketId === oldSocketId) {
        this.pendingDefense.defenderSocketId = newSocketId;
      }
    }

    if (this.pendingMultiTarget) {
      if (this.pendingMultiTarget.attackerSocketId === oldSocketId) {
        this.pendingMultiTarget.attackerSocketId = newSocketId;
      }
      this.pendingMultiTarget.remainingTargets = this.pendingMultiTarget.remainingTargets.map((id) =>
        id === oldSocketId ? newSocketId : id
      );
    }

    return player;
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
    this.turnStepCount = 0;
    this.initCosts();
  }

  // ---- 다시 시작 (재시작 기능, 2026-08-27) ----
  // 게임이 끝난 뒤 같은 방(같은 플레이어들)으로 새 게임을 하고 싶을 때 씀. 대기실 상태로
  // 되돌리고 방/플레이어 목록은 그대로 둔 채, 지난 게임에서 쌓인 상태(HP, 손패, 코스트, 지속상태,
  // 필드, 턴 순서 등)만 전부 처음 값으로 리셋합니다. 이후 startGame()을 다시 호출하면
  // (gameHandlers.js의 game:start가 그대로 재사용됨) 새 덱을 셔플해서 손패를 새로 나눠줍니다.
  resetForNewGame() {
    this.status = "waiting";
    this.turnOrder = [];
    this.currentTurnIndex = 0;
    this.turnStepCount = 0;
    this.pendingDefense = null;
    this.pendingMultiTarget = null;
    this.terrain = null;
    this.effects = [];
    this.deck = [];
    this.winnerNickname = null;

    this.players.forEach((p) => {
      p.hp = p.maxHp;
      p.isAlive = true;
      p.hand = [];
      p.statuses = [];
      p.pendingSwapCard = null;
      p.attackCost = 0;
      p.maxAttackCost = 3;
      p.defenseCost = 0;
      p.maxDefenseCost = 3;
    });
  }

  // 게임 시작 시 전원의 코스트를 기준값(maxAttackCost / maxDefenseCost)으로 채움.
  // startGame()에서 한 번만 호출됩니다. 이후 턴마다의 처리는 resetDefenseCostsForNewTurn()과
  // rechargeAttackCostsForRound()가 담당합니다.
  initCosts() {
    this.players.forEach((p) => {
      p.attackCost = Math.min(MAX_COST_CAP, p.maxAttackCost);
      p.defenseCost = Math.min(MAX_COST_CAP, p.maxDefenseCost);
    });
  }

  // 매 턴 전환마다 advanceTurn()에서 호출 — 방어 코스트만 "전원" maxDefenseCost로 통째로
  // 초기화합니다. 방어는 자기 턴이 아닐 때도 발생하므로, 상대 턴에 방어할 때도 이번 턴에 채워진
  // 방어 코스트를 쓸 수 있어야 하기 때문입니다. (공격 코스트는 여기서 건드리지 않습니다.)
  resetDefenseCostsForNewTurn() {
    this.players.forEach((p) => {
      p.defenseCost = Math.min(MAX_COST_CAP, p.maxDefenseCost);
    });
  }

  // 전체 턴 순서가 한 바퀴 돈 뒤에만 advanceTurn()에서 호출 (2026-08-29 변경).
  // 예전(2026-08-28)에는 "자기 턴이 시작될 때 그 사람만" 충전했지만, 이제는 한 라운드가 끝나는
  // 시점에 "전원 동시에" ATTACK_COST_RECHARGE_PER_TURN(+ 각자의 maxAttackCostBuff 합계)만큼
  // 충전합니다. 안 쓴 공격 코스트는 다음 라운드로 이월되며 MAX_COST_CAP을 넘지 않습니다.
  rechargeAttackCostsForRound() {
    this.players.forEach((p) => {
      const amount =
        ATTACK_COST_RECHARGE_PER_TURN + this.getStatusTotal(p.socketId, "maxAttackCostBuff");
      p.attackCost = Math.min(MAX_COST_CAP, p.attackCost + amount);
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

      // 방어 코스트는 매 턴 전원 리셋 (기존과 동일)
      this.resetDefenseCostsForNewTurn();

      // 공격 코스트는 "전체 순서가 한 바퀴 돈" 뒤에만 전원 충전 (2026-08-29 변경).
      // 이번 advanceTurn이 턴 순서에서 몇 칸(i+1, 건너뛴 칸 포함) 지나왔는지 누적하다가,
      // total(turnOrder 길이)만큼 채워지면 한 라운드가 끝난 것으로 보고 전원 충전 후 0으로 되돌림.
      this.turnStepCount += i + 1;
      if (this.turnStepCount >= total) {
        this.turnStepCount %= total; // 건너뜀 때문에 딱 안 떨어지고 넘칠 수 있어 나머지는 이월
        this.rechargeAttackCostsForRound();
      }
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

  // 손패 시스템 개편(2026-08-27): 손패가 이미 가득 찼을 때(MAX_HAND_SIZE) 카드를 뽑으면 바로
  // 손패에 넣지 않고 pendingSwapCard에 잠깐 보관해둠. drawCardForPlayer와 거의 똑같지만
  // "손패에 push" 대신 "pendingSwapCard에 저장"만 다름
  drawCardToPending(socketId) {
    if (this.deck.length === 0) return null;
    const player = this.getPlayer(socketId);
    if (!player) return null;
    const cardId = this.deck.pop();
    const card = { instanceId: `${cardId}-${this._nextInstanceId()}`, cardId };
    player.pendingSwapCard = card;
    return card;
  }

  // pendingSwapCard에 대한 본인의 결정을 반영함.
  // replaceInstanceId가 있으면: 손패에서 그 카드를 빼고 그 자리에 pendingSwapCard를 넣음(교체).
  // replaceInstanceId가 없으면(변경하지 않음): 그냥 pendingSwapCard를 버림 - 손패는 그대로 유지.
  // 성공적으로 처리됐으면 true, pendingSwapCard가 없었거나 instanceId를 못 찾았으면 false
  resolveHandSwap(socketId, replaceInstanceId) {
    const player = this.getPlayer(socketId);
    if (!player || !player.pendingSwapCard) return false;

    if (replaceInstanceId) {
      const index = player.hand.findIndex((c) => c.instanceId === replaceInstanceId);
      if (index === -1) return false; // 잘못된 instanceId - 제안은 그대로 두고 아무 일도 안 함
      player.hand.splice(index, 1, player.pendingSwapCard);
    }

    player.pendingSwapCard = null;
    return true;
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
        connected: p.connected, // 재접속 처리(2026-08-27): 잠깐 끊긴 상태면 false - 다른 사람 화면에 배지로 표시됨
        hp: p.hp,
        maxHp: p.maxHp,
        isAlive: p.isAlive,
        // 카드 내용은 비공개, 장수만 공개 (상대 손패가 몇 장인지는 다들 볼 수 있게)
        handCount: p.hand.length,
        // 코스트는 대부분의 카드 게임에서 마나처럼 공개 정보이므로 그대로 노출
        attackCost: p.attackCost,
        // 공격 코스트는 개편(2026-08-28~29)으로 라운드마다 쌓일 수 있음(최대 MAX_COST_CAP). pip 개수로는
        // "현재 보유량"과 기준값(maxAttackCost) 중 큰 쪽을 씀 - 쌓인 코스트가 다 보이면서도,
        // 다 썼을 땐 최소 기준값(3)만큼의 빈 pip이 남아 레이아웃이 덜 흔들림.
        // maxAttackCostBuff(정기서린땅)는 이제 "충전량"을 늘리는 것이지 상한을 늘리는 게 아니라 여기 안 더함
        maxAttackCost: Math.min(MAX_COST_CAP, Math.max(p.attackCost, p.maxAttackCost)),
        defenseCost: p.defenseCost,
        maxDefenseCost: Math.min(MAX_COST_CAP, p.maxDefenseCost),
        // 지속상태(기절/봉쇄/화상/버프)도 전원에게 공개되는 정보 (8단계 Phase 2, 2026-08-26)
        statuses: p.statuses.map((s) => ({ type: s.type, amount: s.amount, remainingTurns: s.remainingTurns })),
      })),
      // 게임 중일 때만 의미있는 값이지만, 항상 같이 내려줘도 무방
      currentTurnSocketId: this.status === "playing" ? this.getCurrentTurnSocketId() : null,
      // 게임 종료 후 재접속한 사람도 결과를 알 수 있도록 (재접속 처리, 2026-08-27) - status가
      // "ended"가 아니면 항상 null
      winnerNickname: this.status === "ended" ? this.winnerNickname || null : null,
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
        // 클라이언트가 손패 카드의 "현재 코스트/위력 변동분"을 직접 계산해 금색으로 표시하기 위해
        // 필요한 값들 (2026-08-29). 해당 효과가 아니면 0
        element: e.element,
        damageBonusAmount: e.damageBonusAmount || 0,
        costReductionAmount: e.costReductionAmount || 0,
      })),
    };
  }
}

module.exports = Room;
