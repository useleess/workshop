'use strict';
// Useleess Mod Workshop: an animated office drawn from data/status.json (the current state) and
// data/events.json (every change, numbered). Everything runs in the visitor's browser; nothing here
// talks to Discord or any AI. The live data comes from the one-commit "data" branch, published into data/ next
// to this page on every update; ?data=<folder> reads another data folder, ?poll=<seconds> checks faster.

const SITE_VERSION = '11'; // keep equal to version.txt and the ?v= in index.html; open tabs reload when it changes
const params = new URLSearchParams(location.search);
const DATA = params.get('data') || 'data';
const POLL_MS = Math.max(2, Number(params.get('poll')) || 15) * 1000;
const KIND_COLOR = { testers: '#8E5BD9', beta: '#F2B544', release: '#2E9E5B' };
const KIND_TEXT = {
  testers: 'testers push (private GitHub only)',
  beta: 'beta push (GitHub + Modrinth beta)',
  release: 'release push (GitHub + Modrinth)',
};
const STATUS_TEXT = { reported: 'Reported', planned: 'Planned', 'in-progress': 'Working on it', done: 'Done, in next push' };
const SLOTS = [[380, 310], [620, 310], [380, 560], [620, 560], [140, 560]];
const HEADS = ['#9ED3A8', '#F5C9D6', '#F2B544', '#7FB7E8', '#C9B8E8'];
const STATION_Y = [290, 440, 590];
const PER_FLOOR = 5;
const PER_ROW = 10;
const CORRIDOR = 470;
const ELEV = [1244, 166];
const ELEV_OUT = [1244, 280];
const FETCH_HOME = [290, 290];

let status = null;
let lastSeen = 0;
let floors = {};
let floorList = [];
let model = {};
let current = 'f1';
let view = 'office';
let busy = 0;
let mail = null;

// ---------- small helpers ----------

function el(tag, cls, parent, html) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html != null) node.innerHTML = html;
  if (parent) parent.appendChild(node);
  return node;
}
function at(node, x, y) {
  node.style.left = x + 'px';
  node.style.top = y + 'px';
  return node;
}
function pos(node) {
  let x = parseFloat(node.style.left) || 0;
  let y = parseFloat(node.style.top) || 0;
  const parent = node.parentElement;
  if (parent && parent.classList.contains('char')) {
    x += parseFloat(parent.style.left) || 0;
    y += parseFloat(parent.style.top) || 0;
  }
  return [x, y];
}
const speed = () => Math.min(4, 1 + Math.max(0, busy - 3) / 4); // catch up only when a lot piled up
const sleep = (ms) => new Promise((done) => setTimeout(done, ms / speed()));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const kindName = (kind) => (kind === 'bug' ? 'Bug' : 'Idea');

async function waitFor(test, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = test();
    if (value) return value;
    if (Date.now() > end) return null;
    await new Promise((done) => setTimeout(done, 200));
  }
}

class Queue {
  constructor() { this.tail = Promise.resolve(); }
  push(job) {
    busy++;
    this.tail = this.tail.then(job).catch((err) => console.error(err)).finally(() => {
      busy--;
      if (!busy) settle();
    });
  }
}
const queues = new Map();
function queue(name) {
  if (!queues.has(name)) queues.set(name, new Queue());
  return queues.get(name);
}

// ---------- movement ----------

async function walk(ch, points, px = 170) {
  ch.classList.add('walking');
  ch.classList.remove('seated');
  for (const [x, y] of points) {
    const [x0, y0] = pos(ch);
    const dist = Math.hypot(x - x0, y - y0);
    if (dist < 1) continue;
    const anim = ch.animate([{ left: x0 + 'px', top: y0 + 'px' }, { left: x + 'px', top: y + 'px' }],
      { duration: (dist / px) * 1000 / speed(), easing: 'linear', fill: 'forwards' });
    await anim.finished;
    at(ch, x, y);
    anim.cancel();
  }
  ch.classList.remove('walking');
}

async function move(thing, x, y, ms = 400, lift = 0) {
  const [x0, y0] = pos(thing);
  const room = thing.closest('.room');
  if (thing.parentElement !== room) {
    room.appendChild(thing);
    at(thing, x0, y0);
  }
  const frames = [{ left: x0 + 'px', top: y0 + 'px' }];
  if (lift) frames.push({ left: (x0 + x) / 2 + 'px', top: Math.min(y0, y) - lift + 'px' });
  frames.push({ left: x + 'px', top: y + 'px' });
  const anim = thing.animate(frames, { duration: ms / speed(), easing: 'ease-in-out', fill: 'forwards' });
  await anim.finished;
  at(thing, x, y);
  anim.cancel();
}

function hold(ch, thing) {
  ch.appendChild(thing);
  const crate = thing.classList.contains('crate');
  at(thing, crate ? 6 : 14, crate ? 30 : 36);
}

async function elevatorRide(ch, from, to) {
  await walk(ch, [ELEV_OUT, ELEV]);
  await openElevator(from, 500);
  ch.classList.add('hidden');
  await sleep(1200);
  to.room.appendChild(ch);
  at(ch, ...ELEV);
  openElevator(to, 900);
  ch.classList.remove('hidden');
  await walk(ch, [ELEV_OUT]);
}

