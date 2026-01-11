import http from "http";
import fs from "fs";
import path from "path";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const nowMs = () => Date.now();

// ---------- Game constants (match your feel) ----------
const W = 980, H = 560;
const UI_TOP = 44, UI_BOTTOM = 56, UI_SIDE = 40;

const field = {
  l: UI_SIDE,
  r: W - UI_SIDE,
  t: UI_TOP,
  b: H - UI_BOTTOM,
  mx: W / 2,
  my: (UI_TOP + (H - UI_BOTTOM)) / 2
};

const goal = { w: 160, d: 60 };

const DT = 1 / 120;

const CAR_RADIUS = 18;
const BALL_RADIUS = 25;

const ACCEL = 1700;
const MAXSPD = 400;

const BOOSTA = 2600;
const BOOSTSPD = 780;

const BRAKE_A = 3200;
const REV_ACCEL = 1200;
const REV_MAX = 230;

const TURN = 6.5;
const ANGDRAG = 9.0;

const COASTKILL = 2.0;
const ALIGN = 30.0;

const BALLDRAG = 0.75;
const BOUNCE = 0.86;

const PAD_R = 14;
const PAD_COOLDOWN = 3.0;

const padsTemplate = [
  { x: field.mx,      y: field.t + 80 },
  { x: field.mx,      y: field.b - 80 },
  { x: field.l + 140, y: field.my - 120 },
  { x: field.l + 140, y: field.my + 120 },
  { x: field.r - 140, y: field.my - 120 },
  { x: field.r - 140, y: field.my + 120 }
];

// ---------- Rooms ----------
const rooms = new Map(); // code -> room

function makeCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function newRoom() {
  const room = {
    code: "",
    createdAt: nowMs(),
    players: new Map(), // ws -> { id, lastInput, connectedAt }
    seats: { p1: null, p2: null }, // ws refs
    // world state
    kickoffActive: true,
    kickoffTimer: 5.0,
    goHold: 0.6,
    scoreL: 0,
    scoreR: 0,
    blue: { x: field.mx - 220, y: field.my, vx: 0, vy: 0, a: 0, av: 0, boost: 100, boosting: false },
    red:  { x: field.mx + 220, y: field.my, vx: 0, vy: 0, a: Math.PI, av: 0, boost: 100, boosting: false },
    ball: { x: field.mx, y: field.my, vx: 0, vy: 0, spin: 0 },
    pads: padsTemplate.map(p => ({ ...p, t: 0 })),
    lastTickMs: nowMs(),
    acc: 0
  };
  room.code = makeCode();
  return room;
}

function resetKickoff(room) {
  Object.assign(room.blue, { x: field.mx - 220, y: field.my, vx: 0, vy: 0, a: 0, av: 0, boost: 100, boosting: false });
  Object.assign(room.red,  { x: field.mx + 220, y: field.my, vx: 0, vy: 0, a: Math.PI, av: 0, boost: 100, boosting: false });
  Object.assign(room.ball, { x: field.mx, y: field.my, vx: 0, vy: 0 });
  room.ball.spin = 0;

  for (const p of room.pads) p.t = 0;

  room.kickoffActive = true;
  room.kickoffTimer = 5.0;
}

function updateKickoff(room, dt) {
  if (!room.kickoffActive) return;
  room.kickoffTimer -= dt;
  if (room.kickoffTimer <= -room.goHold) {
    room.kickoffActive = false;
    room.ball.vx = 0;
    room.ball.vy = 0;
  }
}

function updatePads(room, dt) {
  for (const p of room.pads) {
    if (p.t > 0) p.t = Math.max(0, p.t - dt);
  }
}

function tryPadPickup(room, car) {
  for (const p of room.pads) {
    if (p.t > 0) continue;
    const d = Math.hypot(car.x - p.x, car.y - p.y);
    if (d <= (CAR_RADIUS + PAD_R)) {
      if (car.boost < 50) car.boost = Math.min(100, car.boost + 50);
      else car.boost = 100;
      p.t = PAD_COOLDOWN;
    }
  }
}

