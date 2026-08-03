#!/usr/bin/env python3
"""Serve webR Studio locally with the headers required for SharedArrayBuffer."""

from __future__ import annotations

import argparse
import http.server
import socketserver
from pathlib import Path


class IsolatedHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
        ".webmanifest": "application/manifest+json",
    }

    def end_headers(self) -> None:
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


class ReusableTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    root = Path(__file__).resolve().parent
    handler = lambda *handler_args, **handler_kwargs: IsolatedHandler(  # noqa: E731
        *handler_args, directory=str(root), **handler_kwargs
    )
    with ReusableTCPServer((args.host, args.port), handler) as server:
        print(f"webR Studio: http://{args.host}:{args.port}")
        server.serve_forever()


if __name__ == "__main__":
    main()
