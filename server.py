import sys

PORT = 8000

if sys.version_info < (3, 0):
    import SimpleHTTPServer
    import SocketServer

    class Handler(SimpleHTTPServer.SimpleHTTPRequestHandler):
        # See the Python 3 handler below.
        def end_headers(self):
            self.send_header("Cache-Control", "no-cache")
            SimpleHTTPServer.SimpleHTTPRequestHandler.end_headers(self)

    Handler.extensions_map = {
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
    
    httpd = SocketServer.TCPServer(("", PORT), Handler)

    print("serving at port", PORT)
    httpd.serve_forever()


else:
    import http.server
    from http.server import HTTPServer, BaseHTTPRequestHandler
    import socketserver

    # Without a Cache-Control header, browsers guess how long a file stays fresh from its age (about a tenth of the
    # time since it last changed), so a scene file untouched for a year could be reused from the cache for weeks
    # after it is edited. no-cache makes the browser check every time; an unchanged file costs a 304.
    class Handler(http.server.SimpleHTTPRequestHandler):
        def end_headers(self):
            self.send_header("Cache-Control", "no-cache")
            super().end_headers()

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