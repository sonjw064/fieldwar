// main.js
// 브라우저에서 실행되는 코드입니다.
// 서버에 이벤트를 "보내고(emit)", 서버가 보내는 이벤트를 "받아서(on)" 화면을 갱신합니다.

const socket = io(); // 지금 열려있는 주소로 자동 연결됨 (예: http://localhost:3000)

// ---- 화면 요소 가져오기 ----
const appDiv = document.getElementById("app"); // 로비/대기실/게임종료 화면을 담는 좁은 폭 컨테이너
const lobbySection = document.getElementById("lobby");
const roomSection = document.getElementById("room");
const gameSection = document.getElementById("game"); // #app 밖에 있는 게임 보드 (좌상단/우상단/우하단/하단 레이아웃)

const nicknameInput = document.getElementById("nicknameInput");
const roomIdInput = document.getElementById("roomIdInput");
const createRoomBtn = document.getElementById("createRoomBtn");
const joinRoomBtn = document.getElementById("joinRoomBtn");
const errorMsg = document.getElementById("errorMsg");

const roomIdLabel = document.getElementById("roomIdLabel");
const playerList = document.getElementById("playerList");
const startGameBtn = document.getElementById("startGameBtn");

const turnLabel = document.getElementById("turnLabel");
const endTurnBtn = document.getElementById("endTurnBtn");

const myStatusCard = document.getElementById("myStatusCard"); // 좌상단: 내 HP/코스트
const opponentsPanel = document.getElementById("opponentsPanel"); // 우상단: 상대들 HP/코스트
const terrainSlot = document.getElementById("terrainSlot"); // 좌상단: 현재 지형
const effectsSlot = document.getElementById("effectsSlot"); // 좌상단: 현재 효과 목록
const combatLog = document.getElementById("combatLog");
const handArea = document.getElementById("handArea"); // 하단: 내 손패 (부채꼴)

const defenseBanner = document.getElementById("defenseBanner"); // 방어 요청 안내 배너 (더 이상 팝업 아님)
const defenseInfo = document.getElementById("defenseInfo");
const confirmDefenseBtn = document.getElementById("confirmDefenseBtn"); // 우하단: 고른 방어 카드 사용 확정
const cancelDefenseBtn = document.getElementById("cancelDefenseBtn"); // 좌하단: 방어 카드 선택 취소(로컬)

const gameOverSection = document.getElementById("gameOver");
const winnerLabel = document.getElementById("winnerLabel");
const playAgainBtn = document.getElementById("playAgainBtn"); // 재시작(2026-08-27 추가) - 방장에게만 보임
const playAgainHint = document.getElementById("playAgainHint"); // 방장이 아닌 사람에게 보이는 안내 문구

const connectionBanner = document.getElementById("connectionBanner");

const castOverlay = document.getElementById("castOverlay"); // 지형/효과 카드 미리보기(클릭해서 확정)
const castCard = document.getElementById("castCard");

const combatOverlay = document.getElementById("combatOverlay"); // 공격/방어 카드가 겹쳐 보이는 전투 연출 (전원 공통)
const combatStack = document.getElementById("combatStack");
const combatResultNumber = document.getElementById("combatResultNumber"); // 전투 결과 수치("-12" / "방어함") 큰 글씨 (2026-08-29)

const handSwapOverlay = document.getElementById("handSwapOverlay"); // 손패 교체(2026-08-27 추가) 안내용 오버레이
const handSwapNewCard = document.getElementById("handSwapNewCard"); // 왼쪽: 새로 뽑은 카드
const handSwapReplaceCard = document.getElementById("handSwapReplaceCard"); // 오른쪽: 바꿀 카드로 고른 것(없으면 빈 칸)
const handSwapDeclineBtn = document.getElementById("handSwapDeclineBtn"); // "변경하지 않음"
const handSwapClearBtn = document.getElementById("handSwapClearBtn"); // "선택 취소"
const handSwapConfirmBtn = document.getElementById("handSwapConfirmBtn"); // "교체하기"

// ---- 재접속(reconnect) 처리 (2026-08-27 추가) ----
// socket.id는 연결이 끊겼다 다시 붙을 때마다 매번 새로 발급되는 값이라, 서버 입장에서
// "아까 그 사람이 돌아왔다"를 알아볼 수가 없습니다. 그래서 브라우저에 영구적으로 저장되는
// 별도의 식별자(token)를 하나 만들어서, 방을 만들거나 들어갈 때마다 서버에 같이 보내줍니다.
// localStorage는 탭을 닫았다 열거나 새로고침해도 그대로 남아있어서(서버를 재시작해도 안 지워짐),
// "같은 브라우저"라는 걸 증명하는 열쇠로 쓸 수 있습니다.
const PLAYER_TOKEN_KEY = "fieldwar_playerToken";
const SESSION_KEY = "fieldwar_session"; // { roomId, nickname } - 지금 들어가 있는 방 정보

function getOrCreatePlayerToken() {
  let token = localStorage.getItem(PLAYER_TOKEN_KEY);
  if (!token) {
    // crypto.randomUUID()는 최신 브라우저면 다 있음 - 진짜 로그인이 아니라 그냥 "이 브라우저"를
    // 구분하기 위한 무작위 값이라 굳이 서버에서 발급받을 필요 없이 클라이언트에서 만들어도 안전함
    token = crypto.randomUUID();
    localStorage.setItem(PLAYER_TOKEN_KEY, token);
  }
  return token;
}

const playerToken = getOrCreatePlayerToken();

function saveSession(roomId, nickname) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ roomId, nickname }));
}

function loadSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null; // 저장된 값이 손상되어 있으면 그냥 없는 것으로 취급
  }
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

let myNickname = "";
let currentRoomId = "";
let currentHostSocketId = null; // 방장(2026-08-27 추가) - 게임 종료 화면에서 "다시 시작" 버튼을 방장에게만 보여주기 위해 기억해둠
let latestPlayers = []; // 닉네임/HP 표시용으로 마지막 방 상태를 기억해둠
let lastKnownTurnSocketId = null;
let myHand = []; // 카드 상세 정보가 포함된 내 손패 (game:handUpdated로 갱신됨)
let selectedAttackCardInstanceId = null; // 대상 선택 모드일 때, 지금 고른 공격 카드
let latestTerrain = null; // { cardId, element, synergyBonus } | null (room:updated로 갱신됨)
let latestEffects = []; // [{ cardId, remainingTurns }] (room:updated로 갱신됨)

// 전투 결과가 왔을 때 잠깐 재생할 "피격/방어" 애니메이션 정보.
// renderMyStatus()/renderOpponents()가 매번 DOM을 통째로 새로 그리기 때문에, 애니메이션용
// 클래스를 DOM에 직접 붙였다 떼는 대신 "지금 누구한테 어떤 효과를 보여줘야 하는지"를 여기
// 기억해뒀다가 두 함수가 카드를 그릴 때 참고하는 방식을 씁니다.
let pendingFlash = null; // { socketId, className, expiresAt }

// 공격이 나가서(game:attackAnnounced) 방어 결과가 확정될 때까지(game:combatResult) true.
// 전원의 화면에서 동시에 true가 되므로, 그 동안에는 (방어 중인 사람 본인을 제외하고) 새로 공격을
// 고르거나 다시 대상을 지정하는 걸 막습니다. (2026-08-27: 로컬 연출에서 서버 방송 기반으로 바뀜)
let isCasting = false;

// 서버로부터 game:defenseRequest를 받아서 "지금 내가 방어할 차례"인 동안 true.
// 이 동안에는 renderHand()가 방어 카드만 선택 가능하게(defendable) 바꿔줍니다 (더 이상 팝업 없음).
let isDefending = false;

// 지금 나에게 들어온 공격의 속성 (game:defenseRequest로 받음, game:combatResult에서 비움).
// 방어 카드가 이 속성을 상극하면 상극 보너스(+5)가 붙으므로, 손패의 방어력 표기를 금색으로
// 보정해서 보여주기 위해 기억해둠 (2026-08-29)
let pendingAttackElement = null;

// 방어하는 동안 지금까지 "선택"해둔(아직 서버에는 안 보낸) 방어 카드 instanceId 목록.
// "사용" 버튼을 눌러야 실제로 game:confirmDefense로 서버에 보내지고, "취소"를 누르면 그냥
// 이 목록만 비워집니다 (서버에는 아무 영향 없음 - 코스트가 부족해서 막힌 채 멈추는 문제를 피하기 위함)
let selectedDefenseCardIds = [];

// 손패 교체 (2026-08-27 추가): 서버로부터 game:handSwapOffered를 받으면 { card }로 채워짐
// (card는 새로 뽑았지만 아직 손패에 안 들어간 카드). null이면 교체 제안이 없는 평소 상태.
let pendingHandSwap = null;

// 손패 교체 중, 지금까지 "바꿀 카드"로 고른(아직 서버에는 안 보낸) 손패 카드의 instanceId.
// isDefending과 마찬가지로 로컬 선택만 해뒀다가 "교체하기"를 눌러야 서버에 반영됨
let selectedSwapReplaceInstanceId = null;

// 지형/효과 카드를 화면 중앙(#castOverlay)에 띄워놓고 "클릭해서 확정 / 바깥 클릭해서 취소"를
// 기다리는 중이면 { cardInstanceId }, 아니면 null. 나만 보는 로컬 UI라서 서버 방송과는 무관함
let pendingFieldCard = null;