function updateCar(room, car, input, dt) {
  car.boosting = false;
  if (room.kickoffActive) return;

  // Steering (speed-scaled)
  const fx = Math.cos(car.a), fy = Math.sin(car.a);
  const fwdSpeed = car.vx * fx + car.vy * fy;
  const speedMag = Math.abs(fwdSpeed);
  const steerScale = clamp(speedMag / 220, 0, 1);
  const turnFactor = 0.15 + 0.85 * steerScale;

  const targetYaw = (input.steer || 0) * TURN * turnFactor;
  const blend = 1 - Math.exp(-ANGDRAG * dt);
  car.av = car.av + (targetYaw - car.av) * blend;
  car.a += car.av * dt;

  // Local components
  const fx2 = Math.cos(car.a), fy2 = Math.sin(car.a);
  const sx = -fy2, sy = fx2;
  let vF = car.vx * fx2 + car.vy * fy2;
  let vS = car.vx * sx  + car.vy * sy;

  const accel = !!input.accel;
  const brake = !!input.brake;
  const accelAmt = clamp(input.accelAmt ?? (accel ? 1 : 0), 0, 1);
  const brakeAmt = clamp(input.brakeAmt ?? (brake ? 1 : 0), 0, 1);
  const drift = !!input.drift;
  const boostBtn = !!input.boost;

  if (accel) {
    vF += ACCEL * accelAmt * dt;

    if (boostBtn && car.boost > 0 && vF >= -5) {
      car.boosting = true;
      vF += BOOSTA * dt;
      car.boost = Math.max(0, car.boost - 40 * dt);
    }
  } else if (brake) {
    const amt = brakeAmt;
    if (vF > 50) vF = Math.max(0, vF - BRAKE_A * amt * dt);
    else vF -= REV_ACCEL * amt * dt;
  } else {
    const k = Math.exp(-COASTKILL * dt);
    vF *= k;
    vS *= k;
    if (Math.hypot(vF, vS) < 6) { vF = 0; vS = 0; }
  }

  if (!drift) {
    const kill = Math.exp(-ALIGN * dt);
    vS *= kill;
  }

  const capFwd = (car.boosting && accel) ? BOOSTSPD : MAXSPD;
  if (vF >= 0) vF = Math.min(vF, capFwd);
  else vF = Math.max(vF, -REV_MAX);

  car.vx = fx2 * vF + sx * vS;
  car.vy = fy2 * vF + sy * vS;

  car.x += car.vx * dt;
  car.y += car.vy * dt;

  car.x = clamp(car.x, field.l + CAR_RADIUS, field.r - CAR_RADIUS);
  car.y = clamp(car.y, field.t + CAR_RADIUS, field.b - CAR_RADIUS);
}

function updateBall(room, dt) {
  if (room.kickoffActive) return;

  const b = room.ball;

  const v = Math.hypot(b.vx, b.vy);
  b.spin += (v / (BALL_RADIUS * 2)) * dt;

  b.vx *= Math.exp(-BALLDRAG * dt);
  b.vy *= Math.exp(-BALLDRAG * dt);
  b.x += b.vx * dt;
  b.y += b.vy * dt;

  const inMouth = (y) => (y > field.my - goal.w/2 && y < field.my + goal.w/2);

  if (b.y - BALL_RADIUS < field.t) { b.y = field.t + BALL_RADIUS; b.vy =  Math.abs(b.vy) * BOUNCE; }
  if (b.y + BALL_RADIUS > field.b) { b.y = field.b - BALL_RADIUS; b.vy = -Math.abs(b.vy) * BOUNCE; }

  // Goals
  if (inMouth(b.y) && (b.x + BALL_RADIUS) < (field.l - goal.d)) {
    room.scoreR += 1;
    resetKickoff(room);
    return;
  }
  if (inMouth(b.y) && (b.x - BALL_RADIUS) > (field.r + goal.d)) {
    room.scoreL += 1;
    resetKickoff(room);
    return;
  }

  // Side walls (not in mouth)
  if (b.x - BALL_RADIUS < field.l && !inMouth(b.y)) { b.x = field.l + BALL_RADIUS; b.vx =  Math.abs(b.vx) * BOUNCE; }
  if (b.x + BALL_RADIUS > field.r && !inMouth(b.y)) { b.x = field.r - BALL_RADIUS; b.vx = -Math.abs(b.vx) * BOUNCE; }
}

