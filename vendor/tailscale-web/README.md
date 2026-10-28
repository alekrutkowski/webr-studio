# webR Studio networking runtime

These files provide a browser Tailscale node and an HTTP(S) client for the
optional networking feature. The `main.wasm` binary is built from the retained
source in `network-src/`, with official Tailscale v1.96.0 and Go 1.26.10.

The entry point is `tailscale-web.es.js`. Keep that file, `wasm_exec.js`, and
`main.wasm` in the same directory. Serve `.wasm` files as `application/wasm`.
The app loads the runtime only when networking is connected.

See `../../network-src/README.md` for rebuild instructions and transport limits.
`provenance.json` records exact versions and artifact hashes. `SHA256SUMS` can
be checked with `sha256sum -c SHA256SUMS` on Linux or WSL.

The upstream JavaScript API and Go bridge are MIT-licensed by Adriano Sela
Aviles. `LICENSE.tailscale-web.txt` preserves that license, and
`THIRD-PARTY-LICENSES.txt` preserves notices for all compiled Go modules,
including Go, Tailscale, gVisor, WireGuard, and the Mozilla CA bundle.
