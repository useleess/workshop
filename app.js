'use strict';
// Useleess Mod Workshop: an animated office drawn from data/status.json (the current state) and
// data/events.json (every change, numbered). Everything runs in the visitor's browser; nothing here
// talks to Discord or any AI. The live data comes from the one-commit "data" branch, published into data/ next
// to this page on every update; ?data=<folder> reads another data folder, ?poll=<seconds> checks faster.

const SITE_VERSION = '17'; // keep equal to version.txt and the ?v= in index.html; open tabs reload when it changes
const params = new URLSearchParams(location.search);
const DATA = params.get('data') || 'data';
const POLL_MS = Math.max(2, Number(params.get('poll')) || 15) * 1000;
const KIND_COLOR = { testers: '#8E5BD9', beta: '#F2B544', release: '#2E9E5B' };
const KIND_TEXT = {
  testers: 'testers push (private GitHub only)',
  beta: 'beta push (GitHub + Modrinth beta)',
  release: 'release push (GitHub + Modrinth)',
};
const STATUS_TEXT = { reported: 'At the front desk', 'more-info': 'Needs more info', planned: 'Planned',
  'in-progress': 'Working on it', done: 'Done, in next push', 'not-planned': 'Not planned' };
const LANE_TEXT = { auto: 'Autopilot', 'with-me': 'With Useleess' };
const LANE_HINT = { auto: 'Autopilot: built automatically by AI', 'with-me': 'With Useleess: waits for Useleess to work on it' };
// where an item is in the office, by its status: the front desk (waiting for Useleess's decision), sent back to the
// player (more info), not planned (leaving), the to-do board (2 lanes), the builder's desk, the READY pile
const WHERE_OF = { reported: 'front', 'more-info': 'info', 'not-planned': 'out', planned: 'board', 'in-progress': 'desk', done: 'ready' };
const WHERE = ['board', 'desk', 'ready', 'front', 'info', 'out'];
const VERDICT = { auto: ['AUTOPILOT', '#8FE3B0'], 'with-me': ['WITH USELEESS', '#7FB7E8'], info: ['MORE INFO?', '#F2B544'],
  out: ['NOT PLANNED', '#B8C0C8'], front: ['ANSWERED', '#FFFFFF'] };
const LANE_X = { auto: 184, 'with-me': 362 };
const LANE_MAX = 5;
const FRONT_MAX = 14;
const FRONT_ROW = 7;
const AISLE = 352;
const MAIL_STAND = [20, 395];
const SLOTS = [[380, 310], [620, 310], [380, 560], [620, 560], [140, 560]];
const HEADS = ['#9ED3A8', '#F5C9D6', '#F2B544', '#7FB7E8', '#C9B8E8'];
const STATION_Y = [290, 440, 590];
const PER_FLOOR = 5;
const CORRIDOR = 470;
const ELEV = [1244, 166];
const ELEV_OUT = [1244, 280];
const FETCH_HOME = [322, 452];

let status = null;
let lastSeen = 0;
let floors = {};
let floorList = [];
let model = {};
let current = 'f1';
let view = 'office';
let busy = 0;
let mail = null;
let seq = 0; // arrival order of front-desk tickets
// pushes on their way through the office (testing -> shipped or sent back), for the watchdog
const openJobs = new Set();
let brokenAt = 0; // an animation step crashed: the office no longer matches the data
let lastMove = Date.now(); // when something last finished walking or moving

// ---------- watchdog ----------
// A crate must never stay stuck: background tabs pause the animations, and a step that crashes leaves
// the office "busy" forever. Both are healed by loading the live state again.
const STUCK_MS = 5 * 60000;
const FLIGHT_STALE_MS = 6 * 3600000; // a push with no news for this long crashed: show it no more (as the exporter)
let hiddenAt = document.hidden ? Date.now() : 0;
let visibleSince = document.hidden ? 0 : Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now();
    visibleSince = 0;
    return;
  }
  visibleSince = Date.now();
  // back after a long time away: show what is true now instead of replaying old animations
  if (hiddenAt && Date.now() - hiddenAt > STUCK_MS && (busy || openJobs.size)) location.reload();
  hiddenAt = 0;
});
function watchdog() {
  if (document.hidden || !visibleSince) return;
  const now = Date.now();
  if (brokenAt && now - brokenAt > 10000) {
    console.warn('workshop: an animation step failed, loading the live state again');
    location.reload();
    return;
  }
  // the data says this push is over (shipped, a newer push of the mod started, or the live state no longer lists
  // it: a crashed push the exporter dropped), its crate is still here and
  // nothing in the office has moved for a minute: stuck (a queue of pushes keeps people walking, that is fine)
  const idle = now - Math.max(lastMove, visibleSince);
  for (const job of openJobs) {
    const over = job.pushedAt || job.supersededAt || job.droppedAt;
    if (over && idle > 60000) {
      console.warn('workshop: a crate got stuck, loading the live state again', job.version);
      location.reload();
      return;
    }
  }
}
setInterval(watchdog, 15000);

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
const laneOf = (item) => (item.lane === 'auto' ? 'auto' : 'with-me'); // older items without a lane: With Useleess
const whereOf = (item) => WHERE_OF[item.status] || 'board';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function niceDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : '';
}
const today = () => new Date().toISOString().slice(0, 10);

