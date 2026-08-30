// roomStore.js
// 모든 방(Room 인스턴스)을 저장하는 공용 저장소입니다.
// 예전에는 이 Map이 roomHandlers.js 안에 있었는데, 재접속 처리를 위해 roomHandlers.js가
// gameHandlers.js의 턴 진행 로직(advanceTurnAndTick 등)도 가져다 써야 하는 상황이 생겼습니다.
// gameHandlers.js는 원래도 "rooms"가 필요해서 roomHandlers.js를 require하고 있었는데,
// 거꾸로 roomHandlers.js가 gameHandlers.js를 require해버리면 두 파일이 서로를 참조하는
// "순환 참조"가 됩니다. 그래서 rooms Map만 이 파일로 따로 빼서, 두 파일 다 여기서 가져다
// 쓰게 만들었습니다 (roomHandlers -> gameHandlers -> roomStore, roomHandlers -> roomStore
// 순서라 순환이 생기지 않습니다).

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

module.exports = { rooms, generateRoomId };
