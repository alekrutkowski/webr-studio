# Download networking in webR Studio

## Choose your route

The **Download route** selector offers Browser direct, Tailscale, and
Cloudflare Worker proxy. Both optional transports support ordinary
`download.file()` and base R URL reads through the same bridge. Selection is
explicit; errors never trigger a fallback to a different route.

### Cloudflare Worker proxy

This alternative fetches public HTTP(S) data through a Worker in your own
Cloudflare account. It needs no Tailscale connection or exit node. It includes:

- A single dependency-free Worker file: `cloudflare-worker/worker.js`.
- An inline setup guide with **Copy worker.js**, a password generator, and
  the exact site origin to paste into Cloudflare.
- A connection check before the route becomes ready, then the existing
  **Test a download** and ordinary R download workflow.
- A detailed [step-by-step tutorial](cloudflare-worker/README.md), with
  dashboard instructions, explanations, troubleshooting, and optional CLI setup.

The Worker requires a shared `PROXY_TOKEN` secret and an exact
`ALLOWED_ORIGINS` list. Its password is separate from a Cloudflare account API
token. Only public GET downloads are accepted. The implementation preserves
binary response streams and real upstream HTTP status codes, validates
redirects, and separates proxy failures from data-server errors. It forwards
explicit target headers such as an R-supplied Authorization header without
sending the proxy password to that target.

The Worker receives target URLs, explicitly supplied request headers, and
response data. Keep using Tailscale for private tailnet services. Neither
route bypasses a data server's login, access controls, or bot restrictions.

**Cloudflare Worker proxy** and **Cloudflare through exit node** are separate:
the first is a complete alternative HTTP transport; the second changes only
DNS resolution inside an existing Tailscale connection.

### Tailscale

## What you get

Choose **Networking → Download route → Tailscale**, connect, approve the browser device, and select an exit node. Normal HTTP(S) data downloads then travel through your Tailscale connection. The destination does not need to send browser CORS headers because a Go HTTP client inside the browser's WebAssembly worker performs the request over Tailscale's TCP/IP transport.

