const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const APPROVALS_REQUIRED = parseInt(process.env.APPROVALS_REQUIRED, 10) || 1;
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

// --- Persistence ---
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {
      nextId: 1,
      production: { bubbles: [], connections: [] },
      dev: null
    };
  }
}

let state = loadState();
let savePending = false;
const MAX_UNDO = 50;
let undoStack = []; // stores snapshots of state before each mutation

function saveState() {
  if (savePending) return;
  savePending = true;
  setTimeout(() => {
    savePending = false;
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }, 1000);
}

// --- Users ---
const clients = new Map(); // ws -> { ip }

function getIp(req) {
  let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  ip = ip.replace(/^::ffff:/, '');
  return ip;
}

function broadcastUsers() {
  const ips = [...new Set([...clients.values()].map(c => c.ip))];
  for (const [ws, info] of clients) {
    send(ws, { type: 'users', users: ips, yourIp: info.ip });
  }
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients.keys()) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastState() {
  broadcast({
    type: 'state',
    production: state.production,
    dev: state.dev,
    approvalsRequired: APPROVALS_REQUIRED
  });
  saveState();
}

// --- Helpers ---
function getTarget(ws, target) {
  if (target === 'production') {
    send(ws, { type: 'error', message: 'Production cannot be edited directly.' });
    return null;
  }
  if (target === 'dev' && state.dev) return state.dev;
  return null;
}

function connKey(from, to) { return `${from}->${to}`; }

function pushUndo() {
  undoStack.push(JSON.parse(JSON.stringify({ nextId: state.nextId, production: state.production, dev: state.dev })));
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

// --- WebSocket ---
wss.on('connection', (ws, req) => {
  const ip = getIp(req);
  clients.set(ws, { ip });

  send(ws, {
    type: 'init',
    production: state.production,
    dev: state.dev,
    yourIp: ip,
    users: [...new Set([...clients.values()].map(c => c.ip))],
    approvalsRequired: APPROVALS_REQUIRED
  });
  broadcastUsers();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(ws, ip, msg);
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcastUsers();
  });
});

