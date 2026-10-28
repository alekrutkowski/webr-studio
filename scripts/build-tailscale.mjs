#!/usr/bin/env node
// Rebuild the optional browser networking runtime. Requires Go 1.26.10 and Node.js.
// Public dependencies are pinned by network-src/tailscale-web/go.mod and go.sum.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(project, 'network-src', 'tailscale-web');
const output = join(project, 'vendor', 'tailscale-web');
const go = process.env.GO_BINARY || 'go';
const toolchain = 'go1.26.10';
const env = { ...process.env, GOOS: 'js', GOARCH: 'wasm', CGO_ENABLED: '0', GOTOOLCHAIN: 'local' };
const run = (...args) => execFileSync(go, args, { cwd: source, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

if (run('env', 'GOVERSION').trim() !== toolchain) {
  throw new Error(`This reproducible build requires ${toolchain}. Put it on PATH or set GO_BINARY to its go executable.`);
}
if (/^replace\s/m.test(readFileSync(join(source, 'go.mod'), 'utf8'))) {
  throw new Error('The networking build must not contain local or fork module replacements.');
}
mkdirSync(output, { recursive: true });
run('mod', 'download');
process.stdout.write(run('mod', 'verify'));
run('build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid=', '-o', join(output, 'main.wasm'), '.');

const goroot = run('env', 'GOROOT').trim();
const shim = [join(goroot, 'lib', 'wasm', 'wasm_exec.js'), join(goroot, 'misc', 'wasm', 'wasm_exec.js')].find(existsSync);
if (!shim) throw new Error('Cannot find wasm_exec.js in this Go distribution.');
copyFileSync(shim, join(output, 'wasm_exec.js'));
const loader = readFileSync(join(project, 'network-src', 'tailscale-web.es.js'), 'utf8')
  .replaceAll('__WASM_SHA256__', sha256(join(output, 'main.wasm')))
  .replaceAll('__GO_SHIM_SHA256__', sha256(join(output, 'wasm_exec.js')));
writeFileSync(join(output, 'tailscale-web.es.js'), loader);
copyFileSync(join(source, 'LICENSE'), join(output, 'LICENSE.tailscale-web.txt'));

const rows = run('list', '-mod=readonly', '-buildvcs=false', '-deps', '-f', '{{if .Module}}{{.Module.Path}}\t{{.Module.Version}}\t{{.Module.Dir}}{{end}}', '.')
  .trim().split('\n').filter(Boolean).map(row => row.split('\t'));
const modules = [...new Map(rows.filter(row => row[1]).map(row => [row[0], row])).values()]
  .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

function licenseFiles(folder, prefix = '') {
  const result = [];
  for (const entry of readdirSync(join(folder, prefix), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) {
      // Keep nested third-party notices included in a module, including its forks.
      if (!entry.name.startsWith('.')) result.push(...licenseFiles(folder, path));
    } else if (/^(licen[cs]e|copying|notice|copyright|patents)([._-]|$)/i.test(entry.name)
      && !/\.(go|js|ts|c|h|py|sh|json)$/i.test(entry.name)) {
      result.push(path);
    }
  }
  return result;
}

const notices = [
  'Third-party notices for the optional webR Studio Tailscale runtime',
  'This file contains upstream notices without changing their license terms.',
  'Compiled module versions are also recorded in provenance.json.',
  '\n=== tailscale-web (MIT) ===\n' + readFileSync(join(source, 'LICENSE'), 'utf8'),
  '\n=== Go toolchain and standard library ===\n' + readFileSync(join(goroot, 'LICENSE'), 'utf8'),
];
for (const file of licenseFiles(join(goroot, 'src', 'vendor'))) {
  notices.push(`\n=== Go standard-library vendor: ${file.replaceAll('\\', '/')} ===\n` + readFileSync(join(goroot, 'src', 'vendor', file), 'utf8'));
}
for (const [name, version, directory] of modules) {
  const files = licenseFiles(directory);
  if (!files.length) throw new Error(`No license notice found for ${name}@${version}; review before distribution.`);
  for (const file of files) notices.push(`\n=== ${name}@${version}: ${file.replaceAll('\\', '/')} ===\n` + readFileSync(join(directory, file), 'utf8'));
}
writeFileSync(join(output, 'THIRD-PARTY-LICENSES.txt'), notices.join('\n') + '\n');

const artifactNames = ['main.wasm', 'wasm_exec.js', 'tailscale-web.es.js', 'LICENSE.tailscale-web.txt', 'THIRD-PARTY-LICENSES.txt'];
const artifacts = Object.fromEntries(artifactNames.map(name => [name, { sha256: sha256(join(output, name)) }]));
const provenance = {
  upstream: 'https://github.com/adrianosela/tailscale-web',
  upstreamVersion: '0.1.16',
  upstreamCommit: '004de98821ba5856332df750f431f4fcb7ca76f6',
  goToolchain: toolchain,
  goToolchainDownloads: 'https://go.dev/dl/',
  officialTailscaleVersion: 'v1.96.0',
  sourceChanges: [
    'Removed the local Tailscale module replacement; use the official checksum-verified module.',
    'Removed the experimental WebRTC signaling environment setting and its unused envknob import.',
    'Use the Go runtime shim from the build toolchain instead of the npm-inlined shim.',
    'Normalize comment and diagnostic typography to the project style.',
    'Use content-hash URL queries for the Go shim and WebAssembly asset.',
    'Increase the HTTP client timeout from 30 to 120 seconds for data downloads over relayed connections.',
    'Require Tailscale Running state, an assigned IP, and a node key before reporting connection readiness.',
    'Add opt-in Cloudflare DNS-over-HTTPS through the selected exit node for public downloads, preserving private-name routing and the default exit-node DNS mode.',
    'Add explicit staged diagnostics for the selected exit, configured WireGuard route, encrypted peer, PeerAPI, and DNS-free TCP/TLS/HTTP to 1.1.1.1 using the same userspace connection.',
    'Expose exit-node operating system and device-key expiry, and reject selecting expired exits.',
  ],
  buildFlags: ['-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid='],
  modules: modules.map(([path, version]) => ({ path, version })),
  goModSha256: sha256(join(source, 'go.mod')),
  goSumSha256: sha256(join(source, 'go.sum')),
  artifacts,
};
writeFileSync(join(output, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
writeFileSync(join(output, 'SHA256SUMS'), artifactNames.map(name => `${artifacts[name].sha256}  ${name}`).join('\n') + '\n');
console.log(`Built ${relative(project, output)} using ${toolchain} and official Tailscale v1.96.0.`);