This follows [WebVM's networking design](https://labs.leaningtech.com/blog/webvm-virtual-machine-with-networking-via-tailscale): the browser joins your tailnet, and an exit node provides public internet access. It does not require a public CORS proxy, an IDE backend, or a CheerpX virtual machine.

## First connection

1. Install Tailscale on an existing Windows or Linux device that will remain online. Advertise it as an exit node, approve it in the admin console, and ensure your tailnet access rules permit using it. The [official exit-node guide](https://tailscale.com/docs/features/exit-nodes) has the platform-specific instructions.
2. Serve this complete project over HTTPS, or run `python3 serve.py` and open `http://127.0.0.1:8000`. Do not open `index.html` as a local file. Service workers require a secure browser context.
3. Wait for R to become ready. Choose **Networking → Download route → Tailscale**, then **Connect to Tailscale**. The approximately 35 MB networking runtime loads only on demand.
4. Click the sign-in link and approve the new `webr-studio-…` device in Tailscale. Return to the IDE; the panel updates automatically. The sign-in link is explicit so pop-up blockers do not interrupt the workflow.
5. One online exit node with an unexpired device key is selected automatically. If several are available, select one yourself. If no exit node is listed, use **Refresh**, check its approval and online status, and review your tailnet policy. Expired exits are labeled and cannot be selected. Tailnet-only access is still useful for HTTP(S) services on Tailscale peers.
6. Test a URL using the panel, or run the examples below. A displayed IP and selected exit node identify the chosen route; the successful download is the reachability check.

Connecting through Tailscale does not grant access to data that requires authorization. Tailnet rules, server authentication, and ordinary HTTPS certificate checks still apply.

## DNS and exit-node timeouts

### Successful downloads shown as errors in 1.3.1

If **Test a download** succeeds and a complete file appears in R, a console
card containing only `trying URL '…'` is normal progress. Earlier versions
incorrectly labeled all raw stderr output as **Error**. R sends download
progress to that stream before transferring the file, which made a successful
download appear to fail immediately.

Version 1.4.0 renders raw progress as **Output** while preserving structured R
errors, warnings, and messages. The fix covers streamed and collected console
output, R Markdown preview, and Markdown export. It does not suppress actual
HTTP or R failures. The webR [download implementation](https://github.com/r-wasm/webr/blob/v0.6.0/patches/R-4.6.0/emscripten-xhr-download.diff#L455)
uses `REprintf` for this progress; the [R extension manual](https://stat.ethz.ch/CRAN/doc/manuals/r-devel/R-exts.html#Printing)
documents that function's stderr output.

Downloaded files now appear automatically in the left **Explorer**, alongside
saved project files. The duplicate right Files tab has been removed. Use a
row's trash icon or **Delete selected** to remove files from R and saved project
storage. Files under `/project` are automatically kept after R operations,
including binary downloads, and restored after a page reload. Files outside
`/project` remain temporary unless copied with **Keep in project**. The
[file-management section](README.md#manage-files-in-the-explorer) explains text
opening, backup status, exporting, and restart behavior.

### Actual DNS failures

**Exit node DNS** is the default. Tailscale resolves public names through the
selected exit node's PeerAPI DNS service. A failure such as
`lookup data.example.org on [::1]:53: Post "http://100.x.x.x:1/dns-query": context deadline exceeded`
means this DNS request did not complete. It occurs before the HTTP request to
the data server, so changing the CSV URL or its CORS headers cannot correct
that particular failure.

The `[::1]:53` text is Go's resolver diagnostic context. The actual DNS request
uses the shown `/dns-query` endpoint over Tailscale. TCP port 1 is a legitimate
Tailscale PeerAPI port on some platforms; it is not a port to open on your
router. An upstream [Tailscale issue](https://github.com/tailscale/tailscale/issues/20870)
describes this failure class even when the peer's WireGuard connection remains
available. The error alone does not establish whether the DNS service or the
underlying tunnel is failing.

To bypass the exit node's DNS service for public data downloads:

1. Keep the desired exit node selected.
2. Click **Use Cloudflare DNS and retry** beside the failed Networking test.
   Alternatively set **DNS for public hostnames → Cloudflare through exit node**
   and start a new test.
3. Check the DNS setting printed with the test result, then retry the R command.

The recovery button is an explicit choice to use Cloudflare. It waits for the
runtime to confirm the setting before retrying exactly the failed test URL.
Changing the input URL or connection invalidates that retry action. It does
not rerun R code. Reloading, reconnecting, or clearing the exit node restores
the default **Exit node DNS**, so select the alternative again in a new session.

The message **The DNS request through the exit node timed out** means that
particular request began with the default resolver. A newly started public
download with Cloudflare selected uses the alternative resolver and has a
different diagnostic on timeout. A request already in progress retains its
original setting. Older request completions do not overwrite the current
connection's error banner after the DNS or exit-node setting changes.

This opt-in mode sends public hostname queries to Cloudflare's DNS-over-HTTPS
service at `https://1.1.1.1/dns-query`, through the same Tailscale userspace
network. It uses a literal resolver IP to avoid depending on the broken DNS
path, and verifies the HTTPS certificate. The data request also travels through
the exit node. There is no direct browser fetch fallback or automatic switch
to a public resolver.

Literal IP addresses, known tailnet peers, MagicDNS names, extra DNS records,
single-label names, and configured private/split-DNS suffixes continue to use
the original tailnet route. Use **Exit node DNS** for other private DNS zones
that are not represented in the tailnet configuration. Clearing the exit node
or disconnecting resets the DNS choice to its default. Changing DNS applies
to subsequent downloads; it does not restart a request already in progress.

If the alternate DNS mode also times out, manually test
`https://1.1.1.1/cdn-cgi/trace` in the same Networking panel. That URL avoids
hostname lookup. Success establishes HTTPS connectivity to that IP through
the selected exit and narrows the remaining problem to the DNS request path.
A timeout also affects a request without DNS, so inspect the peer connection,
exit forwarding, internet access, and the browser device's tailnet permissions.
Use **Diagnose connection**, described below, to distinguish the stage that
fails. No such public probe is sent automatically.

The current Go resolver gives each DNS exchange a five-second deadline,
independent of the download client's 120-second timeout. The DoH request
inherits that deadline, including the time needed for TCP and TLS. Therefore,
a Cloudflare DNS timeout alone does not prove that the exit cannot reach the
internet. Conversely, a successful direct-IP test does not prove that this
deadline is the cause: DoH also uses a different HTTP transport. The resolver
defaults and exchange deadline are visible in Go's
[DNS configuration](https://go.dev/src/net/dnsconfig_unix.go) and
[DNS client](https://go.dev/src/net/dnsclient_unix.go).

The client now waits for Tailscale's `Running` state before reporting a
connection. Receiving an IP address and node key alone is insufficient. An
online exit-node listing still does not prove a particular download will work;
the explicit download test provides that check.

## Diagnose a stalled connection

Click **Networking → Diagnose connection** with an exit node selected. This
explicit action checks the current connection without changing DNS or routing.
It uses the same Tailscale userspace dialer as data downloads and never uses
browser fetch for the target. Each network stage has a ten-second limit;
independent probes run concurrently, with an overall 35-second runtime limit.

| Check | What a pass establishes |
| --- | --- |
| Selected exit node | The selected peer exists in the network map, has a Tailscale IP, and its device key is not expired. |
| Route to `1.1.1.1` | The WireGuard engine is configured to use the selected exit's IPv4 default route. Advertised routes alone are not sufficient, and the following probes test live traffic. |
| Encrypted connection to exit | A TSMP reply returned through the encrypted peer path. This does not test permission to use public TCP. |
| Exit node service | The exit's PeerAPI answered an HTTP HEAD request by literal Tailscale IP. This does not perform a DNS lookup or test public forwarding. |
| TCP to `1.1.1.1:443` | TCP connected to that specific address through the selected exit, without DNS. |
| TLS handshake and certificate | The same TCP connection completed TLS with normal certificate verification for `1.1.1.1`. |
| HTTP response from `1.1.1.1` | The same verified TLS connection returned an HTTP response to `/cdn-cgi/trace`. The report includes the status, follows no redirects, and does not retain the response body. |

TCP, TLS, and HTTP run in order. If one fails, the later dependent stages are
shown as **Skipped**. The peer probes still run when the public-route check
fails, so the report can distinguish a reachable exit from an incorrect route.
An offline indication comes from the control server; the explicit probes test
actual reachability. A failed public check concerns `1.1.1.1`, which could be
blocked independently of other internet destinations.

The report includes the exit's name, Tailscale IP, operating system, online
and key-expiry indicators, application version, and completion time. **Copy
report** copies those fields and the stage results as plain text. It does not
copy sign-in URLs, credentials, runtime logs, or the trace body. Changing the
connection, selected exit, or DNS mode clears the report and rejects an older
in-flight result. Disconnect also stops the worker and its probes.

Tailscale documents the meaning of its
[TSMP and PeerAPI probes](https://tailscale.com/docs/reference/ping-types).
Expired exit-node keys can leave advertised routes visible while traffic
fails; see the [exit-node caveats](https://tailscale.com/docs/features/exit-nodes).
The application now exposes that state and prevents selecting such an exit.

## R examples

Use the default webR download method:

```r
data_url <- "https://your-data-server.example/data.csv"  # Replace with your URL.
download.file(data_url, "data.csv", mode = "wb")
data <- read.csv("data.csv")

# The same primitive backs base R URL reads.
data <- read.csv(data_url)
lines <- readLines(data_url, warn = FALSE)
```

An actual small public connectivity example is:

```r
download.file("https://example.com/", "example.html", mode = "wb")
head(readLines("example.html", warn = FALSE))
```

For a server that accepts a bearer token, pass an explicit header rather than relying on a website's browser cookies:

```r
download.file(
  data_url, "data.csv", mode = "wb",
  headers = c(Authorization = paste("Bearer", Sys.getenv("DATA_TOKEN")))
)
```

R downloads are written to webR's virtual filesystem. Use the IDE's **Files** panel to inspect them. Existing project synchronization rules continue to apply.

## Supported scope

| Operation | Route |
| --- | --- |
| Default `download.file()` HTTP(S) GET | Tailscale while connected; ordinary browser fetch after explicit Disconnect |
| Base R `url()`, `readLines()`, `read.csv()` URL reads | Same webR download primitive |
| Explicit HTTP request headers, binary response bodies, normal HTTP redirects | Preserved by the bridge and Go HTTP client |
| HTTP(S) services on tailnet peers | Available according to tailnet access rules; no exit node required |
| Public internet downloads | Require a selected approved exit node |
| `curl`, `httr`, `httr2`, raw sockets, databases, FTP | Not automatically supplied by this HTTP download integration |
| IDE dependencies, Google Fonts, Gist API, browser-side package/runtime fetches | Existing browser routes; not redirected by this bridge |
| Browser website cookies or signed-in website sessions | Not inherited; provide explicit supported request authentication |

Do not force `method = "libcurl"` when using this integration. webR's more general socket-based clients can require its separately documented [WebSocket proxy setup](https://docs.r-wasm.org/webr/latest/networking.html).

The hook is verified for the included default webR 0.6.0. It checks for the runtime primitive when another webR version is selected. If an incompatible version is used, Networking explains that its R bridge is unavailable. An already selected Tailscale route cannot silently switch to direct traffic because of a failed hook installation.

## Sessions, disconnects, and failures

- Each browser tab creates an independent Tailscale worker and private bridge token. Requests go only to the owning tab.
- Restarting R reinstalls the hook while keeping the existing Tailscale worker alive.
- Reloading or closing the tab loses its in-memory identity. Sign in again for a new connection.
- Disconnect terminates the worker and immediately rejects pending transport requests. It then restores ordinary CORS-restricted browser downloads for new requests.
- A login failure, unavailable exit node, failed download, or worker crash never causes an automatic retry through browser fetch. Reconnect or explicitly Disconnect.
- Tailscale keys are not stored in IndexedDB, localStorage, workspace exports, shared URL state, or Gists. The registered device can remain in your Tailscale admin console after its browser keys are forgotten; remove unused browser devices there.
- The Go client buffers complete responses in memory and imposes a 120-second HTTP timeout. Browser and R memory limits still apply. The bridge allows extra time to report errors and clean up message ports.
- The client has no per-request abort API. Cancelling an individual bridge request stops delivery to R; its underlying Go request can continue until its timeout. Disconnect terminates the entire worker and its requests.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Connect is disabled | Wait for R. If the panel reports a bridge error, reload once after the service-worker update and confirm HTTPS or localhost. |
| A new deployment still shows an unavailable bridge | Reload the page after the service worker updates. The app checks for worker updates and uses versioned modules and hashed networking binaries. |
| Sign-in link never appears | Check access to Tailscale coordination and relay services and whether the browser blocks WebSockets. Reconnect after correcting it. |
| Connected, but internet downloads fail | Select an approved online exit node; check its internet connection and your tailnet's access rules. |
| `lookup ... /dns-query ... context deadline exceeded` | Click **Use Cloudflare DNS and retry**, or select that DNS mode and start a fresh test. Check the DNS setting shown with the result. If the alternative also fails, check tunnel/exit reachability. |
| Literal-IP HTTPS also times out | Run **Diagnose connection** and use **Copy report**. A resolver change cannot correct the failed request that already skips DNS; inspect which peer/TCP/TLS/HTTP stage fails. |
| Exit node has an expired device key | Reauthenticate that exit device or select an available exit. The browser cannot repair the exit's authentication. |
| Sign-in succeeds but the client stays connecting | The browser has not reached Tailscale's `Running` state. Check relay WebSocket access and device approval; an assigned IP alone is insufficient. |
| Selected exit node is offline | The indicator becomes amber. Choose a different online node, or reconnect the selected device. |
| A CSV downloaded but `read.csv()` fails | Check that the server returned data rather than an HTML sign-in page. Networking does not replace server authorization. |
| `curl` or `httr2` still fails | Those libraries use a different socket path. Use `download.file()` first, then read the local file, or configure webR's separate socket proxy. |
| Large download times out | This transport buffers responses and has a 120-second timeout. Use a smaller export, split the transfer at the data source, or use a faster reachable exit node. |

## Implementation

`js/network-bridge.js` installs a wrapper around `Module.downloadFileContent` inside the webR worker through `webr::eval_js()`. HTTP(S) downloads become synchronous POST requests to a private same-origin endpoint. Other URL schemes keep the original implementation. Neither R functions nor the user's scripts are replaced.

The existing `coi-serviceworker.js` recognizes that endpoint and opens a `MessageChannel` to the exact owning window. It does not broadcast requests to other tabs. A 192-bit random token, the owner client ID, the service-worker source, the protocol version, and request shapes are validated. The endpoint carries the URL and explicit headers in a JSON body rather than query parameters. Its responses are private and uncached; remote cookies and redirect headers never become IDE-origin response headers.

`js/network.js` chooses the explicitly active route. In browser mode it uses ordinary CORS-enforcing fetch. In Tailscale mode it sends a request to `js/tailscale-worker.js`; the worker uses the bundled Go HTTP client and Tailscale dialer. Binary buffers are transferred back through the message channels. The original HTTP status and bytes are reconstructed for webR.

The optional public-DNS mode uses its own download client and resolver state,
leaving Tailscale's control-plane and peer-DNS clients unchanged. DNS selection
is validated in both the JavaScript controller and the Go runtime. The
Cloudflare route requires an exit node and uses the userspace stack for both
DNS and data; tailnet and private-name decisions are made before public DNS.

The R worker inherits its service-worker controller because the bridge is initialized before creating webR. This supports both SharedArrayBuffer and PostMessage communication modes, without waiting for the R interpreter to become idle when a user disconnects.

The bundled client comes from pinned [tailscale-web source](https://github.com/adrianosela/tailscale-web/tree/004de98821ba5856332df750f431f4fcb7ca76f6), rebuilt with official Tailscale rather than the upstream package's local development replacement. The experimental signaling setting is removed. See [network-src/README.md](network-src/README.md) for precise provenance, changes, licences, and rebuild instructions.

## Deployment and validation

The archive is ready to serve. Keep the `vendor/` directory next to `js/`; the included GitHub Pages workflow stages both. Servers must serve `.wasm` as `application/wasm`. `serve.py` already sets the correct MIME type and isolation headers. The optional network build requires Go; ordinary deployment does not.

Run the dependency-free suite:

```sh
npm test
```

It includes application regression tests plus behavioral checks of download routing, binary transfers, request headers, unsafe sign-in URLs, worker startup failure, reconnect races, timeouts, cancellation, explicit browser restoration, tab separation, and service-worker restart behavior.

To exercise the Go DNS and download-routing implementation as WebAssembly,
install the pinned Go compiler and Node.js, then run:

```sh
npm run test:network-runtime
```

These tests use controlled in-memory endpoints and run the actual Go resolver
and HTTP client. They do not need a Tailscale account or contact public DNS.
They supplement the browser-to-R tests below; they do not prove reachability
of an individual user's exit node.

For optional real-browser checks, install Playwright in your development environment and install its Chromium browser, then run:

```sh
npm install --no-save playwright
npx playwright install chromium
npm run test:browser
npm run test:browser-dns
npm run test:browser-diagnostics
npm run test:browser-console
npm run test:browser-files
npm run test:browser-cloudflare
```

The browser test serves the actual app under a subdirectory and runs actual webR, but injects a clearly marked simulated Tailscale transport. It checks the browser-to-R bridge using controlled local fixtures, including a server without CORS headers. It does not authenticate to a Tailscale account or prove an actual exit-node transfer. A final live check consists of connecting your own tailnet, selecting its exit node, and downloading a known HTTP(S) URL.

The console regression keeps the real networking controller and bridge, and
substitutes only the final Tailscale worker transport. It verifies the default
non-quiet download returns R status 0, writes the exact expected bytes, and
shows neutral progress. Real HTTP 404 and `stop()` controls must still render
Error cards. The file regression uses real webR and IndexedDB to check the
unified Explorer, current file contents, deletion and cancellation, save races,
restart persistence, and navigation outside `/project`.

The Cloudflare regression runs the actual app, real webR, and the shipped
Worker handler behind a local HTTP endpoint. Outbound data requests use a
controlled test server; a deliberately failed lazy-package request also checks
that a Packages refresh cannot trap later R console output. It checks CORS preflight,
authenticated activation, direct R reads and downloads, binary integrity,
upstream headers and redirects, real HTTP failures, R restart, cancellation
when changing providers, and exclusion of the proxy password from stored or
exported state. This local test does not deploy a Worker into a Cloudflare
account. Focused Worker and controller tests also cover configuration errors,
forbidden destinations, header boundaries, malformed responses, and timeouts.

Run `npm run test:browser-packages` for the package-inspection regression. It
uses real webR with SharedArrayBuffer and PostMessage, checking that a failed
lazy metadata download preserves user sinks, warning settings, open connections,
working directory, and R objects. It also verifies successful package records
from a local metadata fixture and subsequent console output after a restart.

The DNS recovery browser test uses the actual controller and interface with an
explicit simulated worker. It checks that a failure never switches providers
automatically, that the recovery action waits for runtime confirmation and
retries the same URL, and that URL edits or a failed DNS confirmation prevent
an unintended retry. The regular network tests also check that late results
from an earlier DNS/exit setting cannot overwrite the current error banner.

Version 1.3.1 was also checked in Chromium against a separate, isolated local
Tailscale test network with real WireGuard traffic, DERP WebSockets, and a
native exit node. The shipped binary downloaded a controlled CSV by tailnet
IP and MagicDNS name. An unreachable resolver on the exit reproduced the
reported `/dns-query` timeout while those downloads continued to work. After
switching to Cloudflare mode, MagicDNS still worked and the native exit
received the expected connections to `1.1.1.1:443`. This test environment
denied outbound access to that public IP, so a live Cloudflare response was
not verified there. Positive DoH and HTTPS behavior, including certificate
verification, is covered by the controlled Go/WASM tests. No user credentials
were used by these checks.

Version 1.3.3 adds a browser regression for explicit diagnostics, report copying,
expired exit selection, and stale-result rejection, using the actual interface
and controller with a simulated worker. Its Go/WASM tests exercise verified
TLS and HTTP on one in-memory connection, stage deadlines, cancellation, and
route ownership. The same shipped binary was also checked with real WireGuard
and DERP against an isolated native exit: both DNS settings produced passing
exit, configured-route, TSMP, and PeerAPI checks. Public TCP was refused by the
test environment, and TLS/HTTP were correctly skipped. Raw tailnet-IP and
MagicDNS CSV downloads still returned HTTP 200 after the diagnostics. These
checks verify stage reporting and preserve transport behavior; they do not
identify the cause of a different exit node's timeout or establish a successful
public-internet transfer in that environment.

To rebuild the shipped networking runtime from its retained source, see the source README and run `npm run build:network` with the pinned Go toolchain installed. Runtime hashes are recorded in `vendor/tailscale-web/SHA256SUMS` and `provenance.json`.
