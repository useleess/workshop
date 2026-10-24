// Injected into the page by tools/check (never part of the site). Samples the office every SAMPLE_MS and records
//  - snapshots (window.__office.snapshot(): where every item is, each push's stage), only when they change,
//  - "floating" violations: a visible request block / crate / letter that is not held, not moving and not resting.
// Python reads it with window.__probe.dump().
(() => {
  if (window.__probe) return;
  const SAMPLE_MS = 100;
  const TOL = 8; // how far (in office pixels, 1800 x 800 stage) a resting item may be off its surface edge
  const ITEMS = '.room .block, .room .crate, .room .letter';
  // states that are designed to look "lifted" (a ticket being picked up with its stamp, a rejected one fading out)
  const EXEMPT = ['picked', 'leaving'];
  const P = (window.__probe = { id: Math.random().toString(36).slice(2), snaps: [], viol: {}, samples: 0, lastActive: Date.now(),
    all: true, last: null, activeNow: false, moving: 0, busy: 0, itemSamples: 0, restSamples: 0, rest: {} });

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
    }
  }
  setInterval(sample, SAMPLE_MS);
  P.state = () => ({ now: Date.now(), lastActive: P.lastActive, active: P.activeNow, moving: P.moving, busy: P.busy,
    snap: P.last ? JSON.parse(P.last) : null, samples: P.samples });
  P.dump = () => ({ id: P.id, snaps: P.snaps, viol: Object.values(P.viol), samples: P.samples, rest: P.rest, itemSamples: P.itemSamples, restSamples: P.restSamples, snapError: P.snapError || null });
})();