async function openElevator(F, ms) {
  F.elevator.classList.add('open');
  await sleep(ms);
  F.elevator.classList.remove('open');
}

// ---------- building the floors ----------

function layout(mods) {
  const released = mods.filter((m) => m.stage !== 'dungeon');
  const dungeon = mods.filter((m) => m.stage === 'dungeon');
  const list = [];
  for (let i = 0; i === 0 || i < released.length; i += PER_FLOOR) {
    const n = i / PER_FLOOR + 1;
    list.push({ id: 'f' + n, name: 'Floor ' + n, type: n === 1 ? 'ground' : 'upper', mods: released.slice(i, i + PER_FLOOR) });
  }
  for (let i = 0; i < dungeon.length; i += PER_FLOOR) {
    const n = i / PER_FLOOR + 1;
    list.push({ id: 'b' + n, name: 'B' + n, type: 'dungeon', mods: dungeon.slice(i, i + PER_FLOOR) });
  }
  return list;
}

function makeChar(parent, opts) {
  const ch = el('div', 'char ' + (opts.cls || ''), parent);
  const body = el('div', 'body', ch);
  if (opts.antenna) el('div', 'antenna', body);
  if (opts.cap) el('div', 'cap', body).style.background = opts.cap;
  el('div', 'head', body, '<i></i><i></i>').style.background = opts.head;
  el('div', 'torso', body).style.background = opts.torso || opts.head;
  el('div', 'legs', body, '<i></i><i></i>');
  if (opts.label) el('div', 'tag', body).textContent = opts.label;
  return at(ch, opts.x, opts.y);
}