// 다중 대상 공격 카드(흙먼지폭풍 등)를 화면 중앙에 띄워놓고 확정을 기다리는 중이면
// { cardInstanceId }, 아니면 null. 대상 선택이 필요 없어서 필드 카드와 같은 미리보기 방식을 씀
// (8단계 Phase 3, 2026-08-26)
let pendingMultiTargetAttack = null;

// 지금 combatOverlay에 겹쳐서 보여주고 있는 카드들 (공격 카드 1장 + 방어 카드 0장 이상).
// game:attackAnnounced로 시작되고, 방어 카드가 추가될 때마다 늘어나다가, game:combatResult가
// 오면 전부 한꺼번에 지워집니다. (2026-08-27 추가)
let combatStackCards = [];

// 오행 속성 -> 이모지 아이콘 (카드에 붙여서 속성을 한눈에 구분하기 위함)
const ELEMENT_ICONS = { 목: "🌳", 화: "🔥", 토: "⛰️", 금: "⚙️", 수: "💧" };
function elementIcon(element) {
  return ELEMENT_ICONS[element] || "";
}

// 오행 상성 (서버 elementTable.js와 같은 값). 손패 카드의 "현재 코스트/위력 변동분"을 클라이언트가
// 직접 계산해서 금색으로 보여주기 위해 필요 (실제 판정은 여전히 서버 전담, 여기는 표시용)
const GENERATE_MAP = { 목: "화", 화: "토", 토: "금", 금: "수", 수: "목" }; // key가 value를 강화(상생)
const COUNTER_MAP = { 목: "토", 토: "수", 수: "화", 화: "금", 금: "목" }; // key가 value를 상극(카운터)
const COUNTER_BONUS = 5; // 방어 속성이 공격 속성을 상극할 때 방어력에 붙는 고정 보너스 (서버 상수와 동일)

// 나(본인) 플레이어 객체 (latestPlayers 기준). 없으면 null
function getMe() {
  return latestPlayers.find((p) => p.socketId === socket.id) || null;
}
function myStatusTotal(type) {
  const me = getMe();
  if (!me || !me.statuses) return 0;
  return me.statuses.filter((s) => s.type === type).reduce((sum, s) => sum + (s.amount || 0), 0);
}

// 손패 공격/방어 카드에 "지금 이 순간" 붙는 위력 보정치의 합 (지형 상생 + 내 버프 + 필드효과 +
// 방어 중이면 상극 보너스). 0이면 보정 없음. (2026-08-29)
function getCardPowerBonus(card) {
  if (!card || (card.type !== "attack" && card.type !== "defense")) return 0;
  // 서버가 굴려 보낸 임시 연출 카드(min/max 없음)에는 이미 보너스가 반영돼 있으므로 건드리지 않음
  const rangeKey = card.type === "attack" ? "attackPowerMin" : "defensePowerMin";
  if (card[rangeKey] == null) return 0;

  let bonus = 0;
  // 지형 상생: 지형 속성 자신 또는 지형이 상생하는 속성이면 synergyBonus
  if (latestTerrain) {
    const boosted = GENERATE_MAP[latestTerrain.element];
    if (card.element === latestTerrain.element || card.element === boosted) {
      bonus += latestTerrain.synergyBonus || 0;
    }
  }
  // 필드효과(작열의기운 등): 같은 속성이면 damageBonusAmount 합산
  bonus += (latestEffects || [])
    .filter((e) => e.element === card.element)
    .reduce((sum, e) => sum + (e.damageBonusAmount || 0), 0);

  if (card.type === "attack") {
    bonus += myStatusTotal("attackBuff");
  } else {
    bonus += myStatusTotal("defBuff");
    // 방어 중이고, 이 방어 카드가 들어온 공격 속성을 상극하면 상극 보너스
    if (isDefending && pendingAttackElement && COUNTER_MAP[card.element] === pendingAttackElement) {
      bonus += COUNTER_BONUS;
    }
  }
  return bonus;
}

// 손패 카드의 "지금 이 순간" 실제 코스트와, 그게 인쇄값과 다른지 여부. (2026-08-29)
// 코스트 계산은 서버가 권위자라서, 서버가 손패로 내려주는 effectiveCost를 그대로 신뢰함.
// (지형/효과로 남의 코스트가 바뀌는 경우에도 항상 최신이도록 서버가 game:playFieldCard 때
//  전원에게 손패를 다시 보내줌 - gameHandlers.js 참고). 연출용 임시 카드엔 effectiveCost가
// 없으므로 그때는 변동 없음으로 취급.
function getCardCostInfo(card) {
  if (card.effectiveCost === undefined) {
    return { cost: card.cost != null ? card.cost : getDisplayCost(card), modified: false };
  }
  return { cost: card.effectiveCost, modified: card.effectiveCost !== card.cost };
}

// 카드 타입 -> CSS 클래스 (손패/시전 연출에서 공용으로 씀)
const TYPE_CLASS_MAP = {
  attack: "card-attack",
  defense: "card-defense",
  terrain: "card-terrain",
  effect: "card-effect",
};

// 카드 타입 -> 좌상단 작은 아이콘 (속성 아이콘과는 별개로, "이 카드가 공격/방어/지형/효과 중 무엇인지"를
// 한눈에 보여줌 - 2026-08-29 카드 디자인 개편, 스케치 기준)
const TYPE_ICON_MAP = {
  attack: "⚔️",
  defense: "🛡️",
  terrain: "🗺️",
  effect: "⚡",
};

// 지형 속성 -> 배경 테마 (실제 이미지 파일은 없어서 그라디언트로 분위기만 표현)
const ELEMENT_BACKGROUNDS = {
  목: "radial-gradient(circle at 50% 15%, #234d20, #1b1b2f 70%)",
  화: "radial-gradient(circle at 50% 15%, #5c1a12, #1b1b2f 70%)",
  토: "radial-gradient(circle at 50% 15%, #4a3620, #1b1b2f 70%)",
  금: "radial-gradient(circle at 50% 15%, #3a3a45, #1b1b2f 70%)",
  수: "radial-gradient(circle at 50% 15%, #123a4d, #1b1b2f 70%)",
};
const DEFAULT_BACKGROUND = "#24243e"; // .game-board 기본 배경색과 동일 (2026-08-27, 고정 크기 박스 UI 도입)

// 현재 깔린 지형에 맞춰 배경 테마를 바꿈 (없으면 기본 배경으로 복귀)
// 예전에는 document.body에 적용했는데, 게임 보드가 배경과 구분되는 별도 박스(.game-board)로
// 바뀌면서 body 배경은 박스 뒤에 가려 안 보이게 됨 -> 박스 자체(gameSection)에 적용하도록 변경
function applyTerrainBackground() {
  gameSection.style.background = latestTerrain
    ? ELEMENT_BACKGROUNDS[latestTerrain.element] || DEFAULT_BACKGROUND
    : DEFAULT_BACKGROUND;
}

// 지형 감면/필드효과 감면/코스트증가가 반영된 실제 코스트. 전투 연출용으로 서버가 만들어 보내는
// 임시 카드 객체(공격 카드 announce, 방어 카드 stack 등)에는 effectiveCost가 없을 수 있어서
// 그때는 그냥 cost를 그대로 씀 (8단계 Phase 3, 2026-08-26)
function getDisplayCost(card) {
  return card.effectiveCost !== undefined ? card.effectiveCost : card.cost;
}

// 카드 한 장의 "실물 카드처럼 보이는" 내부 마크업을 만듦 (손패/시전 연출 공용).
// 개발자가 준 스케치 기준(2026-08-29 개편): 상단 줄(타입 아이콘/이름/코스트) - 이미지 영역(속성 아이콘으로
// 대신함) - 설명(효과) 영역 - 하단 줄(속성/수치). 전투 연출에서 서버가 만들어 보내는 임시 카드 객체는
// description이 없을 수 있어서 그 경우 빈 칸으로 둠
// 공격/방어 카드의 위력 표기 (2026-08-29: 이제 고정값이 아니라 범위라서 "2~5"처럼 보여줌).
// 서버가 전투 연출용으로 보내는 임시 카드 객체엔 min/max가 없고 이미 굴려진 단일 수치만 있어서,
// 그 경우엔 그 숫자를 그대로 씀
function powerText(card, kind) {
  const min = card[`${kind}PowerMin`];
  const max = card[`${kind}PowerMax`];
  if (min != null && max != null) return min === max ? `${min}` : `${min}~${max}`;
  return `${card[`${kind}Power`]}`;
}

// 공격/방어 카드 하단의 위력 표기. 지금 이 순간 지형/버프/상극 등으로 위력이 바뀌어 있으면
// 인쇄된 범위 대신 "보정된 범위"를 금색(.value-modified)으로 보여줌 (2026-08-29)
function powerLabel(card, kind, icon) {
  const bonus = getCardPowerBonus(card);
  if (bonus === 0) return `${icon} ${powerText(card, kind)}`;
  const min = card[`${kind}PowerMin`];
  const max = card[`${kind}PowerMax`];
  const shifted =
    min === max ? `${min + bonus}` : `${min + bonus}~${max + bonus}`;
  return `${icon} <span class="value-modified">${shifted}</span>`;
}

