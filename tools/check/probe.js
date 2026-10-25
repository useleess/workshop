// Injected into the page by tools/check (never part of the site). Samples the office every SAMPLE_MS and records
//  - snapshots (window.__office.snapshot(): where every item is, each push's stage), only when they change,
//  - "floating" violations: a visible request block / crate / letter that is not held, not moving and not resting,
//  - "twice" violations (D5a): one request (mod#id) or one push crate drawn visibly in two elements at once (>= 2 samples),
//  - "taken" violations (D5b): an element still marked `pending` (the invisible placeholder that keeps a spot while the real
//    thing is still on its way there) that gets taken: removed, put into a character's hand, or sent flying. Seen with a
//    MutationObserver on the whole document (needs nothing from the page except the class names pending / flying).
//  - "invisible" violations (D4): a block / crate / letter that is carried (inside a character) or moving (a running
//    Web Animation on it) while it cannot be seen. A carried thing is judged against its carrier: if the carrier itself is
//    not visible (a character riding the elevator, class hidden) nothing is asked of what it holds.
// Python reads it with window.__probe.dump().
(() => {
  if (window.__probe) return;
  const SAMPLE_MS = 100;
  const TOL = 8; // how far (in office pixels, 1800 x 800 stage) a resting item may be off its surface edge
  const ITEMS = '.room .block, .room .crate, .room .letter';
  // states that are designed to look "lifted" (a ticket being picked up with its stamp, a rejected one fading out)
  const EXEMPT = ['picked', 'leaving'];
  const P = (window.__probe = { id: Math.random().toString(36).slice(2), snaps: [], viol: {}, samples: 0, lastActive: Date.now(),
    all: true, last: null, hid: {}, twice: {}, taken: [], activeNow: false, moving: 0, busy: 0, itemSamples: 0, restSamples: 0, rest: {} });

  const style = document.createElement('style');
  style.textContent = '.floor { display: block !important; }'; // every floor is measured, not only the visible one
  const addStyle = () => (document.head || document.documentElement).appendChild(style);
  if (document.documentElement) addStyle(); else document.addEventListener('DOMContentLoaded', addStyle);
  P.showAll = (on) => { style.media = on ? 'all' : 'not all'; };

  const scale = () => {
    const stage = document.getElementById('stage');
    return stage ? stage.getBoundingClientRect().width / 1800 || 1 : 1;
  };
  const isRunning = (a) => a.playState === 'running' && a.effect && a.effect.getComputedTiming().iterations !== Infinity;
  const visible = (e) => {
    for (let n = e; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return false;
    }
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const label = (e) => (e.getAttribute('aria-label') || e.className || e.tagName).toString().slice(0, 90);
  const inRect = (x, y, r, tol) => x >= r.left - tol && x <= r.right + tol && y >= r.top - tol && y <= r.bottom + tol;

  function floating() {
    const k = scale();
    const tol = TOL * k;
    const surfaces = [...document.querySelectorAll('[data-surface]')].map((s) => ({ name: s.dataset.surface, rest: s.dataset.rest, r: s.getBoundingClientRect() }))
      .filter((s) => s.r.width > 0 && s.r.height > 0);
    const list = [...document.querySelectorAll(ITEMS)].filter(visible);
    P.itemSamples += list.length;
    P.restSamples += list.filter((e) => !e.closest('.char')).length;
    const rects = new Map(list.map((e) => [e, e.getBoundingClientRect()]));
    const solid = new Set(); // resting on a surface (or stacked on one that does)
    const free = [];
    for (const e of list) {
      if (e.closest('.char') || EXEMPT.some((c) => e.classList.contains(c))) continue; // held / by design
      let moving = false;
      for (let n = e; n && !n.classList.contains('floor'); n = n.parentElement) {
        if (n.getAnimations().some(isRunning)) { moving = true; break; }
      }
      if (!moving) free.push(e);
    }
    // resting on a declared surface, or stacked on a resting item (bottom-centre inside that item)
    const onSurface = (e) => {
      const r = rects.get(e), x = r.left + r.width / 2, y = r.bottom;
      // data-rest="floor": things stand on the bottom edge (a lift cabin); otherwise anywhere inside the rect (a desk top, a bin, a wall board)
      const hit = surfaces.find((s) => inRect(x, y, s.r, tol) && (s.rest !== 'floor' || Math.abs(y - s.r.bottom) <= tol));
      if (hit) { // how deep below the surface's top edge the item's bottom is (stage px): a picture of how tight things rest
        const key = hit.name + ' / ' + (e.classList.contains('crate') ? 'crate' : e.classList.contains('letter') ? 'letter' : 'block');
        const d = Math.round((y - hit.r.top) / k);
        const rest = P.rest[key] || (P.rest[key] = { min: d, max: d, n: 0 });
        rest.min = Math.min(rest.min, d);
        rest.max = Math.max(rest.max, d);
        rest.n++;
      }
      return !!hit;
    };
    let pending = free.filter((e) => !onSurface(e));
    for (const e of free) if (!pending.includes(e)) solid.add(e);
    for (let again = true; again;) {
      again = false;
      for (const e of [...pending]) {
        const r = rects.get(e), x = r.left + r.width / 2, y = r.bottom;
        if ([...solid].some((o) => inRect(x, y, rects.get(o), 0))) {
          solid.add(e);
          pending = pending.filter((p) => p !== e);
          again = true;
        }
      }
    }
    const nearest = (x, y) => { // the closest declared surface, to tell the reader how far off the item is
      let best = null;
      for (const s of surfaces) {
        const dx = Math.max(s.r.left - x, 0, x - s.r.right);
        const dy = s.rest === 'floor' ? y - s.r.bottom : y < s.r.top ? s.r.top - y : y > s.r.bottom ? y - s.r.bottom : 0;
        const d = Math.hypot(dx, dy);
        if (!best || d < best.d) best = { d, text: `${s.name}: ${Math.round(Math.abs(dx) / k)} px sideways, ${Math.round(Math.abs(dy) / k)} px ${dy < 0 ? 'above' : 'below'} ${s.rest === 'floor' ? 'its floor' : 'its edge'}` };
      }
      return best ? best.text : 'none on this page';
    };
    return pending.map((e) => {
      const r = rects.get(e), st = document.getElementById('stage').getBoundingClientRect();
      return { what: label(e), cls: e.className.toString().replace(/\s+/g, '.'), x: Math.round((r.left + r.width / 2 - st.left) / k),
        y: Math.round((r.bottom - st.top) / k), near: nearest(r.left + r.width / 2, r.bottom) };
    });
  }

  // why an item cannot be seen, looking only at the elements from the item up to (not including) `stop`; null = visible
  function whyHidden(e, stop) {
    for (let n = e; n && n !== stop && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const who = n === e ? 'itself' : 'its parent ' + (n.className || n.tagName).toString().slice(0, 30);
      if (cs.display === 'none') return 'display:none on ' + who;
      if (cs.visibility === 'hidden') return 'visibility:hidden on ' + who + (n.classList.contains('hidden') ? ' (class hidden)' : '');
      if (parseFloat(cs.opacity) < 0.05) return 'opacity ' + cs.opacity + ' on ' + who;
    }
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? null : 'zero size';
  }

  // D4: carried or moving things must be visible
  function invisible() {
    const out = [];
    for (const e of document.querySelectorAll(ITEMS)) {
      if (EXEMPT.some((c) => e.classList.contains(c)) || e.classList.contains('pending')) continue; // fading out / a placeholder keeping its spot, by design
      const carrier = e.parentElement && e.parentElement.closest('.char');
      let kind = null, stop = null;
      if (carrier) {
        if (visible(carrier)) { kind = 'carried'; stop = carrier; } // a hidden carrier (elevator ride) hides what it holds: fine
      } else if (e.getAnimations().some(isRunning)) {
        kind = 'moving';
        // inside a hidden ancestor that is not moving with it nothing is asked either way: only the chain up to the room counts
        stop = e.closest('.room');
      }
      if (!kind) continue;
      const why = whyHidden(e, stop);
      if (why) out.push({ what: label(e), cls: e.className.toString().replace(/\s+/g, '.'), kind, why, carrier: carrier ? label(carrier) : '' });
    }
    return out;
  }

  // D5a: the same request / crate in two visible elements
  const itemKey = (e) => {
    const l = e.getAttribute('aria-label') || '';
    if (/copy\)$/.test(l)) return null; // the Modrinth copy on its truck is a second crate by design
    let m = e.classList.contains('block') && /^(.+?) #(\d+)/.exec(l);
    if (m) return m[1] + '#' + m[2];
    m = e.classList.contains('crate') && /^(.+? v[\d.]+)/.exec(l);
    return m ? 'crate ' + m[1] : null;
  };
  const fl = (n) => { const f = n.closest('.floor'); return f ? (f.dataset.floor || f.id || f.className.toString()) : '?'; };
  function twice() {
    const seen = new Map();
    for (const e of document.querySelectorAll('.room .block, .room .crate')) {
      if (['leaving', 'fade', 'pending'].some((c) => e.classList.contains(c))) continue;
      const k = itemKey(e);
      if (!k || !visible(e)) continue;
      const car = e.parentElement && e.parentElement.closest('.char');
      (seen.get(k) || seen.set(k, []).get(k)).push(car ? 'in the hand of ' + label(car) + ' (' + fl(car) + ')' : 'standing ' + fl(e) + ' ' + e.className.toString().replace(/\s+/g, '.'));
    }
    return [...seen].filter(([, v]) => v.length > 1).map(([k, v]) => ({ key: k, where: v }));
  }
  const watchTaken = () => new MutationObserver((records) => {
    const t = Date.now();
    const isItem = (n) => n.nodeType === 1 && n.matches && n.matches('.block, .crate, .letter');
    for (const r of records) {
      if (r.type === 'childList') {
        for (const n of r.removedNodes) if (isItem(n) && n.classList.contains('pending')) P.taken.push({ t, how: 'removed', what: label(n) });
        if (r.target.closest && r.target.closest('.char')) for (const n of r.addedNodes) if (isItem(n) && n.classList.contains('pending')) P.taken.push({ t, how: 'put into the hand of ' + label(r.target.closest('.char')), what: label(n) });
      } else if (r.attributeName === 'class' && isItem(r.target) && (r.oldValue || '').split(/\s+/).includes('pending')
        && !(r.oldValue || '').split(/\s+/).includes('flying') && r.target.classList.contains('flying')) {
        P.taken.push({ t, how: 'sent flying', what: label(r.target) });
      }
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  if (document.documentElement) watchTaken(); else document.addEventListener('DOMContentLoaded', watchTaken);

  function sample() {
    const t = Date.now();
    P.samples++;
    let snap = null;
    try {
      snap = window.__office && window.__office.snapshot();
    } catch (err) {
      P.snapError = String(err);
    }
    const moving = document.getAnimations().filter(isRunning).length;
    P.moving = moving;
    P.busy = snap ? snap.busy : 0;
    // a push in flight keeps the office 'busy' by design (its crate is held until shipped or sent back): that is not movement
    P.activeNow = moving > 0 || P.busy > (snap ? Object.keys(snap.pushes).length : 0);
    if (P.activeNow) P.lastActive = t;
    if (snap) {
      const text = JSON.stringify(snap);
      if (text !== P.last) { P.last = text; P.snaps.push({ t, s: snap }); }
    }
    if (P.all) {
      for (const f of floating()) {
        const key = f.cls + '|' + f.what + '|' + Math.round(f.x / 10) + ',' + Math.round(f.y / 10);
        const v = P.viol[key] || (P.viol[key] = { ...f, first: t, last: t, count: 0 });
        v.last = t;
        v.count++;
      }
      for (const f of twice()) {
        const key = f.key + '|' + f.where.join('|');
        const v = P.twice[key] || (P.twice[key] = { ...f, first: t, last: t, count: 0 });
        v.last = t;
        v.count++;
      }
      for (const f of invisible()) {
        const key = f.kind + '|' + f.cls + '|' + f.what + '|' + f.why;
        const v = P.hid[key] || (P.hid[key] = { ...f, first: t, last: t, count: 0 });
        v.last = t;
        v.count++;
      }
    }
  }
  setInterval(sample, SAMPLE_MS);
  P.state = () => ({ now: Date.now(), lastActive: P.lastActive, active: P.activeNow, moving: P.moving, busy: P.busy,
    snap: P.last ? JSON.parse(P.last) : null, samples: P.samples });
  P.dump = () => ({ id: P.id, snaps: P.snaps, viol: Object.values(P.viol), hid: Object.values(P.hid), twice: Object.values(P.twice), taken: P.taken, samples: P.samples, rest: P.rest, itemSamples: P.itemSamples, restSamples: P.restSamples, snapError: P.snapError || null });
})();
