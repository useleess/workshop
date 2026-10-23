"""Fake events for testing the workshop page - writes ONLY to workshop-site/data-test/ (never the real data).

Open http://127.0.0.1:8123/?data=data-test&poll=3 and run:

    simulate.py reset                         copy the real status into data-test, empty event log
    simulate.py request <mod> [count] [bug|request]   new Discord requests (the mailman delivers them)
    simulate.py start <mod> <id>              item in progress (the fetcher takes it to the desk)
    simulate.py done <mod> <id>               item done (it moves to the READY pile)
    simulate.py push <mod> <testers|beta|release>   pack the READY pile into a crate and ship it
    simulate.py staged <mod> <kind> [total] [failed]   push with live tester count (failed > 0 = crate returns)
    simulate.py story                         a scripted demo of everything, with pauses
"""
import json
import shutil
import sys
import time
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent
REAL = SITE.parent / "discord-bot" / "site-data"  # the bot's copy of the live data (read only here)
TEST = SITE / "data-test"


def load(name):
    return json.loads((TEST / name).read_text(encoding="utf-8"))


def save(name, data):
    (TEST / name).write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def mod_of(status, key):
    mod = next((m for m in status["mods"] if m["key"] == key), None)
    if not mod:
        raise SystemExit(f"unknown mod {key!r}: {', '.join(m['key'] for m in status['mods'])}")
    return mod


def emit(status, event):
    log = load("events.json")
    n = max([status["last_event"]] + [e["n"] for e in log["events"]]) + 1
    log["events"].append({"n": n, "t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **event})
    status["last_event"] = n
    save("events.json", log)
    save("status.json", status)
    print(f"#{n} {event}")


def request(key, count=1, kind=None):
    forced = kind
    status = load("status.json")
    mod = mod_of(status, key)
    for _ in range(count):
        new_id = max([i["id"] for i in mod["items"]] + [100]) + 1
        kind = forced or ("bug" if new_id % 3 == 0 else "request")
        item = {"id": new_id, "title": f"Test {('bug' if kind == 'bug' else 'idea')} #{new_id}", "kind": kind,
                "status": "reported", "votes": 0}
        mod["items"].append(item)
        emit(status, {"type": "request", "mod": key, "item": new_id, "title": item["title"], "kind": kind,
                      "status": "reported"})


def set_status(key, item_id, new):
    status = load("status.json")
    item = next(i for i in mod_of(status, key)["items"] if i["id"] == int(item_id))
    item["status"] = new
    emit(status, {"type": "status", "mod": key, "item": item["id"], "status": new})


def push(key, kind):
    status = load("status.json")
    mod = mod_of(status, key)
    shipped = [i["id"] for i in mod["items"] if i["status"] == "done"]
    mod["items"] = [i for i in mod["items"] if i["id"] not in shipped]
    x, y, z = (mod["version"].split("-")[0].split(".") + ["0", "0"])[:3]
    mod["version"] = f"{x}.{y}.{int(z) + (0 if '-' in mod['version'] else 1)}"
    status["pushes"].insert(0, {"mod": key, "name": mod["name"], "version": mod["version"], "kind": kind,
                                "date": time.strftime("%Y-%m-%d")})
    emit(status, {"type": "push", "mod": key, "version": mod["version"], "kind": kind, "items": shipped,
                  "judge": {"Tests": [3, 3], "Safety": [4, 4], "Release notes": [3, 3]}})


def staged(key, kind, total=300, failed=0):
    """A push the way the real push command reports it: crate to a tester, live count, judge, upload."""
    status = load("status.json")
    mod = mod_of(status, key)
    shipped = [i["id"] for i in mod["items"] if i["status"] == "done"]
    x, y, z = (mod["version"].split("-")[0].split(".") + ["0", "0"])[:3]
    version = f"{x}.{y}.{int(z) + (0 if '-' in mod['version'] else 1)}"
    emit(status, {"type": "testing", "mod": key, "version": version, "kind": kind, "items": shipped})
    time.sleep(20)  # builder packs and walks to the tester
    passed = 0
    for step in range(1, 9):
        done = total * step // 8
        bad = failed * step // 8
        emit(load("status.json"), {"type": "test_progress", "mod": key, "version": version, "total": total,
                                   "passed": done - bad, "failed": bad, "skipped": 0})
        passed = done - bad
        time.sleep(3)
    ok = failed == 0
    score = {"Tests": [4 if ok else 3, 4], "Safety": [4, 4], "Release notes": [3, 3]}
    emit(load("status.json"), {"type": "tests_done", "mod": key, "version": version, "ok": ok, "total": total,
                               "passed": passed, "failed": failed, "skipped": 0})
    emit(load("status.json"), {"type": "judged", "mod": key, "version": version, "ok": ok, "score": score})
    if not ok:  # like release.py: the crate's requests need work again
        for item_id in shipped:
            set_status(key, item_id, "in-progress")
        return
    time.sleep(25)  # uploads to GitHub / Modrinth
    status = load("status.json")
    mod = mod_of(status, key)
    mod["items"] = [i for i in mod["items"] if i["id"] not in shipped]
    mod["version"] = version
    status["pushes"].insert(0, {"mod": key, "name": mod["name"], "version": version, "kind": kind,
                                "date": time.strftime("%Y-%m-%d")})
    emit(status, {"type": "push", "mod": key, "version": version, "kind": kind, "items": shipped, "judge": score})


def story():
    status = load("status.json")
    released = [m["key"] for m in status["mods"] if m["stage"] == "released"]
    dungeon = [m["key"] for m in status["mods"] if m["stage"] == "dungeon"]
    a, b = released[0], (dungeon or released)[0]
    print("Watch Floor 1 first, then the Beta Dungeon.")
    request(a, 2)
    request(b, 1)
    time.sleep(25)
    ids = [i["id"] for i in mod_of(load("status.json"), a)["items"] if i["status"] == "reported"]
    for item in ids[-2:]:
        set_status(a, item, "in-progress")
    time.sleep(20)
    for item in ids[-2:]:
        set_status(a, item, "done")
    time.sleep(8)
    push(a, "beta")
    time.sleep(40)
    item = [i["id"] for i in mod_of(load("status.json"), b)["items"]][-1]
    set_status(b, item, "in-progress")
    time.sleep(12)
    set_status(b, item, "done")
    time.sleep(5)
    push(b, "testers" if dungeon else "beta")


def main(args):
    if not args:
        print(__doc__)
        return
    cmd = args[0]
    if cmd == "reset":
        TEST.mkdir(exist_ok=True)
        shutil.copy(REAL / "status.json", TEST / "status.json")
        status = load("status.json")
        save("events.json", {"events": []})
        print(f"data-test reset (starts at event {status['last_event']})")
    elif cmd == "request":
        request(args[1], int(args[2]) if len(args) > 2 else 1, args[3] if len(args) > 3 else None)
    elif cmd == "start":
        set_status(args[1], args[2], "in-progress")
    elif cmd == "done":
        set_status(args[1], args[2], "done")
    elif cmd == "push":
        push(args[1], args[2])
    elif cmd == "staged":
        staged(args[1], args[2], int(args[3]) if len(args) > 3 else 300, int(args[4]) if len(args) > 4 else 0)
    elif cmd == "story":
        story()
    else:
        print(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
