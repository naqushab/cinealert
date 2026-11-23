#!/usr/bin/env python3
"""Fetch one URL with a real Chrome TLS/HTTP2 fingerprint (curl_cffi).
stdin: {"url": "...", "headers": {...}}   stdout: {"status": 200, "body": "..."}
Used by the Node runner when FETCHER=cffi (GitHub Actions), because BookMyShow refuses
plain HTTP clients from data-centre IPs. Does not solve CAPTCHAs or challenges."""
import json
import sys

from curl_cffi import requests

req = json.load(sys.stdin)
try:
    r = requests.get(req["url"], headers=req.get("headers") or {}, impersonate="chrome", timeout=20)
    json.dump({"status": r.status_code, "body": r.text}, sys.stdout)
except Exception as e:  # network error -> status 0
    json.dump({"status": 0, "body": f"{type(e).__name__}: {e}"}, sys.stdout)
