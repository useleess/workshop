"""A tiny Chrome DevTools Protocol client: one headless Edge (never a visible window), driven over a websocket.

Every browser gets its own free debugging port and its own temp profile; stop() kills the whole process tree and
deletes the profile, also after a failure. Pages from anywhere but the local test server are answered with an empty
200 (Google Fonts), so a run never depends on the network and fonts look the same every time."""
import asyncio
import base64
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request

import aiohttp

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


PROFILES = []  # temp profile folders of every browser we started (Edge's launcher may hand over to another process,
               # so the only reliable way to find "our" browser processes is their --user-data-dir)


def kill_profile(profile):
    ps = ("Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*" + str(profile).replace("'", "''")
          + "*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }")
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True)


def kill_all_browsers():
    for p in PROFILES:
        kill_profile(p)


def kill_tree(proc):
    if proc and proc.poll() is None:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)


class Browser:
    def __init__(self, tmp_root, origins, probe_js):
        self.tmp_root, self.origins, self.probe_js = tmp_root, tuple(origins), probe_js
        self.proc = None
        self.profile = None
        self.errors = []  # console errors / exceptions / failed loads, as readable text
        self.navs = 0  # top-level navigations since the last goto() (a reload by the page itself shows here)
        self._id = 0
        self._wait = {}
        self._loaded = asyncio.Event()

    async def start(self):
        self.port = free_port()
        self.profile = tempfile.mkdtemp(prefix="edge-", dir=self.tmp_root)
        PROFILES.append(self.profile)
        self.proc = subprocess.Popen(
            [EDGE, "--headless=new", f"--remote-debugging-port={self.port}", f"--user-data-dir={self.profile}",
             "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--mute-audio",
             "--force-device-scale-factor=1", "--disable-background-timer-throttling",
             "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ws_url = None
        for _ in range(100):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json/list", timeout=2) as r:
                    pages = [t for t in json.load(r) if t.get("type") == "page"]
                if pages:
                    ws_url = pages[0]["webSocketDebuggerUrl"]
                    break
            except OSError:
                pass
            await asyncio.sleep(0.2)
        if not ws_url:
            raise RuntimeError("Edge did not start (no debugging page after 20 s)")
        self.http = aiohttp.ClientSession()
        self.ws = await self.http.ws_connect(ws_url, max_msg_size=0)
        self._reader = asyncio.create_task(self._read())
        for domain in ("Page", "Runtime", "Log", "Network"):
            await self.call(f"{domain}.enable")
        await self.call("Network.setCacheDisabled", cacheDisabled=True)
        await self.call("Fetch.enable", patterns=[{"urlPattern": "*"}])
        await self.call("Page.addScriptToEvaluateOnNewDocument", source=self.probe_js)

    async def stop(self):
        try:
            await asyncio.wait_for(self.call("Browser.close"), 5)
        except Exception:  # noqa: BLE001 - shutting down, whatever state we are in
            pass
        try:
            self._reader.cancel()
            await self.ws.close()
            await self.http.close()
        except Exception:  # noqa: BLE001
            pass
        if self.profile:
            kill_profile(self.profile)
        kill_tree(self.proc)
        for _ in range(20):  # Edge lets go of its profile a moment after it exits
            if not self.profile or not os.path.exists(self.profile):
                break
            shutil.rmtree(self.profile, ignore_errors=True)
            time.sleep(0.25)

    async def _read(self):
        async for msg in self.ws:
            if msg.type != aiohttp.WSMsgType.TEXT:
                continue
            data = json.loads(msg.data)
            if "id" in data:
                fut = self._wait.pop(data["id"], None)
                if fut and not fut.done():
                    fut.set_result(data)
            else:
                self._event(data.get("method"), data.get("params", {}))

    def _event(self, method, p):
        if method == "Page.loadEventFired":
            self._loaded.set()
        elif method == "Page.frameNavigated" and not p["frame"].get("parentId"):
            self.navs += 1
        elif method == "Runtime.exceptionThrown":
            d = p["exceptionDetails"]
            text = (d.get("exception") or {}).get("description") or d.get("text")
            self.errors.append(f"JS exception: {text} (line {d.get('lineNumber')}, col {d.get('columnNumber')}, {d.get('url', '')[-40:]})")
        elif method == "Runtime.consoleAPICalled":
            text = " ".join(str(a.get("value", a.get("description", ""))) for a in p.get("args", []))
            if p["type"] == "error" or (p["type"] == "warning" and text.startswith("workshop:")):
                self.errors.append(f"console.{p['type']}: {text[:300]}")
        elif method == "Log.entryAdded":
            e = p["entry"]
            if e["level"] == "error" and not str(e.get("url", "")).endswith("favicon.ico"):
                self.errors.append(f"browser log error: {e.get('text')} {e.get('url', '')}"[:300])
        elif method == "Inspector.targetCrashed":
            self.errors.append("the page crashed")
        elif method == "Fetch.requestPaused":
            asyncio.create_task(self._answer(p))

    async def _answer(self, p):
        url = p["request"]["url"]
        try:
            if url.startswith(self.origins + ("data:", "about:", "blob:")):
                await self.call("Fetch.continueRequest", requestId=p["requestId"])
            else:
                kind = "text/css" if "css" in url else "application/octet-stream"
                await self.call("Fetch.fulfillRequest", requestId=p["requestId"], responseCode=200,
                                responseHeaders=[{"name": "Content-Type", "value": kind}], body="")
        except Exception:  # noqa: BLE001 - the page may already be gone
            pass

    async def call(self, method, timeout=60, **params):
        self._id += 1
        fut = asyncio.get_running_loop().create_future()
        self._wait[self._id] = fut
        await self.ws.send_str(json.dumps({"id": self._id, "method": method, "params": params}))
        data = await asyncio.wait_for(fut, timeout)
        if "error" in data:
            raise RuntimeError(f"{method}: {data['error']}")
        return data.get("result", {})

    async def eval(self, expr):
        r = await self.call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        if "exceptionDetails" in r:
            raise RuntimeError("eval failed: " + json.dumps(r["exceptionDetails"])[:300])
        return r["result"].get("value")

    async def goto(self, url, width, height, mobile=False):
        await self.call("Emulation.setDeviceMetricsOverride", width=width, height=height, deviceScaleFactor=1, mobile=mobile)
        self._loaded.clear()
        self.navs = 0
        await self.call("Page.navigate", url=url)
        await asyncio.wait_for(self._loaded.wait(), 30)
        for _ in range(100):  # the office is built once the data arrived
            if await self.eval("document.querySelectorAll('.floor').length > 0"):
                return
            await asyncio.sleep(0.1)
        raise RuntimeError("the office was not built within 10 s of loading " + url)

    async def shot(self, path, full=False):
        args = {"format": "png"}
        if full:
            m = await self.call("Page.getLayoutMetrics")
            size = m.get("cssContentSize") or m["contentSize"]
            args.update(captureBeyondViewport=True, clip={"x": 0, "y": 0, "width": size["width"], "height": size["height"], "scale": 1})
        r = await self.call("Page.captureScreenshot", **args)
        with open(path, "wb") as f:
            f.write(base64.b64decode(r["data"]))
