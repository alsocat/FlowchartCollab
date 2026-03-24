// === CONFIG ===
const GRID = 40;
const CORNER_RADIUS = 12;
const BUBBLE_H = 64;
const MIN_BUBBLE_W = 120;
const GRAVEYARD_GAP = 80;

const COLOR_GREEN = '#a6e3a1';
const COLOR_YELLOW = '#f9e2af';
const COLOR_RED = '#f38ba8';
const COLOR_LINE = '#6c7086';
const COLOR_BG = '#1e1e2e';
const COLOR_GRID = '#313244';

function snap(v) { return Math.round(v / GRID) * GRID; }

// === CANVAS ===
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let W, H;
function resize() {
  W = canvas.width = window.innerWidth;
  H = canvas.height = window.innerHeight;
  requestAnimationFrame(draw);
}
window.addEventListener('resize', resize);
W = canvas.width = window.innerWidth;
H = canvas.height = window.innerHeight;

// === STATE ===
let state = { production: { bubbles: [], connections: [] }, dev: null };
let approvalsRequired = 3;
let users = [];
let myIp = '';
let viewTarget = 'production'; // 'production' | 'dev'
let cam = { x: 0, y: 0, zoom: 1 };
let mode = 'pan'; // pan | connect | delete
let dragging = null;
let panning = false;
let panStart = { x: 0, y: 0 };
let connectFrom = null;
let connectWaypoints = []; // grid points placed during connection
let mouseWorld = { x: 0, y: 0 };

// === WEBSOCKET ===
let ws = null;
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => console.log('Connected');

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'init':
        state.production = msg.production;
        state.dev = msg.dev;
        myIp = msg.yourIp;
        users = msg.users;
        approvalsRequired = msg.approvalsRequired || 3;
        updateUI();
        fitToWindow();
        draw();
        break;
      case 'state':
        state.production = msg.production;
        state.dev = msg.dev;
        approvalsRequired = msg.approvalsRequired || approvalsRequired;
        // If viewing dev but dev was cleared, switch to production
        if (viewTarget === 'dev' && !state.dev) viewTarget = 'production';
        updateUI();
        draw();
        break;
      case 'users':
        users = msg.users;
        myIp = msg.yourIp;
        updateUsers();
        break;
      case 'error':
        showError(msg.message);
        break;
    }
  };

  ws.onclose = () => {
    console.log('Disconnected, reconnecting...');
    setTimeout(connectWs, 2000);
  };
}

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// === UI ===
const btnAdd = document.getElementById('btnAdd');
const btnConnect = document.getElementById('btnConnect');
const btnDelete = document.getElementById('btnDelete');
const btnExport = document.getElementById('btnExport');
const btnUndo = document.getElementById('btnUndo');
const tabProd = document.getElementById('tabProd');
const tabDev = document.getElementById('tabDev');
const devInfo = document.getElementById('devInfo');
const approvalCount = document.getElementById('approvalCount');
const btnApprove = document.getElementById('btnApprove');
const btnPush = document.getElementById('btnPush');
const btnDiscard = document.getElementById('btnDiscard');
const errorEl = document.getElementById('error');

function devHasChanges() {
  if (!state.dev) return false;
  if (state.dev.removedBubbleIds.length > 0) return true;
  if (state.dev.removedConnectionKeys.length > 0) return true;
  // Check for added bubbles (ids not in base)
  for (const b of state.dev.bubbles) {
    if (!state.dev.baseBubbleIds.includes(b.id)) return true;
  }
  // Check for added connections
  for (const c of state.dev.connections) {
    const key = `${c.from}->${c.to}`;
    if (!state.dev.baseConnectionKeys.includes(key)) return true;
  }
  // Check for moved/renamed bubbles
  const prodMap = new Map(state.production.bubbles.map(b => [b.id, b]));
  for (const b of state.dev.bubbles) {
    const pb = prodMap.get(b.id);
    if (pb && (pb.x !== b.x || pb.y !== b.y || pb.label !== b.label)) return true;
  }
  // Check for changed waypoints
  const prodConnMap = new Map(state.production.connections.map(c => [`${c.from}->${c.to}`, c]));
  for (const c of state.dev.connections) {
    const key = `${c.from}->${c.to}`;
    const pc = prodConnMap.get(key);
    if (pc && JSON.stringify(c.waypoints || []) !== JSON.stringify(pc.waypoints || [])) return true;
  }
  return false;
}

