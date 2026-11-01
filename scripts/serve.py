#!/usr/bin/env python3
"""Local-only, dependency-free PNG2ANSI research web server."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import sys
import threading
import webbrowser


def main():
    if len(sys.argv) != 3:
        print('Usage: serve.py <application-directory> <port>', file=sys.stderr)
        return 2
    app = Path(sys.argv[1]).resolve()
    if not (app / 'experiments/webgpu/photographic.html').is_file():
        print(f'ERROR: Missing workbench in {app}. Run setup.bat.', file=sys.stderr)
        return 2
    try:
        port = int(sys.argv[2])
        if not 1 <= port <= 65535:
            raise ValueError()
    except ValueError:
        print('ERROR: port must be a number from 1 to 65535.', file=sys.stderr)
        return 2

    class Handler(SimpleHTTPRequestHandler):
        extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                          '.js': 'text/javascript', '.mjs': 'text/javascript',
                          '.wgsl': 'text/plain', '.json': 'application/json'}
        def end_headers(self):
            # Always reload changed HTML/ES modules during development. Python
            # SimpleHTTPRequestHandler otherwise permits stale 304 responses.
            self.send_header('Cache-Control', 'no-store, no-cache, max-age=0, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            super().end_headers()
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(app), **kwargs)

    try:
        server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    except OSError as error:
        print(f'ERROR: Unable to bind 127.0.0.1:{port}: {error}', file=sys.stderr)
        print('Run start.bat with another port, e.g. start.bat 8001.', file=sys.stderr)
        return 1
    url = f'http://127.0.0.1:{port}/experiments/webgpu/photographic.html'
    print(f'PNG2ANSI GPU-006: {url}', flush=True)
    print('The service is bound to localhost only; Ctrl+C to stop.', flush=True)
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        print('\nStopping server.')
    finally:
        server.server_close()
    return 0

if __name__ == '__main__':
    sys.exit(main())