function carBallCollision(room, car) {
  if (room.kickoffActive) return;

  const b = room.ball;

  const L = 38, Wc = 22;
  const halfL = L / 2, halfW = Wc / 2;
  const bodyR = 14;

  const cos = Math.cos(car.a), sin = Math.sin(car.a);
  const rx = b.x - car.x;
  const ry = b.y - car.y;

  const lx =  cos * rx + sin * ry;
  const ly = -sin * rx + cos * ry;

  const cx = clamp(lx, -halfL, halfL);
  const cy = clamp(ly, -halfW, halfW);

  let dx = lx - cx;
  let dy = ly - cy;
  let dist = Math.hypot(dx, dy);

  if (dist < 1e-6) {
    const px = halfL - Math.abs(lx);
    const py = halfW - Math.abs(ly);
    if (px < py) { dx = (lx >= 0) ? 1 : -1; dy = 0; }
    else { dx = 0; dy = (ly >= 0) ? 1 : -1; }
    dist = 1;
  }

  const minD = bodyR + BALL_RADIUS;
  if (dist >= minD) return;

  const nxl = dx / dist, nyl = dy / dist;
  const nx =  cos * nxl - sin * nyl;
  const ny =  sin * nxl + cos * nyl;

  const overlap = (minD - dist);
  b.x += nx * overlap;
  b.y += ny * overlap;

  const rvx = b.vx - car.vx;
  const rvy = b.vy - car.vy;
  const relN = rvx * nx + rvy * ny;
  if (relN > 0) return;

  const restitution = 0.92;
  const impulseScale = 0.78;
  const j = (-(1 + restitution) * relN) * impulseScale;

  b.vx += nx * j;
  b.vy += ny * j;

  car.vx -= nx * j * 0.18;
  car.vy -= ny * j * 0.18;
}

function carCarCollision(room, a, b) {
  if (room.kickoffActive) return;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const minD = CAR_RADIUS + CAR_RADIUS;
  if (d <= 0 || d >= minD) return;

  const nx = dx / d;
  const ny = dy / d;

  const overlap = (minD - d);
  a.x -= nx * overlap * 0.5;
  a.y -= ny * overlap * 0.5;
  b.x += nx * overlap * 0.5;
  b.y += ny * overlap * 0.5;

  a.x = clamp(a.x, field.l + CAR_RADIUS, field.r - CAR_RADIUS);
  a.y = clamp(a.y, field.t + CAR_RADIUS, field.b - CAR_RADIUS);
  b.x = clamp(b.x, field.l + CAR_RADIUS, field.r - CAR_RADIUS);
  b.y = clamp(b.y, field.t + CAR_RADIUS, field.b - CAR_RADIUS);

  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const relN = rvx * nx + rvy * ny;
  if (relN > 0) return;

  const restitution = 0.35;
  const j = -(1 + restitution) * relN / 2;

  a.vx -= nx * j;
  a.vy -= ny * j;
  b.vx += nx * j;
  b.vy += ny * j;
}

// ---------- Server tick ----------
function stepRoom(room, input1, input2, dt) {
  updateKickoff(room, dt);

  updateCar(room, room.blue, input1, dt);
  updateCar(room, room.red,  input2, dt);

  carCarCollision(room, room.blue, room.red);

  updatePads(room, dt);
  if (!room.kickoffActive) {
    tryPadPickup(room, room.blue);
    tryPadPickup(room, room.red);
  }

  updateBall(room, dt);
  carBallCollision(room, room.blue);
  carBallCollision(room, room.red);
}

function roomSnapshot(room) {
  return {
    t: nowMs(),
    field: { ...field },
    goal: { ...goal },
    kickoffActive: room.kickoffActive,
    kickoffTimer: room.kickoffTimer,
    scoreL: room.scoreL,
    scoreR: room.scoreR,
    blue: { ...room.blue },
    red:  { ...room.red  },
    ball: { ...room.ball },
    pads: room.pads.map(p => ({ x: p.x, y: p.y, t: p.t }))
  };
}

