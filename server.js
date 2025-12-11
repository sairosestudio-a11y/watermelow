const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
  res.send('Relay active.');
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const clientRoom = new WeakMap();

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    let obj;
    try {
      obj = JSON.parse(message.toString());
    } catch (e) { return; }

    if (!obj || typeof obj.room !== 'string' || typeof obj.payload !== 'string') return;

    clientRoom.set(ws, obj.room);

    wss.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;

      const room = clientRoom.get(client);
      if (room === obj.room) {
        client.send(JSON.stringify({ room: obj.room, payload: obj.payload }));
      }
    });
  });

  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log("Relay running on", PORT);
});