function buildCardFaceHtml(card) {
  let statLabel;
  if (card.type === "attack") {
    statLabel = powerLabel(card, "attack", "⚔");
  } else if (card.type === "defense") {
    statLabel = powerLabel(card, "defense", "🛡");
  } else if (card.type === "terrain") {
    statLabel = `+${card.synergyBonus}`;
  } else {
    statLabel = `☠ ${card.tickDamage}`;
  }

  const costInfo = getCardCostInfo(card);
  const costBadge = costInfo.modified
    ? `<div class="card-cost-badge value-modified">${costInfo.cost}</div>`
    : `<div class="card-cost-badge">${costInfo.cost}</div>`;

  return `
    <div class="card-top-row">
      <div class="card-type-icon">${TYPE_ICON_MAP[card.type] || ""}</div>
      <div class="card-name">${card.name}</div>
      ${costBadge}
    </div>
    <div class="card-image-area">${elementIcon(card.element)}</div>
    <div class="card-desc-area">${card.description || ""}</div>
    <div class="card-bottom-row">
      <span class="card-element">${card.element}속성</span>
      <span class="card-stat">${statLabel}</span>
    </div>
  `;
}

// 카드 얼굴에는 다 못 담는 상세 설명. 버튼의 title 속성으로 넣어두면 마우스를 올렸을 때
// 브라우저 기본 툴팁으로 보여줌 (카드 디자인을 안 건드리고 정보를 보완하는 용도)
function buildCardTitleText(card) {
  const { cost } = getCardCostInfo(card);
  if (card.type === "attack" || card.type === "defense") {
    const kind = card.type === "attack" ? "attack" : "defense";
    const label = card.type === "attack" ? "공격력" : "방어력";
    const bonus = getCardPowerBonus(card);
    const bonusNote = bonus !== 0 ? ` (현재 지형/버프로 ${bonus > 0 ? "+" : ""}${bonus})` : "";
    return `${card.name} · ${label} ${powerText(card, kind)}(사용할 때마다 무작위)${bonusNote} · ${card.element}속성 · 코스트 ${cost}`;
  }
  if (card.type === "terrain") {
    return `${card.name} · ${card.element}속성 및 상생 대상 속성 카드 위력 +${card.synergyBonus} · 코스트 ${cost}`;
  }
  return `${card.name} · ${card.durationTurns}턴 동안 매턴 ${card.tickDamage}의 피해 · 코스트 ${cost}`;
}

// ---- 방 만들기 버튼 ----
createRoomBtn.addEventListener("click", () => {
  myNickname = nicknameInput.value.trim();
  if (!myNickname) {
    showError("닉네임을 입력해주세요.");
    return;
  }
  // 서버에 "room:create" 이벤트를 보냄 (서버의 roomHandlers.js에서 이걸 받음)
  socket.emit("room:create", { nickname: myNickname, token: playerToken });
});

// ---- 방 입장 버튼 ----
joinRoomBtn.addEventListener("click", () => {
  myNickname = nicknameInput.value.trim();
  const roomId = roomIdInput.value.trim();

  if (!myNickname) {
    showError("닉네임을 입력해주세요.");
    return;
  }
  if (!roomId) {
    showError("방 코드를 입력해주세요.");
    return;
  }
  currentRoomId = roomId;
  saveSession(roomId, myNickname); // 성공했다고 가정하고 미리 저장 - 실패하면 room:rejoinFailed에서 알아서 지워짐
  socket.emit("room:join", { roomId, nickname: myNickname, token: playerToken });
});

// ---- 서버가 "방 생성 완료"를 알려줄 때 ----
socket.on("room:created", ({ roomId }) => {
  currentRoomId = roomId;
  saveSession(roomId, myNickname); // 새로고침/재접속 시 이 방으로 자동으로 돌아오기 위해 기억해둠
  console.log("방 생성됨:", roomId);
});

// ---- 서버가 "방 상태가 바뀌었다"고 알려줄 때 (입장/퇴장 등) ----
// 방 안에 있는 모든 사람에게 매번 이 이벤트가 전달됩니다.
socket.on("room:updated", (room) => {
  currentRoomId = room.roomId;
  currentHostSocketId = room.hostSocketId;
  latestPlayers = room.players;

  // 재접속 처리(2026-08-27): 게임이 끝난 게 아니라면(= 아직 이 방에서 뭔가 이어서 할 수 있다면)
  // 세션을 계속 최신으로 저장해둠. "다시 시작"으로 대기실로 돌아온 경우에도 이 덕분에 세션이
  // 다시 살아나서, 재시작한 새 게임 도중에도 새로고침하면 재접속이 됨
  if (room.status !== "ended" && myNickname) {
    saveSession(room.roomId, myNickname);
  }

  // 게임이 이미 시작된 상태에서 이 이벤트가 온 거라면(예: 도중 참가는 지금 막혀있지만 방어적으로)
  // 대기실 화면으로 되돌리지 않고, 대신 전장(HP 등)을 최신 정보로 다시 그림
  if (room.status === "playing") {
    lastKnownTurnSocketId = room.currentTurnSocketId;
    latestTerrain = room.terrain;
    latestEffects = room.effects;
    renderMyStatus();
    renderOpponents();
    renderFieldStatus();
    // 지형/필드효과/내 버프가 바뀌면 손패 카드의 "현재 코스트·위력"(금색 표기)도 달라지므로 다시 그림
    // (2026-08-29). renderHand는 myHand 배열만 참조하므로 저렴하고, 손패 자체 내용은 안 바뀜
    renderHand();
    return;
  }
  if (room.status === "ended") {
    // 보통은 game:over 이벤트로 이미 처리되지만, 게임이 끝난 뒤에 재접속한 사람은 그 순간
    // 연결이 끊겨있어서 game:over를 못 받았을 수 있음 - 그런 경우를 위해 room.winnerNickname으로
    // 여기서도 같은 화면을 보여줌 (재접속 처리, 2026-08-27)
    showGameOverScreen(room.winnerNickname);
    return;
  }

  appDiv.classList.remove("hidden");
  lobbySection.classList.add("hidden");
  roomSection.classList.remove("hidden");
  gameSection.classList.add("hidden");
  gameOverSection.classList.add("hidden"); // 재시작(2026-08-27)으로 대기실로 돌아온 경우, 이전 게임 종료 화면을 정리

  roomIdLabel.textContent = room.roomId;

  playerList.innerHTML = "";
  room.players.forEach((p) => {
    const li = document.createElement("li");
    li.textContent = p.nickname + (p.socketId === room.hostSocketId ? " (방장)" : "");
    playerList.appendChild(li);
  });

  // 방장이고, 2명 이상 모였을 때만 "게임 시작" 버튼 노출
  const isHost = room.hostSocketId === socket.id;
  if (isHost && room.players.length >= 2) {
    startGameBtn.classList.remove("hidden");
  } else {
    startGameBtn.classList.add("hidden");
  }
});

// ---- 서버가 에러를 알려줄 때 ----
socket.on("error", ({ message }) => {
  showError(message);
});

// ---- 연결 끊김 / 재연결 (2026-08-27: 재접속 처리 추가) ----
// Socket.io 클라이언트는 기본적으로 연결이 끊기면 자동으로 재연결을 계속 시도합니다.
// 재연결에 성공하면 서버 입장에서는 새로운 socket.id를 가진 "새 연결"이라, 예전에는 방/게임에
// 다시 자동으로 들어가지는 게 아니라 완전히 새로 접속한 것처럼 처리됐습니다.
//
// 이제는 localStorage에 저장해둔 세션(방 코드 + 내 토큰)이 있으면, 연결될 때마다(최초 접속이든
// 와이파이가 끊겼다 자동 재연결됐든, 페이지를 새로고침했든 전부 여기로 옴) 그 방으로 재접속을
// 시도합니다. 서버가 유예시간(60초) 안이라고 판단하면 손패/HP/턴까지 그대로 이어서 할 수 있고,
// 유예시간이 지났거나 방이 사라졌으면 room:rejoinFailed로 알려주므로 그때는 세션을 지우고
// 평범한 로비 화면으로 돌아갑니다.
socket.on("disconnect", () => {
  connectionBanner.classList.remove("hidden");
});

socket.on("connect", () => {
  connectionBanner.classList.add("hidden");

  const session = loadSession();
  if (session) {
    socket.emit("room:rejoin", { roomId: session.roomId, token: playerToken });
  }
});

// ---- 서버가 "재접속 성공"을 알려줄 때 (본인에게만 옴) ----
// 이후 room:updated가 곧이어 도착해서 실제 화면(대기실/전장)을 그려줌 - 여기서는 화면 전환에
// 필요한 최소한의 상태만 미리 맞춰둠
socket.on("room:rejoined", ({ roomId }) => {
  currentRoomId = roomId;
  console.log("재접속 성공:", roomId);
});

// ---- 서버가 "재접속 실패"를 알려줄 때 (방이 사라졌거나, 유예시간이 지나서 이미 내보내진 경우) ----
socket.on("room:rejoinFailed", ({ message }) => {
  console.log("재접속 실패:", message);
  clearSession();
  // 로비 화면으로 되돌림 (혹시 게임 화면이 남아있을 수 있으니 정리)
  gameSection.classList.add("hidden");
  appDiv.classList.remove("hidden");
  lobbySection.classList.remove("hidden");
  roomSection.classList.add("hidden");
  gameOverSection.classList.add("hidden");
  showError(message);
});

