import assert from 'node:assert/strict';
import { configureAceScriptLoader, loadAceModule } from '../js/editor.js';

function fixture({ nonce, pageNonce, appendError } = {}) {
  const scripts = [];
  const modules = new Map();
  const original = () => { throw new Error('The original no-cors loader must not be used.'); };
  const net = { loadScript: original };
  const document = {
    createElement(tag) {
      assert.equal(tag, 'script');
      const script = {
        removed: false,
        remove() { this.removed = true; },
        set src(value) {
          assert.equal(this.crossOrigin, 'anonymous', 'CORS must be set before the URL.');
          this.url = value;
        }
      };
      return script;
    },
    head: {
      appendChild(script) {
        assert.equal(script.crossOrigin, 'anonymous', 'CORS must be set before insertion.');
        assert.equal(typeof script.onload, 'function', 'Listeners must be ready before insertion.');
        assert.equal(typeof script.onerror, 'function');
        scripts.push(script);
        if (appendError) throw appendError;
      }
    },
    querySelector(selector) {
      assert.equal(selector, 'script[nonce]');
      return pageNonce ? { nonce: pageNonce } : null;
    }
  };
  const ace = {
    require(id) { return id === 'ace/lib/net' ? net : modules.get(id); },
    config: {
      get(key) {
        if (key === 'cspNonce' && nonce) return nonce;
        throw new Error(`Unknown config key: ${key}`);
      },
      loadModule(id, callback) {
        net.loadScript(`https://cdn.example.test/${id}.js`, () => callback(modules.get(id)));
      }
    }
  };
  return { ace, document, net, scripts, modules, original };
}

const normal = fixture({ nonce: 'configured-nonce', pageNonce: 'page-nonce' });
assert.equal(configureAceScriptLoader(normal.ace, { document: normal.document }), true);
const installed = normal.net.loadScript;
assert.notEqual(installed, normal.original);
assert.equal(configureAceScriptLoader(normal.ace, { document: normal.document }), true);
assert.equal(normal.net.loadScript, installed, 'Configuration must be idempotent.');
const loadCalls = [];
normal.net.loadScript('https://cdn.example.test/mode-r.js', error => loadCalls.push(error));
const loaded = normal.scripts[0];
assert.equal(loaded.nonce, 'configured-nonce');
assert.equal(loaded.async, true);
const lateError = loaded.onerror;
loaded.onload();
lateError();
assert.deepEqual(loadCalls, [undefined], 'A later error must not call the callback twice.');
assert.equal(loaded.removed, true);
assert.equal(loaded.onload, null);
assert.equal(loaded.onerror, null);

const failing = fixture({ pageNonce: 'page-nonce' });
configureAceScriptLoader(failing.ace, { document: failing.document });
const errorCalls = [];
failing.net.loadScript('https://cdn.example.test/missing.js', error => errorCalls.push(error));
const failed = failing.scripts[0];
assert.equal(failed.nonce, 'page-nonce', 'Existing page CSP nonces must be retained.');
const lateLoad = failed.onload;
failed.onerror();
lateLoad();
assert.equal(errorCalls.length, 1);
assert.match(errorCalls[0].message, /could not be loaded/);
assert.equal(failed.removed, true);

const stateChange = fixture();
configureAceScriptLoader(stateChange.ace, { document: stateChange.document });
let stateCalls = 0;
stateChange.net.loadScript('/mode-r.js', () => { stateCalls += 1; });
const legacyScript = stateChange.scripts[0];
legacyScript.readyState = 'loading';
legacyScript.onreadystatechange();
assert.equal(stateCalls, 0);
legacyScript.readyState = 'complete';
legacyScript.onreadystatechange();
assert.equal(stateCalls, 1);

const blocked = fixture({ appendError: new Error('Insertion blocked by policy') });
configureAceScriptLoader(blocked.ace, { document: blocked.document });
let insertionFailure;
blocked.net.loadScript('/mode-r.js', error => { insertionFailure = error; });
assert.match(insertionFailure.message, /Insertion blocked/);
assert.equal(blocked.scripts[0].removed, true);

const stalled = fixture();
configureAceScriptLoader(stalled.ace, { document: stalled.document, timeoutMs: 5 });
const scriptTimeout = await new Promise(resolve => stalled.net.loadScript('/stalled.js', resolve));
assert.match(scriptTimeout.message, /timed out/);
assert.equal(stalled.scripts[0].removed, true);

const moduleLoad = fixture();
configureAceScriptLoader(moduleLoad.ace, { document: moduleLoad.document });
const modulePromise = loadAceModule(moduleLoad.ace, 'ace/mode/r');
const rMode = { Mode: class RMode {} };
moduleLoad.modules.set('ace/mode/r', rMode);
moduleLoad.scripts[0].onload();
assert.equal(await modulePromise, rMode);
assert.equal(await loadAceModule(moduleLoad.ace, 'ace/mode/r'), rMode);
assert.equal(moduleLoad.scripts.length, 1, 'Loaded modules must not create another script.');

const missingModule = loadAceModule(moduleLoad.ace, 'ace/mode/missing');
moduleLoad.scripts[1].onerror();
await assert.rejects(missingModule, /could not be loaded/);

const fakeWithoutNet = {
  require() { return null; },
  config: { loadModule(id, callback) { callback(rMode); } }
};
assert.equal(configureAceScriptLoader(fakeWithoutNet, { document: moduleLoad.document }), false);
assert.equal(await loadAceModule(fakeWithoutNet, 'ace/mode/r'), rMode);
await assert.rejects(loadAceModule({ config: { loadModule() {} } }, 'ace/mode/stalled', { timeoutMs: 5 }), /timed out/);
await assert.rejects(loadAceModule({ config: { loadModule() { throw new Error('Loader failed'); } } }, 'ace/mode/broken'), /Loader failed/);

console.log('Ace loader checks passed: CORS-before-insertion, CSP nonces, idempotence, success/error settlement, script/module timeouts, and fallback-compatible module loading.');