function buildFloor(f) {
  const floor = el('div', 'floor', stage);
  const room = el('div', 'room', floor);
  const F = { ...f, el: floor, room, stations: [] };
  const abs = (cls, x, y, html) => at(el('div', 'abs ' + cls, room, html), x, y);

  if (f.type === 'ground') {
    abs('outside parking', -200, 0);
    for (const y of [240, 384, 540, 690]) abs('lot-line', -196, y);
    abs('p-sign', -186, 30, '<b>P</b>Parking');
  } else if (f.type === 'upper') {
    abs('outside sky', -200, 0, `<div class="abs cloud" style="left:20px;top:120px;width:90px"></div>
      <div class="abs cloud" style="left:70px;top:320px;width:100px"></div>
      <div class="abs" style="left:14px;top:30px;font:700 18px Fredoka,sans-serif">${f.name}</div>
      <div class="abs" style="left:14px;top:56px;width:150px;font-size:13px;font-weight:600">Mail comes up by the elevator</div>`);
  } else {
    abs('outside ground', -200, 0);
  }
  abs('side-wall', -14, 0);
  if (f.type === 'ground') {
    abs('door-gap', -14, 386);
    F.door = abs('door', -14, 386);
    abs('mat', -60, 488);
  }
  const wall = abs('wall' + (f.type === 'dungeon' ? ' stone' : ''), 0, 0);
  const planks = abs('planks', 0, 266);
  if (f.type !== 'ground') wall.style.width = planks.style.width = '1600px'; // no loading bay up/down here
  abs('zone-test', 808, 266);
  abs('zone-judge', 1074, 266);
  abs('zone-label', 20, 740, '1 Design<span>builders at their desks</span>');
  abs('zone-label', 822, 740, '2 Test<span>AI plays the mod</span>');
  abs('zone-label', 1088, 740, '3 Judge<span>release checks</span>');
  abs('zone-label', 1356, 740, f.type === 'ground' ? '4 Release<span>GitHub + Modrinth trucks</span>' : '4 To Floor 1<span>shipper takes the elevator</span>');

  const badge = f.type === 'dungeon' ? 'BETA DUNGEON · testers only' : 'RELEASED · ' + f.name.toUpperCase();
  abs('title', 600, 22, `<h1>USELEESS MOD<br>WORKSHOP</h1>
    <div class="badge" style="background:${f.type === 'dungeon' ? '#F2B544' : '#8FE3B0'}">${badge}</div>`);
  if (f.type === 'dungeon') {
    abs('torch', 838, 96, '<i></i><b></b>');
    abs('torch', 1202, 96, '<i></i><b></b>');
  }

  F.board = abs('board', 24, 22, `<h2>Discord requests</h2><div class="hint">hover a block</div>
    <div class="legend"><span><i style="background:#F2B544"></i>idea</span><span><i style="background:#E56B5D"></i>bug</span>
    <a href="${esc(status.discord || '#')}">Want something built? Suggest it in our Discord</a></div>`);
  F.score = abs('score', 856, 18);
  F.elevator = abs('elevator', 1220, 96, `<div class="num">${f.type === 'dungeon' ? f.name : f.id.slice(1)}</div>
    <div class="inside"></div><div class="ld"></div><div class="rd"></div>`);

  // test stations with an AI tester each
  STATION_Y.forEach((y, i) => {
    const station = at(el('div', 'desk station', room), 850, y);
    station.innerHTML = `<div class="top" style="width:170px"></div><div class="front" style="width:150px"><div class="plate">AI TESTER ${i + 1}</div></div>
      <div class="monitor"><div class="game"><div class="what"></div><div class="playing hidden">PLAYING</div><div class="cover free">FREE<br>waiting for a build</div></div></div>`;
    makeChar(room, { head: '#8FE3B0', antenna: true, cls: 'seated', x: 948, y: y - 22 });
    F.stations.push({ y, busy: false, what: station.querySelector('.what'), playing: station.querySelector('.playing'),
      cover: station.querySelector('.cover') });
  });

  // judge
  makeChar(room, { head: '#B99AE0', cap: '#1D2433', torso: '#1D2433', cls: 'seated', x: 1176, y: 294 });
  const bench = abs('bench', 1110, 300, '<div class="wood">RELEASE JUDGE</div>');
  bench.style.zIndex = 10;
  const list = abs('checklist', 1088, 500, '<h4>Release checklist</h4><div class="abs stamp">APPROVED</div>');
  // the release judge's 3 sections (discord-bot/judge.py); each push shows its real score per section
  F.checks = [['Tests', 'builds, automated tests, tests for new code'],
    ['Safety', 'no personal info, secrets, big files or debug code'],
    ['Release notes', 'notes written, every request mentioned, version']].map(([section, hint]) => {
    const row = el('div', 'check', list, '<i></i>');
    el('span', '', row, `<b>${section}</b> <em></em><br><small>${hint}</small>`);
    row.section = section;
    row.score = row.querySelector('em');
    return row;
  });
  F.stamp = list.querySelector('.stamp');

  if (f.type === 'ground') {
    abs('bay', 1340, 0);
    abs('bay-stripe', 1340, 0);
    abs('bay-title', 1374, 30, 'LOADING<br>BAY');
    abs('bay-legend', 1374, 84, `<span>Crate tag:</span><span><i style="background:#8E5BD9"></i>testers: GitHub truck only</span>
      <span><i style="background:#F2B544"></i>beta: both trucks</span><span><i style="background:#2E9E5B"></i>release: both trucks</span>`);
    const truck = (y, label, cab) => abs('truck', 1370, y, `<div class="box-part">${label}</div><div class="cab" style="background:${cab}"></div>
      <div class="wheel" style="left:18px"></div><div class="wheel" style="left:140px"></div>`);
    F.trucks = { gh: truck(290, 'GitHub', '#7FB7E8'), mr: truck(470, 'Modrinth', '#2E9E5B'), count: 0, leaving: null, timer: 0 };
    F.van = abs('van hidden', -440, 560, '<div class="box-part">MAIL</div><div class="cab"></div><div class="wheel" style="left:16px"></div><div class="wheel" style="left:124px"></div>');
  } else {
    abs('upstairs-bay', 1340, 266);
    abs('upstairs-sign', 1362, 296, `Shipping happens on Floor 1. The shipper takes approved boxes ${f.type === 'dungeon' ? 'up' : 'down'} in the elevator.`);
  }

  F.fetcher = makeChar(room, { head: '#7FB7E8', cap: '#E56B5D', torso: '#5E95C8', label: 'FETCHER', x: FETCH_HOME[0], y: FETCH_HOME[1] });
  F.home = f.type === 'ground' ? [1440, 636] : [1380, 500];
  F.shipper = makeChar(room, { head: '#F29A5E', torso: '#F2B544', label: f.type === 'ground' ? 'SHIPPER' : 'SHIPPER · ' + (f.type === 'dungeon' ? f.name : 'F' + f.id.slice(1)), x: F.home[0], y: F.home[1] });
  return F;
}

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildMod(F, mod, slot, row) {
  const [x, y] = SLOTS[slot];
  const M = { mod, F, x, y, row, board: [], desk: [], ready: [] };
  const desk = at(el('div', 'desk', F.room), x, y);
  desk.innerHTML = `<div class="top"></div><div class="front"><div class="plate"></div></div>
    <div class="monitor"><div class="screen"></div></div><div class="ready-label hidden">READY</div>`;
  desk.querySelector('.plate').textContent = mod.name;
  M.screen = desk.querySelector('.screen');
  M.readyLabel = desk.querySelector('.ready-label');
  M.zz = el('div', 'hidden', desk, '<div class="zz" style="left:140px;top:0">z</div><div class="zz d" style="left:148px;top:-6px">z</div>');
  M.deskCount = at(el('div', 'count hidden', F.room), x + 140, y - 16);
  M.readyCount = at(el('div', 'count hidden', F.room), x - 50, y + 20);
  M.builder = makeChar(F.room, { head: HEADS[slot], label: 'BUILDER', cls: 'seated', x: x + 86, y: y - 4 });
  // the mod's row on the Discord board
  const top = 38 + 32 * row;
  at(el('div', 'row-name', F.board), 14, top + 6).textContent = mod.name;
  M.empty = at(el('div', 'row-empty', F.board), 162, top + 7);
  M.empty.textContent = 'no requests';
  M.more = at(el('button', 'more hidden', F.room), 191 + 32 * PER_ROW, 67 + 32 * row);
  return M;
}

