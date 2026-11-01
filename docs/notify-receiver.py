#!/usr/bin/env python3
"""Example receiver for rdv-gateway notify webhooks (stdlib only).

    RDV_NOTIFY_SECRET_FILES=notify.secret python3 notify-receiver.py [port] [bind-address]

Binds 127.0.0.1:8080 unless told otherwise (give your Tailscale or LAN address to
reach it from the gateway). Verifies X-Rdv-Signature (t=<unix>,v1=<hex
HMAC-SHA256(secret, t + "." + body)>, several v1= while a secret rotates), rejects a
timestamp more than 300 s from now, and handles each event id once (delivery is at
least once), remembering ids in SQLite. RDV_NOTIFY_SECRET_FILES may list several
files (separated by os.pathsep), to accept an old and a new secret while you rotate.
"""
import hashlib, hmac, json, os, sqlite3, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FILES = os.environ.get("RDV_NOTIFY_SECRET_FILES", "notify.secret").split(os.pathsep)
SECRETS = [open(f, "rb").read().strip(b" \t\r\n\v\f") for f in FILES if f]
DB = sqlite3.connect(os.environ.get("RDV_NOTIFY_DB", "rdv-notify.sqlite3"), check_same_thread=False)
DB.execute("CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at INTEGER)")
LOCK = threading.Lock()

def verify(header, body):
    parts = [p.split("=", 1) for p in (header or "").split(",") if "=" in p]
    ts = [v.strip() for k, v in parts if k.strip() == "t"]
    sigs = [v.strip() for k, v in parts if k.strip() == "v1"]
    if len(ts) != 1 or not ts[0].isdigit() or abs(time.time() - int(ts[0])) > 300:
        return False
    wants = [hmac.new(s, ts[0].encode() + b"." + body, hashlib.sha256).hexdigest() for s in SECRETS]
    return any(hmac.compare_digest(w, s) for w in wants for s in sigs)

def handle(event):  # data is metadata only; a peer's words come as {"untrusted_peer_text": ...}
    print(f"{event['at']} {event['agent_name']}: {event['event']} {json.dumps(event['data'])}", flush=True)

class Hook(BaseHTTPRequestHandler):
    timeout = 10  # a slow or stuck client cannot hold a thread
    def answer(self, status):
        self.send_response(status)
        self.end_headers()
    def do_POST(self):
        n = self.headers.get("Content-Length", "")
        if not n.isdigit():
            return self.answer(411)  # missing or negative: 4xx, never retried
        if int(n) > 65536:
            return self.answer(413)
        body = self.rfile.read(int(n))
        if not verify(self.headers.get("X-Rdv-Signature"), body):
            return self.answer(401)
        event = json.loads(body)
        with LOCK, DB:  # a retry of a handled event has the same id; if handle() fails, the id is not kept (rollback)
            if DB.execute("INSERT OR IGNORE INTO seen VALUES (?, ?)", (event["id"], int(time.time()))).rowcount:
                handle(event)
        self.answer(204)  # answer 5xx or 429 instead to have the gateway try again later

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
ThreadingHTTPServer((sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1", port), Hook).serve_forever()
