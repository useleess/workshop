"""Sections C and D of the check: scripted scenarios played against the real page, judged by the invariants.

Each scenario starts from the fixture data (tools/check/fixture/status.json) in its own data folder, so scenarios
can run side by side in several headless browsers. The events are written with the site's own tools/simulate.py
(with its sleeps removed: the scenario waits for the office instead), and the time every event file was written is
recorded, so the check knows what the page could not have known yet."""
import asyncio
import importlib.util
import time
import types
from collections import defaultdict
from pathlib import Path

POLL_S = 2  # ?poll=2: the page looks for news every 2 s (its minimum)
SAMPLE_SLACK_S = 0.05  # clock/ordering slack when comparing a sample time with an event's write time
QUIET_S = 2.0  # "nothing is moving" = no finite animation and no busy office for this long
SETTLE_LIMIT_S = 240  # after the last event the office must have finished moving by then
STAGE_WAIT_S = 150  # how long a scenario step waits for the office to reach a stage before it is called stuck
# How long after an event is written its effect must show, on top of POLL_S. Budgets of the longest animation
# chain that event starts (mailman trip, the person's walk to a board incl. the elevator, the runner's carries,
# the judge's three checks...). An event that arrives while earlier ones are still showing gets one more budget
# for each of them (the office does one thing at a time).
EFFECT_BUDGET_S = {'request': 30, 'status': 45, 'testing': 40, 'tests_done': 25, 'judged': 45, 'push': 60}

# push stages in the order a crate goes through them; each needs one of these events written first (same mod+version)
STAGE_NEEDS = {
    'packing': {'testing', 'push'}, 'to-tester': {'testing', 'push'}, 'testing': {'testing', 'push'},
    'tested': {'tests_done', 'push'}, 'returning': {'tests_done', 'judged'},
    'to-judge': {'judged', 'push'}, 'judging': {'judged', 'push'}, 'conveyor': {'judged', 'push'},
    'staged': {'judged', 'push'}, 'loading': {'push'},
}
AFTER_TESTS = {'tested', 'to-judge', 'judging', 'conveyor', 'staged', 'loading', 'returning'}
AFTER_JUDGE = {'to-judge', 'judging', 'conveyor', 'staged', 'loading', 'returning'}

A, B, D, D2 = 'litematica-turbo', 'schematica-upgraded', 'redstone-scope', 'storage-turbo'  # fixture mods (A, B: Floor 1)


def place_of(status, lane=None):
    return {'reported': 'front', 'more-info': 'info', 'not-planned': 'out', 'planned': 'board:' + ('auto' if lane == 'auto' else 'with-me'),
            'in-progress': 'desk', 'done': 'ready'}.get(status, 'board:with-me')


def expected_from_status(status):
    """What the office should show for a status.json: item places and the open pushes (mod -> (version, stage))."""
    items, pushes = {}, {}
    for m in status['mods']:
        for i in m['items']:
            items[f"{m['key']}#{i['id']}"] = place_of(i['status'], i.get('lane'))
    for f in status.get('in_flight', []):
        pushes[f['mod']] = (f['version'], {'testing': 'testing', 'judging': 'tested', 'shipping': 'staged'}[f['stage']])
        for i in f['items']:
            items[f"{f['mod']}#{i}"] = 'crate'
    return items, pushes


def mod_maker_root(site):
    for folder in [site, *site.parents]:
        if (folder / 'discord-bot' / 'site_export.py').exists():
            return folder
    raise RuntimeError('cannot find the mod maker folder (the one that holds discord-bot) above ' + str(site))


def load_sim(site, data_dir, rec):
    spec = importlib.util.spec_from_file_location('sim_' + data_dir.name, site / 'tools' / 'simulate.py')
    sim = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sim)
    sim.TEST = data_dir
    sim.print = lambda *a, **k: None  # the simulator's progress lines are not wanted here
    sim.time = types.SimpleNamespace(sleep=lambda s: None, strftime=time.strftime, gmtime=time.gmtime)  # we wait for the office instead
    real_save = sim.save

    def save(name, data):
        if name == 'events.json':
            now = time.time()
            for e in data['events']:
                rec.setdefault(e['n'], (now, e))  # the page cannot know an event before this moment
        real_save(name, data)

    sim.save = save
    return sim