function blockXY(M, k) { return [191 + 32 * Math.min(k, PER_ROW), 67 + 32 * M.row]; }
function deskXY(M, k) { return [M.x + 110, M.y + 24 - 22 * Math.min(k, 3)]; }
function readyXY(M, k) { return [M.x - 44, M.y + 86 - 24 * Math.min(k, 3)]; }

function itemTip(M, item, where) {
  const base = `${M.mod.name} #${item.id} ${kindName(item.kind)}: ${item.title}`;
  if (where === 'desk') return base + ' · working on it';
  if (where === 'ready') return base + ' · done, waits for the next push';
  return base + (item.votes ? ` · 👍 ${item.votes}` : '');
}

function makeThing(parent, cls, tip, color) {
  const thing = el('button', cls, parent);
  thing.type = 'button';
  if (color) thing.style.background = color;
  setTip(thing, tip);
  return thing;
}
function setTip(thing, text) {
  thing.setAttribute('aria-label', text);
  let tip = thing.querySelector(':scope > .tip');
  if (!tip) tip = el('span', 'tip', thing);
  tip.textContent = text;
}
const itemColor = (item) => (item.kind === 'bug' ? '#E56B5D' : '#F2B544');

function restack(M) {
  // the most-voted request in the row gets a star, so players and Useleess see what matters most
  const top = M.board.reduce((best, e) => ((e.item.votes || 0) > (best ? best.item.votes || 0 : 0) ? e : best), null);
  M.board.forEach((e) => e.el.classList.toggle('star', e === top));
  M.board.forEach((entry, k) => {
    entry.el.classList.toggle('hidden', k >= PER_ROW);
    if (k < PER_ROW) at(entry.el, ...blockXY(M, k));
  });
  const over = M.board.length - PER_ROW;
  M.more.classList.toggle('hidden', over <= 0);
  if (over > 0) {
    M.more.textContent = '+' + over;
    setTip(M.more, `${over} more requests waiting (this row is full)`);
  }
  M.empty.classList.toggle('hidden', M.board.length > 0);
  M.desk.forEach((entry, k) => {
    entry.el.classList.toggle('hidden', k > 3);
    at(entry.el, ...deskXY(M, k));
    setTip(entry.el, itemTip(M, entry.item, 'desk'));
  });
  M.ready.forEach((entry, k) => {
    entry.el.classList.toggle('hidden', k > 3);
    at(entry.el, ...readyXY(M, k));
    setTip(entry.el, itemTip(M, entry.item, 'ready'));
  });
  M.deskCount.classList.toggle('hidden', M.desk.length <= 4);
  M.deskCount.textContent = '+' + (M.desk.length - 4);
  M.readyCount.classList.toggle('hidden', M.ready.length <= 4);
  M.readyCount.textContent = '+' + (M.ready.length - 4);
  M.readyLabel.classList.toggle('hidden', !M.ready.length);
  refreshDesk(M);
}

function refreshDesk(M, text, cls) {
  const b = M.builder;
  const working = M.desk.length > 0;
  b.classList.toggle('busy', working && b.classList.contains('seated'));
  b.classList.toggle('asleep', !working && !M.ready.length && b.classList.contains('seated'));
  M.zz.classList.toggle('hidden', working || M.ready.length > 0 || !b.classList.contains('seated'));
  if (text) {
    M.screen.className = 'screen ' + (cls || '');
    M.screen.textContent = text;
  } else if (working) {
    M.screen.className = 'screen work';
    M.screen.textContent = 'Working on #' + M.desk.map((d) => d.item.id).join(', #');
  } else if (M.ready.length) {
    M.screen.className = 'screen done';
    M.screen.textContent = M.ready.length + ' ready for the next push';
  } else {
    M.screen.className = 'screen';
    M.screen.textContent = 'No tasks';
  }
}

function addBlock(M, item) {
  const block = makeThing(M.F.room, 'block', itemTip(M, item, 'board'), itemColor(item));
  M.board.push({ item, el: block });
  restack(M);
  return block;
}
function addBox(M, item, where) {
  const box = makeThing(M.F.room, 'box', itemTip(M, item, where), itemColor(item));
  M[where].push({ item, el: box });
  restack(M);
  return box;
}

function buildAll() {
  stage.innerHTML = '';
  floors = {};
  model = {};
  floorList = layout(status.mods);
  for (const f of floorList) {
    const F = buildFloor(f);
    floors[f.id] = F;
    f.mods.forEach((mod, slot) => {
      const M = buildMod(F, mod, slot, slot);
      model[mod.key] = M;
      for (const item of mod.items) {
        if (item.status === 'in-progress') addBox(M, item, 'desk');
        else if (item.status === 'done') addBox(M, item, 'ready');
        else addBlock(M, item);
      }
      restack(M);
    });
  }
  mail = { pending: [], running: false, man: null };
  const f1 = floors.f1;
  mail.man = makeChar(f1.room, { head: '#F5C9A8', cap: '#2B3A8C', torso: '#2B3A8C', label: 'MAILMAN', cls: 'hidden', x: -70, y: 590 });
  el('div', 'bag', mail.man.querySelector('.body'));
  mail.count = el('div', 'bag-count hidden', mail.man.querySelector('.body'));
  if (!floors[current]) current = 'f1';
  renderScores();
  renderBar();
  showFloor(current);
}