// Tick all rooms at high rate; broadcast at lower rate
const BROADCAST_HZ = 20;
let lastBroadcast = 0;

function tickAll() {
  const t = nowMs();

  for (const room of rooms.values()) {
    const dtReal = Math.min(0.05, (t - room.lastTickMs) / 1000);
    room.lastTickMs = t;
    room.acc += dtReal;

    // Gather inputs (default neutral if missing)
    const p1 = room.seats.p1;
    const p2 = room.seats.p2;

    const i1 = (p1 && room.players.get(p1)?.lastInput) || {};
    const i2 = (p2 && room.players.get(p2)?.lastInput) || {};

    while (room.acc >= DT) {
      stepRoom(room, i1, i2, DT);
      room.acc -= DT;
    }
  }

  // Broadcast snapshots ~20Hz
  if ((t - lastBroadcast) >= (1000 / BROADCAST_HZ)) {
    lastBroadcast = t;
    for (const room of rooms.values()) {
      const snap = JSON.stringify({ type: "state", snap: roomSnapshot(room) });
      for (const ws of room.players.keys()) {
        if (ws.readyState === 1) ws.send(snap);
      }
    }
  }

  setTimeout(tickAll, 8);
}

// ---------- HTTP + WebSocket ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname === "/" ? "/index.html" : url.pathname;

  const filePath = path.join(__dirname, "public", p);
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    const type =
      ext === ".html" ? "text/html; charset=utf-8" :
      ext === ".js"   ? "text/javascript; charset=utf-8" :
      ext === ".css"  ? "text/css; charset=utf-8" :
      "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function cleanupRoomIfEmpty(room) {
  if (room.players.size === 0) rooms.delete(room.code);
}

wss.on("connection", (ws) => {
  let room = null;

  send(ws, { type: "hello", msg: "connected" });

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString("utf-8")); }
    catch { return; }

    // Create room
    if (msg.type === "create") {
      room = newRoom();
      rooms.set(room.code, room);

      room.players.set(ws, { id: "host", connectedAt: nowMs(), lastInput: {} });
      room.seats.p1 = ws;

      send(ws, { type: "room", code: room.code, seat: "p1" });
      return;
    }

    // Join room
    if (msg.type === "join") {
      const code = String(msg.code || "").trim().toUpperCase();
      const r = rooms.get(code);
      if (!r) { send(ws, { type: "err", msg: "Room not found" }); return; }
      room = r;

      if (!room.seats.p2) room.seats.p2 = ws;
      else if (!room.seats.p1) room.seats.p1 = ws;
      else { send(ws, { type: "err", msg: "Room full" }); room = null; return; }

      const seat = (room.seats.p1 === ws) ? "p1" : "p2";
      room.players.set(ws, { id: "joiner", connectedAt: nowMs(), lastInput: {} });

      send(ws, { type: "room", code: room.code, seat });
      return;
    }

    // Inputs
    if (msg.type === "input") {
      if (!room) return;
      const p = room.players.get(ws);
      if (!p) return;

      // Trust only expected fields
      const i = msg.i || {};
      p.lastInput = {
        steer: clamp(i.steer ?? 0, -1, 1),
        accel: !!i.accel,
        accelAmt: clamp(i.accelAmt ?? (i.accel ? 1 : 0), 0, 1),
        brake: !!i.brake,
        brakeAmt: clamp(i.brakeAmt ?? (i.brake ? 1 : 0), 0, 1),
        drift: !!i.drift,
        boost: !!i.boost
      };
      return;
    }

    // Reset kickoff (host only)
    if (msg.type === "reset") {
      if (!room) return;
      if (room.seats.p1 !== ws) return;
      resetKickoff(room);
      return;
    }
  });

  ws.on("close", () => {
    if (!room) return;

    room.players.delete(ws);
    if (room.seats.p1 === ws) room.seats.p1 = null;
    if (room.seats.p2 === ws) room.seats.p2 = null;

    cleanupRoomIfEmpty(room);
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
  tickAll();
});