function showError(message) {
  errorMsg.textContent = message;
  setTimeout(() => (errorMsg.textContent = ""), 3000);
}

// 닉네임처럼 사용자가 직접 입력한 텍스트를 로그에 innerHTML로 넣기 전에 이스케이프 처리.
// (카드 이름 등은 서버의 고정 데이터라 안전하지만, 닉네임은 사용자 입력이라 그대로 넣으면 위험함)
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---- 게임 시작 버튼 ----
startGameBtn.addEventListener("click", () => {
  socket.emit("game:start", { roomId: currentRoomId });
});

// ---- 서버가 "턴이 바뀌었다"고 알려줄 때 ----
// 게임 시작 직후에도 이 이벤트가 오기 때문에, 여기서 화면을 대기실 -> 게임 화면으로 전환합니다.
socket.on("game:turnChanged", ({ currentTurnSocketId }) => {
  // 게임 보드는 #app 밖에 있으므로, 로비/대기실/게임종료를 담고 있는 #app을 통째로 숨김
  appDiv.classList.add("hidden");
  gameSection.classList.remove("hidden");

  lastKnownTurnSocketId = currentTurnSocketId;
  selectedAttackCardInstanceId = null; // 새 턴이 되면 대상 선택 모드는 초기화

  const isMyTurn = currentTurnSocketId === socket.id;
  const currentPlayer = latestPlayers.find((p) => p.socketId === currentTurnSocketId);
  const currentNickname = currentPlayer ? currentPlayer.nickname : "알 수 없음";

  turnLabel.textContent = isMyTurn
    ? "지금은 내 턴입니다!"
    : `${currentNickname}님의 턴입니다. 기다려주세요...`;
  flashTurnLabel();

  // 내 턴일 때만 "턴 종료" 버튼 활성화
  endTurnBtn.classList.toggle("hidden", !isMyTurn);

  renderMyStatus();
  renderOpponents();
  renderFieldStatus();
  renderHand();
});

// ---- 턴 종료 버튼 ----
endTurnBtn.addEventListener("click", () => {
  socket.emit("game:endTurn", { roomId: currentRoomId });
});

// ==================== 카드 / 전투 ====================

// ---- 서버가 "네 손패는 이거야"라고 알려줄 때 (카드 사용/방어 후에도 갱신됨) ----
socket.on("game:handUpdated", ({ hand }) => {
  myHand = hand;
  renderHand();
});

// 이름으로 socketId -> 닉네임 찾기 (latestPlayers 기준)
function getNicknameOf(socketId) {
  const p = latestPlayers.find((pl) => pl.socketId === socketId);
  return p ? p.nickname : "알 수 없음";
}

// 특정 플레이어 카드에 잠깐 애니메이션(피격/방어 등)을 재생하도록 예약.
// 실제 클래스 부착은 renderMyStatus()/renderOpponents()가 다음에 그릴 때 처리함 (위 pendingFlash 설명 참고)
function triggerCardFlash(socketId, className) {
  pendingFlash = { socketId, className, expiresAt: Date.now() + 500 };
}

// 턴 라벨을 잠깐 반짝이게 함 (같은 DOM 요소를 계속 재사용하므로 클래스를 뗐다 붙이는 방식으로 재생)
function flashTurnLabel() {
  turnLabel.classList.remove("turn-flash");
  void turnLabel.offsetWidth; // 강제 리플로우: 애니메이션을 처음부터 다시 재생시키기 위한 트릭
  turnLabel.classList.add("turn-flash");
}

// ---- 지형/효과 카드 미리보기 (클릭해서 확정) ----
// 화면 중앙에 띄운 뒤 사용자의 클릭을 기다립니다.
// 카드 자체를 클릭하면 사용 확정, 카드가 아닌 바깥(배경)을 클릭하면 취소됩니다.
function previewFieldCard(card) {
  pendingFieldCard = { cardInstanceId: card.instanceId };
  castCard.innerHTML = `
    <div class="card-btn ${TYPE_CLASS_MAP[card.type]}">${buildCardFaceHtml(card)}</div>
    <div class="preview-hint">클릭하면 사용 · 바깥을 클릭하면 취소</div>
  `;
  castOverlay.classList.remove("hidden");
}

function confirmFieldCardPreview() {
  if (!pendingFieldCard) return;
  const { cardInstanceId } = pendingFieldCard;
  pendingFieldCard = null;
  castOverlay.classList.add("hidden");
  socket.emit("game:playFieldCard", { roomId: currentRoomId, cardInstanceId });
}

function cancelFieldCardPreview() {
  pendingFieldCard = null;
  castOverlay.classList.add("hidden");
}

// ---- 다중 대상 공격 카드 미리보기 (필드 카드와 같은 패턴) ----
// 대상을 정할 필요가 없으니 클릭 한 번으로 미리보기, 한 번 더 클릭하면 서버에 targetSocketId 없이
// 보냄(서버가 생존한 상대 전원을 알아서 대상으로 잡음) - 8단계 Phase 3, 2026-08-26
function previewMultiTargetCard(card) {
  pendingMultiTargetAttack = { cardInstanceId: card.instanceId };
  castCard.innerHTML = `
    <div class="card-btn ${TYPE_CLASS_MAP[card.type]}">${buildCardFaceHtml(card)}</div>
    <div class="preview-hint">전체 대상 공격 · 클릭하면 사용 · 바깥을 클릭하면 취소</div>
  `;
  castOverlay.classList.remove("hidden");
}

function confirmMultiTargetAttack() {
  if (!pendingMultiTargetAttack) return;
  const { cardInstanceId } = pendingMultiTargetAttack;
  pendingMultiTargetAttack = null;
  castOverlay.classList.add("hidden");
  socket.emit("game:playCard", { roomId: currentRoomId, cardInstanceId, targetSocketId: null });
}

function cancelMultiTargetAttack() {
  pendingMultiTargetAttack = null;
  castOverlay.classList.add("hidden");
}

// 클릭한 지점이 카드(.card-btn) 안이면 확정, 그 외(안내 문구·배경 등 카드가 아닌 모든 곳)는 취소
castOverlay.addEventListener("click", (e) => {
  if (pendingFieldCard) {
    if (e.target.closest(".card-btn")) {
      confirmFieldCardPreview();
    } else {
      cancelFieldCardPreview();
    }
    return;
  }
  if (pendingMultiTargetAttack) {
    if (e.target.closest(".card-btn")) {
      confirmMultiTargetAttack();
    } else {
      cancelMultiTargetAttack();
    }
  }
});

// ---- 손패 교체 (2026-08-27 추가) ----
// 손패가 가득 찬(9장) 상태에서 자기 턴이 끝나 카드를 뽑으면 서버가 game:handSwapOffered를 보내고,
// 그때부터 이 상태가 활성화됩니다. 방어(isDefending)와 같은 패턴: 실제 선택은 아래 손패를 직접
// 클릭해서 하고(renderHand 참고), "교체하기"를 눌러야 서버에 반영됩니다. 게임 진행을 막지는
// 않으므로(다른 사람 턴이 계속 진행됨) 원할 때 아무 때나 답해도 됩니다.
function openHandSwap(card) {
  pendingHandSwap = { card };
  selectedSwapReplaceInstanceId = null;
  renderHandSwapOverlay();
  renderHand();
}

function closeHandSwap() {
  pendingHandSwap = null;
  selectedSwapReplaceInstanceId = null;
  handSwapOverlay.classList.add("hidden");
  handSwapDeclineBtn.classList.add("hidden");
  handSwapClearBtn.classList.add("hidden");
  handSwapConfirmBtn.classList.add("hidden");
  renderHand();
}

// 왼쪽(새 카드)/오른쪽(바꿀 카드로 고른 것) 슬롯과 버튼 표시 여부를 지금 상태에 맞춰 다시 그림
function renderHandSwapOverlay() {
  if (!pendingHandSwap) return;

  handSwapOverlay.classList.remove("hidden");
  handSwapDeclineBtn.classList.remove("hidden");

  handSwapNewCard.innerHTML = `<div class="card-btn ${TYPE_CLASS_MAP[pendingHandSwap.card.type]}">${buildCardFaceHtml(
    pendingHandSwap.card
  )}</div>`;

  const selectedCard = selectedSwapReplaceInstanceId
    ? myHand.find((c) => c.instanceId === selectedSwapReplaceInstanceId)
    : null;

  if (selectedCard) {
    handSwapReplaceCard.className = "";
    handSwapReplaceCard.innerHTML = `<div class="card-btn ${TYPE_CLASS_MAP[selectedCard.type]}">${buildCardFaceHtml(
      selectedCard
    )}</div>`;
    handSwapClearBtn.classList.remove("hidden");
    handSwapConfirmBtn.classList.remove("hidden");
  } else {
    handSwapReplaceCard.className = "hand-swap-placeholder";
    handSwapReplaceCard.innerHTML = "아래 손패에서<br />바꿀 카드를 클릭하세요";
    handSwapClearBtn.classList.add("hidden");
    handSwapConfirmBtn.classList.add("hidden");
  }
}

handSwapDeclineBtn.addEventListener("click", () => {
  socket.emit("game:resolveHandSwap", { roomId: currentRoomId, replaceInstanceId: null });
  closeHandSwap();
});