function handleMessage(ws, ip, msg) {
  switch (msg.type) {

    case 'undo': {
      if (undoStack.length === 0) return send(ws, { type: 'error', message: 'Nothing to undo.' });
      const prev = undoStack.pop();
      state.nextId = prev.nextId;
      state.production = prev.production;
      state.dev = prev.dev;
      broadcastState();
      break;
    }

    case 'addBubble': {
      const chart = getTarget(ws, msg.target);
      if (!chart) return send(ws, { type: 'error', message: 'Cannot edit this chart right now.' });
      pushUndo();
      const id = state.nextId++;
      const b = { id, x: msg.x, y: msg.y, w: msg.w || 140, h: msg.h || 64, label: msg.label || 'Bubble' };
      chart.bubbles.push(b);
      broadcastState();
      break;
    }

    case 'moveBubble': {
      const chart = getTarget(ws, msg.target);
      if (!chart) return;
      pushUndo();
      const b = chart.bubbles.find(b => b.id === msg.id);
      if (b) { b.x = msg.x; b.y = msg.y; }
      broadcastState();
      break;
    }

    case 'renameBubble': {
      const chart = getTarget(ws, msg.target);
      if (!chart) return;
      pushUndo();
      const b = chart.bubbles.find(b => b.id === msg.id);
      if (b) { b.label = msg.label; b.w = msg.w || b.w; }
      broadcastState();
      break;
    }

    case 'deleteBubble': {
      const chart = getTarget(ws, msg.target);
      if (!chart) return;
      pushUndo();

      if (msg.target === 'dev' && state.dev) {
        if (state.dev.baseBubbleIds.includes(msg.id)) {
          if (!state.dev.removedBubbleIds.includes(msg.id)) {
            state.dev.removedBubbleIds.push(msg.id);
            state.dev.connections.forEach(c => {
              if (c.from === msg.id || c.to === msg.id) {
                const key = connKey(c.from, c.to);
                if (state.dev.baseConnectionKeys.includes(key) && !state.dev.removedConnectionKeys.includes(key)) {
                  state.dev.removedConnectionKeys.push(key);
                }
              }
            });
          }
        } else {
          chart.bubbles = chart.bubbles.filter(b => b.id !== msg.id);
          chart.connections = chart.connections.filter(c => c.from !== msg.id && c.to !== msg.id);
        }
      } else {
        chart.bubbles = chart.bubbles.filter(b => b.id !== msg.id);
        chart.connections = chart.connections.filter(c => c.from !== msg.id && c.to !== msg.id);
      }
      broadcastState();
      break;
    }

    case 'addConnection': {
      const chart = getTarget(ws, msg.target);
      if (!chart) return;
      pushUndo();
      const exists = chart.connections.some(c => c.from === msg.from && c.to === msg.to);
      const wps = Array.isArray(msg.waypoints) ? msg.waypoints.map(p => ({ x: p.x, y: p.y })) : [];
      if (!exists) chart.connections.push({ from: msg.from, to: msg.to, waypoints: wps });
      if (msg.target === 'dev' && state.dev) {
        const key = connKey(msg.from, msg.to);
        state.dev.removedConnectionKeys = state.dev.removedConnectionKeys.filter(k => k !== key);
      }
      broadcastState();
      break;
    }

    case 'deleteConnection': {
      const chart = getTarget(ws, msg.target);
      if (!chart) return;
      pushUndo();
      if (msg.target === 'dev' && state.dev) {
        const key = connKey(msg.from, msg.to);
        if (state.dev.baseConnectionKeys.includes(key)) {
          if (!state.dev.removedConnectionKeys.includes(key)) {
            state.dev.removedConnectionKeys.push(key);
          }
        } else {
          chart.connections = chart.connections.filter(c => !(c.from === msg.from && c.to === msg.to));
        }
      } else {
        chart.connections = chart.connections.filter(c => !(c.from === msg.from && c.to === msg.to));
      }
      broadcastState();
      break;
    }

    case 'forkDev': {
      if (state.dev) return; // already exists, no-op
      pushUndo();
      state.dev = {
        author: ip,
        baseBubbleIds: state.production.bubbles.map(b => b.id),
        baseConnectionKeys: state.production.connections.map(c => connKey(c.from, c.to)),
        bubbles: JSON.parse(JSON.stringify(state.production.bubbles)),
        connections: JSON.parse(JSON.stringify(state.production.connections)),
        removedBubbleIds: [],
        removedConnectionKeys: [],
        approvals: []
      };
      broadcastState();
      break;
    }

    case 'discardDev': {
      if (!state.dev) return;
      pushUndo();
      state.dev = null;
      broadcastState();
      break;
    }

    case 'approveDev': {
      if (!state.dev) return;
      if (state.dev.approvals.includes(ip)) return send(ws, { type: 'error', message: 'You have already approved.' });
      pushUndo();
      state.dev.approvals.push(ip);
      broadcastState();
      break;
    }

    case 'pushToProduction': {
      if (!state.dev) return;
      if (state.dev.approvals.length < APPROVALS_REQUIRED) {
        return send(ws, { type: 'error', message: `Need ${APPROVALS_REQUIRED} approvals (have ${state.dev.approvals.length}).` });
      }
      pushUndo();
      const removedSet = new Set(state.dev.removedBubbleIds);
      const removedConnSet = new Set(state.dev.removedConnectionKeys);
      state.production = {
        bubbles: state.dev.bubbles.filter(b => !removedSet.has(b.id)),
        connections: state.dev.connections.filter(c => !removedConnSet.has(connKey(c.from, c.to)))
      };
      state.dev = null;
      broadcastState();
      break;
    }
  }
}

// --- Static files ---
app.use(express.static(path.join(__dirname, 'public')));

server.listen(PORT, () => {
  console.log(`Flowchart server running at http://localhost:${PORT}`);
  console.log(`Approvals required: ${APPROVALS_REQUIRED}`);
});
