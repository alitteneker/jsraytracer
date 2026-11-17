# Serves the repository for the CPU and GPU pages (python server.py, then open http://localhost:8000/). Needs Python 3.7
# or later.
PORT = 8000

import http.server
import json, os, re

PREVIEW_PATH = re.compile(r"^/tests/([A-Za-z0-9_\-]+)/preview\.jpg$")
MAX_PREVIEW_BYTES = 16 * 1024 * 1024

# Without a Cache-Control header, browsers guess how long a file stays fresh from its age (about a tenth of the
# time since it last changed), so a scene file untouched for a year could be reused from the cache for weeks
# after it is edited. no-cache makes the browser check every time; an unchanged file costs a 304.
class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # The GPU page's ?update_previews=1 (gl/webgl-demo.js) sends each scene's new preview here. This is the only
    # thing the server writes: tests/<scene>/preview.jpg, for a scene listed in tests/list.json, a JPEG, and only
    # when the request comes from this computer.
    def do_PUT(self):
        if self.client_address[0] not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
            return self.send_error(403, "Previews can only be updated from this computer")
        match = PREVIEW_PATH.match(self.path)
        if not match:
            return self.send_error(404, "Only tests/<scene>/preview.jpg can be written")
        scene = match.group(1)
        with open(self.translate_path("/tests/list.json"), encoding="utf-8") as f:
            scenes = {s["name"] for group in json.load(f)["groups"] for s in group["scenes"]}
        target = self.translate_path("/tests/%s/preview.jpg" % scene)
        if scene not in scenes or not os.path.isdir(os.path.dirname(target)):
            return self.send_error(404, "%s is not a scene in tests/list.json" % scene)
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_PREVIEW_BYTES:
            return self.send_error(413, "A preview must be a JPEG of at most %d bytes" % MAX_PREVIEW_BYTES)
        data = self.rfile.read(length)
        if not data.startswith(b"\xff\xd8\xff"):
            return self.send_error(415, "A preview must be a JPEG")
        # Write a temporary file and rename it over the old preview, so an interrupted write never leaves half
        # an image behind.
        with open(target + ".tmp", "wb") as f:
            f.write(data)
        os.replace(target + ".tmp", target)
        self.send_response(204)
        self.end_headers()

Handler.extensions_map={
    '.manifest': 'text/cache-manifest',
    '.html': 'text/html',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.svg': 'image/svg+xml',
    '.css': 'text/css',
    '.js':  'application/x-javascript',
    '.mjs': 'application/x-javascript',
    '': 'application/octet-stream', # Default
}

# One thread per request: a scene that loads many files at once (Sponza fetches two dozen textures together)
# overflows a single-threaded server's short listen queue, and the requests it refuses fail in the browser.
httpd = http.server.ThreadingHTTPServer(("", PORT), Handler)

print("serving at port", PORT)
httpd.serve_forever()