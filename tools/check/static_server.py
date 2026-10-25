"""The check's static web server: serves a folder like `python -m http.server`, and appends one line "<unix time> <path>"
to a log file for every request it receives (before answering), so a scenario can assert which files the page asked for.

    python static_server.py PORT ROOT LOGFILE
"""
import functools
import http.server
import sys
import time


def main(port, root, logfile):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):  # no console noise
            pass

        def _log(self):
            with open(logfile, 'a', encoding='utf-8') as f:
                f.write(f'{time.time():.3f} {self.path}\n')

        def do_GET(self):
            self._log()
            super().do_GET()

        def do_HEAD(self):
            self._log()
            super().do_HEAD()

    server = http.server.ThreadingHTTPServer(('127.0.0.1', int(port)), functools.partial(Handler, directory=root))
    server.daemon_threads = True
    server.serve_forever()


if __name__ == '__main__':
    main(*sys.argv[1:4])