function signature(mods) {
  return JSON.stringify(layout(mods).map((f) => [f.id, f.mods.map((m) => [m.key, m.name, m.version,
    m.items.filter((i) => !['in-progress', 'done'].includes(i.status)).map((i) => i.id).sort(),
    m.items.filter((i) => i.status === 'in-progress').map((i) => i.id).sort(),
    m.items.filter((i) => i.status === 'done').map((i) => i.id).sort()])]));
}
function modelSignature() {
  return JSON.stringify(floorList.map((f) => [f.id, f.mods.map((m) => {
    const M = model[m.key];
    return [m.key, m.name, m.version, M.board.map((e) => e.item.id).sort(), M.desk.map((e) => e.item.id).sort(),
      M.ready.map((e) => e.item.id).sort()];
  })]));
}
// When nothing is moving, make sure the office matches the latest snapshot (missed events, renames...).
function settle() {
  if (busy || !status || status.last_event > lastSeen) return;
  if (signature(status.mods) !== modelSignature()) buildAll();
}

// ---------- events ----------

function dispatch(event) {
  const M = model[event.mod];
  if (event.type === 'request') return onRequest(event);
  if (!M) return;
  if (event.type === 'status') return onStatus(M, event);
  if (event.type === 'push') return onPush(M, event);
  if (event.type === 'removed') {
    const found = findEntry(M, event.item);
    if (found) {
      found.entry.el.remove();
      M[found.where].splice(found.index, 1);
      restack(M);
    }
  }
}

function findEntry(M, id) {
  for (const where of ['board', 'desk', 'ready']) {
    const index = M[where].findIndex((e) => e.item.id === id);
    if (index >= 0) return { where, index, entry: M[where][index] };
  }
  return null;
}

function onRequest(event) {
  if (!model[event.mod]) return;
  busy++;
  mail.pending.push(event);
  if (!mail.running) mailTrip();
}

async function mailTrip() {
  mail.running = true;
  await sleep(400); // requests that arrive together go in one trip
  const letters = mail.pending.splice(0);
  const f1 = floors.f1;
  const man = mail.man;
  const byFloor = new Map();
  for (const e of letters) {
    const F = model[e.mod].F;
    if (!byFloor.has(F)) byFloor.set(F, []);
    byFloor.get(F).push(e);
  }
  try {
    mail.count.textContent = '×' + letters.length;
    mail.count.classList.toggle('hidden', letters.length < 2);
    f1.room.appendChild(man);
    at(man, -70, 590);
    f1.van.classList.remove('hidden');
    await move(f1.van, -196, 560, 1500);
    man.classList.remove('hidden');
    f1.door.classList.add('open');
    await walk(man, [[-70, 395], [20, 395]]);
    f1.door.classList.remove('open');
    let here = f1;
    for (const [F, list] of byFloor) {
      if (F !== here) {
        await walk(man, [[240, 280], ELEV_OUT]);
        await elevatorRide(man, here, F);
        here = F;
      }
      await walk(man, [[240, 280], [220, 262]]);
      for (const e of list) await postLetter(F, man, e);
    }
    if (here !== f1) {
      await walk(man, [[240, 280], ELEV_OUT]);
      await elevatorRide(man, here, f1);
    }
    await walk(man, [[240, 280], [20, 395]]);
    f1.door.classList.add('open');
    await walk(man, [[-70, 395]]);
    f1.door.classList.remove('open');
    await walk(man, [[-70, 590]]);
    man.classList.add('hidden');
    await move(f1.van, -440, 560, 1500);
    f1.van.classList.add('hidden');
  } catch (err) {
    console.error(err);
  }
  busy -= letters.length;
  mail.running = false;
  if (mail.pending.length) mailTrip();
  else if (!busy) settle();
}

async function postLetter(F, man, e) {
  const M = model[e.mod];
  const item = { id: e.item, title: e.title, kind: e.kind, status: e.status || 'reported', votes: 0 };
  if (findEntry(M, item.id)) return;
  const letter = el('div', 'letter', F.room);
  setTip(letter, `New Discord request for ${M.mod.name}`);
  const [hx, hy] = pos(man);
  at(letter, hx + 24, hy + 38);
  await move(letter, ...blockXY(M, M.board.length), 700, 40);
  letter.remove();
  addBlock(M, item);
  if (item.status === 'in-progress' || item.status === 'done') {
    onStatus(M, { item: item.id, status: 'in-progress' });
    if (item.status === 'done') onStatus(M, { item: item.id, status: 'done' });
  }
}

