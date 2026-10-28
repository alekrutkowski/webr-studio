# Use your own free Cloudflare Worker for webR downloads

This folder contains a small CORS proxy that you can deploy to your own Cloudflare account. In webR Studio, choose **Cloudflare Worker proxy** in the Networking panel, enter your Worker's URL and a password you generate, and use ordinary R downloads through that route. A Tailscale account or exit-node computer is not required for this option.

The Worker is a single JavaScript file with no external packages, database, KV, R2 bucket, or paid service binding. The Cloudflare Workers Free plan can run it within that plan's usage limits. You keep control of the Worker and its password.

## Why does this help with CORS?

webR runs R inside your browser. A browser checks whether another website permits JavaScript on your app's origin to read its response. That permission normally arrives in a CORS response header. A CSV can open in a browser tab and still be unavailable to `download.file()` when its server omits that header.

With this option, the request has four steps:

1. R asks webR Studio to download the original data URL.
2. Your browser sends that URL and your proxy password to **your Worker**.
3. The Worker makes an ordinary server-side HTTP GET request to the public data server.
4. The Worker streams the response back with CORS permission for **your app's origin**; Studio passes the bytes to R.

The data server does not need to enable CORS for your app. It still controls access to its data: a login requirement, expired link, rate limit, or HTTP 403 can still prevent the download. Keep using the original data URL in your R code; you do not put the Worker URL into `read.csv()` or append a target URL to the Worker address.