handSwapClearBtn.addEventListener("click", () => {
  selectedSwapReplaceInstanceId = null;
  renderHandSwapOverlay();
  renderHand();
});

handSwapConfirmBtn.addEventListener("click", () => {
  socket.emit("game:resolveHandSwap", { roomId: currentRoomId, replaceInstanceId: selectedSwapReplaceInstanceId });
  closeHandSwap();
});

// ---- 서버가 "손패가 가득 차서 교체할지 물어봄"을 알려줄 때 (본인에게만 옴) ----
socket.on("game:handSwapOffered", ({ card }) => {
  openHandSwap(card);
});

// ---- 전투 연출: 공격 카드 + 방어 카드(들)가 겹쳐 쌓이는 화면 (2026-08-27) ----
// 서버 방송(game:attackAnnounced/game:defenseCardApplied)으로 채워지므로 모든 플레이어에게
// 똑같이 보입니다. 카드는 하나씩 "추가"만 되고(기존 카드를 다시 그리지 않음), 그래야 새로
// 추가된 카드만 등장 애니메이션이 재생되고 이미 쌓인 카드는 그대로 있습니다.
function appendCombatStackCard(cardData) {
  combatStackCards.push(cardData);
  const div = document.createElement("div");
  div.className = "card-btn " + TYPE_CLASS_MAP[cardData.type];
  div.dataset.instanceId = cardData.instanceId || ""; // 방어자 본인의 미리보기 카드를 나중에 선택 해제로 뺄 때 찾기 위함
  div.style.setProperty("--stack-index", combatStackCards.length - 1);
  div.innerHTML = buildCardFaceHtml(cardData);
  combatStack.appendChild(div);
}

// 방어자 본인이 손패에서 방어 카드를 "선택"한 순간, 서버 응답을 기다리지 않고
// 곧바로 내 화면에서만 미리 겹쳐 보여줌 (실제 서버 반영은 "사용"을 눌러야 일어남).
// 상극/지형 보너스는 서버만 계산할 수 있고, 방어력 자체도 확정 시점에 무작위로 굴려지므로(2026-08-29)
// 여기서는 범위(예: 2~5)만 보여줌 - 정확한 최종 수치는 결과가 나온 뒤 전투 로그에 표시됨.
function previewLocalDefenseCard(card) {
  appendCombatStackCard({
    instanceId: card.instanceId,
    type: "defense",
    name: card.name,
    element: card.element,
    cost: card.cost,
    defensePower: card.defensePower,
    defensePowerMin: card.defensePowerMin,
    defensePowerMax: card.defensePowerMax,
  });
}

// 방어자 본인이 선택을 해제(다시 클릭 또는 "취소")했을 때, 미리 쌓아뒀던 카드를 스택에서 뺌
function removeLocalDefenseCardFromStack(instanceId) {
  const index = combatStackCards.findIndex((c) => c.instanceId === instanceId);
  if (index === -1) return;
  combatStackCards.splice(index, 1);
  const el = Array.from(combatStack.children).find((child) => child.dataset.instanceId === instanceId);
  if (el) el.remove();
}

// 공격 카드로 전투 연출을 새로 시작 (기존에 남아있던 카드가 있다면 정리하고 새로 시작)
function showAttackInStack(data) {
  combatStackCards = [];
  combatStack.innerHTML = "";
  combatResultNumber.classList.remove("show"); // 직전 결과 수치가 남아있으면 지움
  combatOverlay.classList.remove("fading-out");
  appendCombatStackCard({ type: "attack", name: data.cardName, element: data.element, cost: data.cost, attackPower: data.attackPower });
  combatOverlay.classList.remove("hidden");
}

// 방어 카드 한 장이 추가로 겹쳐 쌓임 (여러 장 낼 수 있으므로 여러 번 호출될 수 있음)
function appendDefenseToStack(data) {
  appendCombatStackCard({
    type: "defense",
    name: data.cardName,
    element: data.element,
    cost: data.cost,
    defensePower: data.effectiveDefensePower, // 상극/지형 보너스까지 반영된 "실제로 막아낸 방어력"을 보여줌
  });
}

// 결과가 확정되면(game:combatResult) 잠깐 그대로 보여주다가, 쌓여있던 카드들이 다같이 사라짐
function clearCombatStackWithDelay() {
  setTimeout(() => {
    combatOverlay.classList.add("fading-out");
    setTimeout(() => {
      combatOverlay.classList.add("hidden");
      combatOverlay.classList.remove("fading-out");
      combatStack.innerHTML = "";
      combatStackCards = [];
    }, 350); // .cast-overlay의 opacity 트랜지션(0.35s)과 맞춤
  }, 500); // 결과를 잠깐 보여주는 시간
}

// 지속상태(기절/봉쇄/화상/버프) 타입별 아이콘+라벨 (8단계 Phase 2, 2026-08-26)
const STATUS_BADGE_MAP = {
  stun: { icon: "🌀", label: "기절" },
  attackLock: { icon: "🚫", label: "공격봉쇄" },
  defenseLock: { icon: "🛡️🚫", label: "방어봉쇄" },
  dot: { icon: "🔥", label: "화상" },
  attackBuff: { icon: "⚔️", label: "공격력" },
  defBuff: { icon: "🛡️", label: "방어력" },
  // 8단계 Phase 3, 2026-08-26
  damageReduction: { icon: "🧱", label: "피해감소" },
  costUp: { icon: "💸", label: "코스트+" },
  maxAttackCostBuff: { icon: "🔋", label: "충전+" },
};

// p.statuses를 작은 배지 목록으로 렌더링 (없으면 빈 문자열)
function buildStatusBadgesHtml(statuses) {
  if (!statuses || statuses.length === 0) return "";
  const badges = statuses
    .map((s) => {
      const info = STATUS_BADGE_MAP[s.type] || { icon: "❔", label: s.type };
      const amountText = s.amount > 0 ? ` +${s.amount}` : "";
      return `<span class="status-badge">${info.icon} ${info.label}${amountText} (${s.remainingTurns}턴)</span>`;
    })
    .join("");
  return `<div class="status-badges">${badges}</div>`;
}

// HP바 + 코스트 점(pip) 마크업을 만듦 (내 상태 카드/상대 상태 카드에서 공용으로 씀)
function buildStatusCardInnerHtml(p) {
  const hpPercent = Math.max(0, Math.round((p.hp / p.maxHp) * 100));
  // 재접속 처리(2026-08-27): 연결이 끊긴 사람은 유예시간(60초) 동안 자리를 그대로 유지하되,
  // 다른 사람 화면에는 "연결 끊김"으로 표시해서 왜 반응이 없는지 알 수 있게 함
  const disconnectedBadge = p.connected === false ? `<div class="disconnected-badge">🔌 연결 끊김 - 재접속 대기 중</div>` : "";
  return `
    ${disconnectedBadge}
    <div class="status-hp-bar"><div class="status-hp-fill" style="width:${hpPercent}%"></div></div>
    <div class="status-hp-text">HP ${p.hp} / ${p.maxHp} · 카드 ${p.handCount}장</div>
    ${buildStatusBadgesHtml(p.statuses)}
    <div class="cost-pips">
      <div class="cost-group cost-attack">${buildPips(p.attackCost, p.maxAttackCost)}</div>
      <div class="cost-group cost-defense">${buildPips(p.defenseCost, p.maxDefenseCost)}</div>
    </div>
  `;
}

// current/max 만큼 동그란 점을 만듦 (채워진 점 = 남은 코스트)
function buildPips(current, max) {
  let html = "";
  for (let i = 0; i < max; i++) {
    html += `<span class="pip${i < current ? " filled" : ""}"></span>`;
  }
  return html;
}

// 좌상단: 내 HP/코스트 상태 카드 다시 그리기
function renderMyStatus() {
  const me = latestPlayers.find((p) => p.socketId === socket.id);
  if (!me) return;

  myStatusCard.dataset.socketId = me.socketId; // 피격/방어 애니메이션 대상을 찾기 위한 표식

  let className = "status-card";
  if (me.socketId === lastKnownTurnSocketId) className += " current-turn";
  if (!me.isAlive) className += " dead";
  if (pendingFlash && pendingFlash.socketId === me.socketId && Date.now() < pendingFlash.expiresAt) {
    className += " " + pendingFlash.className;
  }
  myStatusCard.className = className;

  myStatusCard.innerHTML = buildStatusCardInnerHtml(me);
}