function onStatus(M, event) {
  const F = M.F;
  if (event.status === 'in-progress') {
    queue('fetch:' + F.id).push(async () => {
      const found = await waitFor(() => findEntry(M, event.item), 90000);
      if (!found || found.where === 'desk') return;
      if (found.where === 'ready') {
        M.ready.splice(found.index, 1);
        M.desk.push(found.entry);
        restack(M);
        return;
      }
      const f = F.fetcher;
      const [bx, by] = pos(found.entry.el);
      const stand = [clamp(bx - 14, 30, 540), 286];
      await walk(f, [stand]);
      const entry = M.board.splice(M.board.indexOf(found.entry), 1)[0];
      restack(M);
      entry.el.remove();
      const box = makeThing(F.room, 'box', itemTip(M, entry.item, 'desk'), itemColor(entry.item));
      at(box, bx, by);
      await move(box, stand[0] + 14, stand[1] + 36, 350);
      hold(f, box);
      const front = [M.x + 90, M.y + 90];
      await walk(f, [[stand[0], CORRIDOR], [front[0], CORRIDOR], front]);
      await move(box, ...deskXY(M, M.desk.length), 350, 30);
      M.desk.push({ item: { ...entry.item, status: 'in-progress' }, el: box });
      restack(M);
      await walk(f, [[front[0], CORRIDOR], [FETCH_HOME[0], CORRIDOR], FETCH_HOME]);
    });
  } else if (event.status === 'done') {
    queue('desk:' + M.mod.key).push(async () => {
      const found = await waitFor(() => {
        const f = findEntry(M, event.item);
        return f && f.where !== 'board' ? f : null;
      }, 120000);
      if (!found || found.where === 'ready') return;
      M.desk.splice(found.index, 1);
      await move(found.entry.el, ...readyXY(M, M.ready.length), 600, 30);
      M.ready.push(found.entry);
      restack(M);
    });
  } else {
    // back to reported / planned: the box goes back on the board
    const found = findEntry(M, event.item);
    if (found && found.where !== 'board') {
      M[found.where].splice(found.index, 1);
      found.entry.el.remove();
      addBlock(M, { ...found.entry.item, status: event.status });
    }
  }
}

function onPush(M, event) {
  const F = M.F;
  queue('desk:' + M.mod.key).push(async () => {
    const wanted = new Set(event.items || []);
    let boxes = [...M.ready, ...M.desk].filter((e) => wanted.has(e.item.id));
    if (!wanted.size) boxes = [...M.ready];
    const spot = [M.x + 102, M.y + 12];
    refreshDesk(M, 'Packing v' + event.version, 'done');
    await Promise.all(boxes.map((b) => move(b.el, M.x + 110, M.y + 24, 500, 20)));
    for (const b of boxes) {
      b.el.remove();
      for (const where of ['ready', 'desk']) M[where] = M[where].filter((e) => e !== b);
    }
    const count = boxes.length || wanted.size;
    const crate = makeThing(F.room, 'crate', `${M.mod.name} v${event.version} · ${count} ${count === 1 ? 'change' : 'changes'} · ${KIND_TEXT[event.kind] || event.kind}`);
    el('span', 'label', crate).textContent = `v${event.version} · ${count}`;
    el('span', 'kind', crate).style.background = KIND_COLOR[event.kind] || '#FFFFFF';
    at(crate, ...spot);
    restack(M);
    refreshDesk(M, 'Done! Off to testing', 'done');
    M.mod.version = event.version;
    await sleep(600);

    const station = await waitFor(() => F.stations.find((s) => !s.busy), 600000);
    station.busy = true;
    const b = M.builder;
    const out = [M.x + 176, M.y - 10];
    await walk(b, [[M.x + 96, M.y - 10]]);
    hold(b, crate);
    await walk(b, [out, [out[0], CORRIDOR], [880, CORRIDOR], [880, station.y + 60]]);
    await move(crate, 984, station.y + 16, 400, 30);
    testCrate(F, M, station, crate, event);
    refreshDesk(M, 'In testing...', 'test');
    await walk(b, [[880, CORRIDOR], [out[0], CORRIDOR], out, [M.x + 86, M.y - 4]]);
    b.classList.add('seated');
    restack(M);
  });
}

async function testCrate(F, M, station, crate, event) {
  busy++;
  station.cover.classList.add('hidden');
  station.what.innerHTML = `${esc(M.mod.name)}<br><b>v${esc(event.version)}</b>`;
  station.playing.classList.remove('hidden');
  await sleep(4000);
  station.playing.classList.add('hidden');
  station.cover.className = 'cover pass';
  station.cover.innerHTML = 'PASSED ✓<br>shipper, come get it';
  busy--;
  queue('ship:' + F.id).push(() => ship(F, M, station, crate, event));
}

async function ship(F, M, station, crate, event) {
  const s = F.shipper;
  await walk(s, [[990, station.y + 60]]);
  hold(s, crate);
  station.cover.className = 'cover free';
  station.cover.innerHTML = 'FREE<br>waiting for a build';
  station.what.textContent = '';
  station.busy = false;
  await walk(s, [[1150, 400]]);
  await move(crate, 1134, 330, 400, 30);
  for (const check of F.checks) {
    await sleep(450);
    const score = (event.judge || {})[check.section];
    check.score.textContent = score ? `${score[0]}/${score[1]}` : '';
    check.classList.add('on');
  }
  F.stamp.classList.add('on');
  await sleep(800);
  hold(s, crate);
  F.checks.forEach((c) => {
    c.classList.remove('on');
    c.score.textContent = '';
  });
  F.stamp.classList.remove('on');
  if (!crate.isConnected) return;
  if (F.type === 'ground') {
    await deliver(s, F, crate, event.kind);
    await walk(s, [F.home]);
  } else {
    const f1 = floors.f1;
    await elevatorRide(s, F, f1);
    await deliver(s, f1, crate, event.kind);
    await elevatorRide(s, f1, F);
    await walk(s, [F.home]);
  }
  if (model[M.mod.key] === M) refreshDesk(M);
}

