/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  handoffFileName,
  isAllowedHandoffOrigin,
  isHandoffModelMessage,
  parseHandoffOrigins,
  startModelHandoff,
} from './model-handoff.js';

const ALLOWED = parseHandoffOrigins('https://example.org, https://bridge.test/');

describe('model hand-off origin allowlist', () => {
  it('accepts configured origins and the default', () => {
    assert.strictEqual(isAllowedHandoffOrigin('https://bridge.geobim.app', ALLOWED), true);
    assert.strictEqual(isAllowedHandoffOrigin('https://example.org', ALLOWED), true);
    assert.strictEqual(isAllowedHandoffOrigin('https://bridge.test', ALLOWED), true);
  });
  it('accepts loopback development hosts on any port', () => {
    assert.strictEqual(isAllowedHandoffOrigin('http://localhost:5173', ALLOWED), true);
    assert.strictEqual(isAllowedHandoffOrigin('http://127.0.0.1:8080', ALLOWED), true);
    assert.strictEqual(isAllowedHandoffOrigin('http://[::1]:3000', ALLOWED), true);
  });
  it('rejects everything else', () => {
    for (const o of ['https://evil.example', 'https://bridge.geobim.app.evil.example', 'http://bridge.geobim.app', 'null', '', 'https://localhost.evil.example', 'file://', 'https://bridge.geobim.app/path']) {
      assert.strictEqual(isAllowedHandoffOrigin(o, ALLOWED), false, o);
    }
  });
});

describe('model hand-off message shape', () => {
  it('requires type, version, name and an ArrayBuffer', () => {
    assert.strictEqual(isHandoffModelMessage({ type: 'geobim:handoff-model', version: 1, name: 'a.ifc', buffer: new ArrayBuffer(4) }), true);
    assert.strictEqual(isHandoffModelMessage({ type: 'geobim:handoff-model', version: 1, name: 'a.ifc', buffer: 'x' }), false);
    assert.strictEqual(isHandoffModelMessage({ type: 'other', version: 1, name: 'a.ifc', buffer: new ArrayBuffer(4) }), false);
    assert.strictEqual(isHandoffModelMessage(null), false);
  });
  it('sanitises the file name', () => {
    assert.strictEqual(handoffFileName('C:\\x\\bruecke.ifc'), 'bruecke.ifc');
    assert.strictEqual(handoffFileName('../../bruecke'), 'bruecke.ifc');
    assert.strictEqual(handoffFileName(''), 'model.ifc');
  });
});

/** Minimal window double: location, history, opener and message listeners. */
function fakeWindow(search: string, opener: unknown) {
  const listeners: ((ev: MessageEvent) => void)[] = [];
  const posted: { msg: unknown; target: string }[] = [];
  const openerWin = opener ?? { postMessage: (msg: unknown, target: string) => posted.push({ msg, target }) };
  const location = { search, pathname: '/', hash: '' };
  const win = {
    location,
    opener: opener === null ? null : openerWin,
    history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => { location.search = url.includes('?') ? url.slice(url.indexOf('?')) : ''; } },
    addEventListener: (_t: string, fn: (ev: MessageEvent) => void) => listeners.push(fn),
    removeEventListener: (_t: string, fn: (ev: MessageEvent) => void) => listeners.splice(listeners.indexOf(fn), 1),
  };
  const dispatch = (data: unknown, origin: string, source: unknown = openerWin) =>
    [...listeners].forEach((fn) => fn({ data, origin, source } as MessageEvent));
  return { win: win as unknown as Window, posted, dispatch, listeners, location };
}

const model = () => ({ type: 'geobim:handoff-model', version: 1, name: 'b.ifc', buffer: new TextEncoder().encode('ISO-10303-21;').buffer });

describe('startModelHandoff', () => {
  it('does nothing without ?handoff=1 or without an opener', () => {
    assert.strictEqual(startModelHandoff({ win: fakeWindow('', undefined).win, allowedOrigins: ALLOWED, onModel: async () => {} }), null);
    assert.strictEqual(startModelHandoff({ win: fakeWindow('?handoff=1', null).win, allowedOrigins: ALLOWED, onModel: async () => {} }), null);
  });

  it('announces itself, loads one model from the opener and confirms', async () => {
    const f = fakeWindow('?handoff=1&x=2', undefined);
    const files: File[] = [];
    const stop = startModelHandoff({ win: f.win, allowedOrigins: ALLOWED, onModel: async (file) => void files.push(file) });
    assert.ok(stop);
    assert.deepStrictEqual(f.posted[0], { msg: { type: 'geobim:handoff-ready', version: 1 }, target: '*' });
    f.dispatch(model(), 'https://evil.example'); // wrong origin
    f.dispatch(model(), 'http://localhost:5173', {}); // wrong source window
    assert.strictEqual(files.length, 0);
    f.dispatch(model(), 'http://localhost:5173');
    f.dispatch(model(), 'http://localhost:5173'); // only once
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].name, 'b.ifc');
    assert.strictEqual(await files[0].text(), 'ISO-10303-21;');
    assert.deepStrictEqual(f.posted[1], { msg: { version: 1, type: 'geobim:handoff-done' }, target: 'http://localhost:5173' });
    assert.strictEqual(f.location.search, '?x=2');
    stop();
    assert.strictEqual(f.listeners.length, 0);
  });

  it('survives a StrictMode effect re-run', async () => {
    const f = fakeWindow('?handoff=1', undefined);
    const files: File[] = [];
    const opts = { win: f.win, allowedOrigins: ALLOWED, onModel: async (file: File) => void files.push(file) };
    startModelHandoff(opts)!();
    startModelHandoff(opts);
    f.dispatch(model(), 'https://bridge.geobim.app');
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(files.length, 1);
  });

  it('reports load errors to the opener', async () => {
    const f = fakeWindow('?handoff=1', undefined);
    const errors: string[] = [];
    startModelHandoff({ win: f.win, allowedOrigins: ALLOWED, onModel: async () => { throw new Error('parse failed'); }, onError: (m) => errors.push(m) });
    f.dispatch(model(), 'https://bridge.geobim.app');
    await new Promise((r) => setTimeout(r, 0));
    assert.deepStrictEqual(errors, ['parse failed']);
    assert.deepStrictEqual(f.posted[1].msg, { version: 1, type: 'geobim:handoff-error', message: 'parse failed' });
  });
});