function updateUI() {
  const hasDev = !!state.dev;
  const hasChanges = devHasChanges();

  // View tabs — always show both
  tabProd.classList.toggle('active', viewTarget === 'production');
  tabDev.classList.remove('dev-active', 'dev-clean');
  if (viewTarget === 'dev') {
    tabDev.classList.add(hasChanges ? 'dev-active' : 'dev-clean');
  }

  // Edit buttons: only enabled when viewing dev
  const canEdit = viewTarget === 'dev';
  btnAdd.disabled = !canEdit;
  btnConnect.disabled = !canEdit;
  btnDelete.disabled = !canEdit;

  // Dev info bar: show when viewing dev AND there are actual changes
  if (hasDev && viewTarget === 'dev' && hasChanges) {
    devInfo.classList.remove('hidden');
    const count = state.dev.approvals.length;
    approvalCount.textContent = `${count}/${approvalsRequired} approvals`;
    btnApprove.disabled = !hasDev || state.dev.approvals.includes(myIp);
    btnPush.disabled = !hasDev || count < approvalsRequired;
  } else {
    devInfo.classList.add('hidden');
  }

  updateUsers();
}

function updateUsers() {
  const container = document.getElementById('userIps');
  container.innerHTML = '';
  for (const ip of users) {
    const div = document.createElement('div');
    div.className = 'ip' + (ip === myIp ? ' you' : '');
    div.textContent = ip + (ip === myIp ? ' (you)' : '');
    container.appendChild(div);
  }
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.style.display = 'block';
  setTimeout(() => { errorEl.style.display = 'none'; }, 3000);
}

// === COORDINATE TRANSFORMS ===
function screenToWorld(sx, sy) {
  return { x: (sx - W / 2) / cam.zoom + cam.x, y: (sy - H / 2) / cam.zoom + cam.y };
}
function worldToScreen(wx, wy) {
  return { x: (wx - cam.x) * cam.zoom + W / 2, y: (wy - cam.y) * cam.zoom + H / 2 };
}

// === FIT TO WINDOW ===
function fitToWindow() {
  const chart = getActiveChart();
  if (chart.bubbles.length === 0) { cam.x = 0; cam.y = 0; cam.zoom = 1; return; }

  const pad = 80;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of chart.bubbles) {
    const bw = b.w || MIN_BUBBLE_W, bh = b.h || BUBBLE_H;
    minX = Math.min(minX, b.x - bw / 2);
    minY = Math.min(minY, b.y - bh / 2);
    maxX = Math.max(maxX, b.x + bw / 2);
    maxY = Math.max(maxY, b.y + bh / 2);
  }
  for (const c of chart.connections) {
    for (const wp of (c.waypoints || [])) {
      minX = Math.min(minX, wp.x); minY = Math.min(minY, wp.y);
      maxX = Math.max(maxX, wp.x); maxY = Math.max(maxY, wp.y);
    }
  }

  const cw = maxX - minX + pad * 2;
  const ch = maxY - minY + pad * 2;
  cam.x = (minX + maxX) / 2;
  cam.y = (minY + maxY) / 2;
  cam.zoom = Math.min(2, Math.min(W / cw, H / ch));
}

// === ACTIVE CHART ===
function getActiveChart() {
  if (viewTarget === 'dev' && state.dev) return state.dev;
  return state.production;
}

// === MEASURE BUBBLE ===
function measureBubbleWidth(label) {
  ctx.font = '16px system-ui, sans-serif';
  const m = ctx.measureText(label);
  return Math.max(MIN_BUBBLE_W, m.width + 48);
}

