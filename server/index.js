// index.js
// 서버의 시작점입니다. "이 파일을 실행하면 서버가 켜진다"고 보시면 됩니다.
// Spring Boot의 @SpringBootApplication이 붙은 메인 클래스와 같은 역할이에요.

const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { registerRoomHandlers } = require("./socket/roomHandlers");
const { registerGameHandlers } = require("./socket/gameHandlers");

const app = express();
const server = http.createServer(app); // Express 앱을 감싸는 진짜 서버 객체
const io = new Server(server); // 이 서버 위에 Socket.io를 얹음

const PORT = process.env.PORT || 3000;

// client 폴더를 정적 파일(HTML/CSS/JS)로 서빙
// -> 브라우저에서 http://localhost:3000 접속하면 client/index.html이 보임
app.use(express.static(path.join(__dirname, "..", "client")));

// 클라이언트가 새로 연결될 때마다 이 콜백이 실행됨
// (한 명이 브라우저를 열 때마다 한 번씩 실행된다고 보면 됩니다)
io.on("connection", (socket) => {
  console.log(`[연결] socket ${socket.id}`);

  // 방 관련 이벤트(room:create, room:join 등)를 이 소켓에 등록
  registerRoomHandlers(io, socket);

  // 게임 진행(턴) 관련 이벤트를 이 소켓에 등록
  registerGameHandlers(io, socket);
});

server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