class Ctx:
    def __init__(self, name, site, browser, origin, fixture, frames_dir):
        self.name, self.site, self.b, self.origin, self.fixture, self.frames_dir = name, site, browser, origin, fixture, frames_dir
        self.rec = {}  # event n -> (time written, event)
        self.fails = defaultdict(list)  # section -> messages
        self.data_dir = site / 'data-test' / name
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.sim = load_sim(site, self.data_dir, self.rec)
        self.sim.main(['reset', '--from', str(fixture)])
        self.opened = None
        self.initial = {}
        self.compares = []  # (time, label) of every settle+compare, for the report

    # ---- helpers for scenario scripts ----
    def status(self):
        return self.sim.load('status.json')

    def fail(self, section, text):
        if text not in self.fails[section]:
            self.fails[section].append(text)

    async def open(self, floor='f1'):
        self.initial, _ = expected_from_status(self.status())
        self.t_open = time.time()
        await self.b.goto(f'{self.origin}/index.html?data=data-test/{self.name}&poll={POLL_S}', 1400, 900)
        self.opened = True
        if floor != 'f1':
            await self.show(floor)

    async def show(self, floor):
        await self.b.eval(f"document.querySelector('[data-go=\"{floor}\"]').click()")

    async def state(self):
        return await self.b.eval('window.__probe.state()')

    async def wait_for(self, what, test, timeout=STAGE_WAIT_S):
        end = time.time() + timeout
        while time.time() < end:
            st = await self.state()
            if st['snap'] and test(st['snap']):
                return st['snap']
            await asyncio.sleep(0.25)
        st = await self.state()
        self.fail('C', f'step stuck: waited {timeout} s for {what}; the office showed pushes={st["snap"]["pushes"] if st["snap"] else None}, busy={st["busy"]}')
        return None

    async def wait_stage(self, mod, stages, timeout=STAGE_WAIT_S):
        stages = set(stages)
        return await self.wait_for(f'{mod} to reach stage {sorted(stages)}', lambda s: (s['pushes'].get(mod) or {}).get('stage') in stages, timeout)

    async def wait_shipped(self, mod, timeout=STAGE_WAIT_S):
        version = next((f['version'] for f in self.status().get('in_flight', []) if f['mod'] == mod), None)
        return await self.wait_for(f'{mod} push to be shipped', lambda s: version is None or (s['closed'].get(mod) or {}).get(version) == 'shipped', timeout)

    async def settle(self, why):
        """Wait until the page has read every event and nothing has moved for QUIET_S, then compare it with status.json."""
        end = time.time() + SETTLE_LIMIT_S
        status_last = self.status()['last_event']
        while time.time() < end:
            st = await self.state()
            snap = st['snap']
            if snap and snap['last_event'] >= status_last and not st['active'] and st['now'] - st['lastActive'] > QUIET_S * 1000:
                break
            await asyncio.sleep(0.4)
        else:
            st = await self.state()
            self.fail('D3', f'after {why}: still moving or busy {SETTLE_LIMIT_S} s after the last event (busy={st["busy"]}, moving={st["moving"]})')
            return
        snap = st['snap']
        want_items, want_pushes = expected_from_status(self.status())
        wrong = []
        for key, place in want_items.items():
            if snap['items'].get(key) != place:
                wrong.append(f'{key}: status.json says {place}, the office shows {snap["items"].get(key)}')
        for key in snap['items']:
            if key not in want_items:
                wrong.append(f'{key}: shown in the office as {snap["items"][key]} but status.json no longer has it')
        have = {m: (p['version'], p['stage']) for m, p in snap['pushes'].items()}
        if have != want_pushes:
            wrong.append(f'open pushes: status.json says {want_pushes}, the office shows {have}')
        for w in wrong[:8]:
            self.fail('D3', f'after {why}: {w}')
        self.compares.append((time.time(), why))

    async def frame(self, label, floor):
        """A picture of the current moment for the visual judge (only when a request file was given)."""
        if not self.frames_dir:
            return
        await self.show(floor)
        await self.b.eval('window.__probe.showAll(false)')
        await asyncio.sleep(0.15)
        await self.b.shot(self.frames_dir / f'{self.name}-{label}.png')
        await self.b.eval('window.__probe.showAll(true)')

    def request(self, mod, n=1, kind=None):
        before = {i['id'] for i in next(m for m in self.status()['mods'] if m['key'] == mod)['items']}
        self.sim.request(mod, n, kind)
        return sorted(i['id'] for i in next(m for m in self.status()['mods'] if m['key'] == mod)['items'] if i['id'] not in before)

    def judged_ok(self, mod):
        status = self.status()
        flight = next(f for f in status['in_flight'] if f['mod'] == mod)
        self.sim.emit(status, {'type': 'judged', 'mod': mod, 'version': flight['version'], 'ok': True,
                               'score': {'Tests': [4, 4], 'Safety': [4, 4], 'Release notes': [3, 3]}})


