"""The automatic check for the workshop website (the judge for the model ladder: exit code 0 = the change is good).

    python tools/check/check.py [--request FILE] [--baseline REF] [--quick] [--sections A,B,C,D,E] [--only NAME,..]
                                [--jobs N] [--selftest]

A  static    version equal in app.js / index.html / version.txt and higher than the baseline's when the page changed;
             no personal info in any tracked file
B  load      desktop 1400x900 and phone 390 wide: no JS exception / console error (also during every scenario), no
             horizontal scroll on the phone
C  scenarios scripted stories (requests, every desk decision, pushes that pass / fail the tests / fail the judge, a
             Dungeon push via the elevator, the page opened mid-push) played against the real page in headless Edge
D  invariants sampled every 100 ms during every scenario: D1 nothing floats (every visible block/crate/letter is held,
             moving, or resting on a declared surface = an element with data-surface); D2 nothing moves before the event
             that causes it was written, and every event shows within its time budget; D3 the office settles and then
             equals status.json; D4 whatever is carried (inside a character) or moving (a running animation) is
             visible - not class hidden, opacity 0, display none or zero size (a carrier that is itself hidden, e.g.
             riding the elevator, excuses what it holds). Scenario "overflow-carry" fills the front desk and a builder's
             desk past what they draw and then decides / finishes the hidden ones; D5 hand-offs: (a) one request / push
             crate is never visible in two elements at once, (b) nothing is taken from a `pending` placeholder (the invisible
             spot kept for a thing that is still on its way: removed, put in a hand or sent flying) - scenario
             "handoff-order" (relay mode) decides + starts a Dungeon request 2 s apart and runs a push whose events
             arrive close together
E  looks     fixed settled scenes (both floors, dashboard, phone, pushes in flight) rendered for this copy and for the
             baseline and pixel-diffed. Without --request any difference fails; with --request an AI reviewer must
             explain every changed region from the request text.

Relay scenarios (names start with "relay-", run them alone with --only relay-basic,relay-drop,relay-gap): the page opened
with ?relay=<url of tools/check/relay_mock.py> must get its data from the relay only (zero requests for status.json /
events.json from the data folder, seen in the static server's request log), show every event within 2 s of its being written,
exactly once (needs window.__office.snapshot().applied = every event number the page applied, in order), fall back to polling
the data folder while the relay is down, and go back to the relay alone when it returns; a missed websocket message must be
filled from the relay's /state, never from the data folder.

Relay scenarios (relay-basic, relay-drop, relay-gap; run alone with --only relay-basic,relay-drop,relay-gap): the page opened
with ?relay=<url of tools/check/relay_mock.py> must get its data from the relay only (zero requests for status.json /
events.json of the data folder, seen in the static server's request log), have every event within 2 s of its being written,
exactly once (needs window.__office.snapshot().applied = every event number the page dispatched, in order), poll the data
folder while the relay is down, and use the relay alone again once it is back; a lost websocket update must be filled from
the relay's /state, never from the data folder.

Baseline = origin/main unless --baseline REF is given. Runs only inside this repo copy (works in a ladder worktree), its
git-ignored data-test folder and one temp folder. Always kills the browsers and the servers it started.
"""
import argparse
import asyncio
import atexit
import glob
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SITE = HERE.parent.parent
sys.path.insert(0, str(HERE))
import cdp  # noqa: E402
import scenarios  # noqa: E402

PERSONAL = re.compile('nd' + 'san|san' + 'dri', re.I)  # (built from pieces so this file does not match itself)
PROBE = (HERE / 'probe.js').read_text(encoding='utf-8')
FIXTURE = HERE / 'fixture' / 'status.json'
SECTION_NAMES = {'X': 'crash', 'A': 'static', 'B': 'load', 'C': 'scenarios', 'D': 'invariants', 'E': 'looks'}
PHONE = (390, 844)
DESKTOP = (1400, 900)
FREEZE_CSS = ('*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }'
              ' #live { visibility: hidden !important; }')  # still pictures: no walking legs, no "updated 3 s ago"

def rm(path, ignore_errors=True):
    """delete a folder tree, also git's read-only object files; a missing folder is fine"""
    def unlock(func, p, _):
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except OSError:
            pass
    if os.path.exists(path):
        shutil.rmtree(path, onerror=unlock)


