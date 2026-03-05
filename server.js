'use strict';
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const crypto  = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' }, pingInterval: 10000, pingTimeout: 30000 });

/*
  ╔══════════════════════════════════════════════╗
  ║  TRUSTTOWER: LAVA OR LIE?  — SERVER          ║
  ╚══════════════════════════════════════════════╝

  FLOOR TYPES:
  1–3: Standard (50% lava)
  4:   Timer floor (5s to decide)
  5:   Truth Floor (answerer MUST tell truth)
  6:   Double lava (70% lava)
  7:   Bluff Bonus (successful lie = 2 floors gained)
  8:   Silence Round (no text chat allowed)
  9:   Double Question (ask twice)
  10:  Final — 2 platforms, pick one, only one safe

  ROLES swap every floor:
    - Stander  = oyunçu platformda durur, GÜVEN / GÜVENME seçər
    - Answerer = cavab verir: EVET / HAYIR

  FALL MECHANIC:
    - 2 fall → oyun biter

  PHASES per floor:
  'answering'   → answerer types YES/NO
  'deciding'    → stander sees answer, picks TRUST/DISTRUST
  'reveal'      → result shown (lava/safe, outcome)
  'between'     → brief pause before next floor
  'final_pick'  → floor 10 special, stander picks platform A or B
  'ended'       → game over
*/

const ROOMS = new Map();
let seq = 1;

const FLOOR_CONFIGS = [
  null,                                          // index 0 unused
  { type: 'standard', lavaChance: 0.5 },         // 1
  { type: 'standard', lavaChance: 0.5 },         // 2
  { type: 'standard', lavaChance: 0.5 },         // 3
  { type: 'timer',    lavaChance: 0.5, timer: 5 },// 4
  { type: 'truth',    lavaChance: 0.5 },          // 5
  { type: 'doublelava', lavaChance: 0.7 },        // 6
  { type: 'bluff',    lavaChance: 0.5 },          // 7
  { type: 'silence',  lavaChance: 0.5 },          // 8
  { type: 'doublequestion', lavaChance: 0.5 },    // 9
  { type: 'final',    lavaChance: null },         // 10
];

function makeRoom(id) {
  return {
    id,
    players: {},        // slot 'A'|'B' → { id, name, socketId }
    phase: 'lobby',
    floor: 0,
    // Current floor state
    stander: null,      // 'A'|'B' — who is on platform this floor
    answerer: null,     // 'A'|'B'
    isLava: null,       // bool — random result for this floor
    finalLavaSide: null,// 'A'|'B' for floor 10
    answer: null,       // 'yes'|'no'
    secondAnswer: null, // for floor 9 double question
    decision: null,     // 'trust'|'distrust'
    timerEnd: null,
    questionCount: 0,   // for floor 9
    // Scores
    falls: { A: 0, B: 0 },
    levels: { A: 0, B: 0 },
    winner: null,
    messages: [],
    silenceFloor: false,
    created: Date.now(),
  };
}

function findOrCreate() {
  for (const [, r] of ROOMS) if (Object.keys(r.players).length < 2 && r.phase === 'lobby') return r;
  const id = 'T' + (seq++);
  const r  = makeRoom(id);
  ROOMS.set(id, r);
  return r;
}

function pub(room, ev, data) { io.to('r:' + room.id).emit(ev, data); }
function addMsg(room, msg) {
  room.messages.push(msg);
  if (room.messages.length > 150) room.messages.shift();
  pub(room, 'msg', msg);
}

function state(room) {
  return {
    phase: room.phase,
    floor: room.floor,
    players: room.players,
    stander: room.stander,
    answerer: room.answerer,
    isLava: room.phase === 'reveal' || room.phase === 'ended' ? room.isLava : undefined,
    finalLavaSide: room.phase === 'reveal' || room.phase === 'ended' ? room.finalLavaSide : undefined,
    answer: room.answer,
    secondAnswer: room.secondAnswer,
    decision: room.decision,
    timerEnd: room.timerEnd,
    falls: room.falls,
    levels: room.levels,
    winner: room.winner,
    silenceFloor: room.silenceFloor,
    questionCount: room.questionCount,
    floorConfig: FLOOR_CONFIGS[room.floor] || null,
  };
}

