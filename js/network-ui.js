import { describeNetworkError, networkErrorCode } from './network-common.js?v=1.5.4';
import { APP_VERSION } from './config.js?v=1.5.4';

/** The networking panel deliberately keeps all account and network data as text. */
function loginLink(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

function byteCount(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes.toLocaleString()} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function dnsSetting(state) {
  if (!state.exitNodeId) return 'Tailnet DNS';
  return state.dnsMode === 'cloudflare' ? 'Cloudflare through exit node' : 'Exit node DNS';
}

function testSetting(state) {
  return state.mode === 'cloudflare'
    ? 'Route: Cloudflare Worker proxy.'
    : `DNS setting: ${dnsSetting(state)}.`;
}

function diagnosticText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function elapsedTime(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '';
  return milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

export class NetworkUI {
  constructor(network, { toast = () => {} } = {}) {
    this.network = network;
    this.toast = toast;
    this.state = network.state || {};
    this.pending = new Set();
    this.testRun = 0;
    this.testInputRevision = 0;
    this.routeRevision = 0;
    this.networkRouteRevision = network.routeRevision;
    this.failedTest = null;
    this.diagnosticRun = 0;
    this.diagnosticReportText = '';
    this.initialized = false;
    this.exitOptionsKey = '';
    this.operationError = '';
    this.init();
  }

  init() {
    if (this.initialized) return this;
    this.initialized = true;
    const get = id => document.getElementById(id);
    this.button = get('network-button');
    this.dialog = get('network-dialog');
    this.status = get('network-status');
    this.title = get('network-status-title');
    this.message = get('network-status-message');
    this.provider = get('network-provider');
    this.providerHelp = get('network-provider-help');
    this.tailscaleSettings = get('network-tailscale-settings');
    this.tailscaleDiagnostics = get('network-tailscale-diagnostics');
    this.cloudflareSettings = get('network-cloudflare-settings');
    this.proxyURL = get('network-proxy-url');
    this.proxyToken = get('network-proxy-token');
    this.proxyUse = get('network-proxy-use');
    this.proxyOrigin = get('network-proxy-origin');
    this.proxyCopyOrigin = get('network-proxy-copy-origin');
    this.proxyGenerateToken = get('network-proxy-generate-token');
    this.proxyCopyToken = get('network-proxy-copy-token');
    this.proxyCopyCode = get('network-proxy-copy-code');
    this.proxyDownloadCode = get('network-proxy-download-code');
    this.proxyDraft = get('network-proxy-draft');
    this.connect = get('network-connect');
    this.connectLabel = get('network-connect-label');
    this.login = get('network-login');
    this.loginHint = get('network-login-hint');
    this.disconnect = get('network-disconnect');
    this.exitNode = get('network-exit-node');
    this.dnsMode = get('network-dns-mode');
    this.routeBadge = get('network-route-badge');
    this.refresh = get('network-refresh');
    this.ipRow = get('network-ip-row');
    this.ip = get('network-ip');
    this.copyIP = get('network-copy-ip');
    this.actionError = get('network-action-error');
    this.testURL = get('network-test-url');
    this.testButton = get('network-test');
    this.testHelp = get('network-test-help');
    this.testResult = get('network-test-result');
    this.dnsRecovery = get('network-dns-recovery');
    this.retryDNS = get('network-retry-dns');
    this.diagnoseButton = get('network-diagnose');
    this.diagnosticPanel = get('network-diagnostics');
    this.diagnosticStatus = get('network-diagnostic-status');
    this.diagnosticExit = get('network-diagnostic-exit');
    this.diagnosticChecks = get('network-diagnostic-checks');
    this.copyDiagnostic = get('network-copy-diagnostic');

    this.proxyURL.value = this.state.proxyUrl || '';
    this.proxyOrigin.value = window.location.origin;

    this.button.addEventListener('click', () => this.open());
    this.provider.addEventListener('change', () => {
      const mode = this.provider.value;
      this.proxyToken.value = '';
      this.invalidateTest();
      this.invalidateDiagnostics();
      this.run('provider', () => this.network.selectMode(mode));
    });
    this.connect.addEventListener('click', () => this.run('connect', () => this.network.connect()));
    this.disconnect.addEventListener('click', () => {
      this.proxyToken.value = '';
      this.invalidateTest();
      this.invalidateDiagnostics();
      this.run('disconnect', () => this.network.disconnect());
    });
    this.proxyUse.addEventListener('click', () => this.useCloudflare());
    this.proxyGenerateToken.addEventListener('click', () => {
      if (this.proxyGenerateToken.disabled) return;
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      this.proxyToken.value = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
      this.proxyToken.setCustomValidity('');
      this.invalidateTest();
      this.render();
      this.toast('Proxy password generated', 'Copy it into the Worker secret named PROXY_TOKEN.', 'success');
    });
    this.proxyCopyToken.addEventListener('click', () => this.run('copyToken', async () => {
      if (!this.proxyToken.value) return;
      await navigator.clipboard.writeText(this.proxyToken.value);
      this.toast('Proxy password copied', 'Paste it into the Worker secret named PROXY_TOKEN.', 'success');
    }));
    this.proxyCopyOrigin.addEventListener('click', () => this.run('copyOrigin', async () => {
      await navigator.clipboard.writeText(window.location.origin);
      this.toast('Page origin copied', 'Paste it into the Worker variable named ALLOWED_ORIGINS.', 'success');
    }));
    this.proxyCopyCode.addEventListener('click', () => this.run('copyCode', async () => {
      const source = await this.workerSource();
      await navigator.clipboard.writeText(source);
      this.toast('Worker code copied', 'Replace the starter Worker code with this code, then deploy it.', 'success');
    }));
    this.proxyDownloadCode.addEventListener('click', () => this.run('downloadCode', async () => {
      const source = await this.workerSource();
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'worker.js';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }));
    for (const input of [this.proxyURL, this.proxyToken]) {
      input.addEventListener('input', () => {
        input.setCustomValidity('');
        this.operationError = '';
        this.invalidateTest();
        this.render();
      });
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (!this.proxyUse.disabled) this.useCloudflare();
        }
      });
    }
    this.refresh.addEventListener('click', () => this.run('refresh', () => this.network.refresh()));
    this.exitNode.addEventListener('change', () => {
      const selected = this.exitNode.value;
      this.testRun += 1;
      this.failedTest = null;
      this.testResult.hidden = true;
      this.invalidateDiagnostics();
      this.run('exitNode', () => this.network.setExitNode(selected));
    });
    this.dnsMode.addEventListener('change', () => {
      const selected = this.dnsMode.value;
      this.testRun += 1;
      this.failedTest = null;
      this.testResult.hidden = true;
      this.invalidateDiagnostics();
      this.run('dnsMode', () => this.network.setDNSMode(selected));
    });
    this.copyIP.addEventListener('click', () => this.run('copy', async () => {
      if (!this.state.ip) return;
      await navigator.clipboard.writeText(this.state.ip);
      this.toast('Tailscale IP copied', this.state.ip, 'success');
    }));
    this.testButton.addEventListener('click', () => this.test());
    this.retryDNS.addEventListener('click', () => this.retryWithCloudflare());
    this.diagnoseButton.addEventListener('click', () => this.diagnose());
    this.copyDiagnostic.addEventListener('click', () => this.run('copyDiagnostic', async () => {
      if (!this.diagnosticReportText) return;
      await navigator.clipboard.writeText(this.diagnosticReportText);
      this.toast('Connection report copied', 'Results for the selected exit and HTTPS to 1.1.1.1.', 'success');
    }));
    this.testURL.addEventListener('input', () => {
      this.testURL.setCustomValidity('');
      this.testInputRevision += 1;
      this.failedTest = null;
      if (this.pending.has('retryDNS')) this.testResult.hidden = true;
      this.render();
    });
    this.testURL.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (!this.testButton.disabled) this.test();
      }
    });
    // Enter in a select should not accidentally submit the dialog form.
    this.dialog.querySelector('form').addEventListener('submit', event => {
      if (!event.submitter || event.submitter.value !== 'cancel') event.preventDefault();
    });
    this.onChange = event => {
      const next = event.detail || this.network.state || {};
      const revisionChanged = this.network.routeRevision !== this.networkRouteRevision;
      const modeChanged = next.mode !== this.state.mode;
      const routeChanged = next.phase !== this.state.phase
        || modeChanged || next.exitNodeId !== this.state.exitNodeId
        || next.dnsMode !== this.state.dnsMode || next.proxyUrl !== this.state.proxyUrl
        || revisionChanged;
      this.networkRouteRevision = this.network.routeRevision;
      if (modeChanged || (revisionChanged && next.phase === 'disconnected' && !this.pending.has('proxy'))) {
        this.proxyToken.value = '';
        this.operationError = '';
      }
      if (next.mode === 'cloudflare' && next.phase === 'connected'
        && (next.phase !== this.state.phase || next.proxyUrl !== this.state.proxyUrl || revisionChanged)) {
        this.proxyToken.value = '';
        this.proxyURL.value = next.proxyUrl || '';
      }
      if (routeChanged) {
        this.routeRevision += 1;
        this.failedTest = null;
        this.invalidateDiagnostics();
      }
      if (this.state.phase === 'connected' && routeChanged) {
        this.testRun += 1;
        this.testResult.hidden = true;
      }
      this.state = next;
      this.render();
    };
    this.network.addEventListener('change', this.onChange);
    this.render();
    return this;
  }

  open() {
    this.state = this.network.state || this.state;
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
  }

  async run(name, action) {
    if (this.pending.has(name)) return;
    this.pending.add(name);
    this.operationError = '';
    this.render();
    let revision = this.network.routeRevision;
    let mode = this.network.state?.mode;
    try {
      const operation = action();
      revision = this.network.routeRevision;
      mode = this.network.state?.mode;
      await operation;
    } catch (error) {
      // Disconnect can intentionally cancel an unfinished login.
      const cancelled = error?.name === 'AbortError'
        || (name === 'connect' && this.network.state?.phase === 'disconnected');
      if (!cancelled && revision === this.network.routeRevision && mode === this.network.state?.mode) {
        this.operationError = describeNetworkError(error);
      }
    } finally {
      this.pending.delete(name);
      this.state = this.network.state || this.state;
      this.render();
    }
  }

  invalidateTest() {
    this.testRun += 1;
    this.failedTest = null;
    this.testResult.hidden = true;
  }

  proxySettingsChanged() {
    return this.state.mode === 'cloudflare' && this.state.phase === 'connected'
      && (this.proxyURL.value.trim() !== this.state.proxyUrl || Boolean(this.proxyToken.value));
  }

  async workerSource() {
    const response = await fetch(new URL('../cloudflare-worker/worker.js', import.meta.url), {
      credentials: 'same-origin', cache: 'no-cache'
    });
    if (!response.ok) throw new Error('The bundled worker.js could not be loaded. Check that cloudflare-worker/worker.js was included when deploying webR Studio.');
    return response.text();
  }

  async useCloudflare() {
    if (this.proxyUse.disabled || this.state.mode !== 'cloudflare') return;
    if (!this.proxyURL.reportValidity()) return;
    const url = this.proxyURL.value.trim();
    const token = this.proxyToken.value;
    this.proxyToken.setCustomValidity(/^[\x21-\x7e]{32,256}$/.test(token)
      ? '' : 'Use 32 to 256 printable ASCII characters with no spaces. Generate password creates a suitable value.');
    if (!this.proxyToken.reportValidity()) return;
    this.invalidateTest();
    this.invalidateDiagnostics();
    await this.run('proxy', () => this.network.useCloudflare({ url, token }));
  }

  async test(retryURL) {
    if (this.pending.has('test') || this.pending.has('exitNode') || this.pending.has('dnsMode')
      || this.pending.has('retryDNS') || this.pending.has('diagnose') || this.pending.has('proxy')
      || this.pending.has('provider') || this.proxySettingsChanged() || this.state.phase !== 'connected') return;
    const inputValue = this.testURL.value.trim();
    const inputRevision = this.testInputRevision;
    const routeRevision = this.routeRevision;
    const setting = testSetting(this.state);
    const provider = this.state.mode === 'cloudflare' ? 'Cloudflare Worker proxy' : 'Tailscale';
    let url;
    try {
      url = new URL(retryURL ?? inputValue);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid protocol');
      if (url.username || url.password) throw new Error('Credentials in URL');
    } catch {
      this.testURL.setCustomValidity('Enter a complete HTTP or HTTPS URL without embedded credentials.');
      this.testURL.reportValidity();
      return;
    }
    this.testURL.setCustomValidity('');
    const run = ++this.testRun;
    this.failedTest = null;
    this.pending.add('test');
    this.testResult.hidden = false;
    this.testResult.dataset.state = 'loading';
    this.testResult.textContent = `Downloading through ${provider}… ${setting}`;
    this.render();
    try {
      const result = await this.network.test(url.href);
      if (run !== this.testRun) return;
      const status = Number(result.status);
      const success = status >= 200 && status < 300;
      this.testResult.dataset.state = success ? 'success' : 'error';
      const duration = Number.isFinite(Number(result.elapsedMs))
        ? ` in ${(Math.max(0, Number(result.elapsedMs)) / 1000).toFixed(2)} s`
        : '';
      this.testResult.textContent = `${success ? 'Download succeeded' : 'Server response'}: HTTP ${status}, ${byteCount(result.bytes)}${duration}. ${setting}`;
    } catch (error) {
      if (run !== this.testRun) return;
      this.testResult.dataset.state = 'error';
      this.testResult.textContent = `${setting}\n${describeNetworkError(error)}`;
      if (this.state.mode === 'tailscale' && networkErrorCode(error) === 'EXIT_NODE_DNS_TIMEOUT'
        && inputRevision === this.testInputRevision && inputValue === this.testURL.value.trim()) {
        this.failedTest = { url: url.href, inputValue, inputRevision, routeRevision };
      }
    } finally {
      this.pending.delete('test');
      this.render();
    }
  }

  canRetryWithCloudflare() {
    const failed = this.failedTest;
    return Boolean(failed && this.state.mode === 'tailscale' && this.state.phase === 'connected' && this.state.exitNodeId
      && this.state.dnsMode === 'exit-node' && failed.routeRevision === this.routeRevision
      && failed.inputRevision === this.testInputRevision && failed.inputValue === this.testURL.value.trim());
  }

  async retryWithCloudflare() {
    if (!this.canRetryWithCloudflare() || this.pending.has('test') || this.pending.has('exitNode')
      || this.pending.has('dnsMode') || this.pending.has('retryDNS') || this.pending.has('diagnose')) return;
    const failed = this.failedTest;
    const exitNodeId = this.state.exitNodeId;
    const worker = this.network.worker;
    this.failedTest = null;
    this.operationError = '';
    this.pending.add('retryDNS');
    this.testResult.hidden = false;
    this.testResult.dataset.state = 'loading';
    this.testResult.textContent = 'Switching to Cloudflare DNS through the exit node…';
    this.render();
    try {
      await this.network.setDNSMode('cloudflare');
      if (this.network.state?.dnsMode !== 'cloudflare') {
        throw new Error('Cloudflare DNS was not enabled. Select it in DNS for public hostnames and try again.');
      }
      // Only our one expected DNS change may happen before this retry. Editing
      // the URL, changing routes, or reconnecting cancels the pending retry.
      if (this.state.phase !== 'connected' || this.state.exitNodeId !== exitNodeId
        || this.network.worker !== worker
        || this.routeRevision !== failed.routeRevision + 1
        || this.testInputRevision !== failed.inputRevision
        || this.testURL.value.trim() !== failed.inputValue) return;
      this.pending.delete('retryDNS');
      await this.test(failed.url);
    } catch (error) {
      if (this.state.phase === 'connected' && this.state.exitNodeId === exitNodeId
        && this.network.worker === worker
        && this.routeRevision <= failed.routeRevision + 1
        && this.testInputRevision === failed.inputRevision
        && this.testURL.value.trim() === failed.inputValue) {
        this.operationError = describeNetworkError(error);
        this.testResult.hidden = false;
        this.testResult.dataset.state = 'error';
        this.testResult.textContent = this.operationError;
      }
    } finally {
      this.pending.delete('retryDNS');
      this.state = this.network.state || this.state;
      this.render();
    }
  }

  invalidateDiagnostics() {
    this.diagnosticRun += 1;
    this.diagnosticReportText = '';
    this.pending.delete('diagnose');
    this.diagnosticPanel.hidden = true;
    this.diagnosticStatus.textContent = '';
    this.diagnosticExit.textContent = '';
    this.diagnosticChecks.replaceChildren();
  }

  async diagnose() {
    if (this.state.phase !== 'connected' || this.state.mode !== 'tailscale' || !this.state.exitNodeId
      || ['diagnose', 'test', 'exitNode', 'dnsMode', 'retryDNS', 'refresh'].some(name => this.pending.has(name))) return;
    const run = ++this.diagnosticRun;
    const revision = this.routeRevision;
    const worker = this.network.worker;
    const exitNodeId = this.state.exitNodeId;
    const mode = this.state.mode;
    const dnsMode = this.state.dnsMode;
    const setting = dnsSetting(this.state);
    const isCurrent = () => run === this.diagnosticRun && revision === this.routeRevision
      && worker === this.network.worker && this.state.phase === 'connected'
      && this.state.exitNodeId === exitNodeId && this.state.mode === mode && this.state.dnsMode === dnsMode;
    this.diagnosticReportText = '';
    this.operationError = '';
    this.pending.add('diagnose');
    this.diagnosticPanel.hidden = false;
    this.diagnosticPanel.dataset.state = 'loading';
    this.diagnosticStatus.textContent = 'Checking the selected exit and HTTPS to 1.1.1.1 without DNS…';
    this.diagnosticExit.textContent = 'This can take about 30 seconds. Your settings stay unchanged.';
    this.diagnosticChecks.replaceChildren();
    this.render();
    try {
      const report = await this.network.diagnose();
      if (!isCurrent()) return;
      if (report.exitNodeId !== exitNodeId) throw new Error('The selected exit node changed. Run the checks again.');
      this.showDiagnosticReport(report, setting);
    } catch (error) {
      if (!isCurrent()) return;
      this.diagnosticPanel.dataset.state = 'error';
      this.diagnosticStatus.textContent = `Connection checks could not finish: ${describeNetworkError(error)}`;
      this.diagnosticExit.textContent = '';
    } finally {
      if (run === this.diagnosticRun) {
        this.pending.delete('diagnose');
        this.render();
      }
    }
  }

  showDiagnosticReport(report, setting) {
    const allowedIDs = new Set(['exit', 'route', 'peer', 'peerapi', 'tcp', 'tls', 'http']);
    const checks = (Array.isArray(report.checks) ? report.checks : []).filter(check => allowedIDs.has(check.id));
    const counts = { pass: 0, fail: 0, skip: 0 };
    const labels = { pass: 'Passed', fail: 'Failed', skip: 'Skipped' };
    const lines = [];
    this.diagnosticChecks.replaceChildren();
    for (const check of checks) {
      const status = Object.hasOwn(labels, check.status) ? check.status : 'skip';
      const label = diagnosticText(check.label || check.id);
      const message = diagnosticText(check.message);
      const elapsed = elapsedTime(check.elapsedMs);
      counts[status] += 1;
      const item = document.createElement('li');
      item.dataset.status = status;
      item.dataset.check = check.id;
      const heading = document.createElement('div');
      heading.className = 'network-diagnostic-check-heading';
      const badge = document.createElement('span');
      badge.className = 'network-diagnostic-check-status';
      badge.textContent = labels[status];
      const title = document.createElement('strong');
      title.textContent = label;
      const time = document.createElement('span');
      time.className = 'network-diagnostic-check-time';
      time.textContent = elapsed;
      heading.append(badge, title, time);
      const description = document.createElement('p');
      description.textContent = message;
      description.hidden = !message;
      item.append(heading, description);
      this.diagnosticChecks.append(item);
      lines.push(`${labels[status].toUpperCase()}: ${label}${elapsed ? ` (${elapsed})` : ''}${message ? `: ${message}` : ''}`);
    }
    const name = diagnosticText(report.exitNodeName) || 'Selected exit node';
    const ip = diagnosticText(report.exitNodeIP) || 'Unknown';
    const os = diagnosticText(report.exitNodeOS) || 'Unknown';
    const online = report.exitNodeOnline ? 'yes' : 'no';
    const expired = report.exitNodeExpired ? 'yes' : 'no';
    const summary = `Checks for the selected exit and 1.1.1.1: ${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped.`;
    this.diagnosticPanel.dataset.state = counts.fail ? 'error' : 'complete';
    this.diagnosticStatus.textContent = summary;
    this.diagnosticExit.textContent = `${name} (${ip}) · OS: ${os} · Advertised online: ${online} · Key expired: ${expired}`;
    this.diagnosticReportText = [
      'webR Studio connection checks',
      `App version: ${APP_VERSION}`, `Completed at: ${new Date().toISOString()}`,
      'Target: HTTPS to 1.1.1.1 without a DNS lookup',
      `Exit node: ${name}`, `Tailscale IP: ${ip}`, `Operating system: ${os}`,
      `Advertised online: ${online}`, `Device key expired: ${expired}`,
      `DNS setting: ${setting} (unchanged)`, summary, ...lines
    ].join('\n');
  }

  render() {
    const state = this.state;
    const mode = ['tailscale', 'cloudflare'].includes(state.mode) ? state.mode : 'browser';
    const tailscale = mode === 'tailscale';
    const cloudflare = mode === 'cloudflare';
    const phase = state.phase || 'disconnected';
    const connected = phase === 'connected';
    const starting = phase === 'loading' || phase === 'login';
    const selectedId = String(state.exitNodeId || '');
    const nodes = Array.isArray(state.exitNodes) ? state.exitNodes : [];
    const selectedNode = nodes.find(node => String(node.id) === selectedId);
    const exitUnavailable = tailscale && connected && selectedId && (!selectedNode || selectedNode.online !== true || selectedNode.expired === true);
    const bridgeUnavailable = connected && state.bridgeReady !== true && state.bridgeError;
    const displayState = exitUnavailable || bridgeUnavailable || (mode !== 'browser' && phase === 'disconnected')
      ? 'attention' : tailscale && connected && !selectedId ? 'tailnet' : phase;
    const titles = cloudflare ? {
      disconnected: 'Worker proxy selected',
      loading: 'Checking Worker proxy…',
      connected: bridgeUnavailable ? 'R downloads need attention' : 'Worker proxy ready to test',
      error: 'Worker proxy needs attention'
    } : tailscale ? {
      disconnected: 'Tailscale selected',
      loading: 'Starting Tailscale…',
      login: 'Sign in to connect',
      connected: bridgeUnavailable ? 'R downloads need attention' : exitUnavailable ? 'Exit node needs attention' : selectedId ? 'Tailscale ready to test' : 'Connected to your tailnet',
      error: 'Tailscale needs attention'
    } : {
      disconnected: 'Browser downloads',
      connected: 'Browser downloads',
      error: 'Browser downloads need attention'
    };
    this.provider.value = mode;
    this.provider.disabled = this.pending.has('provider');
    this.providerHelp.textContent = cloudflare
      ? 'Requested URLs and data pass through your Cloudflare Worker. Configure it below, then connect this route.'
      : tailscale
        ? 'R downloads use your Tailscale network. Select an exit node for access to public websites.'
        : "Browser downloads follow the data server's CORS rules. Choose another route for servers that do not allow browser requests.";
    this.tailscaleSettings.hidden = !tailscale;
    this.tailscaleDiagnostics.hidden = !tailscale;
    this.cloudflareSettings.hidden = !cloudflare;
    this.status.dataset.state = displayState;
    this.status.dataset.mode = mode;
    this.button.dataset.state = displayState;
    this.title.textContent = titles[phase] || 'Networking';
    this.message.textContent = state.message || (cloudflare
      ? connected
        ? 'The Worker accepted your setup. Test a data URL below to check a download.'
        : phase === 'loading'
          ? 'Checking the Worker URL, proxy password, and allowed origin.'
          : 'Enter your Worker URL and proxy password, then choose Use proxy. R downloads wait for this route to connect.'
      : mode === 'browser'
        ? "R downloads use the browser's usual CORS rules."
        : connected
      ? selectedId
        ? 'An exit node is selected. Test a URL below to check internet access.'
        : 'Private tailnet services are available. Select an exit node to download from the public internet.'
      : phase === 'error'
        ? String(state.error || 'Reconnect, or disconnect to restore browser downloads.')
        : phase === 'login'
          ? 'Open the sign-in link and approve this tab as a device in your Tailscale network.'
          : phase === 'loading'
            ? 'The networking runtime is loading. The first connection may take a moment.'
            : 'Connect to Tailscale to use this route for R downloads.');
    if (mode !== 'browser' && phase === 'disconnected' && state.bridgeReady !== true) {
      this.message.textContent = state.bridgeError
        ? `The selected route is unavailable for R downloads: ${state.bridgeError}`
        : 'Start R and wait for its download bridge to be ready before connecting this route.';
    } else if (bridgeUnavailable) {
      this.message.textContent = `The selected route is connected, but R downloads are unavailable: ${state.bridgeError}`;
    } else if (exitUnavailable) {
      this.message.textContent = selectedNode?.expired
        ? 'The selected exit node has an expired device key. Sign in again on that device or choose another exit node.'
        : selectedNode
          ? 'The selected exit node is offline. Bring that device online, or select another exit node and test a URL.'
          : 'The selected exit node is no longer available. Refresh the list and select another exit node.';
    }
    const errors = [...new Set([state.error, this.operationError].filter(Boolean).map(describeNetworkError))];
    this.actionError.textContent = errors.join('\n');
    this.actionError.hidden = errors.length === 0;
    this.button.title = `Networking: ${this.title.textContent}`;
    this.button.setAttribute('aria-label', `Open networking. ${this.title.textContent}.`);

    const authURL = loginLink(state.loginUrl);
    this.login.hidden = !tailscale || phase !== 'login' || !authURL;
    if (authURL) this.login.href = authURL;
    else this.login.removeAttribute('href');
    this.loginHint.hidden = this.login.hidden;
    this.connect.hidden = !tailscale || connected || phase === 'login';
    this.connect.disabled = !tailscale || starting || this.pending.has('connect') || state.bridgeReady !== true;
    this.connectLabel.textContent = phase === 'loading' ? 'Connecting…' : phase === 'error' ? 'Reconnect to Tailscale' : 'Connect to Tailscale';
    this.disconnect.hidden = mode === 'browser';
    this.disconnect.parentElement.hidden = this.disconnect.hidden;
    this.disconnect.disabled = this.pending.has('disconnect');
    this.disconnect.textContent = phase === 'disconnected' ? 'Use browser downloads' : 'Disconnect';
    this.routeBadge.textContent = connected
      ? exitUnavailable ? 'Exit node unavailable' : selectedId ? 'Exit node selected' : 'Tailnet only'
      : state.mode === 'tailscale' ? 'Waiting for connection' : 'Not connected';

    const proxyLoading = cloudflare && (starting || this.pending.has('proxy'));
    const proxyDraft = this.proxySettingsChanged();
    this.proxyURL.disabled = proxyLoading;
    this.proxyToken.disabled = proxyLoading;
    this.proxyToken.placeholder = cloudflare && connected
      ? 'Connected; reenter the password to change the setup'
      : 'Paste the password saved in PROXY_TOKEN';
    this.proxyGenerateToken.disabled = proxyLoading;
    this.proxyCopyToken.disabled = proxyLoading || !this.proxyToken.value || this.pending.has('copyToken');
    this.proxyCopyOrigin.disabled = this.pending.has('copyOrigin');
    this.proxyCopyCode.disabled = this.pending.has('copyCode');
    this.proxyDownloadCode.disabled = this.pending.has('downloadCode');
    this.proxyDraft.hidden = !cloudflare || !proxyDraft;
    this.proxyUse.disabled = !cloudflare || proxyLoading || state.bridgeReady !== true
      || this.pending.has('provider') || this.pending.has('test') || this.pending.has('diagnose')
      || !this.proxyURL.value.trim() || !this.proxyToken.value;
    this.proxyUse.textContent = proxyLoading ? 'Checking proxy…' : 'Use proxy';

    const optionsKey = JSON.stringify([nodes, selectedId]);
    if (optionsKey !== this.exitOptionsKey) {
      this.exitOptionsKey = optionsKey;
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Tailnet only';
      this.exitNode.replaceChildren(option);
      for (const node of nodes) {
        if (!node.id) continue;
        const item = document.createElement('option');
        item.value = String(node.id);
        const unavailable = node.expired ? ' (key expired)' : node.online === false ? ' (offline)' : '';
        item.textContent = `${node.hostName || node.dnsName || node.tailscaleIP || node.id}${unavailable}`;
        item.disabled = node.online === false || node.expired === true;
        this.exitNode.append(item);
      }
      if (selectedId && !nodes.some(node => String(node.id) === selectedId)) {
        const missing = document.createElement('option');
        missing.value = selectedId;
        missing.textContent = 'Selected exit node (unavailable)';
        missing.disabled = true;
        this.exitNode.append(missing);
      }
    }
    this.exitNode.value = selectedId;
    const changingRoute = this.pending.has('exitNode') || this.pending.has('dnsMode') || this.pending.has('retryDNS');
    const diagnosing = this.pending.has('diagnose');
    this.exitNode.disabled = !tailscale || !connected || changingRoute || this.pending.has('test') || diagnosing;
    this.dnsMode.value = state.dnsMode === 'cloudflare' ? 'cloudflare' : 'exit-node';
    this.dnsMode.disabled = !tailscale || !connected || !selectedId || changingRoute || this.pending.has('test') || diagnosing;
    this.refresh.disabled = !tailscale || !connected || this.pending.has('refresh') || changingRoute || diagnosing;
    this.ipRow.hidden = !tailscale || !connected || !state.ip;
    this.ip.textContent = state.ip || '';
    this.copyIP.disabled = this.pending.has('copy');
    this.testButton.disabled = mode === 'browser' || !connected || this.pending.has('test') || changingRoute || diagnosing
      || this.pending.has('proxy') || this.pending.has('provider') || proxyDraft;
    this.testButton.textContent = this.pending.has('test') ? 'Testing…' : 'Test';
    this.testHelp.textContent = cloudflare
      ? 'Downloads the URL through your Cloudflare Worker proxy and reports the result. No project file is created.'
      : tailscale
        ? 'Downloads the URL through Tailscale and reports the result. No project file is created.'
        : 'Choose Tailscale or a Cloudflare Worker proxy and connect to test a download here. No project file is created.';
    this.dnsRecovery.hidden = !this.canRetryWithCloudflare();
    this.retryDNS.disabled = this.testButton.disabled;
    this.diagnoseButton.disabled = !connected || state.mode !== 'tailscale' || !selectedId || changingRoute || diagnosing
      || this.pending.has('test') || this.pending.has('refresh');
    this.diagnoseButton.textContent = diagnosing ? 'Checking connection…' : 'Diagnose connection';
    this.diagnosticPanel.setAttribute('aria-busy', String(diagnosing));
    this.copyDiagnostic.hidden = !this.diagnosticReportText;
    this.copyDiagnostic.disabled = diagnosing || this.pending.has('copyDiagnostic') || !this.diagnosticReportText;
  }
}
