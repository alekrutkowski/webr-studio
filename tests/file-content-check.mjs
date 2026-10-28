import assert from 'node:assert/strict';
import { decodeFileText, textEncodingFromBOM } from '../js/utils.js';

const encoder = new TextEncoder();
for (const value of ['', 'plain text\n', 'café 日本語 🧪\r\n', '\uFEFFfirst\r\nsecond\r\n', '\tcolumn\vbreak\fpage\r\n']) {
  const bytes = encoder.encode(value);
  const original = Uint8Array.from(bytes);
  assert.equal(decodeFileText(bytes), value);
  assert.equal(decodeFileText(value), value);
  assert.deepEqual(encoder.encode(decodeFileText(bytes)), original, 'Accepted text must round-trip every original byte, including BOM and CRLF.');
  assert.deepEqual(bytes, original, 'Classification must not alter input bytes.');
}

for (const bytes of [
  [0, 1, 2, 255], [65, 0, 66], [65, 1, 66], [0xc3, 0x28],
  [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xc0, 0xaf], [0xf4, 0x90, 0x80, 0x80]
]) {
  assert.equal(decodeFileText(Uint8Array.from(bytes)), null, 'Invalid UTF-8 and binary control bytes cannot become editor text.');
}
assert.equal(decodeFileText('NUL\0inside'), null);
assert.equal(decodeFileText({ content: 'not a byte view' }), null);

const framed = Uint8Array.from([0xff, 0xef, 0xbb, 0xbf, 0x41, 0xff]);
const view = framed.subarray(1, 5);
assert.equal(decodeFileText(view), '\uFEFFA');
assert.equal(decodeFileText(new DataView(framed.buffer, 1, 4)), '\uFEFFA');
assert.equal(decodeFileText(view.slice().buffer), '\uFEFFA');
assert.equal(textEncodingFromBOM(view), 'UTF-8');
assert.equal(textEncodingFromBOM('\uFEFFA'), 'UTF-8');
assert.equal(textEncodingFromBOM(encoder.encode('plain')), '');

for (const [bytes, encoding] of [
  [[0xff, 0xfe, 0x41, 0], 'UTF-16 LE'],
  [[0xfe, 0xff, 0, 0x41], 'UTF-16 BE'],
  [[0xff, 0xfe, 0, 0, 0x41, 0, 0, 0], 'UTF-32 LE'],
  [[0, 0, 0xfe, 0xff, 0, 0, 0, 0x41], 'UTF-32 BE']
]) {
  assert.equal(textEncodingFromBOM(Uint8Array.from(bytes)), encoding);
  assert.equal(decodeFileText(Uint8Array.from(bytes)), null, 'Recognized unsupported encodings must retain their original bytes.');
}

console.log('File content checks passed: strict UTF-8 detection, lossless BOM/CRLF and Unicode round trips, byte-view offsets, binary controls, invalid sequences, and unsupported BOM encodings.');
