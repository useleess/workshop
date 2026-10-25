"""A stand-in for the live relay (a Cloudflare Worker) used by the check's relay scenarios. Same contract as the real one:

    GET /state?since=N  -> {"status": <status.json>, "events": [events with n > N, ascending], "oldest": <smallest stored n>}  (CORS *)
    GET /live           -> WebSocket; the server sends {"type":"update","status":..,"events":[newly added events]} on every
                           change and answers the text "ping" with "pong"

It is fed from a data folder (status.json + events.json, the files tools/simulate.py writes): every ~50 ms it looks at
them and broadcasts new events with the matching status. Test controls (also plain HTTP, so it can run as its own process):

    POST /__down        close every socket; /state and /live answer 503 until /__up
    POST /__up
    POST /__drop?count=N   silently do not send the next N updates (their events stay available from /state)
    GET  /__log         every request received so far: [[unix time, "GET", "/state?since=3"], ...]

In-process use (what the check does):  mock = RelayMock(data_dir); await mock.start(); mock.url; mock.down(); mock.up();
mock.drop_next(1); mock.log; mock.live_connects; await mock.stop().   Stand-alone:  python relay_mock.py DATA_DIR [PORT]
"""
import asyncio
import json
import socket
import sys
import time
from pathlib import Path

from aiohttp import WSMsgType, web

TICK_S = 0.05


def _free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class RelayMock:
    def __init__(self, data_dir, port=None):
        self.dir, self.port = Path(data_dir), port or _free_port()
        self.url = f'http://127.0.0.1:{self.port}'
        self.is_down = False
        self.dropping = 0
        self.log = []  # (time, method, path_with_query)
        self.live_connects = []  # time of every accepted /live socket
        self.sockets = set()
        self.sent_n = 0
        self._status_text = None
        self._runner = self._task = None

    # ---- data ----
    def _read(self, name):
        try:
            return json.loads((self.dir / name).read_text(encoding='utf-8'))
        except (OSError, ValueError):
            return None  # missing or half written: the next tick tries again

    def _events(self):
        data = self._read('events.json')
        return sorted(data.get('events', []), key=lambda e: e['n']) if data else None

    # ---- controls ----
    def down(self):
        self.is_down = True
        for ws in list(self.sockets):
            asyncio.ensure_future(ws.close())

    def up(self):
        self.is_down = False

    def drop_next(self, count=1):
        self.dropping += count

    # ---- server ----
    @web.middleware
    async def _mw(self, request, handler):
        self.log.append((time.time(), request.method, request.path_qs))
        if request.path.startswith('/__'):
            return await handler(request)
        if self.is_down:
            return web.Response(status=503, text='relay down', headers={'Access-Control-Allow-Origin': '*'})
        try:
            response = await handler(request)
        except web.HTTPException as err:
            err.headers['Access-Control-Allow-Origin'] = '*'
            raise
        if not isinstance(response, web.WebSocketResponse):
            response.headers['Access-Control-Allow-Origin'] = '*'
        return response

    async def _state(self, request):
        try:
            since = int(request.query.get('since', 0))
        except ValueError:
            since = 0
        status, events = self._read('status.json'), self._events()
        if status is None or events is None:
            return web.Response(status=503, text='data not readable')
        oldest = events[0]['n'] if events else status.get('last_event', 0) + 1
        return web.json_response({'status': status, 'events': [e for e in events if e['n'] > since], 'oldest': oldest})

    async def _live(self, request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        self.sockets.add(ws)
        self.live_connects.append(time.time())
        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT and msg.data == 'ping':
                    await ws.send_str('pong')
        finally:
            self.sockets.discard(ws)
        return ws

    async def _control(self, request):
        what = request.match_info['what']
        if what == 'down':
            self.down()
        elif what == 'up':
            self.up()
        elif what == 'drop':
            self.drop_next(int(request.query.get('count', 1)))
        elif what == 'log':
            return web.json_response([[t, m, p] for t, m, p in self.log])
        else:
            return web.Response(status=404)
        return web.Response(text='ok')

    async def _watch(self):
        while True:
            await asyncio.sleep(TICK_S)
            try:
                status, events = self._read('status.json'), self._events()
                if status is None or events is None:
                    continue
                top = max([e['n'] for e in events] + [0])
                text = json.dumps(status, sort_keys=True)
                fresh = [e for e in events if e['n'] > self.sent_n]
                if fresh and status.get('last_event', 0) < top:
                    continue  # events.json is written before status.json: wait until the pair matches
                if not fresh and text == self._status_text:
                    continue
                self._status_text = text
                self.sent_n = max(self.sent_n, top)
                if self.dropping and fresh:
                    self.dropping -= 1
                    continue
                if self.is_down:
                    continue
                message = json.dumps({'type': 'update', 'status': status, 'events': fresh})
                for ws in list(self.sockets):
                    try:
                        await ws.send_str(message)
                    except ConnectionError:
                        self.sockets.discard(ws)
            except Exception as err:  # noqa: BLE001 - a mock must keep running; show the problem
                print('relay_mock watcher:', repr(err), file=sys.stderr)

    async def start(self):
        status = self._read('status.json') or {}
        self.sent_n = max([status.get('last_event', 0)] + [e['n'] for e in (self._events() or [])])
        app = web.Application(middlewares=[self._mw])
        app.router.add_get('/state', self._state)
        app.router.add_get('/live', self._live)
        app.router.add_route('*', '/__{what}', self._control)
        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        await web.TCPSite(self._runner, '127.0.0.1', self.port).start()
        self._task = asyncio.create_task(self._watch())

    async def stop(self):
        if self._task:
            self._task.cancel()
        for ws in list(self.sockets):
            await ws.close()
        if self._runner:
            await self._runner.cleanup()
        self._task = self._runner = None


async def _serve(data_dir, port):
    mock = RelayMock(data_dir, port)
    await mock.start()
    print('relay mock on', mock.url, flush=True)
    try:
        await asyncio.Event().wait()
    finally:
        await mock.stop()


if __name__ == '__main__':
    asyncio.run(_serve(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else None))