// 우상단: 상대들의 HP/코스트 상태 카드 다시 그리기
// 공격 카드를 선택한 상태(selectedAttackCardInstanceId가 있음)라면
// 살아있는 상대를 클릭 가능하게(targetable) 만들어서 대상 지정을 받음
function renderOpponents() {
  opponentsPanel.innerHTML = "";

  latestPlayers
    .filter((p) => p.socketId !== socket.id)
    .forEach((p) => {
      const wrapper = document.createElement("div");

      const nameLabel = document.createElement("div");
      nameLabel.className = "opp-name";
      nameLabel.textContent = p.nickname;
      wrapper.appendChild(nameLabel);

      const card = document.createElement("div");
      card.dataset.socketId = p.socketId; // 피격/방어 애니메이션을 재생할 때 대상을 찾기 위한 표식

      let className = "status-card";
      if (p.socketId === lastKnownTurnSocketId) className += " current-turn";
      if (!p.isAlive) className += " dead";
      if (pendingFlash && pendingFlash.socketId === p.socketId && Date.now() < pendingFlash.expiresAt) {
        className += " " + pendingFlash.className;
      }

      const isTargetable = selectedAttackCardInstanceId && p.isAlive && !isCasting && !pendingFieldCard;
      if (isTargetable) {
        className += " targetable";
        card.addEventListener("click", () => {
          // 곧바로 서버에 보냄 - 화면 중앙에 카드가 뜨는 연출은 서버가 방송하는
          // game:attackAnnounced를 받았을 때(전원 공통으로) 재생됨
          const cardInstanceId = selectedAttackCardInstanceId;
          selectedAttackCardInstanceId = null;
          renderHand();
          renderOpponents();
          socket.emit("game:playCard", { roomId: currentRoomId, cardInstanceId, targetSocketId: p.socketId });
        });
      }
      card.className = className;

      card.innerHTML = buildStatusCardInnerHtml(p);
      wrapper.appendChild(card);
      opponentsPanel.appendChild(wrapper);
    });
}

// 좌상단의 "지형 카드"/"필드 카드" 박스를 현재 필드 상태로 채움.
// 카드 설명(description)을 그대로 보여주는 방식으로 통일 (8단계 Phase 3, 2026-08-26) - 지형/효과
// 종류가 계속 늘어나서 종류별로 문구를 여기서 직접 조립하면 계속 branching이 늘어나는 걸 피하기 위함
function renderFieldStatus() {
  if (latestTerrain) {
    terrainSlot.className = "field-slot-card terrain-slot";
    terrainSlot.innerHTML = `
      <div class="field-slot-title">🗺️ ${latestTerrain.cardName}</div>
      <div>${elementIcon(latestTerrain.element)}${latestTerrain.element}속성 · ${escapeHtml(latestTerrain.description)}</div>
    `;
  } else {
    terrainSlot.className = "field-slot-card terrain-slot empty";
    terrainSlot.textContent = "🗺️ 지형 없음";
  }

  if (latestEffects.length === 0) {
    effectsSlot.className = "field-slot-card effects-slot empty";
    effectsSlot.textContent = "⚡ 효과 없음";
  } else {
    effectsSlot.className = "field-slot-card effects-slot";
    effectsSlot.innerHTML = latestEffects
      .map(
        (e) =>
          `<div class="effect-item">⚡ ${e.cardName}: ${escapeHtml(e.description)} (${e.remainingTurns}턴 남음)</div>`
      )
      .join("");
  }

  applyTerrainBackground();
}

// 내 손패 다시 그리기 (부채꼴 배치: 카드마다 --fan-offset/--fan-lift 값만 다르게 줘서 CSS가 배치시킴)
// - 평소: 공격 카드를 클릭하면 "대상 선택 모드"로 들어감(다시 클릭하면 취소), 필드 카드(지형/효과)는
//   대상 지정 없이 클릭하면 바로 사용됨, 방어 카드는 클릭해도 아무 일 없음
// - 방어 요청을 받은 동안(isDefending): 방어 카드를 클릭하면 "선택"만 됨(서버에는 아직 안 보냄,
//   다시 클릭하면 선택 해제). 화면 하단의 "사용" 버튼을 눌러야 실제로 서버에 반영됩니다.
//   그 외 카드는 전부 비활성화
function renderHand() {
  handArea.innerHTML = "";

  const me = latestPlayers.find((p) => p.socketId === socket.id);
  const myAttackCost = me ? me.attackCost : 0;
  const myDefenseCost = me ? me.defenseCost : 0;

  // 지금까지 선택해둔 방어 카드들의 코스트 합계 (새 카드를 선택 가능한지 판단할 때 씀)
  // effectiveCost 기준(8단계 Phase 3, 2026-08-26) - 지형/필드효과 감면·코스트증가가 반영된 값
  const selectedDefenseCost = selectedDefenseCardIds.reduce((sum, id) => {
    const c = myHand.find((h) => h.instanceId === id);
    return sum + (c ? getDisplayCost(c) : 0);
  }, 0);

  const total = myHand.length;
  const half = (total - 1) / 2; // 중앙 기준으로 몇 칸까지 벌어지는지 (5장이면 2)

  myHand.forEach((card, index) => {
    const btn = document.createElement("button");
    const isSelected = selectedAttackCardInstanceId === card.instanceId;

    // --fan-offset: 중앙 카드가 0, 왼쪽은 음수 / 오른쪽은 양수 -> CSS가 가로 간격·회전 각도로 환산
    // --fan-lift: 중앙 카드가 가장 큰 음수(=가장 위로 들림), 가장자리로 갈수록 0(=바닥) -> CSS가 높이로 환산
    // 실제 픽셀/각도 값은 style.css의 --card-x-step 등 반응형 변수가 곱해서 계산하므로,
    // 여기서는 "몇 칸째인지"만 정수로 넘겨주면 화면 크기에 따라 알아서 커지고 작아짐
    const offset = index - half;
    const lift = -(half - Math.abs(offset));
    btn.style.setProperty("--fan-offset", offset);
    btn.style.setProperty("--fan-lift", lift);
    btn.style.zIndex = String(index);

    const isSelectedForDefense = selectedDefenseCardIds.includes(card.instanceId);
    // 손패 교체(2026-08-27): 방어 중이면 방어가 더 급하니 방어가 우선이고, 그동안은 교체 선택을 잠깐 막음
    const isSwapping = !isDefending && !!pendingHandSwap;
    const isSelectedForSwap = card.instanceId === selectedSwapReplaceInstanceId;

    let affordable;
    let isDefendable = false;
    if (isDefending) {
      if (card.type !== "defense") {
        affordable = false;
      } else if (isSelectedForDefense) {
        affordable = true; // 이미 선택된 카드는 선택 해제를 위해 항상 클릭 가능
      } else {
        // 아직 선택 안 한 카드는, 지금까지 선택해둔 것들의 코스트 합계에 이 카드를 더해도
        // 방어 코스트 안에 들어오는지로 판단 (실제 소모는 "사용"을 눌러야 서버에 반영됨)
        affordable = selectedDefenseCost + getDisplayCost(card) <= myDefenseCost;
      }
      isDefendable = card.type === "defense" && affordable && !isSelectedForDefense;
    } else if (isSwapping) {
      affordable = true; // 바꿀 카드 고르기는 코스트와 무관하게 아무 카드나 항상 선택 가능
    } else {
      // 평소에는 공격/효과 카드가 공격 코스트 기준으로 판단 (지형 카드는 코스트 0이라 항상 가능,
      // 방어 카드는 평소엔 낼 일이 없어서 그냥 항상 "가능"으로 둠 - 클릭해도 동작이 없을 뿐)
      affordable = card.type === "defense" || getDisplayCost(card) <= myAttackCost;
    }

    const showSelected = isDefending ? isSelectedForDefense : isSwapping ? isSelectedForSwap : isSelected;

    btn.className =
      "card-btn " +
      TYPE_CLASS_MAP[card.type] +
      (showSelected ? " selected" : "") +
      (isDefendable ? " defendable" : "") +
      (isSwapping && !isSelectedForSwap ? " swap-selectable" : "") +
      (!affordable ? " disabled" : "");
    btn.title = buildCardTitleText(card); // 마우스를 올리고 있으면 브라우저 툴팁으로 전체 설명이 보임
    btn.innerHTML = buildCardFaceHtml(card);

    btn.addEventListener("click", () => {
      if (pendingFieldCard || pendingMultiTargetAttack) return; // 카드 미리보기 중에는 항상 막음
      // 전투 연출이 진행 중이면 새로 카드를 고르는 건 막되, 지금 방어해야 하는 본인/손패 교체 중인
      // 본인은 예외 (isCasting은 attackAnnounced~combatResult 동안 전원에게 true라서, 이 예외가
      // 없으면 정작 방어 카드를 내야 하는 사람이나 손패를 정리해야 하는 사람도 손패를 못 누르게 됨)
      if (isCasting && !isDefending && !isSwapping) return;
      if (!affordable) return; // 코스트 부족하거나(또는 방어 중에 방어 카드가 아니면) 선택 불가

      if (isDefending) {
        // 서버에는 아직 아무 것도 안 보내고, 로컬 선택 목록만 토글함 (사용 버튼을 눌러야 반영됨).
        // 대신 화면 중앙의 겹치는 연출은 클릭한 순간 바로 재생함 (선택 해제하면 다시 뺌)
        if (isSelectedForDefense) {
          selectedDefenseCardIds = selectedDefenseCardIds.filter((id) => id !== card.instanceId);
          removeLocalDefenseCardFromStack(card.instanceId);
        } else {
          selectedDefenseCardIds.push(card.instanceId);
          previewLocalDefenseCard(card);
        }
        renderHand();
        return;
      }

      if (isSwapping) {
        // 서버에는 아직 아무 것도 안 보내고, 로컬 선택만 토글함 ("교체하기"를 눌러야 반영됨)
        selectedSwapReplaceInstanceId = isSelectedForSwap ? null : card.instanceId;
        renderHandSwapOverlay();
        renderHand();
        return;
      }

      if (card.type === "attack" && card.multiTarget) {
        // 다중 대상 카드는 대상 선택이 필요 없으니 필드 카드처럼 미리보기 후 확정하는 방식으로 사용
        // (8단계 Phase 3, 2026-08-26)
        previewMultiTargetCard(card);
        return;
      }

      if (card.type === "attack") {
        selectedAttackCardInstanceId = isSelected ? null : card.instanceId;
        renderHand();
        renderOpponents();
        return;
      }

      if (card.type === "terrain" || card.type === "effect") {
        // 공격 카드처럼 화면 중앙에 먼저 띄우고, 카드를 한 번 더 클릭해야 실제로 사용됨
        // (바깥을 클릭하면 취소 - castOverlay의 클릭 핸들러에서 처리)
        previewFieldCard(card);
        return;
      }

      // 방어 카드는 평소엔 여기서 아무 동작도 하지 않음 (방어 요청을 받았을 때만 위 isDefending 분기로 처리)
    });

    handArea.appendChild(btn);
  });
}