PROCS = []  # everything we started, killed at exit whatever happens
TMP = None


def cleanup_at_exit():
    for p in PROCS:
        cdp.kill_tree(p)
    cdp.kill_all_browsers()


atexit.register(cleanup_at_exit)


def run(cmd, cwd=SITE, check=True):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding='utf-8', errors='replace')
    if check and r.returncode:
        raise RuntimeError(f"{' '.join(map(str, cmd))}: {r.stderr.strip()[:300]}")
    return r.stdout


def start_server(root):
    port = cdp.free_port()
    log = Path(TMP) / f'requests-{port}.log'  # every request the page makes, with its time (scenarios.data_requests reads it)
    p = subprocess.Popen([sys.executable, str(HERE / 'static_server.py'), str(port), str(root), str(log)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    PROCS.append(p)
    scenarios.SERVER_LOGS[f'http://127.0.0.1:{port}'] = log
    import urllib.request
    for _ in range(50):
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{port}/version.txt', timeout=1).close()
            return f'http://127.0.0.1:{port}', p
        except OSError:
            time.sleep(0.1)
    raise RuntimeError('the test web server did not start')


# ------------------------------------------------------------------ baseline ----------------------------------------------------------------

class Baseline:
    """A folder with the baseline copy of the site: a temp git worktree of REF (removed afterwards), or --baseline-dir."""

    def __init__(self, ref, folder):
        self.ref, self.root, self.owned = ref, None, False
        if folder:
            self.root = Path(folder)
            return
        if subprocess.run(['git', 'rev-parse', '--verify', '-q', ref + '^{commit}'], cwd=SITE, capture_output=True).returncode:
            raise RuntimeError(f'baseline {ref!r} does not exist in this repo (pass --baseline REF with a commit that does)')
        self.root = Path(TMP) / 'baseline'
        run(['git', 'worktree', 'add', '--detach', str(self.root), ref])
        self.owned = True

    def close(self):
        if self.owned:
            subprocess.run(['git', 'worktree', 'remove', '--force', str(self.root)], cwd=SITE, capture_output=True)
            subprocess.run(['git', 'worktree', 'prune'], cwd=SITE, capture_output=True)
            rm(self.root, ignore_errors=True)
            self.owned = False


def text_of(path):
    return Path(path).read_text(encoding='utf-8', errors='replace').replace('\r\n', '\n') if Path(path).exists() else ''


# ------------------------------------------------------------------ A: static ----------------------------------------------------------------

def section_a(base):
    fails = []
    app, html, txt = text_of(SITE / 'app.js'), text_of(SITE / 'index.html'), text_of(SITE / 'version.txt').strip()
    m = re.search(r"SITE_VERSION = '(\d+)'", app)
    tags = re.findall(r'(?:style\.css|app\.js)\?v=(\d+)', html)
    versions = {'app.js SITE_VERSION': m.group(1) if m else None, 'version.txt': txt or None}
    for i, v in enumerate(tags):
        versions[f'index.html ?v= #{i + 1}'] = v
    if len(tags) != 2:
        fails.append(f'index.html must have exactly two ?v=N (style.css and app.js), found {len(tags)}')
    if len(set(versions.values())) != 1 or None in versions.values():
        fails.append('the site version must be equal in all 3 places (app.js SITE_VERSION, ?v= on style.css and app.js in index.html, version.txt): '
                     + ', '.join(f'{k}={v}' for k, v in versions.items()))
    changed = [f for f in ('app.js', 'style.css', 'index.html') if text_of(SITE / f) != text_of(base.root / f)]
    base_v = text_of(base.root / 'version.txt').strip()
    if changed and txt.isdigit() and base_v.isdigit() and int(txt) <= int(base_v):
        fails.append(f"{', '.join(changed)} changed but the version ({txt}) is not higher than the baseline's ({base_v}): bump it in all 3 places")
    try:
        names = run(['git', 'ls-files', '-co', '--exclude-standard']).splitlines()
    except (RuntimeError, OSError):
        names = [str(p.relative_to(SITE)) for p in SITE.rglob('*') if p.is_file() and 'data-test' not in p.parts and '.git' not in p.parts]
    for name in names:
        path = SITE / name
        if not path.is_file() or path.stat().st_size > 2_000_000:
            continue
        try:
            body = path.read_bytes().decode('utf-8')
        except UnicodeDecodeError:
            continue
        hit = PERSONAL.search(body) or PERSONAL.search(name)
        if hit:
            fails.append(f'personal information ("{hit.group(0)}") in tracked file {name}: remove it')
    return fails


# ------------------------------------------------------------------ B + E: load, looks ----------------------------------------------------------------

async def section_b(browser, origin, data_name):
    fails = []
    url = f'{origin}/index.html?data=data-test/{data_name}&poll=2'
    for label, (w, h), mobile in (('desktop', DESKTOP, False), ('phone', PHONE, True)):
        browser.errors.clear()
        await browser.goto(url, w, h, mobile)
        await asyncio.sleep(3.5)  # past one poll
        for view in ('office', 'dashboard'):
            if view == 'dashboard':
                try:
                    await browser.eval("document.querySelector('[data-go=\"dashboard\"]').click()")
                except RuntimeError:
                    fails.append(f'{label}: the Dashboard button is missing (the page did not finish building its bar)')
                    for err in browser.errors:
                        fails.append(f'{label} {view}: {err}')
                    break
                await asyncio.sleep(0.5)
            for err in browser.errors:
                fails.append(f'{label} {view}: {err}')
            if mobile:
                wide = await browser.eval('({sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, iw: window.innerWidth})')
                if max(wide['sw'], wide['bw']) > wide['iw']:
                    fails.append(f"phone {view}: the page scrolls sideways (scrollWidth {max(wide['sw'], wide['bw'])} > window {wide['iw']})")
            browser.errors.clear()
        if browser.navs > 1:
            fails.append(f'{label}: the page reloaded itself while idle')
    return fails


def make_scenes(sim_site, tmp):
    """Fixed data for the still scenes, written with the site's own simulator into tmp/scenes/<name>/."""
    scenes = {}
    for name, steps in (('base', []), ('testing', [('begin', scenarios.A, 'beta', 2000, 700)]),
                        ('judging', [('begin', scenarios.D, 'testers', 300, 300), ('finish', scenarios.D, 'stop-at-judge')]),
                        ('shipping', [('begin', scenarios.A, 'beta', 300, 300), ('finish', scenarios.A, 'stop-at-judge'), ('judged', scenarios.A)])):
        d = Path(tmp) / 'scenes' / name
        d.mkdir(parents=True)
        sim = scenarios.load_sim(sim_site, d, {})
        sim.main(['reset', '--from', str(FIXTURE)])
        for step in steps:
            if step[0] == 'begin':
                sim.begin(*step[1:])
            elif step[0] == 'finish':
                sim.finish(*step[1:])
            else:
                status = sim.load('status.json')
                flight = next(f for f in status['in_flight'] if f['mod'] == step[1])
                sim.emit(status, {'type': 'judged', 'mod': step[1], 'version': flight['version'], 'ok': True,
                                  'score': {'Tests': [4, 4], 'Safety': [4, 4], 'Release notes': [3, 3]}})
        scenes[name] = d
    return scenes


# (scene name, data, viewport, mobile, view clicked after loading)
SCENES = [('floor1', 'base', DESKTOP, False, 'f1'), ('dungeon', 'base', DESKTOP, False, 'b1'), ('dashboard', 'base', DESKTOP, False, 'dashboard'),
          ('floor1-phone', 'base', PHONE, True, 'f1'), ('dungeon-phone', 'base', PHONE, True, 'b1'), ('dashboard-phone', 'base', PHONE, True, 'dashboard'),
          ('floor1-testing', 'testing', DESKTOP, False, 'f1'), ('floor1-shipping', 'shipping', DESKTOP, False, 'f1'),
          ('dungeon-judging', 'judging', DESKTOP, False, 'b1')]


async def shoot_scenes(browser, origin, side, out, quick):
    for name, data, (w, h), mobile, view in SCENES:
        if quick and name not in ('floor1', 'dungeon', 'floor1-testing'):
            continue
        await browser.goto(f'{origin}/index.html?data=data-test/scene-{data}&poll=3600', w, h, mobile)
        await browser.eval('window.__probe.showAll(false)')  # the probe normally shows every floor at once
        await browser.eval(f'(() => {{ const s = document.createElement("style"); s.textContent = {json.dumps(FREEZE_CSS)}; document.head.appendChild(s); }})()')
        if view != 'f1':
            await browser.eval(f"document.querySelector('[data-go=\"{view}\"]').click()")
        await asyncio.sleep(0.8)
        await browser.shot(out / f'{name}.{side}.png', full=True)


def diff_images(a, b, out):
    from PIL import Image, ImageChops
    ia, ib = Image.open(a).convert('RGB'), Image.open(b).convert('RGB')
    if ia.size != ib.size:
        return -1, None
    mask = ImageChops.difference(ia, ib).convert('L').point(lambda p: 255 if p else 0)
    count = mask.histogram()[255]
    if count:
        shade = ib.point(lambda p: p // 3 + 120)
        Image.composite(Image.new('RGB', ib.size, (255, 0, 0)), shade, mask).save(out)
    return count, mask.getbbox()


def claude_exe():  # the same search as ModelLadder's ladder.py
    if os.environ.get('LADDER_CLAUDE'):
        return os.environ['LADDER_CLAUDE']
    found = shutil.which('claude')
    if found:
        return found
    exts = glob.glob(os.path.expanduser(r'~\.vscode\extensions\anthropic.claude-code-*-win32-x64'))
    key = lambda p: [int(x) for x in os.path.basename(p).split('-')[2].split('.') if x.isdigit()]  # noqa: E731
    for e in sorted(exts, key=key, reverse=True):
        exe = os.path.join(e, 'resources', 'native-binary', 'claude.exe')
        if os.path.exists(exe):
            return exe
    raise RuntimeError('Claude Code CLI not found (set LADDER_CLAUDE to its path)')


JUDGE_PROMPT = """You review a change to a small animated website (an office of little workers who carry requests and crates around). \
The change was meant to do exactly this:

=== REQUEST ===
{request}
=== END REQUEST ===

An automatic check rendered still scenes of the baseline (before) and of the changed site (after), and pixel-diffed them. \
Use the Read tool to look at EVERY image listed here (all are in the current folder):
{listing}

Decide: (1) is every changed region in the before/after/diff images explained by the request (no unrequested visual change: no moved, \
recoloured, resized, missing or extra elements elsewhere)? (2) do the frames from the running scenarios show what the request asked for \
(the frames are named <scenario>-<moment>.png, taken from the changed site)? An image listed as "no still-scene difference" means \
the still scenes are identical, which is fine when the request only changes animation.
Answer with ONLY one JSON object, no other text: {{"ok": true|false, "unrequested": ["each visual change the request does not explain, with where"], "why": "one or two sentences"}}"""


def judge(request_text, listing_files, imgdir):
    listing = '\n'.join(f'- {n}: {d}' for n, d in listing_files)
    prompt = JUDGE_PROMPT.format(request=request_text.strip(), listing=listing or '- (no images)')
    r = subprocess.run([claude_exe(), '-p', prompt, '--model', 'opus', '--output-format', 'json', '--allowedTools', 'Read',
                        '--add-dir', str(imgdir)], cwd=imgdir, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=900)
    try:
        text = json.loads(r.stdout)['result']
    except (ValueError, KeyError):
        raise RuntimeError(f'the visual reviewer (claude CLI) gave no usable answer: {r.stdout[:200]!r} {r.stderr[:200]!r}')
    a, b = text.find('{'), text.rfind('}')
    try:
        return json.loads(text[a:b + 1])
    except ValueError:
        raise RuntimeError(f'the visual reviewer did not answer with JSON: {text[:300]!r}')


async def section_e(browser, origin, base_origin, args, frames_dir, imgdir):
    fails = []
    out = imgdir / 'looks'
    out.mkdir()
    await shoot_scenes(browser, origin, 'after', out, args.quick)
    await shoot_scenes(browser, base_origin, 'before', out, args.quick)
    changed, same = [], []
    for name, *_ in SCENES:
        a, b = out / f'{name}.before.png', out / f'{name}.after.png'
        if not a.exists():
            continue
        count, box = diff_images(a, b, out / f'{name}.diff.png')
        (changed if count else same).append((name, count, box))
    for name, count, box in changed:
        fails.append(f"scene {name}: {'the picture size changed' if count < 0 else f'{count} pixels differ, in the box {box}'}")
    if not args.request:
        if changed:
            return [f'a change that was not requested looks different from the baseline ({len(changed)} of {len(changed) + len(same)} scenes); '
                    'without --request any visual difference fails. before/after/diff pictures: ' + str(out)] + fails
        return []
    listing = []
    for name, count, box in changed:
        listing += [(f'looks/{name}.before.png', f'baseline, scene {name}'), (f'looks/{name}.after.png', f'changed site, scene {name}')]
        if count > 0:
            listing.append((f'looks/{name}.diff.png', f'changed pixels of scene {name} in red ({count} pixels, box {box})'))
    if not changed:
        listing.append(('(none)', 'no still-scene difference in any of ' + ', '.join(n for n, *_ in same)))
    for f in sorted(frames_dir.glob('*.png')):
        shutil.copy(f, imgdir / f.name)
        listing.append((f.name, 'frame from a running scenario of the changed site'))
    verdict = judge(Path(args.request).read_text(encoding='utf-8'), listing, imgdir)
    if not verdict.get('ok') or verdict.get('unrequested'):
        return ['visual reviewer: ' + str(verdict.get('why', '')), *[f'unrequested: {u}' for u in verdict.get('unrequested', [])]] + [f'pictures: {imgdir}']
    return []


# ------------------------------------------------------------------ main ----------------------------------------------------------------

async def pool(names, origin, args, frames_dir, results):
    queue = asyncio.Queue()
    for n in names:
        queue.put_nowait(n)

    async def worker():
        browser = cdp.Browser(TMP, (origin,), PROBE)
        await browser.start()
        try:
            while True:
                try:
                    name = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                c = await scenarios.run_scenario(name, SITE, browser, origin, FIXTURE, frames_dir)
                results.append(c)
                print(f'  scenario {name}: {c.seconds:.0f} s, {sum(len(v) for v in c.fails.values())} problem(s); {getattr(c, "stats", "")}', flush=True)
        finally:
            await browser.stop()

    await asyncio.gather(*(worker() for _ in range(min(args.jobs, len(names)))))


async def main_async(args):
    global TMP
    sections = set(args.sections.upper().split(','))
    TMP = tempfile.mkdtemp(prefix='workshop-check-')
    imgdir = Path(TMP) / 'pictures'
    imgdir.mkdir()
    frames_dir = Path(TMP) / 'frames'
    frames_dir.mkdir()
    report = {s: [] for s in 'ABCDEX'}
    base = None
    started = time.time()
    try:
        base = Baseline(args.baseline, args.baseline_dir) if sections & {'A', 'E'} else None
        origin, _ = start_server(SITE)
        if 'A' in sections:
            report['A'] += section_a(base)
        names = [n for n, (_, q) in scenarios.SCENARIOS.items() if q or not args.quick]
        if args.only:
            names = [n for n in args.only.split(',') if n in scenarios.SCENARIOS]
        results = []
        tasks = []
        if sections & {'C', 'D'} and names:
            tasks.append(pool(names, origin, args, frames_dir if args.request else None, results))

        async def b_and_e():
            base_origin = None
            browser = cdp.Browser(TMP, (origin,), PROBE)
            if 'E' in sections:
                base_origin, _ = start_server(base.root)
                browser.origins = (origin, base_origin)
            await browser.start()
            try:
                if 'B' in sections:
                    d = SITE / 'data-test' / 'load'
                    d.mkdir(parents=True, exist_ok=True)
                    sim = scenarios.load_sim(SITE, d, {})
                    sim.main(['reset', '--from', str(FIXTURE)])
                    report['B'] += await section_b(browser, origin, 'load')
                if 'E' in sections:
                    scene_dirs = make_scenes(SITE, TMP)
                    for root in (SITE, base.root):
                        for name, d in scene_dirs.items():
                            target = root / 'data-test' / f'scene-{name}'
                            rm(target, ignore_errors=True)
                            shutil.copytree(d, target)
                    report['E'] += await section_e(browser, origin, base_origin, args, frames_dir, imgdir)
            finally:
                await browser.stop()

        if sections & {'B', 'E'}:
            tasks.append(b_and_e())
        outcomes = await asyncio.gather(*tasks, return_exceptions=True)
        for o in outcomes:
            if isinstance(o, Exception):
                import traceback
                report['X'].append(f'the check itself crashed: {type(o).__name__}: {o}\n' + ''.join(traceback.format_exception(o))[-1500:])
        if args.keep:
            rest = {}
            for c in results:
                for key, v in getattr(c, 'rest', {}).items():
                    r = rest.setdefault(key, [v['min'], v['max'], 0])
                    r[0], r[1], r[2] = min(r[0], v['min']), max(r[1], v['max']), r[2] + v['n']
            print('\nhow items rest (bottom edge below the surface top edge, office px):')
            for key, (lo, hi, n) in sorted(rest.items()):
                print(f'    {key:<34} {lo:>5} .. {hi:<5} ({n} sightings)')
        for c in results:
            for sec, msgs in c.fails.items():
                key = sec[0]
                report[key] += [f'[{c.name}] {m}' if not m.startswith(c.name) else m for m in msgs]
    finally:
        if base:
            base.close()
        for p in PROCS:
            cdp.kill_tree(p)
        cdp.kill_all_browsers()
    shown = [s for s in 'ABCDE' if s in sections] + (['X'] if report['X'] else [])
    print()
    ok = True
    for s in shown:
        bad = report[s]
        ok &= not bad
        print(f"{s} {SECTION_NAMES[s]:<11}{'PASS' if not bad else 'FAIL'}")
        for line in bad[:14]:
            print('    - ' + line.replace('\n', '\n      '))
        if len(bad) > 14:
            print(f'    ... and {len(bad) - 14} more')
    print(f'\nRESULT: {"PASS" if ok else "FAIL"}   ({time.time() - started:.0f} s)')
    # keep the pictures only when they can help (a failed run); everything else of the temp folder goes
    if args.keep:
        for f in frames_dir.glob('*.png'):
            shutil.copy(f, imgdir / f.name)
    keep = (args.keep or not ok) and any(imgdir.rglob('*.png'))
    if keep:
        print(f'pictures kept in: {imgdir}')
    rm(Path(TMP) / 'baseline', ignore_errors=True)
    for sub in ('frames', 'scenes') + (() if keep else ('pictures',)):
        rm(Path(TMP) / sub, ignore_errors=True)
    for d in glob.glob(str(Path(TMP) / 'edge-*')):
        rm(d, ignore_errors=True)
    if not keep:
        rm(TMP, ignore_errors=True)
    mine = set(scenarios.SCENARIOS) | {'load'}
    for d in (SITE / 'data-test').glob('*') if (SITE / 'data-test').exists() else []:
        if d.is_dir() and (d.name in mine or d.name.startswith('scene-')):
            rm(d, ignore_errors=True)
    return 0 if ok else 1


def forget_old_runs():
    for d in glob.glob(os.path.join(tempfile.gettempdir(), 'workshop-check-*')):
        if time.time() - os.path.getmtime(d) > 86400:
            rm(d, ignore_errors=True)


def selftest(args):
    """Plant one problem at a time in a copy of this site and prove the check catches it (and passes the unmodified copy)."""
    forget_old_runs()
    root = Path(tempfile.mkdtemp(prefix='workshop-selftest-'))
    rows = []
    try:
        pristine = root / 'pristine'
        shutil.copytree(SITE, pristine, ignore=shutil.ignore_patterns('data-test', '__pycache__', '.git'))

        def plant(case):
            def edit(path, old, new, count=None):
                f = case / path
                text = f.read_text(encoding='utf-8', newline='')
                assert old in text, f'selftest: {old!r} not found in {path}'
                f.write_text(text.replace(old, new), encoding='utf-8', newline='')
            return edit

        cases = [
            ('unmodified copy', 'A,B,C,D', 'push-pass', [], lambda e: None),
            ('floating crate (a resting crate 40 px too high)', 'C,D', 'push-pass', ['D'],
             lambda e: e('app.js', '984, station.y + 16', '984, station.y - 24')),
            ('item moves before its event (judge starts without the judged event)', 'C,D', 'push-pass', ['D'],
             lambda e: e('app.js', "    await toTester(M, job);\n  });\n}", "    await toTester(M, job);\n    setTimeout(() => jobStep(job, () => judgeStep(M, job, {}, true)), 1500);\n  });\n}")),
            ('unrequested colour change (lane tint)', 'E', '', ['E'],
             lambda e: e('style.css', '.lane-bg.auto { background: rgba(143,227,176,0.22); }', '.lane-bg.auto { background: rgba(143,227,176,0.40); }')),
            ('JS error on load', 'B', '', ['B'],
             lambda e: e('app.js', 'function renderScores() {\n', 'function renderScores() {\n  planted.boom();\n')),
        ]
        for title, sections, only, expect_fail, edit in cases:
            case = root / 'case'
            rm(case, ignore_errors=True)
            shutil.copytree(pristine, case)
            try:
                edit_fn = plant(case)
                edit(edit_fn)
            except AssertionError as err:
                rows.append((title, 'SELFTEST BROKEN', str(err)))
                continue
            cmd = [sys.executable, str(case / 'tools' / 'check' / 'check.py'), '--baseline-dir', str(pristine), '--sections', sections, '--jobs', '1']
            if only:
                cmd += ['--only', only]
            else:
                cmd += ['--quick']
            t = time.time()
            env = dict(os.environ, MOD_MAKER_ROOT=str(scenarios.mod_maker_root(SITE)))
            r = subprocess.run(cmd, cwd=case, env=env, capture_output=True, text=True, encoding='utf-8', errors='replace')
            line = {m.group(1): m.group(2) for m in re.finditer(r'^([A-E]) \S+\s+(PASS|FAIL)', r.stdout, re.M)}
            failed = sorted(k for k, v in line.items() if v == 'FAIL')
            good = (failed == sorted(expect_fail)) if expect_fail else (not failed and r.returncode == 0)
            rows.append((title, 'caught' if (expect_fail and good) else 'passes' if good else 'WRONG', f"failed sections: {failed or 'none'}, exit {r.returncode}, {time.time() - t:.0f} s"))
            if not good:
                rows[-1] += ((r.stdout + r.stderr)[-1800:],)
            rm(case, ignore_errors=True)
    finally:
        rm(root, ignore_errors=True)
    print('\nSELFTEST')
    print(f"{'planted problem':<72}{'result':<10}details")
    ok = True
    for row in rows:
        print(f'{row[0]:<72}{row[1]:<10}{row[2]}')
        if row[1] in ('WRONG', 'SELFTEST BROKEN'):
            ok = False
            if len(row) > 3:
                print('    ' + row[3].replace('\n', '\n    '))
    print('SELFTEST ' + ('PASS: every planted problem is caught' if ok else 'FAIL'))
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--request', help='text file: what the change was meant to do (an AI reviewer explains the visual changes from it)')
    ap.add_argument('--baseline', default='origin/main', help='git ref to compare the looks and the version with (default origin/main)')
    ap.add_argument('--baseline-dir', help='compare with this folder instead of a git ref (used by --selftest)')
    ap.add_argument('--quick', action='store_true', help='fewer scenarios and still scenes, for development (the ladder uses the full run)')
    ap.add_argument('--sections', default='A,B,C,D,E')
    ap.add_argument('--only', help='comma list of scenario names; one of: ' + ', '.join(scenarios.SCENARIOS))
    ap.add_argument('--jobs', type=int, default=3, help='scenarios played side by side, each in its own headless browser (default 3)')
    ap.add_argument('--keep', action='store_true', help='keep the pictures and print how tightly items rest on each surface')
    ap.add_argument('--selftest', action='store_true')
    args = ap.parse_args()
    if args.selftest:
        return selftest(args)
    forget_old_runs()
    try:
        return asyncio.run(main_async(args))
    except RuntimeError as err:
        print('CHECK COULD NOT RUN: ' + str(err))
        return 2


if __name__ == '__main__':
    sys.exit(main())
