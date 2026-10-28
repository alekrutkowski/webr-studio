/*
 * tailscale-web 0.1.16 JavaScript API, MIT License.
 * Copyright (c) 2026 Adriano Sela Aviles.
 * Adapted for webR Studio: use the separately shipped, matching Go runtime
 * instead of the runtime bundled in the upstream npm JavaScript file.
 * Full upstream license: ./LICENSE.tailscale-web.txt
 */
import './wasm_exec.js?v=0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14';

const x = new URL("main.wasm?v=10342c226f2bdbcf3c952613004d2d8a8025bc1af621d73337996b88dd4a820b", import.meta.url).href;
(() => {
  const n = globalThis, h = "process";
  n[h] ? n[h].pid == null && (n[h].pid = 1) : n[h] = { pid: 1 };
})();
let _ = !1;
async function b() {
  if (_) return;
  const n = new globalThis.Go(), h = await WebAssembly.instantiateStreaming(
    fetch(x),
    n.importObject
  );
  n.run(h.instance), _ = !0;
}
function u() {
  return globalThis.__tailscaleWeb;
}
function T(n) {
  return {
    status: n.status,
    statusText: n.statusText,
    ok: n.ok,
    headers: n.headers,
    text: async () => new TextDecoder().decode(n.body),
    json: async () => JSON.parse(new TextDecoder().decode(n.body)),
    arrayBuffer: async () => n.body.buffer,
    bytes: async () => n.body
  };
}
const p = {
  /**
   * Initialize and connect the Tailscale node. Must be called before any
   * other method. Resolves once the node is authenticated and ready.
   *
   * If the node has persisted state from a previous session it reconnects
   * automatically. Otherwise the OAuth flow is triggered via onAuthRequired.
   * Rejects if the auth URL does not arrive within 60 seconds, or if the
   * user does not complete authentication within 5 minutes.
   *
   * @example
   * await network.init({
   *   hostname: "my-app",
   *   onAuthRequired(url) {
   *     window.open(url, "_blank", "width=600,height=700")
   *   },
   *   onAuthComplete() {
   *     console.log("connected!")
   *   },
   * })
   *
   * @example
   * // Custom storage backend (e.g. sessionStorage or any key/value store)
   * await network.init({
   *   hostname: "my-app",
   *   storage: {
   *     get: key => sessionStorage.getItem(key),
   *     set: (key, val) => sessionStorage.setItem(key, val),
   *   },
   *   onAuthRequired(url) { console.log("Authenticate at:", url) },
   * })
   */
  async init(n = {}) {
    return await b(), u().init(n);
  },
  /**
   * Send an ICMP ping to addr and measure round-trip time.
   * addr may be a hostname or Tailscale IP.
   *
   * @example
   * const result = await network.ping("my-server")
   * if (result.alive) {
   *   console.log(`rtt: ${result.rttMs.toFixed(3)} ms  ip: ${result.nodeIP}`)
   * } else {
   *   console.warn("unreachable:", result.err)
   * }
   */
  async ping(n) {
    return u().ping(n);
  },
  /** Explicit, bounded checks of the selected exit and HTTPS without DNS. */
  async diagnose() {
    return u().diagnose();
  },
  /**
   * Open a raw TCP connection through the Tailscale network.
   * Returns a Connection object for sending and receiving data.
   *
   * @example
   * const conn = await network.dialTCP("my-server:8080")
   *
   * conn.onData(data => {
   *   console.log(new TextDecoder().decode(data))
   * })
   *
   * conn.write("hello\n")
   * conn.close()
   */
  async dialTCP(n) {
    const h = await u().dialTCP(n);
    return {
      onData(f) {
        h.onData(f);
      },
      write(f) {
        h.write(
          typeof f == "string" ? new TextEncoder().encode(f) : f
        );
      },
      close() {
        h.close();
      }
    };
  },
  /**
   * Listen for inbound TCP connections on the given Tailscale port.
   * Pass port 0 (default) to get an ephemeral port assigned automatically.
   * onConnection is called for each accepted connection.
   * Returns a Listener with the assigned port number and a close() method.
   *
   * @example
   * const listener = await network.listenTCP(8080, conn => {
   *   conn.onData(data => console.log(new TextDecoder().decode(data)))
   *   conn.write("hello\n")
   * })
   * console.log("listening on port", listener.port)
   *
   * @example
   * // Ephemeral port
   * const listener = await network.listenTCP(0, conn => { conn.close() })
   * console.log("assigned port:", listener.port)
   * listener.close()
   */
  async listenTCP(n = 0, h) {
    const f = await u().listenTCP(n, (l) => {
      h({
        onData(i) {
          l.onData(i);
        },
        write(i) {
          l.write(
            typeof i == "string" ? new TextEncoder().encode(i) : i
          );
        },
        close() {
          l.close();
        }
      });
    });
    return {
      port: f.port,
      close() {
        f.close();
      }
    };
  },
  /**
   * Make an HTTP request through the Tailscale network. Supports method,
   * headers, and body. Does not yet support AbortSignal, streaming bodies
   * or responses, or other advanced Fetch API options.
   *
   * @example
   * const resp = await network.fetch("https://internal-service/api", {
   *   method: "POST",
   *   headers: { "Content-Type": "application/json" },
   *   body: JSON.stringify({ key: "value" }),
   * })
   * console.log(resp.status, resp.ok)
   * const data = await resp.json()
   */
  async fetch(n, h = {}) {
    return T(await u().fetch(n, h));
  },
  /**
   * Return this node's Tailscale IPv4 address, or an empty string if not yet assigned.
   * Synchronous  -  no await needed. Must be called after init() resolves.
   */
  localIPv4() {
    return u().localIPv4();
  },
  /**
   * Return this node's Tailscale IPv6 address, or an empty string if not yet assigned.
   * Synchronous  -  no await needed. Must be called after init() resolves.
   */
  localIPv6() {
    return u().localIPv6();
  },
  /**
   * Return the current preferences (acceptRoutes, exitNodeId, dnsMode).
   * Synchronous  -  no await needed. Must be called after init() resolves.
   *
   * @example
   * const { acceptRoutes, exitNodeId } = network.getPrefs()
   * console.log("exit node:", exitNodeId || "(none)")
   */
  getPrefs() {
    return u().getPrefs();
  },
  /**
   * Enable or disable acceptance of subnet routes advertised by peers.
   * Equivalent to `tailscale set --accept-routes`.
   *
   * @example
   * await network.setAcceptRoutes(true)
   */
  async setAcceptRoutes(n) {
    return u().setAcceptRoutes(n);
  },
  /**
   * Return all peers that advertise exit-node capability.
   * Synchronous  -  no await needed. Returns an empty array if called before init() resolves.
   *
   * @example
   * const nodes = network.listExitNodes()
   * for (const n of nodes) {
   *   console.log(n.hostName, n.tailscaleIP, n.online ? "online" : "offline")
   * }
   */
  listExitNodes() {
    return Array.from(u().listExitNodes());
  },
  /**
   * Activate an exit node by its stable node ID.
   * Pass an empty string (or omit) to clear the exit node.
   *
   * @example
   * // Activate the first available online exit node
   * const node = network.listExitNodes().find(n => n.online)
   * if (node) await network.setExitNode(node.id)
   *
   * @example
   * // Clear the active exit node
   * await network.setExitNode()
   */
  async setExitNode(n = "") {
    return u().setExitNode(n);
  },
  /**
   * Choose DNS for public HTTP downloads: "exit-node" (default) or
   * "cloudflare". Cloudflare requires a selected exit node and sends DNS
   * over verified HTTPS through that node, never through browser fetch.
   * Tailnet names, literals, and private DNS suffixes keep tailnet resolution.
   * Clearing the exit node resets the mode to "exit-node".
   */
  async setDNSMode(n = "exit-node") {
    return u().setDNSMode(n);
  },
  /**
   * Return the full routing table (self + all peers).
   * Synchronous  -  no await needed. Returns an empty array if called before init() resolves.
   *
   * @example
   * const routes = network.getRoutes()
   * for (const r of routes) {
   *   console.log(r.prefix, "via", r.via, r.isExitRoute ? "(exit)" : "")
   * }
   */
  getRoutes() {
    return Array.from(u().getRoutes());
  },
  /**
   * Return the current Tailscale-managed DNS configuration.
   * Synchronous  -  no await needed. Returns an empty DNSInfo object if called before init() resolves.
   *
   * @example
   * const dns = network.getDNS()
   * console.log("resolvers:", dns.resolvers)
   * console.log("MagicDNS:", dns.magicDNS)
   * for (const [suffix, resolvers] of Object.entries(dns.routes)) {
   *   console.log(`split-DNS: ${suffix} → ${resolvers.join(", ")}`)
   * }
   */
  getDNS() {
    return u().getDNS();
  }
};
export {
  p as network
};
