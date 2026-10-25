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

import relay_mock

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

RELAY_S = 2  # relay mode: an event must reach the page within this many seconds of being written (receipt), and the
             # effect budgets below start from it instead of the poll time
RELAY_FALLBACK_S = 12  # events written while the relay is down (or just before / after): the page needs ~5 s to notice, then a poll
RELAY_RECONNECT_S = 30  # how long the page may take to find a relay that came back
SERVER_LOGS = {}  # origin of a static server -> its request log file (set by check.py)

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


class Abort(Exception):
    """the scenario cannot go on (its failure is already recorded)"""


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
        self.relay = None  # a relay_mock.RelayMock in the relay-* scenarios
        self.outages = []  # [time the relay went down, time the page was back on it or None]

    # ---- helpers for scenario scripts ----
    def status(self):
        return self.sim.load('status.json')

    def fail(self, section, text):
        if text not in self.fails[section]:
            self.fails[section].append(text)

    async def open(self, floor='f1'):
        self.initial, _ = expected_from_status(self.status())
        self.initial_last = self.status()['last_event']
        self.t_open = time.time()
        extra = ''
        if self.relay:
            self.b.origins += (self.relay.url,)  # the browser may talk to the relay (everything else off-site is answered empty)
            extra = f'&relay={self.relay.url}'
        await self.b.goto(f'{self.origin}/index.html?data=data-test/{self.name}&poll={POLL_S}{extra}', 1400, 900)
        self.opened = True
        end = time.time() + 30
        while time.time() < end:  # the office is built once it shows every item the data had when we opened
            st = await self.state()
            if st['snap'] and set(self.initial) <= set(st['snap']['items']):
                break
            await asyncio.sleep(0.1)
        else:
            self.fail('C', 'the page never built its office from the data within 30 s of opening')
            raise Abort()
        if self.relay:
            await self.expect_relay_start()
        if floor != 'f1':
            await self.show(floor)

    # ---- relay helpers ----
    def data_requests(self, since=0.0):
        """[(time, path)] of the page's requests for status.json / events.json of THIS scenario's data folder (version.txt is page code, not data)"""
        out = []
        try:
            lines = SERVER_LOGS[self.origin].read_text(encoding='utf-8').splitlines()
        except (KeyError, OSError):
            return out
        for line in lines:
            t, _, path = line.partition(' ')
            if f'/data-test/{self.name}/' in path and ('status.json' in path or 'events.json' in path) and float(t) >= since:
                out.append((float(t), path))
        return out

    def relay_calls(self, since=0.0, prefix='/state'):
        return [(t, p) for t, _, p in self.relay.log if t >= since and p.startswith(prefix)]

    async def expect_relay_start(self):
        """The page must load /state and open /live on the relay right after opening, else the scenario cannot say anything."""
        end = time.time() + 10
        while time.time() < end and not (self.relay_calls(self.t_open) and self.relay.live_connects):
            await asyncio.sleep(0.2)
        if not self.relay_calls(self.t_open):
            self.fail('C', f'relay mode: the page opened with ?relay={self.relay.url} never asked the relay for /state within 10 s (relay mode is not implemented?)')
        if not self.relay.live_connects:
            self.fail('C', 'relay mode: the page never opened the relay websocket /live within 10 s')
        if not (self.relay_calls(self.t_open) and self.relay.live_connects):
            raise Abort()

    async def relay_down(self):
        self.outages.append([time.time(), None])
        self.relay.down()

    async def relay_up(self):
        """Bring the relay back and wait until the page is on it again (a new /live socket) plus a moment for its in-flight polls."""
        before = len(self.relay.live_connects)
        t_up = time.time()
        self.relay.up()
        end = t_up + RELAY_RECONNECT_S
        while time.time() < end and len(self.relay.live_connects) == before:
            await asyncio.sleep(0.25)
        if len(self.relay.live_connects) == before:
            self.fail('C', f'relay mode: the relay was back for {RELAY_RECONNECT_S} s but the page never reconnected to /live (it must keep retrying)')
            raise Abort()
        await asyncio.sleep(3)  # a data poll that was already on its way may still land
        self.outages[-1][1] = time.time()
        return t_up

    def in_outage(self, t):
        """True for a moment in, just before or shortly after a relay outage (the page may legitimately be on the data folder)"""
        return any(a - 1 <= t <= (b if b else float('inf')) + 3 for a, b in self.outages)

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


