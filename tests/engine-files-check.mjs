import assert from 'node:assert/strict';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { WebREngine } from '../js/webr-engine.js';

// Exercise the worker-side operation against a real temporary filesystem.
// Only webR's RPC and Emscripten's mode helpers are adapted for Node here.
const root = mkdtempSync(fileURLToPath(new URL('engine-files-fixture-', import.meta.url)));
const local = path => join(root, path);
const engine = new WebREngine();
engine.ready = true;
let fileReads = 0;
let workerCalls = 0;
let failedStat = '';
let failedDelete = '';
let ineffectiveDelete = '';
const fs = {
  lstat(path) {
    if (path === failedStat) throw new Error('Permission denied by the fixture filesystem');
    if (path === '/project/device') return { mode: 0o020600, size: 0, mtime: new Date(0) };
    return lstatSync(local(path));
  },
  readdir(path) {
    const names = readdirSync(local(path));
    return ['.', '..', ...names, ...(path === '/project' ? ['device'] : [])];
  },
  isDir: mode => (mode & 0o170000) === 0o040000,
  isFile: mode => (mode & 0o170000) === 0o100000,
  isLink: mode => (mode & 0o170000) === 0o120000,
  unlink(path) {
    if (path === failedDelete) throw new Error('Read-only fixture filesystem');
    if (path !== ineffectiveDelete) unlinkSync(local(path));
  }
};
const expressions = [];
engine.webR = {
  async evalRString(expression) {
    workerCalls += 1;
    const prefix = 'webr::eval_js(';
    assert.ok(expression.startsWith(prefix) && expression.endsWith(')'));
    const source = JSON.parse(expression.slice(prefix.length, -1));
    return vm.runInNewContext(source, { Module: { FS: fs } });
  },
  async evalRVoid(expression) { expressions.push(expression); },
  FS: {
    async readFile(path) {
      fileReads += 1;
      return readFileSync(local(path));
    }
  }
};

