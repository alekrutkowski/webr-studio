# Browser networking source and rebuild

The app ships the compiled networking runtime in `vendor/tailscale-web/`. Ordinary
deployment only needs to serve those files. Go is required only when changing or
rebuilding the networking implementation.

## Provenance

The Go source and JavaScript API originate from
[tailscale-web](https://github.com/adrianosela/tailscale-web), version 0.1.16,
commit `004de98821ba5856332df750f431f4fcb7ca76f6`, by Adriano Sela Aviles, under
the MIT license. The upstream license is preserved in `tailscale-web/LICENSE`
and in the runtime distribution.

This copy has the following deliberate integration changes:

1. `go.mod` uses the official `tailscale.com v1.96.0` module. The upstream local
   development replacement is removed. Go verifies downloaded modules against
   `go.sum` and its module checksum service.
2. `main.go` omits the upstream experimental WebRTC signaling setting and its
   unused import. This build uses the official Tailscale transport.
3. The JavaScript API imports a separate `wasm_exec.js` from the exact compiler
   used for the WebAssembly build. It does not use the runtime shim embedded in
   the upstream npm bundle.
4. Source comments and diagnostic messages follow the project's punctuation
   style. This changes no networking behavior.
5. Generated loader URLs include the corresponding runtime asset's SHA-256 hash,
   so a future build cannot silently reuse a previous cached Go shim or binary.
6. The HTTP client's overall request timeout is increased from 30 to 120 seconds
   to allow larger data downloads through relayed connections.
7. Connection readiness requires Tailscale's `Running` state, an assigned IP,
   and a node key. An authenticated but unconnected node is not reported ready.
8. An explicit `exit-node` / `cloudflare` DNS mode lets public download queries
   use `https://1.1.1.1/dns-query` through the selected exit node. It uses
   separate resolver/download state, requires an exit node, preserves private
   and tailnet-name routing, and never falls back to browser fetch.
   Changing DNS mode or exit clears the public resolver cache and idle
   connections. Download connections have a 90-second idle timeout, and
   userspace dial callbacks return a nil connection explicitly on errors.
9. `network.diagnose()` provides explicit, bounded checks of the selected exit,
   configured WireGuard route, TSMP and PeerAPI reachability, and DNS-free public
   TCP/TLS/HTTP. TLS and HTTP use the same userspace connection with normal
   certificate verification. No trace body or credentials are returned.
10. Exit-node metadata includes operating system and device-key expiry. The Go
    API and application prevent selecting expired exits.

The included binary is built from this retained source, rather than copied from
the upstream npm binary. It includes Go's TLS implementation and the Mozilla
certificate bundle supplied by `github.com/breml/rootcerts v0.3.4`. HTTPS
certificate verification remains enabled.

## Rebuild on Linux, WSL, or Windows

Install [Go 1.26.10](https://go.dev/dl/) and Node.js, then run from the project
root:

```sh
node scripts/build-tailscale.mjs
```

The same Node command works in PowerShell. Put the required Go compiler on
`PATH`, or use `GO_BINARY` to select its executable. Examples:

```sh
GO_BINARY=/path/to/go/bin/go node scripts/build-tailscale.mjs
```

```powershell
$env:GO_BINARY = 'C:\path\to\go\bin\go.exe'
node scripts/build-tailscale.mjs
```

The script downloads pinned public Go modules, verifies their checksums, builds
for `GOOS=js GOARCH=wasm`, copies the matching Go runtime, and records artifact
SHA-256 checksums and dependency versions. It refuses an unexpected compiler
version or a module replacement. Its deterministic build flags remove local
paths, VCS metadata, and the compiler build ID.

Run `npm run test:network-runtime` with the same `GO_BINARY` to compile and
execute the Go regression tests as WebAssembly in Node.js. The tests exercise
the DNS-over-HTTPS and download dialers with controlled endpoints and require
no user credentials. The ordinary `npm test` remains independent of Go.

The development build used the official Linux archive
`go1.26.10.linux-amd64.tar.gz`, verified against SHA-256
`ccfe7ae822d2c2f41f4fe7c956199967a4dac22d0ee0d2b2bfdb440aab3b20c5` from the Go
download service. Other operating systems must use the appropriate official
archive for that same Go version.

After a build, see:

- `vendor/tailscale-web/provenance.json` for version pins and hashes.
- `vendor/tailscale-web/SHA256SUMS` for the runtime file checksums.
- `vendor/tailscale-web/THIRD-PARTY-LICENSES.txt` for Go, Tailscale, gVisor,
  certificate-bundle, and other compiled dependency notices.

## Transport behavior

The implementation makes HTTP(S) requests with a Go HTTP client whose dialer is
the Tailscale userspace TCP/IP stack. It does not fetch the destination through
the browser's ordinary HTTP fetch API. The browser still fetches the static
runtime assets and communicates with Tailscale's coordination and relay
services.

The runtime requires a Tailscale login. Reaching the public internet also
requires an approved, reachable exit node in the user's tailnet. Requests to
tailnet peers can work without an exit node, subject to tailnet access rules.

`network.setDNSMode('cloudflare')` selects public DNS through the exit node;
`network.setDNSMode('exit-node')` restores the default. The active mode is
returned in `network.getPrefs().dnsMode`. This setting changes subsequent
downloads and is reset when the exit node is cleared. Known tailnet names and
private DNS suffixes do not go to the public resolver. See `NETWORKING.md` for
the scope and recovery steps for a PeerAPI DNS timeout.

`network.diagnose()` returns seven ordered `pass`, `fail`, or `skip` checks
plus metadata for the selected exit. It does not change the active route or
resolver. TSMP and PeerAPI probes run concurrently with the public TCP, TLS,
and HTTP sequence. Each network stage is limited to ten seconds and the full
diagnostic to 35 seconds. The public target is the literal address
`1.1.1.1:443`; its failure alone does not establish that all internet access
is unavailable. Connection identity and active-route checks prevent reporting
a clean result for a different exit selected while the probes are running.

This version buffers HTTP response bodies in memory, has a 120-second overall
request timeout, and follows Go's ordinary HTTP redirects. It does not expose
per-request cancellation, streaming responses, browser cookies, or arbitrary
Fetch API options. `network.fetch()` returns a small response wrapper, with
headers as a plain object and a `bytes()` method returning a `Uint8Array`.

The API does not expose runtime shutdown. The application must run it in a
dedicated Worker and terminate that Worker to stop the connection. Removing
saved local state forgets this browser's credentials; deleting a registered
device from the tailnet remains an action in the Tailscale admin console.

## References

- [Upstream pinned source](https://github.com/adrianosela/tailscale-web/tree/004de98821ba5856332df750f431f4fcb7ca76f6)
- [Official Tailscale source](https://github.com/tailscale/tailscale/tree/v1.96.0)
- [WebVM networking design](https://labs.leaningtech.com/blog/webvm-virtual-machine-with-networking-via-tailscale)
- [Go HTTP transport for WebAssembly](https://go.dev/src/net/http/roundtrip_js.go)
- [Tailscale exit-node setup](https://tailscale.com/kb/1408/quick-guide-exit-nodes)