function startFloor(room) {
  const cfg = FLOOR_CONFIGS[room.floor];
  if (!cfg) return endGame(room, null);

  room.answer       = null;
  room.secondAnswer = null;
  room.decision     = null;
  room.timerEnd     = null;
  room.questionCount = 0;
  room.silenceFloor = cfg.type === 'silence';

  // Determine lava
  if (cfg.type === 'final') {
    room.isLava = null;
    // Randomly one of two platforms is lava
    room.finalLavaSide = Math.random() < 0.5 ? 'A' : 'B';
    room.phase = 'final_pick';
  } else if (cfg.type === 'truth') {
    room.isLava = Math.random() < cfg.lavaChance;
    room.phase  = 'answering';
  } else {
    room.isLava = Math.random() < cfg.lavaChance;
    room.phase  = 'answering';
  }

  // Announce floor
  const names = { A: room.players.A?.name, B: room.players.B?.name };
  const standerName   = names[room.stander];
  const answererName  = names[room.answerer];
  addMsg(room, {
    id: crypto.randomUUID(), type: 'system',
    body: `🏗 KAT ${room.floor} — ${standerName} platformda, ${answererName} cavab verir`,
  });

  if (cfg.type === 'timer') {
    room.timerEnd = Date.now() + 5000;
    pub(room, 'state', state(room));
    // Auto-decide after 5s if stander hasn't picked
    setTimeout(() => {
      if (room.phase === 'deciding' && !room.decision) {
        room.decision = 'distrust'; // timeout = distrust
        resolveDecision(room);
      }
    }, 5000 + 500);
  } else if (cfg.type === 'doublequestion') {
    // Phase starts as 'answering', after first answer → second answering → deciding
    room.phase = 'answering';
    pub(room, 'state', state(room));
  } else {
    pub(room, 'state', state(room));
  }
}

function resolveDecision(room) {
  const cfg = FLOOR_CONFIGS[room.floor];
  const stander  = room.stander;
  const answerer = room.answerer;

  // truth floor: answerer must tell truth
  // bluff bonus: successful lie = +2 levels for answerer
  const lava     = room.isLava;
  const trusted  = room.decision === 'trust';
  let outcome    = ''; // 'fell' | 'advanced' | 'missed' | 'survived'
  let standerDelta = 0;
  let answererBonus = 0;

  if (trusted && lava) {
    outcome = 'fell';
    room.falls[stander]++;
  } else if (trusted && !lava) {
    outcome = 'advanced';
    room.levels[stander]++;
    // Check bluff: answerer said "yes" (truth=lava false→lie) meaning answered honestly
  } else if (!trusted && lava) {
    outcome = 'survived';
    room.levels[stander]++;
  } else { // !trusted && !lava
    outcome = 'missed';
  }

  // Bluff bonus floor 7: if answerer lied successfully and stander trusted
  if (cfg?.type === 'bluff') {
    const answererSaidYes = room.answer === 'yes';
    const answererLied    = (answererSaidYes && !lava) || (!answererSaidYes && lava);
    if (answererLied && outcome === 'fell') {
      // Answerer successfully bluffed → +2 levels bonus
      room.levels[answerer] = (room.levels[answerer] || 0) + 2;
      answererBonus = 2;
    }
  }

  room.phase = 'reveal';
  pub(room, 'state', state(room));

  // Build reveal message
  const lavaTxt  = lava ? '🌋 LAV VAR EDİ!' : '✅ ZEMİN GÜVENLİ İDİ';
  const decTxt   = trusted ? '🔓 Güvendi' : '❌ Güvenmedi';
  let resultTxt  = '';
  if (outcome === 'fell')      resultTxt = `💀 ${room.players[stander]?.name} düştü!`;
  if (outcome === 'advanced')  resultTxt = `🎉 ${room.players[stander]?.name} ilerliyor! +1 kat`;
  if (outcome === 'survived')  resultTxt = `🛡 ${room.players[stander]?.name} kurtuldu! +1 kat`;
  if (outcome === 'missed')    resultTxt = `😬 Fırsat kaçırıldı — kat geçilemedi`;
  if (answererBonus > 0)       resultTxt += ` | 🃏 ${room.players[answerer]?.name} blöf bonusu +${answererBonus} kat!`;

  addMsg(room, { id: crypto.randomUUID(), type: 'reveal', lava, outcome, body: `${lavaTxt} · ${decTxt} · ${resultTxt}` });

  // Check win conditions
  if (room.falls[stander] >= 2) return endGame(room, answerer);
  if (room.levels[stander] >= 10 || room.levels[answerer] >= 10) {
    const w = room.levels['A'] >= 10 ? 'A' : 'B';
    return endGame(room, w);
  }

  // Next floor after 3s
  setTimeout(() => {
    if (!ROOMS.has(room.id)) return;
    room.floor++;
    if (room.floor > 10) return endGame(room, null);
    // Swap roles
    const tmp    = room.stander;
    room.stander = room.answerer;
    room.answerer = tmp;
    room.phase = 'between';
    pub(room, 'state', state(room));
    setTimeout(() => startFloor(room), 1500);
  }, 3000);
}