# ---------------------------------------------------------------- scenarios ----------------------------------------------------------------

async def sc_requests(c):
    await c.open()
    c.request(A, 2)
    c.request(D, 1)
    await c.settle('requests arriving (Floor 1 mod + Dungeon mod)')
    c.request(B, 1, 'bug')
    await c.settle('a later single request')


async def sc_desk(c):
    await c.open()
    ids = c.request(A, 4)
    await c.settle('4 requests at the front desk')
    c.sim.decide(A, ids[0], 'auto')
    await c.settle('decision: auto')
    c.sim.decide(A, ids[1], 'with-me')
    c.sim.decide(A, ids[2], 'more-info')
    c.sim.decide(A, ids[3], 'not-planned')
    await c.settle('decisions in a row: with-me, more-info, not-planned')
    c.sim.set_status(A, ids[2], 'reported')  # the player answered
    await c.settle('more-info answered (back to the front desk)')
    c.sim.decide(A, ids[2], 'auto')
    await c.settle('decision after the answer')


async def sc_dungeon_desk(c):
    await c.open('b1')
    ids = c.request(D, 1)
    await c.settle('a Dungeon request arriving')
    c.sim.decide(D, ids[0], 'auto')
    await c.settle('Dungeon decision (elevator trip down and back)')
    c.sim.decide(D, 7, 'with-me')  # a request that was waiting at the desk
    await c.settle('second Dungeon decision')
    c.sim.set_status(D, 1, 'in-progress')
    await c.settle('Dungeon item started (runner board -> builder)')
    c.sim.set_status(D, 1, 'done')
    await c.settle('Dungeon item done (to the READY pile)')


async def push_flow(c, mod, kind, how, label, floor='f1', frames=False):
    """begin -> tester -> tests -> (judge) -> belt/trucks, waiting for the office at every step. how: pass | tests-fail | judge-fail"""
    c.sim.begin(mod, kind, 300, 0)
    await c.wait_stage(mod, {'testing'})
    if frames:
        await c.frame(f'{label}-tester', floor)
    c.sim.progress(mod, 100, 0)
    await asyncio.sleep(2.5)
    if how == 'tests-fail':
        c.sim.progress(mod, 150, 6)
        await asyncio.sleep(2.5)
        c.sim.finish(mod, 'fail')
        await c.settle(f'{label}: tests failed, crate back to the builder')
        return
    c.sim.progress(mod, 250, 0)
    await asyncio.sleep(2.5)
    c.sim.finish(mod, 'stop-at-judge')
    await c.wait_stage(mod, {'tested'})
    if how == 'judge-fail':
        c.sim.finish(mod, 'fail')
        await c.settle(f'{label}: judge rejected, crate back to the builder')
        return
    c.judged_ok(mod)
    if frames:
        await c.wait_stage(mod, {'judging'})
        await c.frame(f'{label}-judge', floor)
    await c.wait_stage(mod, {'staged'})
    if frames:
        await c.frame(f'{label}-belt', 'f1')
    c.sim.finish(mod)  # the push event (upload done)
    if frames:
        await c.wait_stage(mod, {'loading'}, 60)
        await c.frame(f'{label}-loading', 'f1')
    await c.settle(f'{label}: shipped')


def prepare_ready(c, mod, items):
    """Make sure these items are done (on the READY pile) before the push starts."""
    for i in items:
        if next(x for m in c.status()['mods'] if m['key'] == mod for x in m['items'] if x['id'] == i)['status'] != 'done':
            c.sim.set_status(mod, i, 'done')


async def sc_push_pass(c):
    await c.open()
    c.sim.set_status(A, 2, 'in-progress')  # a board request is taken to the builder, finished, and shipped with the rest
    await c.settle('item started')
    c.sim.set_status(A, 2, 'done')
    await c.settle('item done')
    await push_flow(c, A, 'beta', 'pass', 'push', frames=True)


async def sc_tests_fail(c):
    await c.open()
    await push_flow(c, A, 'beta', 'tests-fail', 'push')


async def sc_judge_fail(c):
    await c.open()
    await push_flow(c, A, 'beta', 'judge-fail', 'push')


async def sc_dungeon_push(c):
    await c.open('b1')
    await push_flow(c, D, 'testers', 'pass', 'dungeon push', floor='b1', frames=True)