async def sc_relay_basic(c):
    """A request arriving, a desk decision and a push that passes, all through the relay."""
    await c.open()
    ids = c.request(A, 2)
    await c.settle('relay: requests arriving')
    c.sim.decide(A, ids[0], 'auto')
    await c.settle('relay: a desk decision')
    c.sim.set_status(A, 2, 'in-progress')
    await c.settle('relay: item started')
    c.sim.set_status(A, 2, 'done')
    await c.settle('relay: item done')
    await push_flow(c, A, 'beta', 'pass', 'relay push')
    asked = c.data_requests(c.t_open)
    if asked:
        c.fail('C', f'relay mode: the page asked the data folder {len(asked)} time(s) while the relay was up (first: {asked[0][1]}); it must use the relay only')


async def sc_relay_drop(c):
    """The relay goes down mid-story while events keep coming, then comes back."""
    await c.open()
    c.request(A, 1)
    await c.settle('relay: a request before the outage')
    quiet = c.data_requests(c.t_open)
    if quiet:
        c.fail('C', f'relay mode: the page asked the data folder {len(quiet)} time(s) before any outage (first: {quiet[0][1]})')
    await c.relay_down()
    t_down = time.time()
    ids = c.request(B, 2)  # written while the relay is down: only the data folder has them
    await asyncio.sleep(1)
    c.sim.decide(B, ids[0], 'auto')
    await c.wait_for('the events written during the outage to reach the page through the data folder',
                     lambda s: s['last_event'] >= c.status()['last_event'], 40)
    if not c.data_requests(t_down):
        c.fail('C', 'relay mode: the relay was down but the page never fell back to polling the data folder')
    c.request(D, 1)  # a later outage event
    await c.settle('relay: caught up through the data folder during the outage')
    t_up = await c.relay_up()
    if not c.relay_calls(t_up):
        c.fail('C', 'relay mode: the page came back to the relay but did not load its state (GET /state?since=<last seen>) first')
    t_back = time.time()
    ids = c.request(A, 2)
    await asyncio.sleep(1.5)
    c.sim.decide(A, ids[0], 'with-me')
    await c.settle('relay: events after the relay came back')
    late = c.data_requests(t_back)
    if late:
        c.fail('C', f'relay mode: the relay was back, yet the page still asked the data folder {len(late)} time(s) from {late[0][0] - t_back:.1f} s after '
                    f'the reconnect on (first: {late[0][1]}); it must use the relay alone again')


async def sc_relay_gap(c):
    """One websocket update is lost: the next one skips event numbers, so the page must fill the gap from the relay's /state."""
    await c.open()
    c.request(A, 1)
    await c.settle('relay: a request before the gap')
    seen = c.status()['last_event']
    c.relay.drop_next(1)
    c.request(B, 1)  # this update never reaches the page
    await asyncio.sleep(1)
    c.request(D, 1)  # this one does, with numbers that skip the lost one
    await c.settle('relay: after a lost websocket update')
    fills = [p for _, p in c.relay_calls(c.t_open + 1) if f'since={seen}' in p]
    if not fills:
        c.fail('C', f'relay mode: an update skipped event numbers (the page had seen up to #{seen}) but the page never asked the relay GET /state?since={seen} '
                    f'(state requests: {[p for _, p in c.relay_calls(c.t_open)]})')
    bad = c.data_requests(c.t_open)
    if bad:
        c.fail('C', f'relay mode: the page asked the data folder {len(bad)} time(s) (first: {bad[0][1]}); a gap must be filled from the relay /state')


