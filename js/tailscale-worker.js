// Isolate the Go runtime so Disconnect really closes sockets and erases keys.
import { validateDownloadUrl, validateDNSMode, normalizeNetworkHeaders, normalizeNetworkSnapshot } from './network-common.js?v=1.5.4';

let network = null;
let connected = false;

function snapshot() {
  const prefs = network.getPrefs();
  return normalizeNetworkSnapshot({
    ip: network.localIPv4() || network.localIPv6(),
    exitNodes: network.listExitNodes(),
    exitNodeId: prefs.exitNodeId || '',
    dnsMode: prefs.dnsMode
  });
}

async function connect() {
  if (connected) return snapshot();
  // This pinned, locally shipped build uses official Tailscale source. No
  // general browser fetch proxy or public CORS proxy is involved.
  ({ network } = await import('../vendor/tailscale-web/tailscale-web.es.js?v=1.5.4'));
  self.postMessage({ event: 'progress', message: 'Starting Tailscale and requesting a sign-in link…' });
  const state = new Map();
  await network.init({
    hostname: `webr-studio-${crypto.randomUUID().slice(0, 8)}`,
    storage: {
      get: key => state.get(key) ?? null,
      set: (key, value) => state.set(key, value)
    },
    onAuthRequired: url => self.postMessage({ event: 'auth', url })
  });
  connected = true;
  // A single online exit node gives the same easy path as WebVM. With several
  // available nodes, let the user choose which machine handles their traffic.
  const nodes = network.listExitNodes().filter(node => node.online && !node.expired);
  if (nodes.length === 1) await network.setExitNode(nodes[0].id);
  return snapshot();
}

self.addEventListener('message', async event => {
  const { id, method, args = {} } = event.data || {};
  if (!Number.isSafeInteger(id)) return;
  try {
    let result;
    if (method === 'connect') result = await connect();
    else {
      if (!connected) throw new Error('Tailscale is not connected.');
      if (method === 'status') result = snapshot();
      else if (method === 'setExitNode') {
        const selected = String(args.id || '');
        const node = network.listExitNodes().find(node => node.id === selected);
        if (selected && node?.expired) {
          throw new Error('That exit node has an expired device key. Sign in again on that device or choose another exit node.');
        }
        if (selected && !node?.online) {
          throw new Error('That exit node is unavailable. Refresh the list and choose an online node.');
        }
        await network.setExitNode(selected);
        result = snapshot();
      } else if (method === 'setDNSMode') {
        const mode = validateDNSMode(args.mode);
        if (mode === 'cloudflare' && !network.getPrefs().exitNodeId) {
          throw new Error('Select an exit node before using Cloudflare DNS.');
        }
        await network.setDNSMode(mode);
        result = snapshot();
      } else if (method === 'diagnose') {
        if (!network.getPrefs().exitNodeId) throw new Error('Select an exit node before diagnosing the connection.');
        result = await network.diagnose();
      } else if (method === 'download') {
        const response = await network.fetch(validateDownloadUrl(args.url), {
          method: 'GET', headers: normalizeNetworkHeaders(args.headers)
        });
        const body = await response.arrayBuffer();
        result = { status: response.status, statusText: response.statusText, body };
      } else throw new Error('Unknown Tailscale worker request.');
    }
    self.postMessage({ id, result }, result?.body instanceof ArrayBuffer ? [result.body] : []);
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
});