async def sc_mid_testing(c):
    c.sim.begin(A, 'beta', 300, 100)
    await c.open()
    await c.wait_stage(A, {'testing'})
    await c.settle('page opened while the crate is at the tester')
    c.sim.progress(A, 200, 0)
    c.sim.finish(A, 'stop-at-judge')
    await c.wait_stage(A, {'tested'})
    c.judged_ok(A)
    await c.wait_stage(A, {'staged'})
    c.sim.finish(A)
    await c.settle('push finished after opening mid-testing')


async def sc_mid_judging(c):
    c.sim.begin(D, 'testers', 300, 300)
    c.sim.finish(D, 'stop-at-judge')
    await c.open('b1')
    await c.wait_stage(D, {'tested'})
    await c.settle('page opened while the crate waits for the judge (Dungeon)')
    c.judged_ok(D)
    await c.wait_stage(D, {'staged'})
    c.sim.finish(D)
    await c.settle('Dungeon push finished after opening mid-judging')


async def sc_mid_shipping(c):
    c.sim.begin(A, 'beta', 300, 300)
    c.sim.finish(A, 'stop-at-judge')
    c.judged_ok(A)
    await c.open()
    await c.wait_stage(A, {'staged'})
    await c.settle('page opened while the approved crate waits on the belt')
    c.sim.finish(A)
    await c.settle('push finished after opening mid-shipping')


async def sc_burst(c):
    """Everything of a push written at once (the real events can arrive in one poll): the office must still get it right."""
    await c.open()
    c.sim.staged(A, 'release', 300, 0)
    await c.settle('burst: whole push written at once')
    ids = c.request(B, 2)
    c.sim.decide(B, ids[0], 'auto')
    c.sim.decide(B, ids[1], 'not-planned')
    await c.settle('burst: request + decisions written at once')


# name -> (function, in --quick)
SCENARIOS = {
    'requests': (sc_requests, False), 'desk': (sc_desk, False), 'dungeon-desk': (sc_dungeon_desk, False),
    'push-pass': (sc_push_pass, True), 'tests-fail': (sc_tests_fail, False), 'judge-fail': (sc_judge_fail, False),
    'dungeon-push': (sc_dungeon_push, False), 'mid-testing': (sc_mid_testing, False),
    'mid-judging': (sc_mid_judging, False), 'mid-shipping': (sc_mid_shipping, False), 'burst': (sc_burst, False),
}


# ---------------------------------------------------------------- analysis (section D) ----------------------------------------------------------------

def event_targets(e):
    """event -> {(mod, item): place the item is meant to be in}"""
    t, mod = e['type'], e.get('mod')
    if t in ('request', 'status'):
        return {f'{mod}#{e["item"]}': place_of(e.get('status') or 'reported', e.get('lane'))}
    if t == 'testing':
        return {f'{mod}#{i}': 'crate' for i in e.get('items') or []}
    if t == 'push':
        return {f'{mod}#{i}': None for i in e.get('items') or []}
    return {}


def board_both(place):
    return {'board:auto', 'board:with-me'} if place and place.startswith('board:') else {place}


