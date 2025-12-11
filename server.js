// server.js - Permanent ciphertext storage chat relay with IP-based profiles (no signup)
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '2mb' }));

// Enable CORS so Netlify frontend can call backend
app.use(cors({
  origin: true,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

const PORT = process.env.PORT || 10000;
const MONGO_URI = process.env.MONGO_URI || '';
const IP_SALT = process.env.IP_SALT || '';

if(!MONGO_URI){
  console.error('MONGO_URI not set');
  process.exit(1);
}

let db;
async function init(){
  const client = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  await client.connect();
  db = client.db();

  await db.collection('rooms').createIndex({ roomId: 1 }, { unique: true });
  await db.collection('messages').createIndex({ room: 1, timestamp: 1 });
  await db.collection('profiles').createIndex({ ipHash: 1 }, { unique: true });

  console.log('Connected to MongoDB');
}
init().catch(err => { console.error(err); process.exit(1); });

function hashIp(ip){
  return crypto.createHash('sha256').update((ip || '') + '::' + IP_SALT).digest('hex');
}

function clientIp(req){
  const hdr = req.headers['x-forwarded-for'];
  if(hdr) return hdr.split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

// Create Room
app.post('/create-room', async (req, res) => {
  try{
    const { roomId, password, displayName } = req.body;
    if(!roomId || !password) return res.status(400).json({ error: 'roomId and password required' });

    const exists = await db.collection('rooms').findOne({ roomId });
    if(exists) return res.status(409).json({ error: 'room exists' });

    const hash = await bcrypt.hash(password, 10);

    await db.collection('rooms').insertOne({
      roomId,
      passwordHash: hash,
      displayName: displayName || '',
      createdAt: new Date()
    });

    return res.json({ ok: true });
  }catch(e){
    console.error(e);
    return res.status(500).json({ error: 'server' });
  }
});

// Join Room
app.post('/join-room', async (req, res) => {
  try{
    const { roomId, password } = req.body;
    if(!roomId || !password) return res.status(400).json({ error: 'roomId and password required' });

    const room = await db.collection('rooms').findOne({ roomId });
    if(!room) return res.status(404).json({ error: 'not found' });

    const ok = await bcrypt.compare(password, room.passwordHash);
    if(!ok) return res.status(403).json({ error: 'wrong password' });

    return res.json({ ok: true });
  }catch(e){
    console.error(e);
    return res.status(500).json({ error: 'server' });
  }
});

// Chat history
app.get('/history', async (req, res) => {
  try{
    const room = req.query.room;
    if(!room) return res.status(400).json({ error: 'room required' });

    const docs = await db.collection('messages').find({ room })
      .sort({ timestamp: 1 })
      .limit(2000)
      .toArray();

    const out = docs.map(d => ({
      payload: d.payload,
      timestamp: d.timestamp
    }));

    return res.json({ ok: true, messages: out });
  }catch(e){
    console.error(e);
    return res.status(500).json({ error: 'server' });
  }
});

// Profile (IP-based)
app.post('/profile', async (req, res) => {
  try{
    const ip = clientIp(req);
    const ipHash = hashIp(ip);
    const { displayName } = req.body;

    const now = new Date();

    await db.collection('profiles').updateOne(
      { ipHash },
      { $set: { displayName: displayName || '', lastSeen: now, ipHash } },
      { upsert: true }
    );

    return res.json({ ok: true });
  }catch(e){
    console.error(e);
    return res.status(500).json({ error: 'server' });
  }
});

// Status
app.get('/status', (req, res) => res.json({ ok: true }));

// WebSocket server setup
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const clientRoom = new WeakMap();
const clientProfile = new WeakMap();

wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0].trim();

  const ipHash = hashIp(ip || '');

  clientProfile.set(ws, { ipHash });
  ws.isAlive = true;

  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', async (data) => {
    let obj;
    try { obj = JSON.parse(data.toString()); } catch(e) { return; }

    const type = obj.type || 'message';

    if(type === 'join'){
      const room = obj.room;
      clientRoom.set(ws, room);

      try {
        await db.collection('profiles').updateOne(
          { ipHash },
          { $set: { online: true, lastSeen: new Date() } },
          { upsert: true }
        );
      } catch(e){}

      broadcast(room, JSON.stringify({ type: 'presence', room, ipHash }));
      return;
    }

    if(type === 'typing'){
      const room = obj.room;
      broadcast(room, JSON.stringify({ type:'typing', room, ipHash, typing: !!obj.typing }));
      return;
    }

    if(type === 'message'){
      const room = obj.room;
      const payload = obj.payload;
      const timestamp = new Date();

      try {
        await db.collection('messages').insertOne({ room, payload, timestamp });
      } catch(e){ console.error('db insert', e); }

      broadcast(room, JSON.stringify({ type:'message', room, payload, timestamp }));
      return;
    }
  });

  ws.on('close', async () => {
    const room = clientRoom.get(ws);
    const prof = clientProfile.get(ws);

    if(prof && prof.ipHash){
      try{
        await db.collection('profiles').updateOne(
          { ipHash: prof.ipHash },
          { $set: { online: false, lastSeen: new Date() } }
        );
      } catch(e){}

      if(room) broadcast(room, JSON.stringify({ type:'presence', room, ipHash: prof.ipHash }));
    }
  });
});

function broadcast(room, msg){
  wss.clients.forEach(c => {
    if(c.readyState !== 1) return;
    const r = clientRoom.get(c);
    if(r === room) c.send(msg);
  });
}

setInterval(() => {
  wss.clients.forEach(ws => {
    if(!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);

server.listen(PORT, () => console.log("Server running on", PORT));