async function waitFor(test, ms = Infinity) { // a paused (background) tab just waits longer
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
    this.tail = this.tail.then(job).catch((err) => {
      console.error(err);
      if (!brokenAt) brokenAt = Date.now(); // the watchdog reloads the live state
    }).finally(() => {
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
    lastMove = Date.now();
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
  lastMove = Date.now();
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

  // the to-do board: accepted requests in 2 lanes (Autopilot = built by AI on its own, With Useleess)
  F.board = abs('board', 24, 22, `<h2>To-do board</h2>
    <div class="lane-bg auto" style="left:${LANE_X.auto - 34}px"><b>AUTOPILOT</b><small>built by AI</small></div>
    <div class="lane-bg with-me" style="left:${LANE_X['with-me'] - 34}px"><b>WITH USELEESS</b><small>waits for Useleess</small></div>
    <div class="legend"><span><i style="background:#F2B544"></i>idea</span><span><i style="background:#E56B5D"></i>bug</span>
    <a href="${esc(status.discord || '#')}">Want something built? Suggest it in our Discord</a></div>`);
  // the front desk: new requests wait here for Useleess's decision
  abs('zone-front', 0, 266);
  F.counter = abs('counter', 30, 300, `<div class="counter-top"></div><div class="counter-front"><b>FRONT DESK</b>
    <span class="counter-note"></span></div>`);
  F.counterNote = F.counter.querySelector('.counter-note');
  abs('tray info', 8, 484, '<b>MORE INFO?</b><small>asked the player</small>');
  abs('tray out', 172, 484, '<b>NOT PLANNED</b>');
  F.frontMore = { front: abs('more ticket-more hidden', 0, 0), info: abs('more ticket-more hidden', 0, 0), out: abs('more ticket-more hidden', 0, 0) };
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
  F.home = f.type === 'ground' ? [1374, 636] : [1380, 500];
  F.staging = []; // approved crates waiting for their upload (Floor 1 loading bay)
  F.shipper = makeChar(room, { head: '#F29A5E', torso: '#F2B544', label: f.type === 'ground' ? 'SHIPPER' : 'SHIPPER · ' + (f.type === 'dungeon' ? f.name : 'F' + f.id.slice(1)), x: F.home[0], y: F.home[1] });
  return F;
}

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildMod(F, mod, slot, row) {
  const [x, y] = SLOTS[slot];
  const M = { mod, F, x, y, row, slot, board: [], desk: [], ready: [], front: [], info: [], out: [] };
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
  // the mod's row on the to-do board: a name, then its Autopilot lane and its With Useleess lane
  const top = 38 + 32 * row;
  const name = at(el('div', 'row-name', F.board), 14, top + 6);
  name.textContent = mod.name;
  name.style.borderLeftColor = HEADS[slot]; // the same colour as the mod's builder and its front-desk tickets
  M.empty = {};
  M.more = {};
  for (const lane of ['auto', 'with-me']) {
    M.empty[lane] = at(el('div', 'row-empty', F.board), LANE_X[lane] - 25, top + 7);
    M.empty[lane].textContent = 'empty';
    M.more[lane] = at(el('button', 'more hidden', F.room), ...laneXY(M, lane, LANE_MAX - 1));
  }
  return M;
}

function laneXY(M, lane, k) { return [LANE_X[lane] + 32 * Math.min(k, LANE_MAX - 1), 67 + 32 * M.row]; }
function deskXY(M, k) { return [M.x + 110, M.y + 24 - 22 * Math.min(k, 3)]; }
function readyXY(M, k) { return [M.x - 44, M.y + 86 - 24 * Math.min(k, 3)]; }
// the front desk's counter (2 rows), the MORE INFO tray by the door and the NOT PLANNED tray
const TRAY = {
  front: { max: FRONT_MAX, xy: (k) => [40 + 36 * (k % FRONT_ROW), 312 + 30 * Math.floor(k / FRONT_ROW)] },
  info: { max: 4, xy: (k) => [16 + 36 * k, 508] },
  out: { max: 3, xy: (k) => [180 + 36 * k, 508] },
};

function itemTip(M, item, where) {
  const base = `${M.mod.name} #${item.id} ${kindName(item.kind)}: ${item.title}`;
  const votes = item.votes ? ` · 👍 ${item.votes}` : '';
  const auto = item.lane === 'auto' ? ' · Autopilot' : '';
  if (where === 'desk') return base + ' · working on it' + auto;
  if (where === 'ready') return base + ' · done, waits for the next push' + auto;
  if (where === 'front') return base + ' · at the front desk, waiting for Useleess to decide'
    + (item.since ? ` (since ${niceDate(item.since)})` : '') + votes;
  if (where === 'info') return base + ' · sent back to the player: needs more details';
  if (where === 'out') return base + ' · not planned';
  return base + ' · ' + LANE_HINT[laneOf(item)] + votes;
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
  // the most-voted request on the board gets a star, so players and Useleess see what matters most
  const top = M.board.reduce((best, e) => ((e.item.votes || 0) > (best ? best.item.votes || 0 : 0) ? e : best), null);
  M.board.forEach((e) => e.el.classList.toggle('star', e === top));
  for (const lane of ['auto', 'with-me']) {
    const list = M.board.filter((e) => laneOf(e.item) === lane);
    const full = list.length > LANE_MAX; // the last spot becomes "+N"
    list.forEach((entry, k) => {
      entry.el.classList.toggle('hidden', full && k >= LANE_MAX - 1);
      at(entry.el, ...laneXY(M, lane, k));
      setTip(entry.el, itemTip(M, entry.item, 'board'));
    });
    M.more[lane].classList.toggle('hidden', !full);
    if (full) {
      const over = list.length - LANE_MAX + 1;
      M.more[lane].textContent = '+' + over;
      setTip(M.more[lane], `${over} more ${LANE_TEXT[lane]} requests for ${M.mod.name}`);
    }
    M.empty[lane].classList.toggle('hidden', list.length > 0);
  }
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
  restackFloor(M.F);
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

// the front desk and its two trays hold the tickets of every mod on the floor, oldest first
function restackFloor(F) {
  const mods = F.mods.map((m) => model[m.key]).filter(Boolean);
  for (const where of ['front', 'info', 'out']) {
    const list = mods.flatMap((M) => M[where]).sort((a, b) => a.seq - b.seq);
    const { max, xy } = TRAY[where];
    const full = list.length > max;
    list.forEach((entry, k) => {
      entry.el.classList.toggle('hidden', full && k >= max - 1);
      at(entry.el, ...xy(Math.min(k, max - 1)));
      setTip(entry.el, itemTip(entry.M, entry.item, where));
    });
    const more = F.frontMore[where];
    more.classList.toggle('hidden', !full);
    if (full) {
      at(more, ...xy(max - 1));
      more.textContent = '+' + (list.length - max + 1);
    }
    if (where === 'front') {
      const oldest = list.map((e) => e.item.since).filter(Boolean).sort()[0];
      F.counterNote.textContent = list.length
        ? `${list.length} waiting for Useleess${oldest ? ' · oldest since ' + niceDate(oldest) : ''}`
        : 'nothing waiting · Useleess decides here';
    }
  }
}

// one request somewhere in the office (where: see WHERE_OF); its look follows the place
function addEntry(M, item, where, pending) {
  let thing;
  if (where === 'board') thing = makeThing(M.F.room, 'block', '', itemColor(item));
  else if (where === 'desk' || where === 'ready') thing = makeThing(M.F.room, 'box' + (item.lane === 'auto' ? ' auto' : ''), '', itemColor(item));
  else {
    thing = makeThing(M.F.room, 'ticket' + (where === 'out' ? ' gone' : ''), '', itemColor(item));
    el('span', 'num', thing).textContent = '#' + item.id;
    thing.style.borderLeftColor = HEADS[M.slot];
  }
  if (pending) thing.classList.add('pending'); // its spot is kept while something flies there
  const entry = { item, el: thing, M, seq: ++seq };
  M[where].push(entry);
  restack(M);
  return entry;
}
function addBox(M, item, where) { return addEntry(M, item, where).el; }

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
      for (const item of mod.items) addEntry(M, item, whereOf(item));
      restack(M);
    });
    // tickets at the front desk and in the trays: the longest waiting first
    const tickets = f.mods.flatMap((m) => ['front', 'info', 'out'].flatMap((w) => model[m.key][w]));
    tickets.sort((a, b) => (a.item.since || '').localeCompare(b.item.since || '') || a.item.id - b.item.id)
      .forEach((e) => { e.seq = ++seq; });
    restackFloor(F);
  }
  openJobs.clear(); // (only rebuilt when nothing is moving, or on start: no live crates are lost here)
  for (const flight of status.in_flight || []) restoreFlight(flight);
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