try {
  mkdirSync(local('/project/nested/empty'), { recursive: true });
  mkdirSync(local('/outside'), { recursive: true });
  writeFileSync(local('/project/.hidden'), 'hidden');
  writeFileSync(local('/project/nested/data.bin'), Buffer.from([0, 127, 128, 255]));
  writeFileSync(local('/outside/keep.txt'), 'keep this target');
  symlinkSync(local('/outside'), local('/project/linked-directory'));
  symlinkSync(local('/outside/keep.txt'), local('/project/linked-file'));
  symlinkSync(local('/project'), local('/project/nested/cycle'));
  const literalPath = '/project/ report \\β " data.csv ';
  writeFileSync(local(literalPath), 'id,value\n1,19\n');
  writeFileSync(local('/project/ report \\β " data.csv'), 'different file');
  const modifiedAt = 1_700_000_000_000;
  utimesSync(local('/project/nested/data.bin'), new Date(modifiedAt), new Date(modifiedAt));

  const listing = await engine.listProjectFiles();
  assert.equal(listing.path, '/project');
  assert.deepEqual(listing.entries.map(entry => entry.path).sort(), [
    '/project/.hidden', '/project/nested', '/project/nested/empty',
    '/project/nested/data.bin', literalPath, '/project/ report \\β " data.csv'
  ].sort(), 'listing includes hidden, nested and empty directories without following links or devices');
  assert.equal(fileReads, 0, 'listing must not read file contents');
  const binary = listing.entries.find(entry => entry.path === '/project/nested/data.bin');
  assert.deepEqual(binary, {
    name: 'data.bin', path: '/project/nested/data.bin', isDirectory: false,
    size: 4, modifiedAt
  });
  assert.equal(listing.entries.find(entry => entry.path === '/project/nested').size, 0);
  assert.deepEqual(await engine.statVirtualFile('/project/nested/../nested/data.bin'), binary);
  assert.equal(await engine.statVirtualFile('/project/missing/child.txt'), null);
  await assert.rejects(engine.statVirtualFile('/project/linked-directory/keep.txt'), /Symbolic links/);
  await assert.rejects(engine.statVirtualFile('/project/device'), /Not a regular file or directory/);

  assert.equal(new TextDecoder().decode(await engine.readVirtualFile(literalPath)), 'id,value\n1,19\n');
  assert.equal(await engine.deleteVirtualFile(literalPath), literalPath);
  assert.equal(existsSync(local(literalPath)), false);
  assert.equal(existsSync(local('/project/ report \\β " data.csv')), true,
    'trimming the selected path would delete a different file');
  assert.equal(await engine.deleteVirtualFile('/project/nested/../nested/data.bin'), '/project/nested/data.bin');
  assert.equal(await engine.statVirtualFile('/project/nested/data.bin'), null);
  await assert.rejects(engine.deleteVirtualFile('/project/nested/data.bin'), /File does not exist/);
  await assert.rejects(engine.deleteVirtualFile('/project/nested'), /Only individual regular files/);
  await assert.rejects(engine.deleteVirtualFile('/project'), /Only individual regular files/);
  await assert.rejects(engine.deleteVirtualFile('/project/linked-file'), /Symbolic links/);
  await assert.rejects(engine.deleteVirtualFile('/project/linked-directory/keep.txt'), /Symbolic links/);
  await assert.rejects(engine.deleteVirtualFile('/project/device'), /Only individual regular files/);
  assert.equal(readFileSync(local('/outside/keep.txt'), 'utf8'), 'keep this target');

  failedStat = '/project/.hidden';
  await assert.rejects(engine.statVirtualFile(failedStat), /Permission denied/);
  await assert.rejects(engine.listProjectFiles(), /Permission denied/);
  failedStat = '';
  failedDelete = '/project/.hidden';
  await assert.rejects(engine.deleteVirtualFile(failedDelete), /Read-only fixture filesystem/);
  assert.equal(existsSync(local(failedDelete)), true);
  failedDelete = '';
  ineffectiveDelete = '/project/.hidden';
  await assert.rejects(engine.deleteVirtualFile(ineffectiveDelete), /did not remove the file/);
  ineffectiveDelete = '';

  const callsBeforeBusy = workerCalls;
  engine.running = true;
  await assert.rejects(engine.listProjectFiles(), /while R is executing/);
  await assert.rejects(engine.statVirtualFile('/project/.hidden'), /while R is executing/);
  await assert.rejects(engine.deleteVirtualFile('/project/.hidden'), /while R is executing/);
  assert.equal(workerCalls, callsBeforeBusy);
  engine.running = false;
  for (const path of ['', null, undefined, '/project/invalid\0name']) {
    await assert.rejects(engine.deleteVirtualFile(path), /valid runtime file path/);
  }

  const originalEval = engine.webR.evalRString;
  engine.webR.evalRString = async expression => {
    const result = await originalEval(expression);
    engine.generation += 1;
    return result;
  };
  await assert.rejects(engine.listProjectFiles(), /runtime changed during the file operation/);
  engine.webR.evalRString = originalEval;

  await engine.loadDelimitedFile('/tmp/ actual\\data.csv ');
  assert.ok(expressions.at(-1).includes('"/tmp/ actual\\\\data.csv "'),
    'absolute runtime data paths preserve literal names and never gain a /project prefix');
  await engine.loadDelimitedFile('data\\sample.tsv', '\t');
  assert.ok(expressions.at(-1).includes('"/project/data/sample.tsv"'),
    'existing relative project paths retain their previous normalization');
  assert.ok(expressions.at(-1).includes('sep = "\\t"'));
  assert.equal(fileReads, 1, 'metadata and deletion never read file contents');
  console.log('Engine filesystem checks passed: metadata-only recursion, exact names, symlink/special-file guards, verified deletion, idle and generation checks.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