function resolveFinalPick(room, pick) {
  const lava = pick === room.finalLavaSide;
  room.isLava = lava;
  const stander = room.stander;
  const answerer = room.answerer;

  if (!lava) {
    room.levels[stander]++;
    room.phase = 'reveal';
    pub(room, 'state', state(room));
    addMsg(room, { id: crypto.randomUUID(), type: 'reveal', lava: false, outcome: 'advanced',
      body: `✅ Doğru platform! ${room.players[stander]?.name} finale ulaştı!` });
    setTimeout(() => endGame(room, stander), 2500);
  } else {
    room.falls[stander]++;
    room.phase = 'reveal';
    pub(room, 'state', state(room));
    addMsg(room, { id: crypto.randomUUID(), type: 'reveal', lava: true, outcome: 'fell',
      body: `🌋 Yanlış platform! ${room.players[stander]?.name} lava düştü!` });
    setTimeout(() => endGame(room, answerer), 2500);
  }
}

function endGame(room, winnerSlot) {
  room.winner = winnerSlot;
  room.phase  = 'ended';
  const wName = winnerSlot ? room.players[winnerSlot]?.name : null;
  addMsg(room, { id: crypto.randomUUID(), type: 'system',
    body: wName ? `🏆 ${wName} oyunu kazandı!` : '🤝 Oyun sona erdi!' });
  pub(room, 'state', state(room));
}