// === HIT TEST ===
function hitTest(wx, wy) {
  const chart = getActiveChart();
  const bubbles = getVisibleBubbles(chart);
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];
    const bw = b.w || MIN_BUBBLE_W, bh = b.h || BUBBLE_H;
    if (wx >= b.x - bw / 2 && wx <= b.x + bw / 2 && wy >= b.y - bh / 2 && wy <= b.y + bh / 2) {
      return b;
    }
  }
  return null;
}

function hitTestConnection(wx, wy) {
  const chart = getActiveChart();
  const threshold = 8 / cam.zoom;
  const graveyardY = (viewTarget === 'dev' && state.dev) ? getGraveyardY(chart) : 0;
  const conns = getVisibleConnections(chart);
  for (let i = conns.length - 1; i >= 0; i--) {
    const c = conns[i];
    const from = chart.bubbles.find(b => b.id === c.from);
    const to = chart.bubbles.find(b => b.id === c.to);
    if (!from || !to) continue;
    const fromPos = getBubbleDrawPos(from, graveyardY);
    const toPos = getBubbleDrawPos(to, graveyardY);
    const wps = c.waypoints || [];

    // Build the same point list used for drawing
    const firstTarget = wps.length > 0 ? wps[0] : toPos;
    const lastSource = wps.length > 0 ? wps[wps.length - 1] : fromPos;
    const p1 = rectIntersection(fromPos.x, fromPos.y, from.w || MIN_BUBBLE_W, from.h || BUBBLE_H, firstTarget.x, firstTarget.y);
    const p2 = rectIntersection(toPos.x, toPos.y, to.w || MIN_BUBBLE_W, to.h || BUBBLE_H, lastSource.x, lastSource.y);
    const points = [p1, ...wps, p2];

    // Test against each segment
    for (let j = 0; j < points.length - 1; j++) {
      const dist = pointToSegDist(wx, wy, points[j].x, points[j].y, points[j + 1].x, points[j + 1].y);
      if (dist < threshold) return c;
    }
  }
  return -1;
}

function pointToSegDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// === GEOMETRY: rect edge intersection ===
function rectIntersection(cx, cy, w, h, tx, ty) {
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = w / 2, hh = h / 2;
  // Find t for each edge
  const tRight = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const tBottom = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(tRight, tBottom);
  return { x: cx + dx * t, y: cy + dy * t };
}

// === DEV-AWARE BUBBLE/CONNECTION HELPERS ===
function getBubbleColor(chart, bubble) {
  if (viewTarget === 'production' || !state.dev) return COLOR_GREEN;
  if (state.dev.removedBubbleIds.includes(bubble.id)) return COLOR_RED;
  if (state.dev.baseBubbleIds.includes(bubble.id)) return COLOR_GREEN;
  return COLOR_YELLOW;
}

function getConnectionColor(chart, conn) {
  if (viewTarget === 'production' || !state.dev) return COLOR_LINE;
  const key = `${conn.from}->${conn.to}`;
  if (state.dev.removedConnectionKeys.includes(key)) return COLOR_RED;
  if (state.dev.baseConnectionKeys.includes(key)) return COLOR_LINE;
  return COLOR_YELLOW;
}

function isConnectionRemoved(conn) {
  if (!state.dev || viewTarget !== 'dev') return false;
  return state.dev.removedConnectionKeys.includes(`${conn.from}->${conn.to}`);
}

function getVisibleBubbles(chart) {
  // In dev view, include removed bubbles (they render at bottom)
  return chart.bubbles;
}

function getVisibleConnections(chart) {
  return chart.connections;
}

// === GRAVEYARD: compute positions for removed bubbles ===
function getGraveyardY(chart) {
  let maxY = 0;
  for (const b of chart.bubbles) {
    if (!state.dev || !state.dev.removedBubbleIds.includes(b.id)) {
      maxY = Math.max(maxY, b.y + (b.h || BUBBLE_H) / 2);
    }
  }
  return maxY + GRAVEYARD_GAP + 100;
}

