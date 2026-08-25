// elementTable.js
// 오행(五行) 속성 상성 테이블입니다. 여기 있는 관계는 순수한 데이터/규칙이라서
// Spring Boot로 치면 enum + 상수 매핑 정도의 역할이라고 보면 됩니다.

// 상극(相剋) — 방어 시 코스트 할인에 사용
// key가 value를 이긴다(카운터한다): 목극토, 토극수, 수극화, 화극금, 금극목
const COUNTER_MAP = {
  목: "토",
  토: "수",
  수: "화",
  화: "금",
  금: "목",
};

// 상생(相生) — 필드 지형 강화에 사용 (5단계 필드 시스템에서 사용 예정)
// key가 value를 강화한다: 목생화, 화생토, 토생금, 금생수, 수생목
const GENERATE_MAP = {
  목: "화",
  화: "토",
  토: "금",
  금: "수",
  수: "목",
};

// defenderElement가 attackerElement를 상극(카운터)하는 관계인지 확인
function isCounter(defenderElement, attackerElement) {
  return COUNTER_MAP[defenderElement] === attackerElement;
}

module.exports = { COUNTER_MAP, GENERATE_MAP, isCounter };