// A push that is already on its way when the page opens (or reloads): its crate goes straight to where the
// events would have left it - at an AI tester with the live count, passed and waiting for the judge, or approved
// in the loading bay - so the next test_progress / tests_done / judged / push events carry on from there.
function restoreFlight(flight) {
  const M = model[flight.mod];
  if (!M || Date.now() - Date.parse(flight.updated) > FLIGHT_STALE_MS) return;
  const F = M.F;
  const station = flight.stage === 'shipping' ? null : F.stations.find((s) => !s.busy);
  if (flight.stage !== 'shipping' && !station) return;
  const wanted = new Set(flight.items || []);
  const items = M.mod.items.filter((i) => wanted.has(i.id)); // a crate sent back unpacks these onto the desk
  for (const where of ['ready', 'desk']) { // its boxes are packed in the crate, not on the desk any more
    M[where].filter((e) => wanted.has(e.item.id)).forEach((e) => e.el.remove());
    M[where] = M[where].filter((e) => !wanted.has(e.item.id));
  }
  restack(M);
  const job = M.job = { version: flight.version, kind: flight.kind, packed: null, progress: flight.counts,
    testsOk: flight.stage !== 'testing', startN: status.last_event || 0 };
  const crate = crateFor(M, flight, wanted.size);
  if (flight.stage === 'shipping') { // approved: waiting in the Floor 1 loading bay for its upload
    const f1 = floors.f1;
    const spot = [1440 + 48 * (f1.staging.length % 3), 650];
    f1.room.appendChild(crate);
    at(crate, ...spot);
    f1.staging.push(crate);
    job.packed = { crate, station: null, items };
    job.staged = crate;
  } else {
    station.busy = true;
    at(crate, 984, station.y + 16);
    station.cover.classList.add('hidden');
    station.what.innerHTML = `${esc(M.mod.name)} <b>v${esc(flight.version)}</b><br><span class="tally">testing…</span>`;
    station.playing.classList.remove('hidden');
    showTally(station, flight.counts);
    if (flight.stage === 'judging') { // tests passed, the judge's event is on its way
      const c = flight.counts || {};
      station.playing.classList.add('hidden');
      station.cover.className = 'cover pass';
      station.cover.innerHTML = c.total ? `ALL PASSED ✓<br>${c.total.toLocaleString()} tests` : 'PASSED ✓<br>build tests';
    } else {
      refreshDesk(M, 'In testing...', 'test');
    }
    job.packed = { crate, station, items };
  }
  openJobs.add(job);
  busy++; // held until the crate is shipped or comes back, like onTesting
}