// === GRID ===
function drawGrid() {
  const topLeft = screenToWorld(0, 0);
  const bottomRight = screenToWorld(W, H);
  const startX = snap(topLeft.x) - GRID;
  const startY = snap(topLeft.y) - GRID;
  const endX = bottomRight.x + GRID;
  const endY = bottomRight.y + GRID;

  ctx.fillStyle = COLOR_GRID;
  for (let x = startX; x <= endX; x += GRID) {
    for (let y = startY; y <= endY; y += GRID) {
      ctx.beginPath();
      ctx.arc(x, y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// === DRAW ===
function draw() {
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);

  drawGrid();

  const chart = getActiveChart();
  const graveyardY = (viewTarget === 'dev' && state.dev) ? getGraveyardY(chart) : 0;

  // Draw connections
  for (const c of chart.connections) {
    const removed = isConnectionRemoved(c);
    const from = chart.bubbles.find(b => b.id === c.from);
    const to = chart.bubbles.find(b => b.id === c.to);
    if (!from || !to) continue;

    const fromPos = getBubbleDrawPos(from, graveyardY);
    const toPos = getBubbleDrawPos(to, graveyardY);
    const wps = c.waypoints || [];
    const color = getConnectionColor(chart, c);

    // Build full point list: from-edge, waypoints, to-edge
    const firstTarget = wps.length > 0 ? wps[0] : toPos;
    const lastSource = wps.length > 0 ? wps[wps.length - 1] : fromPos;
    const p1 = rectIntersection(fromPos.x, fromPos.y, from.w || MIN_BUBBLE_W, from.h || BUBBLE_H, firstTarget.x, firstTarget.y);
    const p2 = rectIntersection(toPos.x, toPos.y, to.w || MIN_BUBBLE_W, to.h || BUBBLE_H, lastSource.x, lastSource.y);

    const points = [p1, ...wps, p2];
    drawPath(points, color, removed);
  }

  // Draw in-progress connection with waypoints
  if (mode === 'connect' && connectFrom) {
    const fromPos = getBubbleDrawPos(connectFrom, graveyardY);
    const firstTarget = connectWaypoints.length > 0 ? connectWaypoints[0] : mouseWorld;
    const p1 = rectIntersection(fromPos.x, fromPos.y, connectFrom.w || MIN_BUBBLE_W, connectFrom.h || BUBBLE_H, firstTarget.x, firstTarget.y);

    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    for (const wp of connectWaypoints) ctx.lineTo(wp.x, wp.y);
    ctx.lineTo(mouseWorld.x, mouseWorld.y);
    ctx.strokeStyle = 'rgba(137,180,250,0.5)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw waypoint dots
    for (const wp of connectWaypoints) {
      ctx.beginPath();
      ctx.arc(wp.x, wp.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#89b4fa';
      ctx.fill();
    }
  }

  // Draw graveyard separator if dev view has removed bubbles
  if (viewTarget === 'dev' && state.dev && state.dev.removedBubbleIds.length > 0) {
    const sepY = graveyardY - GRAVEYARD_GAP / 2;
    // Find bounds for the line
    let minX = Infinity, maxX = -Infinity;
    for (const b of chart.bubbles) {
      minX = Math.min(minX, b.x - (b.w || MIN_BUBBLE_W));
      maxX = Math.max(maxX, b.x + (b.w || MIN_BUBBLE_W));
    }
    ctx.beginPath();
    ctx.moveTo(minX, sepY);
    ctx.lineTo(maxX, sepY);
    ctx.strokeStyle = COLOR_RED + '55';
    ctx.lineWidth = 1;
    ctx.setLineDash([8, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = COLOR_RED + '88';
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Removed', (minX + maxX) / 2, sepY - 8);
  }

  // Draw bubbles
  let graveyardIndex = 0;
  for (const b of chart.bubbles) {
    const color = getBubbleColor(chart, b);
    const pos = getBubbleDrawPos(b, graveyardY);
    const bw = b.w || MIN_BUBBLE_W, bh = b.h || BUBBLE_H;

    // Rounded rectangle
    ctx.beginPath();
    ctx.roundRect(pos.x - bw / 2, pos.y - bh / 2, bw, bh, CORNER_RADIUS);
    ctx.fillStyle = color + '22';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Label
    ctx.fillStyle = '#cdd6f4';
    ctx.font = '16px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(b.label, pos.x, pos.y);
  }

  ctx.restore();
}

function getBubbleDrawPos(bubble, graveyardY) {
  if (viewTarget === 'dev' && state.dev && state.dev.removedBubbleIds.includes(bubble.id)) {
    // Stack removed bubbles at the graveyard Y
    const idx = state.dev.removedBubbleIds.indexOf(bubble.id);
    return { x: bubble.x, y: graveyardY + idx * (BUBBLE_H + 20) };
  }
  return { x: bubble.x, y: bubble.y };
}

function drawPath(points, color, dashed) {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  if (dashed) ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Arrowhead at the end
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  const angle = Math.atan2(last.y - prev.y, last.x - prev.x);
  const headLen = 12;
  ctx.beginPath();
  ctx.moveTo(last.x, last.y);
  ctx.lineTo(last.x - headLen * Math.cos(angle - 0.4), last.y - headLen * Math.sin(angle - 0.4));
  ctx.lineTo(last.x - headLen * Math.cos(angle + 0.4), last.y - headLen * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

// === INPUT ===
document.getElementById('toolbar').addEventListener('mousedown', e => e.stopPropagation());
document.getElementById('viewTabs').addEventListener('mousedown', e => e.stopPropagation());
document.getElementById('devInfo').addEventListener('mousedown', e => e.stopPropagation());

canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (mode === 'connect' && connectFrom && connectWaypoints.length > 0) {
    connectWaypoints.pop();
    draw();
  }
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
  const oldZoom = cam.zoom;
  cam.zoom = Math.min(5, Math.max(0.1, cam.zoom * zoomFactor));
  const wx = (e.clientX - W / 2) / oldZoom + cam.x;
  const wy = (e.clientY - H / 2) / oldZoom + cam.y;
  cam.x = wx - (e.clientX - W / 2) / cam.zoom;
  cam.y = wy - (e.clientY - H / 2) / cam.zoom;
  draw();
}, { passive: false });

canvas.addEventListener('mousedown', e => {
  const w = screenToWorld(e.clientX, e.clientY);
  const hit = hitTest(w.x, w.y);

  if (mode === 'delete') {
    if (hit) {
      const isRemoved = state.dev && viewTarget === 'dev' && state.dev.removedBubbleIds.includes(hit.id);
      if (!isRemoved) {
        send({ type: 'deleteBubble', target: viewTarget, id: hit.id });
      }
      return;
    }
    const connHit = hitTestConnection(w.x, w.y);
    if (connHit !== -1 && typeof connHit === 'object') {
      const isRemoved = state.dev && viewTarget === 'dev' && state.dev.removedConnectionKeys.includes(`${connHit.from}->${connHit.to}`);
      if (!isRemoved) {
        send({ type: 'deleteConnection', target: viewTarget, from: connHit.from, to: connHit.to });
      }
      return;
    }
    return;
  }

  if (mode === 'connect') {
    if (hit) {
      const isRemoved = state.dev && viewTarget === 'dev' && state.dev.removedBubbleIds.includes(hit.id);
      if (isRemoved) return;
      if (!connectFrom) {
        connectFrom = hit;
        connectWaypoints = [];
      } else if (hit !== connectFrom) {
        send({ type: 'addConnection', target: viewTarget, from: connectFrom.id, to: hit.id, waypoints: connectWaypoints });
        connectFrom = null;
        connectWaypoints = [];
      }
    } else if (connectFrom) {
      // Clicked empty space — place a waypoint on the grid
      connectWaypoints.push({ x: snap(w.x), y: snap(w.y) });
      draw();
    }
    return;
  }

  // Pan mode
  if (hit) {
    const isRemoved = state.dev && viewTarget === 'dev' && state.dev.removedBubbleIds.includes(hit.id);
    if (!isRemoved) {
      dragging = { bubble: hit, offX: w.x - hit.x, offY: w.y - hit.y };
    }
  } else {
    panning = true;
    panStart = { x: e.clientX, y: e.clientY };
    canvas.classList.add('grabbing');
  }
});

canvas.addEventListener('mousemove', e => {
  const w = screenToWorld(e.clientX, e.clientY);
  mouseWorld = w;

  if (dragging) {
    dragging.bubble.x = w.x - dragging.offX;
    dragging.bubble.y = w.y - dragging.offY;
    draw();
  } else if (panning) {
    const dx = e.clientX - panStart.x;
    const dy = e.clientY - panStart.y;
    cam.x -= dx / cam.zoom;
    cam.y -= dy / cam.zoom;
    panStart = { x: e.clientX, y: e.clientY };
    draw();
  } else if (mode === 'connect' && connectFrom) {
    draw();
  }
});

canvas.addEventListener('mouseup', () => {
  if (dragging) {
    const b = dragging.bubble;
    b.x = snap(b.x);
    b.y = snap(b.y);
    send({ type: 'moveBubble', target: viewTarget, id: b.id, x: b.x, y: b.y });
    dragging = null;
    draw();
  }
  panning = false;
  canvas.classList.remove('grabbing');
});

canvas.addEventListener('dblclick', e => {
  const w = screenToWorld(e.clientX, e.clientY);
  const hit = hitTest(w.x, w.y);
  if (hit) {
    const isRemoved = state.dev && viewTarget === 'dev' && state.dev.removedBubbleIds.includes(hit.id);
    if (isRemoved) return;
    const name = prompt('Rename bubble:', hit.label);
    if (name !== null && name.trim()) {
      const newW = measureBubbleWidth(name.trim());
      send({ type: 'renameBubble', target: viewTarget, id: hit.id, label: name.trim(), w: newW });
    }
  }
});

// === MODE ===
function setMode(m) {
  mode = m;
  connectFrom = null;
  connectWaypoints = [];
  btnConnect.classList.toggle('active', m === 'connect');
  btnDelete.classList.toggle('active', m === 'delete');
  canvas.classList.toggle('connecting', m === 'connect');
}

// === TOOLBAR EVENTS ===
btnAdd.addEventListener('click', e => {
  e.stopPropagation();
  setMode('pan');
  const x = snap(cam.x);
  const y = snap(cam.y);
  const w = measureBubbleWidth('Bubble');
  send({ type: 'addBubble', target: viewTarget, x, y, w, label: 'Bubble' });
});

btnConnect.addEventListener('click', e => { e.stopPropagation(); setMode(mode === 'connect' ? 'pan' : 'connect'); });
btnDelete.addEventListener('click', e => { e.stopPropagation(); setMode(mode === 'delete' ? 'pan' : 'delete'); });

tabProd.addEventListener('click', () => { viewTarget = 'production'; setMode('pan'); updateUI(); fitToWindow(); draw(); });
tabDev.addEventListener('click', () => {
  if (!state.dev) send({ type: 'forkDev' }); // auto-create dev copy
  viewTarget = 'dev';
  setMode('pan');
  updateUI();
  fitToWindow();
  draw();
});

btnApprove.addEventListener('click', e => { e.stopPropagation(); send({ type: 'approveDev' }); });
btnPush.addEventListener('click', e => { e.stopPropagation(); send({ type: 'pushToProduction' }); });
btnDiscard.addEventListener('click', e => { e.stopPropagation(); send({ type: 'discardDev' }); });

btnUndo.addEventListener('click', e => { e.stopPropagation(); send({ type: 'undo' }); });

window.addEventListener('keydown', e => {
  if (e.key === 'Escape') setMode('pan');
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); send({ type: 'undo' }); }
});

// === EXPORT ===
btnExport.addEventListener('click', e => {
  e.stopPropagation();
  const chart = getActiveChart();
  if (chart.bubbles.length === 0) return;

  const pad = 40;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const graveyardY = (viewTarget === 'dev' && state.dev) ? getGraveyardY(chart) : 0;

  for (const b of chart.bubbles) {
    const pos = getBubbleDrawPos(b, graveyardY);
    const bw = b.w || MIN_BUBBLE_W, bh = b.h || BUBBLE_H;
    minX = Math.min(minX, pos.x - bw / 2);
    minY = Math.min(minY, pos.y - bh / 2);
    maxX = Math.max(maxX, pos.x + bw / 2);
    maxY = Math.max(maxY, pos.y + bh / 2);
  }
  for (const c of chart.connections) {
    for (const wp of (c.waypoints || [])) {
      minX = Math.min(minX, wp.x); minY = Math.min(minY, wp.y);
      maxX = Math.max(maxX, wp.x); maxY = Math.max(maxY, wp.y);
    }
  }
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const w = maxX - minX, h = maxY - minY;

  const offscreen = document.createElement('canvas');
  offscreen.width = w * 2;
  offscreen.height = h * 2;
  const oc = offscreen.getContext('2d');
  oc.scale(2, 2);
  oc.translate(-minX, -minY);

  oc.fillStyle = COLOR_BG;
  oc.fillRect(minX, minY, w, h);

  // Connections
  for (const c of chart.connections) {
    const from = chart.bubbles.find(b => b.id === c.from);
    const to = chart.bubbles.find(b => b.id === c.to);
    if (!from || !to) continue;
    const fromPos = getBubbleDrawPos(from, graveyardY);
    const toPos = getBubbleDrawPos(to, graveyardY);
    const wps = c.waypoints || [];
    const color = getConnectionColor(chart, c);
    const removed = isConnectionRemoved(c);

    const firstTarget = wps.length > 0 ? wps[0] : toPos;
    const lastSource = wps.length > 0 ? wps[wps.length - 1] : fromPos;
    const p1 = rectIntersection(fromPos.x, fromPos.y, from.w || MIN_BUBBLE_W, from.h || BUBBLE_H, firstTarget.x, firstTarget.y);
    const p2 = rectIntersection(toPos.x, toPos.y, to.w || MIN_BUBBLE_W, to.h || BUBBLE_H, lastSource.x, lastSource.y);

    const points = [p1, ...wps, p2];
    oc.beginPath();
    oc.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) oc.lineTo(points[i].x, points[i].y);
    oc.strokeStyle = color; oc.lineWidth = 2;
    if (removed) oc.setLineDash([6, 4]);
    oc.stroke(); oc.setLineDash([]);
    const last = points[points.length - 1], prev = points[points.length - 2];
    const angle = Math.atan2(last.y - prev.y, last.x - prev.x);
    const headLen = 12;
    oc.beginPath(); oc.moveTo(last.x, last.y);
    oc.lineTo(last.x - headLen * Math.cos(angle - 0.4), last.y - headLen * Math.sin(angle - 0.4));
    oc.lineTo(last.x - headLen * Math.cos(angle + 0.4), last.y - headLen * Math.sin(angle + 0.4));
    oc.closePath(); oc.fillStyle = color; oc.fill();
  }

  // Bubbles
  for (const b of chart.bubbles) {
    const color = getBubbleColor(chart, b);
    const pos = getBubbleDrawPos(b, graveyardY);
    const bw = b.w || MIN_BUBBLE_W, bh = b.h || BUBBLE_H;
    oc.beginPath();
    oc.roundRect(pos.x - bw / 2, pos.y - bh / 2, bw, bh, CORNER_RADIUS);
    oc.fillStyle = color + '22';
    oc.fill();
    oc.strokeStyle = color;
    oc.lineWidth = 2;
    oc.stroke();
    oc.fillStyle = '#cdd6f4';
    oc.font = '16px system-ui, sans-serif';
    oc.textAlign = 'center';
    oc.textBaseline = 'middle';
    oc.fillText(b.label, pos.x, pos.y);
  }

  const link = document.createElement('a');
  link.download = 'flowchart.png';
  link.href = offscreen.toDataURL('image/png');
  link.click();
});

// === INIT ===
connectWs();
requestAnimationFrame(draw);