async def sc_overflow_carry(c):
    """Requests that are not drawn (hidden behind a '+N' tile, or beyond the first 4 on a builder's desk) must still be visible
    while somebody carries them or they move: decide / finish the hidden ones."""
    await c.open()
    ids = c.request(A, 7)  # the front desk shows 8 (7 + the '+N' tile): with the fixture's own requests this is well past it
    await c.settle('front desk filled past its maximum (the newest requests are hidden behind +N)')
    c.sim.decide(A, ids[-1], 'auto')  # the newest = a hidden one
    await c.settle('decision on a HIDDEN overflow request (Floor 1 mod, clerk carries it to the board)')
    dids = c.request(D, 1)
    await c.settle('a Dungeon request arriving on the full desk')
    c.sim.decide(D, dids[0], 'auto')  # also hidden
    await c.settle('decision on a HIDDEN overflow request of a Dungeon mod (elevator trip)')
    # a builder desk with more than 4 items in progress: the 5th and later are not drawn
    c.sim.decide(A, ids[0], 'auto')
    c.sim.decide(A, ids[1], 'auto')
    await c.settle('two more requests on the board')
    planned = [i['id'] for m in c.status()['mods'] if m['key'] == A for i in m['items'] if i['status'] == 'planned']
    for i in planned:
        c.sim.set_status(A, i, 'in-progress')
    await c.settle(f'{len(planned)} board requests started (the builder desk is past its 4 shown)')
    desk = [i['id'] for m in c.status()['mods'] if m['key'] == A for i in m['items'] if i['status'] == 'in-progress']
    c.sim.set_status(A, desk[-1], 'done')  # the last one started is not drawn on the desk
    await c.settle('a HIDDEN overflow builder-desk item done (to the READY pile)')
    c.sim.set_status(A, desk[-2], 'done')
    await c.settle('a second overflow item done')


async def sc_handoff_order(c):
    """Hand-offs in order, with events arriving one at a time through the relay: a request decided for a board on another floor
    is started 2 s later (the runner must wait for the clerk to pin it), and a push whose events come close together."""
    await c.open('b1')
    ids = c.request(D, 1)
    await c.settle('relay: a Dungeon request arriving')
    c.sim.decide(D, ids[0], 'auto')
    await asyncio.sleep(2)
    c.sim.set_status(D, ids[0], 'in-progress')  # the clerk is still on her way to the Dungeon board
    await c.settle('relay: decided, then started 2 s later (the clerk is still carrying it)')
    c.sim.set_status(D, ids[0], 'done')
    await c.settle('relay: done')
    # a push with its events close together: the loader must wait for the crate to reach the conveyor
    c.sim.begin(A, 'beta', 300, 0)
    await asyncio.sleep(1)
    c.sim.progress(A, 300, 0)
    c.sim.finish(A, 'stop-at-judge')
    await asyncio.sleep(1)
    c.judged_ok(A)
    await asyncio.sleep(1)
    c.sim.finish(A)
    await c.settle('relay: a push whose events came close together')