The [Fetch standard](https://fetch.spec.whatwg.org/#http-cors-protocol) describes browser CORS checks. Cloudflare's [Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/) supplies the server-side request used here.

## What “free” means

As checked on **27 October 2026**, Cloudflare documents **100,000 inbound requests per day per Free account** and **10 milliseconds of CPU time per invocation**. The daily limit resets at midnight UTC. The CPU limit measures code execution; time waiting for network data does not count as CPU time. Health checks and browser preflight requests also consume inbound requests. See the current [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [limits](https://developers.cloudflare.com/workers/platform/limits/) before relying on those amounts.

Use the Workers Free plan if you want the free option. This project does not activate a paid plan, and its code needs none of Cloudflare's storage products. If your account already has a paid Workers plan, your account's billing rules apply. Exhausting the Free request quota causes requests to fail until it resets.

The Worker streams files rather than loading them into its own memory. Studio and webR still buffer downloaded data in browser memory, so large files depend on the memory available to the browser. The Worker's 64 KiB limit is for the small JSON request containing the URL and headers, not the downloaded file. Studio's separate 100 MB limit for saving a file in a project is also not a Worker download-size limit.

## Dashboard setup: no terminal needed

You need a Cloudflare account and a running copy of webR Studio. Open Studio through its hosted URL or local development server. An app opened directly as a `file://` page has no usable web origin for this setup.

### 1. Get the code and this app's origin

Open **Networking** in Studio and select **Cloudflare Worker proxy**. Expand the setup guide. Choose **Copy worker.js**, or use **Download worker.js** if you prefer to keep the source file open beside the Cloudflare editor. The same code is [worker.js](worker.js) in this folder.

Find **This page's origin (`ALLOWED_ORIGINS`)** and use its copy button. An origin is the protocol, host, and any nondefault port. It does not include the app's path or a trailing slash.

| Where Studio is running | Exact allowed origin |
| --- | --- |
| `https://yourname.github.io/webr-studio/` | `https://yourname.github.io` |
| `https://r.example.org/studio/` | `https://r.example.org` |
| `http://localhost:8000/` | `http://localhost:8000` |
| `http://127.0.0.1:8000/` | `http://127.0.0.1:8000` |

The last two are different origins. Copying the displayed value avoids a mismatch. For several Studio deployments, list each exact origin separated by commas. Do not use `*`, `null`, an app URL containing a path, or quotes around the value in the dashboard.

### 2. Create the Worker

In the [Cloudflare dashboard](https://dash.cloudflare.com/), open **Workers & Pages**. Choose **Create application**, then **Start with Hello World!**, then **Get started**. Give the Worker a name, such as `webr-studio-cors-proxy`, and choose **Deploy**.

Open **Edit code** for the new Worker. Replace the entire starter file with the complete contents of `worker.js`, including the `export default` at the end. Deploy the updated code. It is an ES module and does not require a build or package installation.

These are the dashboard Worker-creation steps documented in Cloudflare's [getting-started guide](https://developers.cloudflare.com/d1/get-started/#1-create-a-worker). That guide continues into database setup; this proxy only uses its Worker-creation steps and needs no database.

Your Worker will deliberately refuse requests until you complete the next step.

### 3. Set a password and allow your app's origin

In Studio, choose **Generate password** and **Copy password**. Keep a copy somewhere private so you can reconnect after reloading Studio. Use this generated value for the two places that need it: the Studio password field and the Worker's secret.

**`PROXY_TOKEN` is your own shared proxy password. It is not a Cloudflare API token, account key, login password, or Tailscale key.** Do not paste any of those credentials into this app. A custom proxy password must contain 32 to 256 printable ASCII characters without spaces; the generated password already meets that requirement.

In the Worker's **Settings**, open **Variables and Secrets** and choose **Add**. Add these exact names:

| Type | Variable name | Value |
| --- | --- | --- |
| **Secret** | `PROXY_TOKEN` | The random password you just generated |
| **Text** | `ALLOWED_ORIGINS` | This Studio page's exact origin, copied in step 1 |

Choose **Deploy** to apply the settings. Cloudflare documents these controls under [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/#via-the-dashboard) and [Environment variables](https://developers.cloudflare.com/workers/configuration/environment-variables/#add-environment-variables-via-the-dashboard).

Use the **Secret** type for the password so its value is hidden after configuration. Keep the password out of `worker.js`, `wrangler.jsonc`, public repositories, shared R scripts, and the Worker URL. Neither a missing password nor a missing origin list turns this Worker into an open proxy: both must be configured before health checks or data downloads can succeed.

In **Settings → Runtime**, keep the current **Compatibility date** for a new Worker. If you are reusing an older Worker, use **2024-11-11 or later**. This is needed for the `cache: "no-store"` option used by the proxy. Cloudflare [sets newly created dashboard Workers to the current date](https://developers.cloudflare.com/workers/configuration/compatibility-dates/#via-the-cloudflare-dashboard), and documents the [no-store compatibility date](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-cache-no-store-http-standard-api).

**Ordinary downloads from unrelated public websites need no additional compatibility flags.** If the dashboard does not offer `global_fetch_strictly_public`, `enable_request_signal`, or `request_signal_passthrough`, skip them and continue to **Use proxy**. They are optional routing and cancellation features, described below. They are not CORS switches and should not be added as Text variables or Secrets.

### 4. Connect Studio to the Worker

Copy the Worker's deployed HTTPS URL into Studio's **Worker HTTPS URL** field. It will usually look like:

```text
https://webr-studio-cors-proxy.your-account.workers.dev/
```

Use the root address with no path, query string, or fragment. A custom HTTPS domain is also supported. Leave the same password in **Proxy password (`PROXY_TOKEN`)**, then choose **Use proxy**.

Studio first checks that the Worker is reachable, recognizes this protocol, allows this app's origin, and accepts your password. After connection, use **Test a download** with the public data URL you want to use. This test reports the transfer result without adding a project file. A successful setup check alone does not prove that a particular data server accepts requests from Cloudflare.

The app keeps the proxy password only in memory for the current connection. After a page reload, enter it again. Editing the URL or password does not silently change an active route; choose **Use proxy** to apply the new values.

Opening the Worker URL directly in a browser tab is not the setup test. A tab sends a GET request without the required origin and password headers, so the Worker will return an error. Use Studio's **Use proxy** button instead.

### 5. Download in R

Once the proxy is connected, run your usual code. For example, this public [Rdatasets iris CSV](https://raw.githubusercontent.com/vincentarelbundock/Rdatasets/master/csv/datasets/iris.csv) provides a small test file:

```r
data_url <- paste0(
  "https://raw.githubusercontent.com/vincentarelbundock/",
  "Rdatasets/master/csv/datasets/iris.csv"
)

download.file(data_url, "iris.csv", mode = "wb")
iris_download <- read.csv("iris.csv")
head(iris_download)
file.info("iris.csv")$size
```

Leave the download method at its webR default. Forcing `method = "libcurl"` does not select this bridge. Replace `data_url` with the URL that previously failed for your own data. A data site that already permits CORS is still useful as a connection check, but it does not demonstrate the original CORS restriction.

The resulting file appears in the unified **Explorer**. Files created by R are marked **R session** until you explicitly keep or open them as a saved project file. Choose **Keep in project** if you want a downloaded file to survive an R session restart.

## What goes through the proxy

This route handles the HTTP and HTTPS downloads that webR Studio's download bridge supports, including ordinary `download.file()` and HTTP URL reads using the default webR methods. It does not turn the browser into a general VPN and does not add network support to R packages that bypass that bridge.

The Worker sends only GET requests. The data server sees a request from Cloudflare. Browser cookies, the proxy password header, `Host`, `Origin`, and browser forwarding/security headers are never passed to the target. Explicit data-server headers, such as `Authorization` or `X-Dataset-Key`, can be supplied separately as upstream headers. A redirect to a different origin drops those sensitive headers; only `Accept`, `Accept-Language`, and `Range` survive that hop. Use the final trusted data URL if an authenticated service requires credentials after a cross-origin redirect.

Cloudflare handles the requested URL, any explicitly supplied data-server credentials, and the transferred data. Use a Worker under an account you trust. For an HTTPS data URL, the connection from Cloudflare to the data server uses HTTPS as well. An HTTP target does not encrypt that leg.

The password protects access. CORS origins additionally control which browser pages may read the results, but an origin header can be supplied by a nonbrowser client, so the origin list is not a replacement for a strong secret. Give the password only to people you trust to use your Worker and quota. To rotate it, replace the `PROXY_TOKEN` secret, deploy, and enter the new value in Studio.

Public DNS names resolve from Cloudflare's network. Private IP literals, loopback, link-local and reserved address ranges, and local hostnames are rejected, including on redirects. These URL checks are deliberately conservative; they do not implement independent DNS resolution and IP pinning. This proxy is intended for authenticated public-file downloads. Use **Tailscale** for data reachable only inside your tailnet or private network.

The code makes no log calls and uses `Cache-Control: no-store`. It never includes the data URL or a raw thrown network error in its own error message, because signed URLs and server diagnostics can contain credentials. Cloudflare's platform policies and any logging you enable in your account still apply.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| Setup cannot reach or verify the Worker | Use the deployed HTTPS root URL. Confirm the entire `worker.js` replaced Hello World and that code and settings were deployed. A browser CORS failure can hide the Worker's detailed error. |
| The three suggested compatibility flags are absent from the dashboard | Skip them for ordinary public downloads. Use a current compatibility date and configure the two required variables. Optional advanced flags can be set through the supplied Wrangler configuration. |
| `PROXY_NOT_CONFIGURED` | Both settings are required. Verify `PROXY_TOKEN` is a Secret of the accepted length and `ALLOWED_ORIGINS` is exact, nonempty Text. A malformed entry invalidates the whole origin list. |
| `ORIGIN_NOT_ALLOWED` or a browser CORS error | Copy Studio's displayed origin again. Do not include `/webr-studio/`, a trailing slash, or a wildcard. Development port and `localhost` versus `127.0.0.1` matter. |
| `AUTH_REQUIRED` | The Studio password and Worker secret differ. Replace the secret if you no longer have its value, deploy, and reconnect with the new password. |
| Setup succeeds but a download reports HTTP 401, 403, 404, or 429 | That is the data server's actual status. Check its authentication, the direct file URL, and any rate or Cloudflare-IP restrictions. A CORS proxy does not grant access to protected data. |
| `INVALID_TARGET` or `INVALID_REDIRECT` | Use a public HTTP(S) URL without a username/password in the address. Local/private targets and redirects to them are refused. |
| `REDIRECT_LIMIT` | More than five redirects occurred. Use a final public file URL, or check for a login/redirect loop. |
| `UPSTREAM_FETCH_FAILED` | Check the URL and target availability. Also check the compatibility date is 2024-11-11 or later: an older runtime setting can reject `cache: "no-store"` before making a request. A data server can separately block Cloudflare traffic or reject a connection independently of CORS. |
| Cloudflare Error 1027 | The Free account's daily request quota was exhausted; check account usage and the next UTC reset. |
| Cloudflare Error 1102 | The Worker exceeded a runtime resource limit. Check the Worker metrics and current platform limits. |
| R prints `trying URL ...` | This is normal download progress. Check the return value, file size, and subsequent R output for the actual result. |

The Cloudflare error numbers are documented in [Workers limits](https://developers.cloudflare.com/workers/platform/limits/). Selecting **Browser direct (CORS)** or **Tailscale** in Studio changes the route explicitly; a proxy failure does not cause a silent retry through another provider.

## Optional compatibility flags

The basic dashboard setup above works without these flags for downloads from unrelated public HTTP(S) data servers. Their specific purposes are:

| Flag | Additional behavior |
| --- | --- |
| `global_fetch_strictly_public` | Uses public internet routing when fetching hosts in the Worker's own Cloudflare zone; also relevant to some Worker-to-Worker requests. |
| `enable_request_signal` | Lets the Worker observe that its incoming browser request was cancelled. |
| `request_signal_passthrough` | Lets that incoming cancellation signal propagate to the outgoing fetch. |

Without the two cancellation flags, Studio can still stop waiting for a download, but explicit cancellation of the Worker's upstream request is not guaranteed. Without the routing flag, requests to your own Cloudflare zone can use different routing behavior; enable it if you need those targets. These are separate from browser CORS permission.

Cloudflare documents these flags and their [Wrangler/API configuration methods](https://developers.cloudflare.com/workers/configuration/compatibility-flags/). If your dashboard does not expose them, use the optional Wrangler workflow below when you need their behavior. The supplied `wrangler.jsonc` already enables all three. Do not assume that changing the compatibility date alone enables these optional features.

## Optional deployment with Wrangler

The dashboard workflow above is sufficient. If you prefer the command line, install a Node.js version supported by [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/), then run commands from this folder:

```sh
cd cloudflare-worker
npx wrangler login
```

Edit [wrangler.jsonc](wrangler.jsonc): choose your Worker `name` and replace the empty `ALLOWED_ORIGINS` value with your exact app origin. Do not add the password to `vars`. Deploy the code, then enter the generated password at Wrangler's secret prompt:

```sh
npx wrangler deploy
npx wrangler secret put PROXY_TOKEN
```

The first deployment intentionally refuses traffic until the secret exists. The secret command creates and deploys an updated version. Subsequent code deployments use the same secret unless you change it. See Cloudflare's [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/) and [secret commands](https://developers.cloudflare.com/workers/configuration/secrets/#via-wrangler).

For optional local Wrangler development, put your generated password in a local `.dev.vars` file using the `PROXY_TOKEN` name, configure the local Studio origin, and run `npx wrangler dev`. The included `.gitignore` excludes `.dev.vars*`, `.env*`, `.wrangler/`, and `node_modules/`. Do not commit local passwords. Studio accepts an HTTP Worker endpoint only on loopback for this development case; deployed endpoints must use HTTPS.

## Protocol and tests

The endpoint is `/`. Every response produced by this handler includes `X-WebR-Proxy-Version: 1` and `Cache-Control: no-store`. Both POST actions require an exact allowed `Origin`, `Content-Type: application/json`, and `X-WebR-Proxy-Token` matching the secret.

| Request JSON | Response |
| --- | --- |
| `{"action":"check"}` | HTTP 200 and `{"service":"webr-studio-cors-proxy","protocol":1}`. No upstream request. |
| `{"action":"fetch","url":"https://data.example.org/file.csv","headers":{}}` | The final upstream HTTP status and raw response stream. `X-WebR-Upstream-Status` repeats that numeric status, including 204/205/304 with no body. |
| Invalid configuration, authentication, URL, or a proxy transport failure | Appropriate 4xx/5xx status, `X-WebR-Proxy-Error` containing a stable uppercase code, and a small JSON object `{"error":"Readable explanation","code":"CODE"}`. No upstream-status header. |

An upstream HTTP error is forwarded as that upstream response, without the proxy-error header. The Worker replaces upstream CORS/protocol headers with its own and strips response cookies. It exposes the protocol, upstream-status, and proxy-error headers to the permitted browser origin. OPTIONS preflight permits only POST and the `Content-Type` and `X-WebR-Proxy-Token` request headers; it does not require the password in the preflight itself. An allowed origin can preflight even before the secret is configured, so Studio can display the following POST's clear setup error. No health check or download succeeds without the valid secret.

The bounded JSON body is at most 64 KiB, the target URL at most 16 KiB, and upstream headers at most 64 names and 16 KiB of names/values. Target requests remain GET even if an unsupported method/body field is added. The Worker follows at most five redirects and validates the destination at each hop. The password comparison checks every expected character rather than stopping at a matching prefix.

Run the handler's dependency-free Node checks from the repository root:

```sh
node tests/cloudflare-worker-check.mjs
```

The tests inject a synthetic upstream fetch function after public-target validation. They cover missing/malformed configuration, password failures, exact origins and preflight, private IPv4/IPv6 and alternate IP encodings, redirect validation and header removal, HTTP error/status preservation, empty and binary bodies, streaming without buffering, and cancellation. They do not deploy to a Cloudflare account. For HTTP/browser integration, the module exports `createProxyWorker({ fetcher })`, returning an object with a `fetch(request, env)` handler; its default export uses native Cloudflare `fetch`.

The stream implementation follows Cloudflare's [Streams guidance](https://developers.cloudflare.com/workers/runtime-apis/streams/) and [compressed-response passthrough behavior](https://developers.cloudflare.com/workers/runtime-apis/fetch/#passthrough-behavior): it returns the untouched upstream body stream and preserves its `Content-Encoding`. Node-based HTTP test adapters must account for Node fetch's automatic decompression if they use compressed fixtures.

## License

This Worker is part of webR Studio, copyright (c) 2026 Alek Rutkowski, under the repository's [MIT license](../LICENSE). The complete notice is included in `worker.js` so it stays with the code when pasted into the dashboard. Cloudflare and Tailscale product names belong to their respective owners.