// ---- 누군가 공격 카드를 냈을 때 방 전체(공격자/방어자/구경하는 다른 플레이어 모두)에게 방송됨 ----
// 방어가 끝날 때까지(game:combatResult) 화면 중앙에 이 카드가 계속 보입니다.
socket.on("game:attackAnnounced", (data) => {
  isCasting = true;
  showAttackInStack(data);
});

// ---- 방어자가 방어 카드를 한 장 낼 때마다(여러 장 가능) 방 전체에 방송됨 ----
// 공격 카드 위에 겹쳐서 쌓이는 연출만 담당 (최종 확정은 game:combatResult에서).
// 방어자 본인은 카드를 선택한 순간 이미 previewLocalDefenseCard로 미리 보여줬으므로
// 여기서 또 추가하면 중복으로 쌓이게 됨 -> 본인 화면에서는 건너뜀
socket.on("game:defenseCardApplied", (data) => {
  if (data.defenderSocketId === socket.id) return;
  appendDefenseToStack(data);
});

// ---- 서버가 "너에게 공격이 들어왔다, 방어할지 정해라"라고 알려줄 때 ----
// 실제로 얼마나 막아낼지(방어력 vs 공격력, 상극 보너스 포함)는 서버가 최종 계산하므로
// 여기서는 안내 배너만 띄우고, 방어 카드 선택은 아래 손패(부채꼴)에서 직접 받습니다.
socket.on(
  "game:defenseRequest",
  ({ attackerNickname, cardName, element, attackPower, attackTerrainBonus, attackEffectBonus }) => {
  const bonusParts = [];
  if (attackTerrainBonus > 0) bonusParts.push(`지형 보너스 +${attackTerrainBonus}`);
  if (attackEffectBonus > 0) bonusParts.push(`필드효과 보너스 +${attackEffectBonus}`);
  const bonusHtml = bonusParts.length > 0 ? ` <span class="bonus-text">(${bonusParts.join(", ")} 포함)</span>` : "";
  defenseInfo.innerHTML = `${escapeHtml(attackerNickname)}님이 "${escapeHtml(
    cardName
  )}"(${element}속성, 공격력 ${attackPower})${bonusHtml}(으)로 공격했습니다! 아래 손패에서 방어 카드를 고른 뒤 "사용"을 누르세요.`;

  isDefending = true;
  pendingAttackElement = element; // 상극이면 방어력 금색 보정 표기에 씀 (2026-08-29)
  selectedDefenseCardIds = [];
  defenseBanner.classList.remove("hidden");
  confirmDefenseBtn.classList.remove("hidden");
  cancelDefenseBtn.classList.remove("hidden");
  renderHand(); // 방어 카드가 강조되고 선택 가능해지도록 다시 그림
});

// "사용": 지금까지 고른 방어 카드들을 한 번에 서버로 보내 확정 (0장이면 방어 포기와 같음)
confirmDefenseBtn.addEventListener("click", () => {
  socket.emit("game:confirmDefense", { roomId: currentRoomId, cardInstanceIds: selectedDefenseCardIds });
  // 배너/버튼/손패 상태는 game:combatResult가 왔을 때 정리합니다
});

// "취소": 서버에는 아무 것도 안 보내고, 지금까지의 선택(과 미리 보여줬던 겹침 연출)만 로컬에서 되돌림 (방어는 계속 진행 중)
cancelDefenseBtn.addEventListener("click", () => {
  selectedDefenseCardIds.forEach((id) => removeLocalDefenseCardFromStack(id));
  selectedDefenseCardIds = [];
  renderHand();
});

// 방어 카드 여러 장의 내역을 "돌벽 15(상극 +5) + 물의 장막 15" 같은 문장으로 합쳐줌
function buildDefenseSummaryHtml(appliedDefenses) {
  return appliedDefenses
    .map((d) => {
      const bonusParts = [];
      if (d.counterBonus > 0) bonusParts.push(`상극 +${d.counterBonus}`);
      if (d.terrainBonus > 0) bonusParts.push(`지형 +${d.terrainBonus}`);
      const bonusHtml = bonusParts.length > 0 ? ` <span class="bonus-text">(${bonusParts.join(", ")})</span>` : "";
      return `${escapeHtml(d.cardName)} ${d.effectiveDefensePower}${bonusHtml}`;
    })
    .join(" + ");
}

// ---- 서버가 전투 결과를 알려줄 때 (공격자/방어자 둘 다 아닌, 방 전체에게 방송됨) ----
// defended는 "방어 카드를 1장 이상 냈는가"일 뿐, 냈어도 공격력이 더 세면 일부 피해가 들어갈 수 있습니다.
// appliedDefenses: 이번 방어에 낸 카드들의 배열 (2026-08-27: 여러 장 낼 수 있게 되면서 배열로 바뀜)
socket.on(
  "game:combatResult",
  ({
    attackerSocketId,
    defenderSocketId,
    cardName,
    defended,
    attackPower,
    attackTerrainBonus,
    attackEffectBonus,
    appliedDefenses,
    defensePowerUsed,
    armorPiercing,
    damageDealt,
    defenderHp,
    healOnUse,
    lifestealHeal,
    healOnDefend,
    counterDamage,
    appliedStatuses,
    damageReductionApplied,
    hasMoreTargets,
  }) => {
    const attackerName = escapeHtml(getNicknameOf(attackerSocketId));
    const defenderName = escapeHtml(getNicknameOf(defenderSocketId));
    const safeCardName = escapeHtml(cardName);

    // 지형/필드효과 보너스가 붙었으면 강조색 글씨(<span class="bonus-text">)로 덧붙여서 보여줌
    const attackBonusParts = [];
    if (attackTerrainBonus > 0) attackBonusParts.push(`지형 +${attackTerrainBonus}`);
    if (attackEffectBonus > 0) attackBonusParts.push(`필드효과 +${attackEffectBonus}`);
    const attackBonusHtml =
      attackBonusParts.length > 0 ? ` <span class="bonus-text">(${attackBonusParts.join(", ")})</span>` : "";
    const defenseSummaryHtml = defended ? buildDefenseSummaryHtml(appliedDefenses) : "";

    const line = document.createElement("p");
    if (!defended) {
      line.innerHTML = `${attackerName}의 "${safeCardName}"(공격력 ${attackPower}${attackBonusHtml})! ${defenderName}님이 방어를 포기해 ${damageDealt}의 피해를 입었습니다. (남은 HP: ${defenderHp})`;
    } else if (damageDealt === 0) {
      line.innerHTML = `${attackerName}의 "${safeCardName}"(공격력 ${attackPower}${attackBonusHtml}) 공격을 ${defenderName}님이 ${defenseSummaryHtml} = 방어력 ${defensePowerUsed}로 완전히 막았습니다!`;
    } else {
      line.innerHTML = `${attackerName}의 "${safeCardName}"(공격력 ${attackPower}${attackBonusHtml}) 공격! ${defenderName}님이 ${defenseSummaryHtml} = 방어력 ${defensePowerUsed}로 막았지만 ${damageDealt}의 피해를 입었습니다. (남은 HP: ${defenderHp})`;
    }

    // 8단계 Phase 1(2026-08-26): 관통/흡혈/고정회복/방어회복/반격 같은 즉시효과를 강조색으로 덧붙여 보여줌
    const extraParts = [];
    if (armorPiercing > 0) extraParts.push(`관통 피해 ${armorPiercing} 추가`);
    if (lifestealHeal > 0) extraParts.push(`${attackerName}이(가) 흡혈로 HP ${lifestealHeal} 회복`);
    if (healOnUse > 0) extraParts.push(`${attackerName}이(가) 카드 효과로 HP ${healOnUse} 회복`);
    if (healOnDefend > 0) extraParts.push(`${defenderName}이(가) 방어 효과로 HP ${healOnDefend} 회복`);
    if (counterDamage > 0) extraParts.push(`${attackerName}이(가) 반격 피해 ${counterDamage} 입음`);
    // 8단계 Phase 3(2026-08-26): 받는 피해 감소(대지의보호막/대지의성채 등)
    if (damageReductionApplied > 0) extraParts.push(`${defenderName}의 피해 감소 효과로 ${damageReductionApplied} 경감`);

    // 8단계 Phase 2(2026-08-26): CC/화상/버프 부여 문구도 이어붙임
    (appliedStatuses || []).forEach((s) => {
      const targetName = s.targetSocketId === attackerSocketId ? attackerName : defenderName;
      const info = STATUS_BADGE_MAP[s.type] || { label: s.type };
      if (s.type === "dot") {
        extraParts.push(`${targetName}에게 ${info.label}(매턴 ${s.amount}, ${s.remainingTurns}턴) 부여`);
      } else if (s.type === "attackBuff" || s.type === "defBuff" || s.type === "maxAttackCostBuff") {
        extraParts.push(`${targetName}의 ${info.label}이(가) ${s.remainingTurns}턴간 +${s.amount} 상승`);
      } else if (s.type === "damageReduction") {
        extraParts.push(`${targetName}이(가) ${s.remainingTurns}턴간 받는 피해 ${s.amount} 감소 효과 획득`);
      } else if (s.type === "costUp") {
        extraParts.push(`${targetName}의 카드 코스트가 ${s.remainingTurns}턴간 +${s.amount} 증가`);
      } else {
        extraParts.push(`${targetName}에게 ${info.label} ${s.remainingTurns}턴 부여`);
      }
    });

    if (extraParts.length > 0) {
      line.innerHTML += ` <span class="bonus-text">(${extraParts.join(", ")})</span>`;
    }

    combatLog.prepend(line);

    // 방어자 카드에 피격(빨강+흔들림) 또는 완전방어(초록빛) 애니메이션을 잠깐 재생
    triggerCardFlash(defenderSocketId, damageDealt > 0 ? "damage-flash" : "block-flash");

    // 전투가 실제로 끝났으니, 내가 방어자였다면 배너/버튼을 닫고 손패를 평소 상태로 되돌림
    if (isDefending) {
      isDefending = false;
      pendingAttackElement = null;
      selectedDefenseCardIds = [];
      defenseBanner.classList.add("hidden");
      confirmDefenseBtn.classList.add("hidden");
      cancelDefenseBtn.classList.add("hidden");
      renderHand();
    }

    // 화면 중앙의 공격/방어 카드가 사라진 뒤, 이번 공격으로 들어간 피해 수치(또는 "방어함")를
    // 큼직하게 잠깐 띄움 (2026-08-29). 다중 대상이면 카드가 안 사라지므로 짧게 겹쳐 보여줌
    showCombatResultNumber(damageDealt, hasMoreTargets);

    // 다중 대상 카드(흙먼지폭풍 등)가 아직 다음 대상에게 이어질 예정이면, 연출을 끄지 않고 이어감
    // (곧바로 game:attackAnnounced가 다시 와서 카드 내용을 새로 채워줌 - 8단계 Phase 3, 2026-08-26)
    if (!hasMoreTargets) {
      // 전원의 화면에서 공통으로 진행 중이던 전투 연출을 종료
      isCasting = false;
      clearCombatStackWithDelay();
    }
  }
);