# name -> (function, in --quick)
SCENARIOS = {
    'requests': (sc_requests, False), 'desk': (sc_desk, False), 'dungeon-desk': (sc_dungeon_desk, False),
    'push-pass': (sc_push_pass, True), 'tests-fail': (sc_tests_fail, False), 'judge-fail': (sc_judge_fail, False),
    'dungeon-push': (sc_dungeon_push, False), 'mid-testing': (sc_mid_testing, False),
    'mid-judging': (sc_mid_judging, False), 'mid-shipping': (sc_mid_shipping, False), 'burst': (sc_burst, False),
    'overflow-carry': (sc_overflow_carry, False), 'handoff-order': (sc_handoff_order, False),
    'relay-basic': (sc_relay_basic, False), 'relay-drop': (sc_relay_drop, False), 'relay-gap': (sc_relay_gap, False),
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


def relay_checks(c, events, snaps, rel):
    """Relay mode: every event reaches the page within RELAY_S (D2), and each is applied exactly once, in order (D2).
    Needs the hook window.__office.snapshot().applied = list of every event number the page dispatched, in order."""
    if not snaps or any('applied' not in s for _, s in snaps):
        c.fail('D2', 'the page offers no window.__office.snapshot().applied (list of every event number it applied, in order): '
                     'the check cannot prove that no event was missed or doubled')
        return
    first_seen = {}
    for ts, s in snaps:
        for n in s['applied']:
            first_seen.setdefault(n, ts)
    for tw, e in events:
        if tw < c.t_open or c.in_outage(tw):
            continue
        at = first_seen.get(e['n'])
        if at is None:
            c.fail('D2', f"event #{e['n']} {e['type']} (written {rel(tw)}) never reached the page")
        elif at - tw > RELAY_S + 0.25:  # + the 100 ms sampling
            c.fail('D2', f"event #{e['n']} {e['type']} (written {rel(tw)}) reached the page after {at - tw:.1f} s, limit {RELAY_S} s in relay mode")
    applied = snaps[-1][1]['applied']
    want = sorted(n for n in c.rec if n > c.initial_last)
    dupes = sorted({n for n in applied if applied.count(n) > 1})
    if dupes:
        c.fail('D2', f'events applied more than once: {dupes}')
    missing = [n for n in want if n not in applied]
    if missing:
        c.fail('D2', f'events never applied by the page: {missing}')
    if applied != sorted(applied):
        c.fail('D2', f'events applied out of order: {applied}')


def analyse(c, dump):
    t0 = c.t_open
    rel = lambda t: f'+{t - t0:.1f}s'  # noqa: E731
    events = sorted(c.rec.values(), key=lambda r: r[0])
    snaps = [(s['t'] / 1000, s['s']) for s in dump['snaps']]
    # the page is sampled from its first moment, but until it has read the data it has no office yet (an empty snapshot says
    # nothing about where items are): judge only from the first snapshot that holds every item the data had when we opened
    built = next((i for i, (_, s) in enumerate(snaps) if set(c.initial) <= set(s['items'])), None)
    if built is None:
        c.fail('D3', 'the office never showed all the items the data had when the page was opened')
        snaps = []
    else:
        snaps = snaps[built:]

    c.stats = f"{dump['samples']} samples, {len(snaps)} state changes, {len(events)} events, {dump['itemSamples']} item sightings ({dump['restSamples']} not in a hand)"
    c.rest = dump.get('rest', {})
    # D1 nothing floats
    for v in sorted(dump['viol'], key=lambda v: v['first'])[:12]:
        c.fail('D1', f"floating {v['cls']} \"{v['what']}\" at stage ({v['x']}, {v['y']}) from {rel(v['first'] / 1000)} to {rel(v['last'] / 1000)} "
                     f"({v['count']} samples): held by nobody, not moving, resting on nothing (nearest surface -> " + v['near'] + ")")

    # D4 whatever is carried or moving can be seen
    for v in sorted(dump.get('hid', []), key=lambda v: v['first'])[:12]:
        where = f" (carried by \"{v['carrier']}\")" if v['carrier'] else ''
        c.fail('D4', f"invisible {v['kind']} {v['cls']} \"{v['what']}\"{where} from {rel(v['first'] / 1000)} to {rel(v['last'] / 1000)} "
                     f"({v['count']} samples): it is {v['kind']} but cannot be seen: {v['why']}")

    # D5a one item, one place
    for v in sorted(dump.get('twice', []), key=lambda v: v['first'])[:12]:
        if v['count'] >= 2:
            c.fail('D5', f"{v['key']} was visible in {len(v['where'])} places at once from {rel(v['first'] / 1000)} to {rel(v['last'] / 1000)} "
                         f"({v['count']} samples): " + '; '.join(v['where']))
    # D5b nothing is taken from a spot that is still pending (the real thing has not been put down there yet)
    for v in dump.get('taken', [])[:12]:
        c.fail('D5', f"{rel(v['t'] / 1000)}: \"{v['what']}\" was taken ({v['how']}) while it was still a pending placeholder: "
                     f"the step before it has not finished putting the real thing down")

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
        lat = (RELAY_FALLBACK_S if c.in_outage(tw) else RELAY_S) if c.relay else POLL_S
        limit = lat + EFFECT_BUDGET_S[e['type']] * (1 + waiting)
        if at - tw > limit:
            c.fail('D2', f'{label}: showed after {at - tw:.0f} s, limit {limit} s ({lat} s to reach the page + {EFFECT_BUDGET_S[e["type"]]} s x {1 + waiting})')

    if c.relay:
        relay_checks(c, events, snaps, rel)

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
        if c.relay and c.outages and c.relay.url.split('//')[1] in err:
            continue  # the browser logs every refused relay connection / 503 during an outage by itself: expected there
        c.fail('B', f'{c.name}: {err}')


async def run_scenario(name, site, browser, origin, fixture, frames_dir):
    fn = SCENARIOS[name][0]
    started = time.time()
    c = Ctx(name, site, browser, origin, fixture, frames_dir)
    browser.errors.clear()
    try:
        if name.startswith('relay-') or name == 'handoff-order':
            c.relay = relay_mock.RelayMock(c.data_dir)
            await c.relay.start()
        await fn(c)
        dump = await browser.eval('window.__probe.dump()')
        analyse(c, dump)
    except Abort:
        pass
    except Exception as err:  # noqa: BLE001 - reported as a failure of this scenario
        c.fail('C', f'{name}: the scenario script crashed: {type(err).__name__}: {err}')
    finally:
        if c.relay:
            await c.relay.stop()
    c.seconds = time.time() - started
    return c