async function deliver(s, G, crate, kind) {
  const T = G.trucks;
  if (T.leaving) await T.leaving;
  await walk(s, [[1300, 290]]);
  const k = T.count++ % 4;
  T.gh.appendChild(crate);
  at(crate, 30 + 30 * k, -30);
  if (kind !== 'testers') {
    const copy = crate.cloneNode(true);
    setTip(copy, crate.getAttribute('aria-label') + ' (Modrinth copy)');
    T.mr.appendChild(copy);
    at(copy, 30 + 30 * k, -30);
  }
  if (!T.waiting) { // loaded trucks count as busy until they have left, so nothing redraws them away
    T.waiting = true;
    busy++;
  }
  clearTimeout(T.timer);
  T.timer = setTimeout(() => depart(T), 2500 / speed());
}

function depart(T) {
  T.waiting = false;
  const loaded = [T.gh, T.mr].filter((t) => t.querySelector('.crate')); // an empty truck stays parked
  T.leaving = (async () => {
    for (const t of loaded) t.classList.add('gone');
    await new Promise((done) => setTimeout(done, 2200));
    for (const t of loaded) {
      t.querySelectorAll('.crate').forEach((c) => c.remove());
      t.classList.add('hide');
      t.classList.remove('gone');
    }
    await new Promise((done) => setTimeout(done, 300));
    for (const t of loaded) t.classList.remove('hide');
    T.count = 0;
    T.leaving = null;
    busy--;
    if (!busy) settle();
  })();
}

// ---------- bar, scoreboard, dashboard ----------

function renderScores() {
  const ideas = status.ideas || [];
  const rows = [0, 1, 2, 3, 4].map((i) => ideas[i]
    ? `<div class="score-row"><b>${i + 1}</b><span>${esc(ideas[i].title)}</span><em>▲ ${ideas[i].votes}</em></div>`
    : `<div class="score-row"><b>${i + 1}</b><span class="empty">waiting for ideas…</span><em></em></div>`).join('');
  for (const F of Object.values(floors)) F.score.innerHTML = `<h3>MOST WANTED</h3><small>top votes in #mod-ideas</small>${rows}`;
}

function renderBar() {
  const released = floorList.filter((f) => f.type !== 'dungeon');
  const dungeon = floorList.filter((f) => f.type === 'dungeon');
  const inDungeon = current.startsWith('b');
  const tab = (label, on, go) => `<button class="tab${on ? ' on' : ''}" data-go="${go}">${label}</button>`;
  const group = inDungeon ? dungeon : released;
  const notes = {
    released: 'These mods are out: anyone can download them on Modrinth.',
    dungeon: 'Beta mods are still being tested down here: only testers can download them for now.',
    dashboard: 'Everything in plain text: every mod, its open requests and the latest pushes.',
  };
  bar.innerHTML = tab('Released mods', view === 'office' && !inDungeon, 'f1')
    + (dungeon.length ? tab('Beta Dungeon', view === 'office' && inDungeon, 'b1') : '')
    + (view === 'office' && group.length > 1
      ? `<div class="floors">${group.map((f) => `<button class="floor-btn${f.id === current ? ' on' : ''}" data-go="${f.id}">${f.name}</button>`).join('')}</div>` : '')
    + `<div class="note">${notes[view === 'dashboard' ? 'dashboard' : inDungeon ? 'dungeon' : 'released']}</div>`
    + '<span id="live" class="live ok">Live</span>'
    + `<button class="tab dash${view === 'dashboard' ? ' on' : ''}" data-go="dashboard">Dashboard</button>`;
  showLive();
}

function showFloor(id) {
  current = id;
  for (const F of Object.values(floors)) F.el.classList.toggle('on', F.id === id);
}

