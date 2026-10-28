// Shared, side-effect-free parts of the optional download transports.
export const NETWORK_TIMEOUT_MS = 130_000;
export const NETWORK_AUTH_TIMEOUT_MS = 6 * 60_000;
export const NETWORK_DIAGNOSTIC_TIMEOUT_MS = 45_000;
export const CLOUDFLARE_HEALTH_TIMEOUT_MS = 10_000;

export function validateNetworkMode(value) {
  if (!['browser', 'tailscale', 'cloudflare'].includes(value)) {
    throw new Error('Choose Browser, Tailscale, or Cloudflare Worker networking.');
  }
  return value;
}

export function validateProxyUrl(value) {
  let url;
  try { url = new URL(String(value)); }
  catch { throw new Error('Enter the complete HTTPS address of your Cloudflare Worker.'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('The Cloudflare Worker address must use HTTPS. HTTP is allowed only for localhost development.');
  }
  if (url.username || url.password || url.href.includes('?') || url.href.includes('#')) {
    throw new Error('Use a Worker address without credentials, a query string, or a fragment. Enter its shared token separately.');
  }
  if (url.pathname !== '/') {
    throw new Error('Use the root Worker address, without a path, such as https://your-proxy.workers.dev/.');
  }
  return url.href;
}

export function validateProxyToken(value) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(value)) {
    throw new Error('Enter the Worker’s shared token: 32–256 printable ASCII characters without spaces.');
  }
  return value;
}

export function validateDNSMode(value) {
  if (value !== 'exit-node' && value !== 'cloudflare') {
    throw new Error('Unknown DNS mode. Choose Exit node DNS or Cloudflare through exit node.');
  }
  return value;
}

export function validateDownloadUrl(value) {
  let url;
  try { url = new URL(String(value)); }
  catch { throw new Error('Enter a complete http:// or https:// data URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('The download transport supports HTTP and HTTPS URLs.');
  }
  if (url.username || url.password) {
    throw new Error('Use an Authorization header instead of credentials in the URL.');
  }
  url.hash = '';
  return url.href;
}

export function validateLoginUrl(value) {
  const url = new URL(String(value));
  if (url.protocol !== 'https:' || url.username || url.password
    || !(url.hostname === 'tailscale.com' || url.hostname.endsWith('.tailscale.com'))) {
    throw new Error('Tailscale returned an unexpected sign-in address. Disconnect and try again.');
  }
  return url.href;
}

export function normalizeNetworkHeaders(value = []) {
  const headers = new Headers();
  const entries = Array.isArray(value) ? value
    : value instanceof Headers ? [...value.entries()] : Object.entries(value || {});
  for (const entry of entries) {
    let name, content;
    if (Array.isArray(entry)) [name, content] = entry;
    else {
      const separator = String(entry).indexOf(':');
      if (separator < 1) throw new Error('Invalid HTTP request header.');
      name = String(entry).slice(0, separator);
      content = String(entry).slice(separator + 1).trim();
    }
    if (/\r|\n/.test(String(name)) || /\r|\n/.test(String(content))) {
      throw new Error('HTTP headers must not contain line breaks.');
    }
    headers.append(String(name), String(content));
  }
  return Object.fromEntries(headers.entries());
}

export function normalizeNetworkSnapshot(value = {}) {
  const exitNodeId = String(value.exitNodeId || '');
  const dnsMode = validateDNSMode(value.dnsMode ?? 'exit-node');
  return {
    ip: String(value.ip || ''),
    exitNodeId,
    dnsMode: exitNodeId ? dnsMode : 'exit-node',
    exitNodes: (Array.isArray(value.exitNodes) ? value.exitNodes : []).map(node => ({
      id: String(node.id || ''),
      hostName: String(node.hostName || ''),
      dnsName: String(node.dnsName || ''),
      tailscaleIP: String(node.tailscaleIP || ''),
      os: String(node.os || ''),
      active: Boolean(node.active),
      online: Boolean(node.online),
      expired: Boolean(node.expired)
    })).filter(node => node.id)
  };
}

export function describeNetworkConnection({ exitNodeId, exitNodes = [] }) {
  if (exitNodeId) {
    const selected = exitNodes.find(node => node.id === exitNodeId);
    if (selected?.expired) return 'The selected exit node has an expired device key. Sign in again on that device or choose another exit node.';
    if (!selected?.online) return 'The selected exit node is offline or unavailable. Choose another exit node or reconnect it.';
    return `${selected.hostName || selected.tailscaleIP || 'An exit node'} is selected. Test a URL below to check the download route.`;
  }
  return 'Connected to your tailnet. Select an exit node below for public internet downloads.';
}

const diagnosticLabels = {
  exit: 'Selected exit node',
  route: 'Route to 1.1.1.1',
  peer: 'Encrypted connection to exit',
  peerapi: 'Exit node service',
  tcp: 'TCP to 1.1.1.1:443',
  tls: 'TLS handshake and certificate',
  http: 'HTTP response from 1.1.1.1'
};

// Only a complete, known report can describe the result of this diagnostic.
// Omit all other runtime properties (logs, trace body, internal objects).
export function normalizeNetworkDiagnostics(value) {
  const invalid = () => new Error('Tailscale returned an incomplete connection diagnostic. Reconnect and run the diagnostic again.');
  if (!value || typeof value !== 'object' || !Array.isArray(value.checks)
    || value.checks.length !== Object.keys(diagnosticLabels).length) throw invalid();
  const checks = new Map();
  for (const check of value.checks) {
    if (!check || !Object.hasOwn(diagnosticLabels, check.id) || checks.has(check.id)
      || !['pass', 'fail', 'skip'].includes(check.status)
      || typeof check.elapsedMs !== 'number' || !Number.isFinite(check.elapsedMs) || check.elapsedMs < 0
      || typeof check.message !== 'string') throw invalid();
    checks.set(check.id, {
      id: check.id, label: diagnosticLabels[check.id], status: check.status,
      elapsedMs: check.elapsedMs, message: check.message.slice(0, 2000)
    });
  }
  return {
    exitNodeId: String(value.exitNodeId || ''),
    exitNodeName: String(value.exitNodeName || ''),
    exitNodeIP: String(value.exitNodeIP || ''),
    exitNodeOS: String(value.exitNodeOS || ''),
    exitNodeOnline: Boolean(value.exitNodeOnline),
    exitNodeExpired: Boolean(value.exitNodeExpired),
    checks: Object.keys(diagnosticLabels).map(id => checks.get(id))
  };
}

export function networkErrorCode(error) {
  const known = new Set(['EXIT_NODE_DNS_TIMEOUT', 'CLOUDFLARE_DNS_TIMEOUT']);
  const seen = new Set();
  for (let depth = 0; error != null && depth < 5 && !seen.has(error); depth += 1) {
    seen.add(error);
    if (known.has(error.code)) return error.code;
    const message = typeof error === 'string' ? error : error.message;
    const marker = typeof message === 'string'
      ? message.match(/^\s*\[(EXIT_NODE_DNS_TIMEOUT|CLOUDFLARE_DNS_TIMEOUT)\](?:\s|$)/)
      : null;
    if (marker) return marker[1];
    error = error.cause;
  }
  return '';
}

export function describeNetworkError(error) {
  const message = error?.message || String(error);
  // The runtime adds context-aware advice only for eligible public names.
  // Keep its details while omitting machine-readable markers from the panel.
  return message.replace(/\[(?:EXIT_NODE|CLOUDFLARE)_DNS_TIMEOUT\]\s*/g, '');
}
