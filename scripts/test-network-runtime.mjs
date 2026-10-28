#!/usr/bin/env node
// Execute the Go networking regressions as WebAssembly, using the matching
// compiler/runtime. Tests use controlled in-memory endpoints, not user logins.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(project, 'network-src', 'tailscale-web');
const go = process.env.GO_BINARY || 'go';
const env = { ...process.env, GOOS: 'js', GOARCH: 'wasm', CGO_ENABLED: '0', GOTOOLCHAIN: 'local' };
const output = (...args) => execFileSync(go, args, { cwd: source, env, encoding: 'utf8' }).trim();
if (output('env', 'GOVERSION') !== 'go1.26.10') {
  throw new Error('The networking regression tests require Go 1.26.10. Set GO_BINARY or put it on PATH.');
}
const goroot = output('env', 'GOROOT');
const runner = [join(goroot, 'lib', 'wasm', 'wasm_exec_node.js'), join(goroot, 'misc', 'wasm', 'wasm_exec_node.js')]
  .find(existsSync);
if (!runner) throw new Error('Cannot find the Go WebAssembly Node.js runner.');

// Go parses -exec using its own quoted-word parser. This argument never goes
// through a shell. Double quotes preserve Windows paths and spaces.
const quoteGoArg = value => {
  if (value.includes('"')) throw new Error('The test executable path must not contain a double quote.');
  return `"${value}"`;
};
execFileSync(go, [
  'test', '-mod=readonly', '-count=1', '-timeout=90s',
  '-exec', `${quoteGoArg(process.execPath)} ${quoteGoArg(runner)}`,
  './internal/network'
], { cwd: source, env, stdio: 'inherit' });