function renderDashboard() {
  const order = { 'in-progress': 0, done: 1, planned: 2, reported: 3 };
  const cards = status.mods.map((m) => {
    // most "me too" votes first, then by progress, then oldest first
    const items = [...m.items].sort((a, b) => (b.votes || 0) - (a.votes || 0)
      || (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.id - b.id);
    const rows = items.map((i) => `<div class="req"><span class="id">#${i.id}</span><span class="k">${kindName(i.kind)}</span>
      <span class="t">${esc(i.title)}</span><span class="votes">${i.votes ? '👍 ' + i.votes : ''}</span>
      <span class="chip ${esc(i.status)}">${STATUS_TEXT[i.status] || esc(i.status)}</span></div>`).join('');
    return `<div class="card"><div class="card-head"><h3>${esc(m.name)}</h3>
      <span class="stage-chip" style="background:${m.stage === 'dungeon' ? '#F2B544' : '#8FE3B0'}">${m.stage === 'dungeon' ? 'Beta Dungeon' : 'Released'}</span>
      <span class="version">v${esc(m.version)}</span><span class="n">${items.length} open ${items.length === 1 ? 'request' : 'requests'}</span></div>
      ${rows || '<div class="req"><span class="t" style="color:#4A5668">No open requests right now.</span></div>'}</div>`;
  }).join('');
  const ideas = (status.ideas || []).map((i, k) => `<div class="req"><span class="id" style="color:#F2B544">${k + 1}</span>
    <span class="t">${esc(i.title)}</span><span style="color:#8FE3B0;font-weight:800">▲ ${i.votes}</span></div>`).join('')
    || '<div class="req"><span class="t">No ideas yet.</span></div>';
  const pushes = (status.pushes || []).map((p) => `<div class="req"><span class="dot" style="background:${KIND_COLOR[p.kind] || '#FFF'}"></span>
    <span class="t">${esc(p.name)} ${esc(p.version)}</span><span class="k" style="width:auto">${esc(p.kind)} · ${esc(p.date)}</span></div>`).join('');
  dashboard.innerHTML = `<div class="dash-mods">${cards}</div><div class="dash-side">
    <div class="card dark"><h3>Most wanted</h3><div style="font-size:13px;color:#DCE4EE">Top votes in #mod-ideas</div>${ideas}</div>
    <div class="card"><h3>Latest pushes</h3>${pushes}</div></div>`;
}

function setView(go) {
  if (go === 'dashboard') {
    view = 'dashboard';
    renderDashboard();
  } else {
    view = 'office';
    if (floors[go]) showFloor(go);
  }
  stageWrap.hidden = view !== 'office';
  dashboard.classList.toggle('on', view === 'dashboard');
  renderBar();
  fit();
}

function fit() {
  const scale = Math.min(1, stageWrap.clientWidth / 1800);
  stage.style.transform = `scale(${scale})`;
  stageWrap.style.height = 800 * scale + 'px';
}

// ---------- data ----------

async function getJSON(name) {
  const res = await fetch(`${DATA}/${name}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(name + ' ' + res.status);
  return res.json();
}

async function poll() {
  try {
    const res = await fetch(`version.txt?t=${Date.now()}`, { cache: 'no-store' });
    if (res.ok && (await res.text()).trim() !== SITE_VERSION && !busy) {
      location.reload(); // new page code was uploaded: pick it up without the visitor doing anything
      return;
    }
  } catch (err) {
    // no version file (local test server): keep going
  }
  try {
    const [fresh, log] = await Promise.all([getJSON('status.json'), getJSON('events.json').catch(() => ({ events: [] }))]);
    status = fresh;
    const news = (log.events || []).filter((e) => e.n > lastSeen).sort((a, b) => a.n - b.n);
    for (const event of news) {
      lastSeen = event.n;
      dispatch(event);
    }
    syncVotes();
    renderScores();
    if (view === 'dashboard') renderDashboard();
    if (!busy) settle();
    lastOk = Date.now();
    pollFailed = false;
  } catch (err) {
    console.warn('workshop: could not load data', err);
    pollFailed = true;
  }
  showLive();
  setTimeout(poll, POLL_MS);
}

// "me too" votes change without an event: copy them from the snapshot onto the boxes and blocks
function syncVotes() {
  for (const mod of status.mods) {
    const M = model[mod.key];
    if (!M) continue;
    const votes = new Map(mod.items.map((i) => [i.id, i.votes || 0]));
    for (const where of ['board', 'desk', 'ready']) {
      for (const e of M[where]) if (votes.has(e.item.id)) e.item.votes = votes.get(e.item.id);
    }
    M.board.forEach((e) => setTip(e.el, itemTip(M, e.item, 'board')));
    restack(M);
  }
}

// "Live · updated 20 s ago" / "Can't reach the live data": shows at a glance whether updates arrive.
let lastOk = Date.now();
let pollFailed = false;
function showLive() {
  const live = document.getElementById('live');
  if (!live) return;
  const ago = Math.round((Date.now() - lastOk) / 1000);
  const ok = !pollFailed && ago < POLL_MS / 1000 * 3;
  live.className = 'live ' + (ok ? 'ok' : 'bad');
  live.textContent = ok ? `Live · updated ${ago < 5 ? 'just now' : ago + ' s ago'}` : "Can't reach the live data";
}
setInterval(showLive, 5000);

const bar = document.getElementById('bar');
const stageWrap = document.getElementById('stage-wrap');
const stage = document.getElementById('stage');
const dashboard = document.getElementById('dashboard');

bar.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) setView(go.dataset.go);
});
window.addEventListener('resize', fit);

(async function start() {
  try {
    status = await getJSON('status.json');
  } catch (err) {
    stage.textContent = 'Could not load the workshop data.';
    return;
  }
  lastSeen = status.last_event || 0; // new visitors start from now, not from the whole history
  buildAll();
  fit();
  setTimeout(poll, POLL_MS);
})();