// 화면 중앙에 이번 전투 결과 수치를 잠깐 띄움. damage가 0 이하면 "방어함"으로 표시.
// delayLong=true(단일 대상)면 중앙 카드가 페이드아웃으로 사라진 뒤에 뜨도록 딜레이를 길게 줌.
function showCombatResultNumber(damage, hasMoreTargets) {
  const isBlocked = !(damage > 0);
  const text = isBlocked ? "방어함" : `-${damage}`;
  const delay = hasMoreTargets ? 350 : 900; // 900ms ≈ clearCombatStackWithDelay가 카드를 지우는 시점

  window.setTimeout(() => {
    combatResultNumber.textContent = text;
    combatResultNumber.className = "combat-result-number" + (isBlocked ? " blocked" : "");
    // 방금 붙인 클래스로 트랜지션이 시작되도록 강제 리플로우 후 show
    void combatResultNumber.offsetWidth;
    combatResultNumber.classList.add("show");
    window.setTimeout(() => {
      combatResultNumber.classList.remove("show");
    }, 1100);
  }, delay);
}

// ---- 누군가 기절 상태라 턴을 자동으로 건너뛸 때 (8단계 Phase 2, 2026-08-26) ----
socket.on("game:playerStunned", ({ nickname, remainingTurns }) => {
  const line = document.createElement("p");
  line.innerHTML = `${escapeHtml(nickname)}님은 기절 상태라 턴을 건너뜁니다. <span class="bonus-text">(남은 기절 ${remainingTurns}턴)</span>`;
  combatLog.prepend(line);
});

// ---- 화상(DoT) 등 개인 지속상태가 턴 전환 시 발동할 때 (8단계 Phase 2, 2026-08-26) ----
socket.on("game:statusesTicked", ({ dotTicks }) => {
  dotTicks.forEach((t) => {
    const line = document.createElement("p");
    line.innerHTML = `${escapeHtml(t.nickname)}님이 화상 피해 ${t.damage}를 입었습니다. <span class="bonus-text">(남은 ${t.remainingTurns}턴)</span>`;
    combatLog.prepend(line);
  });
});

// ==================== 필드 (지형 / 효과) ====================

// ---- 누군가 필드 카드(지형 or 효과)를 사용했을 때 방 전체에 방송됨 ----
// 무슨 효과인지(어떤 속성을 강화하는지 / 얼마나 몇 턴간 피해를 주는지)까지 강조색으로 같이 보여줌
socket.on(
  "game:fieldCardPlayed",
  // description을 그대로 보여주는 방식으로 단순화 (8단계 Phase 3, 2026-08-26) - renderFieldStatus()와 같은 이유
  ({ playerNickname, cardName, fieldType, description }) => {
    const safeNickname = escapeHtml(playerNickname);
    const safeCardName = escapeHtml(cardName);
    const typeLabel = fieldType === "terrain" ? "지형" : "효과";

    const line = document.createElement("p");
    line.innerHTML = `${safeNickname}님이 ${typeLabel} 카드 "${safeCardName}"을(를) 사용했습니다. <span class="bonus-text">${escapeHtml(description)}</span>`;
    combatLog.prepend(line);
  }
);

// ---- 턴이 넘어갈 때 효과 카드들이 발동됐을 때 ----
socket.on("game:effectsTicked", ({ effects }) => {
  effects.forEach((eff) => {
    const line = document.createElement("p");
    line.textContent = `"${eff.cardName}" 효과 발동! 생존자 전원이 ${eff.tickDamage}의 피해를 입었습니다.`;
    combatLog.prepend(line);
  });
});

// ---- 게임 종료 ----
// 게임 종료 화면 전환. game:over(그 순간 연결되어 있던 사람들에게 방송)와, 게임이 이미 끝난
// 뒤에 재접속한 사람이 room:updated(status:"ended")로 결과를 알게 되는 경우 양쪽에서 공용으로 씀
// (재접속 처리, 2026-08-27)
function showGameOverScreen(winnerNickname) {
  gameSection.classList.add("hidden");
  // #room/#lobby는 대기실 단계 이후로 다시 hidden이 안 붙은 채로 남아있을 수 있음 (게임 중엔
  // #app 자체가 숨겨져 있어서 안 보였을 뿐, 클래스 자체는 그대로였음) - #app을 다시 보여주기
  // 전에 명시적으로 정리해둬야 게임 종료 화면 위에 대기실 내용이 같이 겹쳐 보이는 걸 막을 수 있음
  lobbySection.classList.add("hidden");
  roomSection.classList.add("hidden");
  defenseBanner.classList.add("hidden");
  confirmDefenseBtn.classList.add("hidden");
  cancelDefenseBtn.classList.add("hidden");
  isDefending = false;
  pendingAttackElement = null;
  selectedDefenseCardIds = [];
  pendingFieldCard = null;
  castOverlay.classList.add("hidden");
  isCasting = false;
  combatOverlay.classList.add("hidden");
  combatOverlay.classList.remove("fading-out");
  combatStack.innerHTML = "";
  combatStackCards = [];
  combatResultNumber.classList.remove("show");
  pendingHandSwap = null; // 손패 교체 도중 게임이 끝났을 수도 있으니 같이 정리
  selectedSwapReplaceInstanceId = null;
  handSwapOverlay.classList.add("hidden");
  handSwapDeclineBtn.classList.add("hidden");
  handSwapClearBtn.classList.add("hidden");
  handSwapConfirmBtn.classList.add("hidden");
  appDiv.classList.remove("hidden"); // 게임 보드를 숨기고 #app(게임 종료 화면)을 다시 보여줌
  gameSection.style.background = DEFAULT_BACKGROUND; // 지형 배경 테마도 기본값으로 복귀
  gameOverSection.classList.remove("hidden");
  winnerLabel.textContent = winnerNickname ? `승자: ${winnerNickname}` : "생존자가 없습니다.";
  // 재시작(2026-08-27): 방장에게만 "다시 시작" 버튼을, 나머지에게는 안내 문구를 보여줌
  const isHost = currentHostSocketId === socket.id;
  playAgainBtn.classList.toggle("hidden", !isHost);
  playAgainHint.classList.toggle("hidden", isHost);
  clearSession(); // 게임이 끝났으니 다음에 새로고침해도 이 방으로 재접속을 시도하지 않게 함
}

playAgainBtn.addEventListener("click", () => {
  socket.emit("game:playAgain", { roomId: currentRoomId });
});

socket.on("game:over", ({ winnerNickname }) => {
  showGameOverScreen(winnerNickname);
});