/* ── SOCKET ── */
io.on('connection', socket => {

  socket.on('join', ({ name, roomId: rId } = {}, cb) => {
    const pName = (name || 'Oyuncu').slice(0, 22);
    let room;
    if (rId && ROOMS.has(rId)) room = ROOMS.get(rId);
    else room = findOrCreate();

    const taken = Object.keys(room.players);
    if (taken.length >= 2) {
      // Create new room
      room = makeRoom('T' + (seq++));
      ROOMS.set(room.id, room);
    }
    const slot = taken.includes('A') ? 'B' : 'A';
    room.players[slot] = { id: socket.id, name: pName, slot };
    socket.join('r:' + room.id);
    socket.data.roomId = room.id;
    socket.data.slot   = slot;

    socket.emit('history', room.messages);
    pub(room, 'state', state(room));

    if (room.players.A && room.players.B) {
      // Start game
      room.phase    = 'playing';
      room.floor    = 1;
      room.stander  = 'A';
      room.answerer = 'B';
      addMsg(room, { id: crypto.randomUUID(), type: 'system',
        body: `🎮 Oyun başladı! ${room.players.A.name} vs ${room.players.B.name}` });
      setTimeout(() => startFloor(room), 1000);
    }

    cb?.({ ok: true, slot, roomId: room.id });
  });

  socket.on('rejoin', ({ roomId, slot, name } = {}, cb) => {
    const room = ROOMS.get(roomId);
    if (!room) return cb?.({ ok: false });
    if (!room.players[slot]) return cb?.({ ok: false });
    room.players[slot].id       = socket.id;
    room.players[slot].socketId = socket.id;
    socket.join('r:' + room.id);
    socket.data.roomId = roomId;
    socket.data.slot   = slot;
    socket.emit('history', room.messages);
    socket.emit('state', state(room));
    cb?.({ ok: true, slot, roomId });
  });

  // Answerer submits YES/NO
  socket.on('answer', ({ answer } = {}, cb) => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room) return cb?.({ ok: false });
    if (room.phase !== 'answering') return cb?.({ ok: false, e: 'Yanlış mərhələ' });
    const slot = socket.data.slot;
    if (slot !== room.answerer) return cb?.({ ok: false, e: 'Siz cavabçı deyilsiniz' });
    if (!['yes', 'no'].includes(answer)) return cb?.({ ok: false });

    const cfg = FLOOR_CONFIGS[room.floor];

    // Floor 5: truth floor — force truth
    if (cfg?.type === 'truth') {
      const truthAnswer = room.isLava ? 'yes' : 'no';
      room.answer = truthAnswer; // override to truth
      addMsg(room, { id: crypto.randomUUID(), type: 'system',
        body: '🔍 HƏQIQƏT KATI — cavabçı həqiqəti söyləməlidir!' });
    } else if (cfg?.type === 'doublequestion' && room.questionCount === 0) {
      // First of two answers
      room.answer = answer;
      room.questionCount = 1;
      pub(room, 'state', state(room));
      cb?.({ ok: true });
      return;
    } else if (cfg?.type === 'doublequestion' && room.questionCount === 1) {
      room.secondAnswer = answer;
      room.questionCount = 2;
    } else {
      room.answer = answer;
    }

    room.phase = 'deciding';
    if (cfg?.type === 'timer') {
      room.timerEnd = Date.now() + 5000;
      // Auto-timeout handler already set in startFloor
    }
    pub(room, 'state', state(room));
    cb?.({ ok: true });
  });

  // Stander decides TRUST / DISTRUST
  socket.on('decide', ({ decision } = {}, cb) => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room) return cb?.({ ok: false });
    if (room.phase !== 'deciding') return cb?.({ ok: false, e: 'Yanlış mərhələ' });
    const slot = socket.data.slot;
    if (slot !== room.stander) return cb?.({ ok: false, e: 'Siz platformda deyilsiniz' });
    if (!['trust', 'distrust'].includes(decision)) return cb?.({ ok: false });

    room.decision = decision;
    resolveDecision(room);
    cb?.({ ok: true });
  });

  // Floor 10 final pick
  socket.on('final_pick', ({ pick } = {}, cb) => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room || room.phase !== 'final_pick') return cb?.({ ok: false });
    if (socket.data.slot !== room.stander) return cb?.({ ok: false });
    if (!['A', 'B'].includes(pick)) return cb?.({ ok: false });
    resolveFinalPick(room, pick);
    cb?.({ ok: true });
  });

  // Emoji reaction
  socket.on('emoji', ({ emoji } = {}) => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room) return;
    const p = room.players[socket.data.slot];
    pub(room, 'emoji', { emoji, name: p?.name, slot: socket.data.slot });
  });

  // Chat
  socket.on('chat', ({ text } = {}) => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room) return;
    if (room.silenceFloor) return; // silence floor
    const p    = room.players[socket.data.slot];
    const body = (text || '').trim().slice(0, 300);
    if (!body) return;
    addMsg(room, {
      id: crypto.randomUUID(), type: 'chat',
      name: p?.name, slot: socket.data.slot, body,
    });
  });

  // New game
  socket.on('new_game', ({} = {}, cb) => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room || room.phase !== 'ended') return cb?.({ ok: false });
    // Reset
    room.phase    = 'playing';
    room.floor    = 1;
    room.stander  = 'A';
    room.answerer = 'B';
    room.falls    = { A: 0, B: 0 };
    room.levels   = { A: 0, B: 0 };
    room.winner   = null;
    addMsg(room, { id: crypto.randomUUID(), type: 'system', body: '🔄 Yeni oyun başladı!' });
    setTimeout(() => startFloor(room), 800);
    cb?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const room = ROOMS.get(socket.data.roomId);
    if (!room) return;
    const slot = socket.data.slot;
    const p    = room.players[slot];
    if (p) addMsg(room, { id: crypto.randomUUID(), type: 'system', body: `⚡ ${p.name} ayrıldı` });
  });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌋 TrustTower → http://localhost:${PORT}`));