// where each request is (board items with their lane), to compare the office with the snapshot
const placeKey = (item, where) => `${where === 'board' ? 'board:' + laneOf(item) : where}:${item.id}`;
function signature(mods) {
  return JSON.stringify(layout(mods).map((f) => [f.id, f.mods.map((m) => [m.key, m.name, m.version,
    m.items.map((i) => placeKey(i, whereOf(i))).sort()])]));
}
function modelSignature() {
  return JSON.stringify(floorList.map((f) => [f.id, f.mods.map((m) => {
    const M = model[m.key];
    return [m.key, m.name, m.version, WHERE.flatMap((w) => M[w].map((e) => placeKey(e.item, w))).sort()];
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
  if (event.type === 'testing') return onTesting(M, event);
  if (event.type === 'test_progress') return onProgress(M, event);
  if (event.type === 'tests_done') return onTestsDone(M, event);
  if (event.type === 'judged') return onJudged(M, event);
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
  for (const where of WHERE) {
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

// the mailman walks behind the front desk's counter to its left end, where he drops the letters
const TO_STAND = [[AISLE, 280], [20, 280], MAIL_STAND];
const FROM_STAND = [[20, 280], [AISLE, 280], ELEV_OUT];

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
    await walk(man, [[-70, 395], MAIL_STAND]);
    f1.door.classList.remove('open');
    let here = f1;
    for (const [F, list] of byFloor) {
      if (F !== here) {
        await walk(man, FROM_STAND);
        await elevatorRide(man, here, F);
        here = F;
        await walk(man, TO_STAND);
      }
      for (const e of list) await postLetter(F, man, e);
    }
    if (here !== f1) {
      await walk(man, FROM_STAND);
      await elevatorRide(man, here, f1);
      await walk(man, TO_STAND);
    }
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

// a new request: its letter goes onto the front desk (or straight to its place, for a request that arrives decided)
async function postLetter(F, man, e) {
  const M = model[e.mod];
  if (findEntry(M, e.item)) return;
  const item = { id: e.item, title: e.title, kind: e.kind, status: e.status || 'reported', votes: 0,
    lane: e.lane || null, since: (e.t || '').slice(0, 10) || today() };
  const letter = el('div', 'letter', F.room);
  setTip(letter, `New Discord request for ${M.mod.name}`);
  const [hx, hy] = pos(man);
  at(letter, hx + 24, hy + 38);
  const entry = addEntry(M, item, whereOf(item), true);
  await move(letter, ...pos(entry.el), 700, 40);
  letter.remove();
  entry.el.classList.remove('pending');
}

// the lane of a status event: from the event, else from the snapshot (older events carry none)
function eventLane(M, event) {
  if (event.lane !== undefined) return event.lane;
  const snap = (status.mods.find((m) => m.key === M.mod.key) || { items: [] }).items.find((i) => i.id === event.item);
  return snap && snap.status === event.status ? snap.lane || null : null;
}

// a decision or any other move between the front desk, the trays and the board: a stamp shows what was
// decided, then the ticket (or block) flies to its new place
async function relocate(M, found, item) {
  const where = whereOf(item);
  const from = found.entry.el;
  M[found.where].splice(M[found.where].indexOf(found.entry), 1);
  const verdictKey = where === 'board' ? laneOf(item) : where;
  let stamp = null;
  if (where !== found.where || found.where === 'board') {
    const [fx, fy] = pos(from);
    const [text, color] = VERDICT[verdictKey] || [STATUS_TEXT[item.status] || item.status, '#FFFFFF'];
    stamp = at(el('div', 'verdict', M.F.room), Math.max(4, fx - 30), fy - 34);
    stamp.textContent = text;
    stamp.style.background = color;
    from.classList.add('picked');
    await sleep(1600);
  }
  const entry = addEntry(M, item, where, true); // keeps its spot while the old one flies there
  from.classList.remove('picked');
  from.classList.add('flying');
  await move(from, ...pos(entry.el), 1100, where === 'board' || found.where === 'board' ? 60 : 30);
  from.remove();
  entry.el.classList.remove('pending');
  if (stamp) { // the stamp stays until the request has landed in its new place
    stamp.classList.add('fade');
    setTimeout(() => stamp.remove(), 400);
  }
}

function onStatus(M, event) {
  const F = M.F;
  if (event.status === 'in-progress') {
    queue('fetch:' + F.id).push(async () => {
      let found = await waitFor(() => findEntry(M, event.item), 90000);
      if (!found || found.where === 'desk') return;
      if (found.where === 'ready') {
        M.ready.splice(found.index, 1);
        found.entry.item.status = 'in-progress';
        M.desk.push(found.entry);
        restack(M);
        return;
      }
      if (found.where !== 'board') { // started straight from the front desk or a tray: onto the board first
        await relocate(M, found, { ...found.entry.item, status: 'planned', lane: eventLane(M, event) || found.entry.item.lane || null });
        found = findEntry(M, event.item);
        if (!found || found.where !== 'board') return;
      }
      const f = F.fetcher;
      const [bx, by] = pos(found.entry.el);
      const stand = [clamp(bx - 14, AISLE, 540), 286];
      await walk(f, [[FETCH_HOME[0], CORRIDOR], [AISLE, CORRIDOR], [AISLE, 286], stand]);
      const entry = M.board.splice(M.board.indexOf(found.entry), 1)[0];
      restack(M);
      entry.el.remove();
      const item = { ...entry.item, status: 'in-progress' };
      const box = makeThing(F.room, 'box' + (item.lane === 'auto' ? ' auto' : ''), itemTip(M, item, 'desk'), itemColor(item));
      at(box, bx, by);
      await move(box, stand[0] + 14, stand[1] + 36, 350);
      hold(f, box);
      const front = [M.x + 90, M.y + 90];
      await walk(f, [[stand[0], 286], [AISLE, 286], [AISLE, CORRIDOR], [front[0], CORRIDOR], front]);
      await move(box, ...deskXY(M, M.desk.length), 350, 30);
      M.desk.push({ item, el: box, M });
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
      found.entry.item.status = 'done';
      await move(found.entry.el, ...readyXY(M, M.ready.length), 600, 30);
      M.ready.push(found.entry);
      restack(M);
    });
  } else {
    // decided at the front desk (planned in a lane / more info / not planned), a player's answer (back to the
    // desk), or a request put back from the desk to the board
    queue('front:' + F.id).push(async () => {
      const found = await waitFor(() => findEntry(M, event.item), 90000);
      if (!found) return;
      const item = { ...found.entry.item, status: event.status, since: (event.t || '').slice(0, 10) || today() };
      const lane = eventLane(M, event);
      if (event.status === 'planned' || lane) item.lane = lane;
      if (placeKey(item, whereOf(item)) === placeKey(found.entry.item, found.where)) { // already there
        found.entry.item = item;
        restack(M);
        return;
      }
      if (found.where === 'desk' || found.where === 'ready') { // taken off the desk: straight back
        M[found.where].splice(found.index, 1);
        found.entry.el.remove();
        addEntry(M, item, whereOf(item));
        return;
      }
      await relocate(M, found, item);
    });
  }
}

// ---------- a push: pack -> AI tester (live count) -> judge -> loading bay -> trucks ----------
// The push command reports: testing (crate goes to a tester), test_progress (live count), tests_done,
// judged, push (uploaded). A push without the earlier steps (older events) plays the whole trip at once.

function crateFor(M, event, count) {
  const crate = makeThing(M.F.room, 'crate', `${M.mod.name} v${event.version} · ${count} ${count === 1 ? 'change' : 'changes'} · ${KIND_TEXT[event.kind] || event.kind}`);
  el('span', 'label', crate).textContent = `v${event.version} · ${count}`;
  el('span', 'kind', crate).style.background = KIND_COLOR[event.kind] || '#FFFFFF';
  return crate;
}

async function toDesk(M) { // builder walks back and sits down
  const out = [M.x + 176, M.y - 10];
  await walk(M.builder, [[880, CORRIDOR], [out[0], CORRIDOR], out, [M.x + 86, M.y - 4]]);
  M.builder.classList.add('seated');
  restack(M);
}

async function packAndTest(M, event) { // the finished boxes become one crate, carried to a free tester
  const F = M.F;
  const wanted = new Set(event.items || []);
  let boxes = [...M.ready, ...M.desk].filter((e) => wanted.has(e.item.id));
  if (!wanted.size) boxes = [...M.ready];
  refreshDesk(M, 'Packing v' + event.version, 'done');
  await Promise.all(boxes.map((b) => move(b.el, M.x + 110, M.y + 24, 500, 20)));
  for (const b of boxes) {
    b.el.remove();
    for (const where of ['ready', 'desk']) M[where] = M[where].filter((e) => e !== b);
  }
  const crate = crateFor(M, event, boxes.length || wanted.size);
  at(crate, M.x + 102, M.y + 12);
  restack(M);
  refreshDesk(M, 'Done! Off to testing', 'done');
  await sleep(600);
  const station = await waitFor(() => F.stations.find((s) => !s.busy));
  station.busy = true;
  const out = [M.x + 176, M.y - 10];
  await walk(M.builder, [[M.x + 96, M.y - 10]]);
  hold(M.builder, crate);
  await walk(M.builder, [out, [out[0], CORRIDOR], [880, CORRIDOR], [880, station.y + 60]]);
  await move(crate, 984, station.y + 16, 400, 30);
  station.cover.classList.add('hidden');
  station.what.innerHTML = `${esc(M.mod.name)} <b>v${esc(event.version)}</b><br><span class="tally">testing…</span>`;
  station.playing.classList.remove('hidden');
  refreshDesk(M, 'In testing...', 'test');
  toDesk(M);
  return { crate, station, items: boxes.map((b) => b.item) };
}

function showTally(station, p) {
  const tally = station.what.querySelector('.tally');
  if (!tally || !p) return;
  tally.textContent = p.total
    ? (p.failed ? `${p.passed.toLocaleString()}✓ ${p.failed}✗ /${p.total.toLocaleString()}`
      : `${p.passed.toLocaleString()} / ${p.total.toLocaleString()} ✓`)
    : 'testing…';
  tally.classList.toggle('bad', p.failed > 0);
}

function freeStation(station) {
  station.cover.className = 'cover free';
  station.cover.innerHTML = 'FREE<br>waiting for a build';
  station.what.textContent = '';
  station.playing.classList.add('hidden');
  station.busy = false;
}

function unpack(M, job, crate) { // a crate that failed comes back: its boxes go back on the desk to be fixed
  openJobs.delete(job);
  crate.remove();
  for (const item of job.packed.items) addBox(M, { ...item, status: 'in-progress' }, 'desk');
  M.job = null;
  busy--;
  restack(M);
  refreshDesk(M, 'Fixing what failed', 'fail');
}

function onTesting(M, event) {
  // the same push again (restored from the live state, or a re-run after a crash): its crate is already here
  if (M.job && openJobs.has(M.job) && M.job.version === event.version && !M.job.failed && !M.job.pushedAt) return;
  busy++; // held until the crate is shipped or comes back
  if (M.job && openJobs.has(M.job)) M.job.supersededAt = Date.now(); // a newer push of the mod: that one is over
  const job = M.job = { version: event.version, kind: event.kind, packed: null, progress: null, testsOk: false,
    startN: event.n || 0 };
  openJobs.add(job);
  queue('desk:' + M.mod.key).push(async () => {
    job.packed = await packAndTest(M, event);
    showTally(job.packed.station, job.progress);
  });
}

function onProgress(M, event) {
  const job = M.job;
  if (!job || job.version !== event.version) return;
  job.progress = event;
  if (job.packed) showTally(job.packed.station, event);
}

function onTestsDone(M, event) {
  const job = M.job;
  if (!job || job.version !== event.version) return;
  job.testsOk = !!event.ok; // known right away: the judge's event can follow in the same check
  if (!event.ok) job.failed = true;
  queue('desk:' + M.mod.key).push(async () => {
    const { station, crate } = job.packed;
    showTally(station, event);
    station.playing.classList.add('hidden');
    if (event.ok) {
      station.cover.className = 'cover pass';
      station.cover.innerHTML = event.total ? `ALL PASSED ✓<br>${event.total.toLocaleString()} tests` : 'PASSED ✓<br>build tests';
      return;
    }
    station.cover.className = 'cover fail';
    station.cover.innerHTML = `${(event.failed || 0).toLocaleString()} FAILED ✗<br>back to the builder`;
    await sleep(1800);
    const out = [M.x + 176, M.y - 10];
    await walk(M.builder, [out, [out[0], CORRIDOR], [880, CORRIDOR], [880, station.y + 60]]);
    hold(M.builder, crate);
    freeStation(station);
    await toDesk(M);
    unpack(M, job, crate);
  });
}

async function judgeCrate(F, crate, score, ok) { // the judge scores each section, then stamps it
  await move(crate, 1134, 330, 400, 30);
  for (const check of F.checks) {
    await sleep(450);
    const s = (score || {})[check.section];
    check.score.textContent = s ? `${s[0]}/${s[1]}` : '';
    check.classList.toggle('bad', !!s && s[0] < s[1]);
    check.classList.add('on');
  }
  F.stamp.textContent = ok ? 'APPROVED' : 'REJECTED';
  F.stamp.classList.toggle('reject', !ok);
  F.stamp.classList.add('on');
  await sleep(1000);
  F.checks.forEach((c) => {
    c.classList.remove('on', 'bad');
    c.score.textContent = '';
  });
  F.stamp.classList.remove('on');
}

function onJudged(M, event) {
  const job = M.job;
  if (!job || job.version !== event.version || !job.testsOk) return; // failed tests already sent it back
  if (!event.ok) job.failed = true;
  const F = M.F;
  queue('ship:' + F.id).push(async () => {
    await waitFor(() => job.packed);
    const s = F.shipper;
    const { station, crate } = job.packed;
    await walk(s, [[990, station.y + 60]]);
    hold(s, crate);
    freeStation(station);
    await walk(s, [[1150, 400]]);
    await judgeCrate(F, crate, event.score, event.ok);
    hold(s, crate);
    if (!event.ok) { // rejected: back to the builder's desk
      await walk(s, [[M.x + 90, CORRIDOR], [M.x + 90, M.y + 90]]);
      unpack(M, job, crate);
      await walk(s, [[M.x + 90, CORRIDOR], F.home]);
      return;
    }
    const f1 = floors.f1;
    if (F !== f1) await elevatorRide(s, F, f1);
    const spot = [1440 + 48 * (f1.staging.length % 3), 650];
    await walk(s, [[spot[0] - 20, spot[1] - 40]]);
    await move(crate, ...spot, 400, 20);
    f1.staging.push(crate);
    job.staged = crate;
    if (F !== f1) await elevatorRide(s, f1, F);
    await walk(s, [F.home]);
  });
}

function onPush(M, event) {
  const job = M.job;
  M.mod.version = event.version;
  if (job && job.version === event.version) {
    job.pushedAt = Date.now();
    queue('ship:f1').push(async () => { // uploaded: the waiting crate goes onto the truck(s)
      await waitFor(() => job.staged);
      const f1 = floors.f1;
      const s = f1.shipper;
      const crate = job.staged;
      const [cx, cy] = pos(crate);
      await walk(s, [[cx - 20, cy - 40]]);
      hold(s, crate);
      f1.staging = f1.staging.filter((c) => c !== crate);
      await deliver(s, f1, crate, event.kind);
      await walk(s, [f1.home]);
      openJobs.delete(job);
      M.job = null;
      busy--;
      refreshDesk(M);
    });
    return;
  }
  // older push events: the whole trip at once, with the judge's scores
  const F = M.F;
  queue('desk:' + M.mod.key).push(async () => {
    const { crate, station } = await packAndTest(M, event);
    busy++;
    await sleep(4000);
    station.playing.classList.add('hidden');
    station.cover.className = 'cover pass';
    station.cover.innerHTML = 'PASSED ✓<br>shipper, come get it';
    busy--;
    queue('ship:' + F.id).push(async () => {
      const s = F.shipper;
      await walk(s, [[990, station.y + 60]]);
      hold(s, crate);
      freeStation(station);
      await walk(s, [[1150, 400]]);
      await judgeCrate(F, crate, event.judge, true);
      hold(s, crate);
      const f1 = floors.f1;
      if (F !== f1) await elevatorRide(s, F, f1);
      await deliver(s, f1, crate, event.kind);
      if (F !== f1) await elevatorRide(s, f1, F);
      await walk(s, [F.home]);
      if (model[M.mod.key] === M) refreshDesk(M);
    });
  });
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
  const order = { 'in-progress': 0, done: 1, planned: 2, reported: 3, 'more-info': 4, 'not-planned': 5 };
  const chip = (i) => (i.status === 'planned' ? `Planned · ${LANE_TEXT[laneOf(i)]}`
    : i.status === 'reported' && i.since ? `At the front desk since ${niceDate(i.since)}` : STATUS_TEXT[i.status] || esc(i.status));
  const cards = status.mods.map((m) => {
    // most "me too" votes first, then by progress, then oldest first
    const items = [...m.items].sort((a, b) => (b.votes || 0) - (a.votes || 0)
      || (order[a.status] ?? 9) - (order[b.status] ?? 9) || a.id - b.id);
    const rows = items.map((i) => `<div class="req"><span class="id">#${i.id}</span><span class="k">${kindName(i.kind)}</span>
      <span class="t">${esc(i.title)}</span><span class="votes">${i.votes ? '👍 ' + i.votes : ''}</span>
      <span class="chip ${esc(i.status)}${i.status === 'planned' ? ' ' + laneOf(i) : ''}">${chip(i)}</span></div>`).join('');
    const open = items.filter((i) => i.status !== 'not-planned').length;
    return `<div class="card"><div class="card-head"><h3>${esc(m.name)}</h3>
      <span class="stage-chip" style="background:${m.stage === 'dungeon' ? '#F2B544' : '#8FE3B0'}">${m.stage === 'dungeon' ? 'Beta Dungeon' : 'Released'}</span>
      <span class="version">v${esc(m.version)}</span><span class="n">${open} open ${open === 1 ? 'request' : 'requests'}</span></div>
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

// The office fills the window below the bar: as big as both width and height allow (also above 1800 x 800),
// centred; phones (narrow) keep it at the top instead of floating mid-screen.
function fit() {
  const width = stageWrap.clientWidth, height = Math.max(240, window.innerHeight - bar.offsetHeight);
  const scale = Math.min(width / 1800, height / 800);
  const wrapHeight = width < 700 ? 800 * scale : height;
  const left = (width - 1800 * scale) / 2, top = (wrapHeight - 800 * scale) / 2;
  stage.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
  stageWrap.style.height = wrapHeight + 'px';
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
    markDropped();
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

// A push the live state no longer lists, with no event that ended it (the exporter dropped a crashed push):
// the watchdog reloads the live state once the office has stopped moving.
function markDropped() {
  if (!Array.isArray(status.in_flight)) return; // older data without the list
  for (const job of openJobs) {
    if (job.pushedAt || job.failed || job.droppedAt || (status.last_event || 0) < job.startN) continue;
    const mod = Object.keys(model).find((key) => model[key].job === job);
    if (!status.in_flight.some((f) => f.mod === mod && f.version === job.version)) job.droppedAt = Date.now();
  }
}

// "me too" votes change without an event: copy them (and the "waiting since" dates) from the snapshot
function syncVotes() {
  for (const mod of status.mods) {
    const M = model[mod.key];
    if (!M) continue;
    const snap = new Map(mod.items.map((i) => [i.id, i]));
    for (const where of WHERE) {
      for (const e of M[where]) {
        const i = snap.get(e.item.id);
        if (!i) continue;
        e.item.votes = i.votes || 0;
        if (i.status === e.item.status && i.since) e.item.since = i.since; // the exporter's date wins
      }
    }
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