def analyse(c, dump):
    t0 = c.t_open
    rel = lambda t: f'+{t - t0:.1f}s'  # noqa: E731
    events = sorted(c.rec.values(), key=lambda r: r[0])
    snaps = [(s['t'] / 1000, s['s']) for s in dump['snaps']]

    c.stats = f"{dump['samples']} samples, {len(snaps)} state changes, {len(events)} events, {dump['itemSamples']} item sightings ({dump['restSamples']} not in a hand)"
    c.rest = dump.get('rest', {})
    # D1 nothing floats
    for v in sorted(dump['viol'], key=lambda v: v['first'])[:12]:
        c.fail('D1', f"floating {v['cls']} \"{v['what']}\" at stage ({v['x']}, {v['y']}) from {rel(v['first'] / 1000)} to {rel(v['last'] / 1000)} "
                     f"({v['count']} samples): held by nobody, not moving, resting on nothing (nearest surface -> " + v['near'] + ")")

    # D2a nothing runs ahead of the data
    item_events = defaultdict(list)
    for tw, e in events:
        for key, place in event_targets(e).items():
            item_events[key].append((tw, place))
    for ts, snap in snaps:
        keys = set(snap['items']) | set(c.initial) | set(item_events)
        for key in keys:
            place = snap['items'].get(key)
            allowed = {c.initial.get(key)}
            written = [(tw, p) for tw, p in item_events[key] if tw <= ts + SAMPLE_SLACK_S]
            for _, p in written:
                allowed |= board_both(p)
            if written or key not in c.initial:
                allowed.add(None)  # in somebody's hands or not shown yet
            if place not in allowed:
                nxt = min((tw for tw, p in item_events[key] if tw > ts + SAMPLE_SLACK_S), default=None)
                c.fail('D2', f"{key} was '{place}' at {rel(ts)} but the data allowed only {sorted(map(str, allowed))} by then "
                             f"(its next event is written {'at ' + rel(nxt) if nxt else 'never'}): the office ran ahead of the data")
        for mod, p in snap['pushes'].items():
            need = STAGE_NEEDS.get(p['stage'])
            if need and not any(e.get('mod') == mod and e.get('version') == p['version'] and e['type'] in need and tw <= ts + SAMPLE_SLACK_S for tw, e in events):
                c.fail('D2', f"push {mod} v{p['version']} was at stage '{p['stage']}' at {rel(ts)} but none of the events {sorted(need)} "
                             f"had been written yet: the office ran ahead of the data")

    # D2b every event's effect shows in time
    def visible(e, snap, later):
        mod, v, t = e.get('mod'), e.get('version'), e['type']
        if t in ('request', 'status'):
            key = f'{mod}#{e["item"]}'
            want = set()
            for p in [event_targets(e)[key]] + later:
                want |= board_both(p)
            return snap['items'].get(key) in want
        job, closed = snap['pushes'].get(mod) or {}, (snap['closed'].get(mod) or {}).get(v)
        same = job.get('version') == v
        if t == 'testing':
            return same or closed is not None
        if t == 'tests_done':
            return (same and job['stage'] in (AFTER_TESTS if e.get('ok') else {'returning'})) or closed is not None
        if t == 'judged':
            return (same and job['stage'] in (AFTER_JUDGE if e.get('ok') else {'returning'})) or closed is not None
        if t == 'push':
            return closed == 'shipped'
        return True

    checked = [(tw, e) for tw, e in events if tw >= t0 and e['type'] in EFFECT_BUDGET_S]
    shown = {}
    for tw, e in checked:
        later = [p for tw2, e2 in checked if e2['type'] in ('request', 'status') and e.get('item') == e2.get('item') and e.get('mod') == e2.get('mod') and tw2 > tw
                 for p in event_targets(e2).values()]
        at = None
        for i, (ts, snap) in enumerate(snaps):
            end = snaps[i + 1][0] if i + 1 < len(snaps) else float('inf')
            if end >= tw and visible(e, snap, later):
                at = max(ts, tw)
                break
        shown[e['n']] = at
    for tw, e in checked:
        at = shown[e['n']]
        label = f"event #{e['n']} {e['type']} {e.get('mod')} {e.get('item', e.get('version', ''))} (written {rel(tw)})"
        if at is None:
            c.fail('D2', f'{label}: its effect never showed in the office')
            continue
        waiting = sum(1 for tw2, e2 in checked if e2['n'] != e['n'] and tw2 <= tw and (shown[e2['n']] is None or shown[e2['n']] > tw))
        limit = POLL_S + EFFECT_BUDGET_S[e['type']] * (1 + waiting)
        if at - tw > limit:
            c.fail('D2', f'{label}: showed after {at - tw:.0f} s, limit {limit} s ({POLL_S} s poll + {EFFECT_BUDGET_S[e["type"]]} s x {1 + waiting})')

    # D3 the office never had to draw itself again from the data, never reloaded by itself
    if snaps:
        last = snaps[-1][1]
        if last['rebuilds'] > 1:
            c.fail('D3', f"the office had to redraw itself from the data {last['rebuilds'] - 1} time(s) (its animations ended in a state that did not match status.json)")
    if c.b.navs > 1:
        c.fail('D3', f'the page reloaded itself {c.b.navs - 1} time(s) (watchdog or version change) while the scenario ran')
    if dump['snapError']:
        c.fail('D2', 'window.__office.snapshot() threw: ' + dump['snapError'])
    for err in c.b.errors:
        c.fail('B', f'{c.name}: {err}')


async def run_scenario(name, site, browser, origin, fixture, frames_dir):
    fn = SCENARIOS[name][0]
    started = time.time()
    c = Ctx(name, site, browser, origin, fixture, frames_dir)
    browser.errors.clear()
    try:
        await fn(c)
        dump = await browser.eval('window.__probe.dump()')
        analyse(c, dump)
    except Exception as err:  # noqa: BLE001 - reported as a failure of this scenario
        c.fail('C', f'{name}: the scenario script crashed: {type(err).__name__}: {err}')
    c.seconds = time.time() - started
    return c
