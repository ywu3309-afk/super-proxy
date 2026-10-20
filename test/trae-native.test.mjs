import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createTraeBridge, selectOfficialTraeRoot } = require('../desktop/trae-native.cjs');
const account = { uid: 'fixture-account' };

function request(bridge, { route = '/catalog', body = account, headers = {}, method = 'POST', raw } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw ?? JSON.stringify(body);
    const req = httpRequest(bridge.url + route, { method, headers: {
      Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json', ...headers
    } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('loopback server uses a random in-memory token and forwards only validated operations', async () => {
  const calls = [];
  const bridge = await createTraeBridge({ runOperation: async (input) => {
    calls.push(input);
    return { models: [{ id: 'fixture-model', uid: 'must-not-leak' }], uid: input.uid, accessToken: 'secret' };
  } });
  try {
    assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(bridge.token, /^[a-f0-9]{64}$/);
    const response = await request(bridge);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { models: [{ id: 'fixture-model' }] });
    assert.deepEqual(calls, [{ ...account, operation: 'catalog', maxChars: 16384, timeoutMs: 90000 }]);
    const chat = await request(bridge, { route: '/chat', body: { ...account, model: 'fixture-model', prompt: 'fixture', maxChars: 3, timeoutMs: 1000 } });
    assert.equal(chat.status, 200);
    assert.equal(calls[1].operation, 'chat');
  } finally { await bridge.close(); await bridge.close(); }
});

test('host, browser origin, fetch-site, and bearer checks fail before invoking TRAE', async () => {
  let calls = 0;
  const bridge = await createTraeBridge({ runOperation: async () => { calls++; return {}; } });
  try {
    for (const headers of [{ Host: 'localhost:9229' }, { Origin: 'http://127.0.0.1' },
      { Origin: 'null' }, { 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Site': 'none' }]) {
      const response = await request(bridge, { headers });
      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, 'FORBIDDEN');
    }
    assert.equal((await request(bridge, { headers: { Authorization: 'Bearer invalid' } })).status, 401);
    assert.equal(calls, 0);
  } finally { await bridge.close(); }
});

test('strict endpoint, size and JSON field validation rejects malformed requests', async () => {
  let calls = 0;
  const bridge = await createTraeBridge({ runOperation: async () => { calls++; return {}; } });
  try {
    for (const body of [null, [], {}, { uid: '' }, { ...account, uid: 'bad uid' },
      { ...account, extra: true }, { ...account, timeoutMs: 180001 }, { ...account, timeoutMs: 0 },
      { ...account, maxChars: 65537 }, { ...account, model: 'not-allowed-on-catalog' }]) {
      assert.equal((await request(bridge, { body })).status, 400);
    }
    assert.equal((await request(bridge, { raw: '{' })).status, 400);
    assert.equal((await request(bridge, { headers: { 'Content-Type': 'text/plain' } })).status, 400);
    assert.equal((await request(bridge, { route: '/chat', body: account })).status, 400);
    assert.equal((await request(bridge, { route: '/chat', body: { ...account, model: 'fixture', prompt: 'a\0b' } })).status, 400);
    assert.equal((await request(bridge, { method: 'GET' })).status, 404);
    assert.equal((await request(bridge, { route: '/catalog?x=1' })).status, 404);
    assert.equal((await request(bridge, { raw: 'x'.repeat(1024 * 1024 + 1) })).status, 413);
    assert.equal(calls, 0);
  } finally { await bridge.close(); }
});

test('only one operation runs at a time and errors never expose payloads or credentials', async () => {
  let release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const bridge = await createTraeBridge({ runOperation: async () => {
    started();
    await new Promise((resolve) => { release = resolve; });
    throw new Error('fixture-account secret-token https://private.invalid/?signature=secret');
  } });
  try {
    const first = request(bridge);
    await ready;
    const second = await request(bridge);
    assert.equal(second.status, 429);
    assert.equal(second.body.error.code, 'BUSY');
    release();
    const failure = await first;
    assert.equal(failure.status, 502);
    assert.equal(failure.body.error.code, 'NATIVE_FAILED');
    assert.doesNotMatch(JSON.stringify(failure.body), /fixture-account|secret-token|signature|private.invalid/);
  } finally { release?.(); await bridge.close(); }
});

test('renderer account mismatch is returned as a fixed safe error', async () => {
  const bridge = await createTraeBridge({ runOperation: async () => ({ error: {
    code: 'wrong_current_account', message: 'DO NOT RETURN THIS uid=fixture-account' } }) });
  try {
    const response = await request(bridge);
    assert.equal(response.status, 502);
    assert.equal(response.body.error.code, 'UID_MISMATCH');
    assert.doesNotMatch(JSON.stringify(response.body), /DO NOT|fixture-account/);
  } finally { await bridge.close(); }
});

test('duplicate bridge instances share the same process-wide operation lock', async () => {
  let release;
  let announce;
  const ready = new Promise((resolve) => { announce = resolve; });
  const first = await createTraeBridge({ runOperation: async () => {
    announce(); await new Promise((resolve) => { release = resolve; }); return { models: [] };
  } });
  const second = await createTraeBridge({ runOperation: async () => ({ models: [] }) });
  try {
    assert.notEqual(first.token, second.token);
    const pending = request(first);
    await ready;
    assert.equal((await request(second)).status, 429);
    release();
    assert.equal((await pending).status, 200);
    assert.equal((await request(second)).status, 200);
  } finally { release?.(); await first.close(); await second.close(); }
});

function nativeFixture({ existing = false, evaluateFail = false, wrongOwner = false, attached = false,
  rendererFail = false, missingModule = false, missingWindow = false } = {}) {
  let active = existing;
  let started = 0;
  let closed = 0;
  let socketsClosed = 0;
  let attachments = 0;
  let detachments = 0;
  const cdpCalls = [];
  const debuggerApi = new EventEmitter();
  debuggerApi.isAttached = () => attached;
  debuggerApi.attach = () => { attached = true; attachments++; };
  debuggerApi.detach = () => { attached = false; detachments++; };
  debuggerApi.sendCommand = async (command) => {
    assert.equal(command, 'Debugger.enable');
    if (!missingModule) debuggerApi.emit('message', {}, 'Debugger.scriptParsed', {
      url: 'vscode-file://vscode-app/d:/fixture/out/vs/workbench/workbench.desktop.main.solo-lite-slim.js'
    });
    return {};
  };
  const window = {
    getURL: () => 'vscode-file://vscode-app/d:/fixture/out/vs/workbench/solo-lite.html',
    debugger: debuggerApi,
    executeJavaScript: async (expression) => {
      if (rendererFail) throw Error('secret-token fixture-account');
      return vm.runInNewContext(expression, { URL, input: null });
    }
  };
  const electron = { webContents: { getAllWebContents: () => missingWindow ? [] : [window] } };
  const sandbox = {
    setTimeout, clearTimeout,
    process: { execPath: 'fixture.exe', getBuiltinModule: (name) => {
      assert.equal(name, 'module');
      return { createRequire: () => (module) => { assert.equal(module, 'electron'); return electron; } };
    } }
  };
  const options = {
    discover: async () => ({ pid: 321 }),
    owners: async () => wrongOwner ? [{ LocalAddress: '127.0.0.1', OwningProcess: 999 }] :
      active ? [{ LocalAddress: '127.0.0.1', OwningProcess: 321 }] : [],
    debugProcess: async (pid) => { assert.equal(pid, 321); active = true; started++; },
    sleep: async () => {},
    performTraeOperation: async function (input, moduleUrl) {
      return { models: [{ id: 'fixture', upstreamId: 'fixture' }], moduleUrl, uid: input.uid };
    },
    connectInspector: async () => ({
      call: async (method, params, timeoutMs) => {
        cdpCalls.push({ method, params, timeoutMs });
        assert.equal(method, 'Runtime.evaluate');
        if (params.expression.includes("getBuiltinModule('inspector').close()")) {
          active = false; closed++;
          return { result: { value: true } };
        }
        if (evaluateFail) throw Error('private-token signed-url');
        return { result: { value: await vm.runInNewContext(params.expression, sandbox) } };
      },
      close: () => { socketsClosed++; }
    })
  };
  return { options, window, sandbox, cdpCalls, stats: () => ({ active, started, closed, socketsClosed, attachments, detachments,
    listeners: debuggerApi.listenerCount('message') }) };
}

test('new inspector is PID-owned, injected operation runs, and all temporary resources close', async () => {
  const fixture = nativeFixture();
  const bridge = await createTraeBridge(fixture.options);
  try {
    const response = await request(bridge);
    assert.equal(response.status, 200);
    assert.equal(response.body.models[0].id, 'fixture');
    assert.equal(response.body.uid, undefined);
    assert.deepEqual(fixture.stats(), { active: false, started: 1, closed: 1,
      socketsClosed: 1, attachments: 1, detachments: 1, listeners: 0 });
  } finally { await bridge.close(); }
});

test('an existing TRAE inspector is reused but never disabled', async () => {
  const fixture = nativeFixture({ existing: true });
  const bridge = await createTraeBridge(fixture.options);
  try {
    assert.equal((await request(bridge)).status, 200);
    assert.deepEqual(fixture.stats(), { active: true, started: 0, closed: 0,
      socketsClosed: 1, attachments: 1, detachments: 1, listeners: 0 });
  } finally { await bridge.close(); }
});

test('a different PID on 9229 is rejected without opening, evaluating or closing it', async () => {
  const fixture = nativeFixture({ wrongOwner: true });
  const bridge = await createTraeBridge(fixture.options);
  try {
    const response = await request(bridge);
    assert.equal(response.body.error.code, 'INSPECTOR_BUSY');
    assert.deepEqual(fixture.stats(), { active: false, started: 0, closed: 0,
      socketsClosed: 0, attachments: 0, detachments: 0, listeners: 0 });
  } finally { await bridge.close(); }
});

test('evaluation and renderer failures still release the newly started inspector', async () => {
  for (const config of [{ evaluateFail: true }, { rendererFail: true }, { missingModule: true }, { missingWindow: true }]) {
    const fixture = nativeFixture(config);
    const bridge = await createTraeBridge(fixture.options);
    try {
      const response = await request(bridge);
      assert.equal(response.status, 502);
      assert.doesNotMatch(JSON.stringify(response.body), /secret-token|private-token|fixture-account|signed-url/);
      assert.equal(fixture.stats().closed, 1);
      assert.equal(fixture.stats().socketsClosed, 1);
      assert.equal(fixture.stats().listeners, 0);
      assert.equal(fixture.stats().attachments, fixture.stats().detachments);
    } finally { await bridge.close(); }
  }
});

test('an existing renderer debugger is not detached or modified', async () => {
  const fixture = nativeFixture({ attached: true });
  const bridge = await createTraeBridge(fixture.options);
  try {
    const response = await request(bridge);
    assert.equal(response.body.error.code, 'RENDERER_BUSY');
    assert.equal(fixture.stats().attachments, 0);
    assert.equal(fixture.stats().detachments, 0);
    assert.equal(fixture.stats().closed, 1);
  } finally { await bridge.close(); }
});

test('the default WebSocket transport uses only a verified loopback inspector target', async () => {
  const calls = [];
  let closed = 0;
  class FakeWebSocket extends EventTarget {
    constructor(url) {
      super();
      assert.equal(url, 'ws://127.0.0.1:9229/abcd-1234');
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(text) {
      const message = JSON.parse(text);
      calls.push(message);
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        id: message.id, result: { result: { value: { models: [{ id: 'fixture' }] } } }
      }) })));
    }
    close() { closed++; this.dispatchEvent(new Event('close')); }
  }
  const bridge = await createTraeBridge({
    discover: async () => ({ pid: 321 }),
    owners: async () => [{ LocalAddress: '127.0.0.1', OwningProcess: 321 }],
    fetch: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:9229/json/list');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers, undefined);
      return new Response(JSON.stringify([{ webSocketDebuggerUrl: 'ws://127.0.0.1:9229/abcd-1234' }]));
    }, WebSocket: FakeWebSocket,
    performTraeOperation: async function () { return { models: [] }; }
  });
  try {
    const response = await request(bridge);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'Runtime.evaluate');
    assert.equal(calls[0].params.returnByValue, true);
    assert.equal(calls[0].params.awaitPromise, true);
    assert.equal(closed, 1);
  } finally { await bridge.close(); }
});

test('unsafe inspector WebSocket targets are rejected before opening a socket', async () => {
  for (const webSocketDebuggerUrl of ['ws://evil.invalid:9229/abcd', 'ws://127.0.0.1:9230/abcd',
    'ws://user:secret@127.0.0.1:9229/abcd', 'wss://127.0.0.1:9229/abcd',
    'ws://127.0.0.1:9229/abcd?signature=secret']) {
    let sockets = 0;
    const bridge = await createTraeBridge({
      discover: async () => ({ pid: 321 }),
      owners: async () => [{ LocalAddress: '127.0.0.1', OwningProcess: 321 }],
      fetch: async () => new Response(JSON.stringify([{ webSocketDebuggerUrl }])),
      WebSocket: class { constructor() { sockets++; } }
    });
    try {
      const response = await request(bridge);
      assert.equal(response.status, 502);
      assert.equal(response.body.error.code, 'INSPECTOR_UNAVAILABLE');
      assert.doesNotMatch(JSON.stringify(response.body), /evil|secret|signature/);
      assert.equal(sockets, 0);
    } finally { await bridge.close(); }
  }
});

test('a newly opened inspector is cleaned through a fresh connection if the first connection fails', async () => {
  const fixture = nativeFixture();
  const connect = fixture.options.connectInspector;
  let connections = 0;
  fixture.options.connectInspector = async (...args) => {
    connections++;
    if (connections === 1) throw Error('secret-token signed-url');
    return connect(...args);
  };
  const bridge = await createTraeBridge(fixture.options);
  try {
    const response = await request(bridge);
    assert.equal(response.status, 502);
    assert.equal(connections, 2);
    assert.equal(fixture.stats().closed, 1);
    assert.equal(fixture.stats().socketsClosed, 1);
    assert.equal(fixture.stats().active, false);
    assert.doesNotMatch(JSON.stringify(response.body), /secret-token|signed-url/);
  } finally { await bridge.close(); }
});

test('wildcard or non-loopback 9229 listeners are never contacted or modified', async () => {
  for (const LocalAddress of ['0.0.0.0', '::', '192.0.2.1']) {
    let touched = false;
    const bridge = await createTraeBridge({
      discover: async () => ({ pid: 321 }),
      owners: async () => [{ LocalAddress, OwningProcess: 321 }],
      debugProcess: () => { touched = true; },
      connectInspector: () => { touched = true; throw Error('not expected'); }
    });
    try {
      assert.equal((await request(bridge)).body.error.code, 'INSPECTOR_BUSY');
      assert.equal(touched, false);
    } finally { await bridge.close(); }
  }
});

test('renderer fixed error codes retain semantics without forwarding native messages', async () => {
  const expected = {
    stop_failed: 'STOP_FAILED', output_limit: 'OUTPUT_LIMIT', event_limit: 'EVENT_LIMIT',
    tool_not_allowed: 'TOOL_NOT_ALLOWED', unsupported_tool: 'TOOL_NOT_ALLOWED',
    upstream_model_mismatch: 'UPSTREAM_MODEL_MISMATCH', model_mismatch: 'UPSTREAM_MODEL_MISMATCH',
    upstream_model_unconfirmed: 'UPSTREAM_MODEL_UNCONFIRMED',
    model_unavailable: 'MODEL_UNAVAILABLE', native_client_unavailable: 'NATIVE_CLIENT_UNAVAILABLE',
    image_not_supported: 'IMAGE_NOT_SUPPORTED', image_upload_failed: 'IMAGE_UPLOAD_FAILED',
    catalog_unavailable: 'CATALOG_UNAVAILABLE', incomplete_response: 'INCOMPLETE_RESPONSE',
    empty_response: 'EMPTY_RESPONSE', upstream_error: 'UPSTREAM_ERROR',
    native_request_failed: 'NATIVE_REQUEST_FAILED', invalid_native_response: 'INVALID_NATIVE_RESPONSE'
  };
  let nativeCode;
  const bridge = await createTraeBridge({ runOperation: async () => ({ error: {
    code: nativeCode, message: 'fixture-account secret-token https://private.invalid/?signature=secret'
  } }) });
  try {
    for (const [code, mapped] of Object.entries(expected)) {
      nativeCode = code;
      const response = await request(bridge);
      assert.equal(response.status, 502);
      assert.equal(response.body.error.code, mapped);
      assert.doesNotMatch(JSON.stringify(response.body), /fixture-account|secret-token|signature|private.invalid/);
    }
    nativeCode = 'unrecognized-private-error';
    assert.equal((await request(bridge)).body.error.code, 'NATIVE_FAILED');
  } finally { await bridge.close(); }
});

test('renderer stop acknowledgement gets fifteen-second grace and CDP keeps an extra margin', async () => {
  const fixture = nativeFixture();
  let clock = 0;
  let next = 0;
  const jobs = new Map();
  fixture.sandbox.setTimeout = (callback, delay) => {
    const id = ++next;
    jobs.set(id, { callback, at: clock + delay });
    return id;
  };
  fixture.sandbox.clearTimeout = (id) => { jobs.delete(id); };
  const tick = (ms) => {
    clock += ms;
    for (const [id, job] of [...jobs]) {
      if (job.at <= clock) { jobs.delete(id); job.callback(); }
    }
  };
  let rendererStarted;
  const ready = new Promise((resolve) => { rendererStarted = resolve; });
  fixture.window.executeJavaScript = () => {
    rendererStarted();
    // Internal request deadline is 1s; stop_chat then needs the full additional 10s.
    return new Promise((resolve) => fixture.sandbox.setTimeout(() => resolve({ error: {
      code: 'timeout', message: 'do not forward native details'
    } }), 11000));
  };
  const bridge = await createTraeBridge(fixture.options);
  try {
    let settled = false;
    const pending = request(bridge, { body: { ...account, timeoutMs: 1000 } }).then((result) => {
      settled = true; return result;
    });
    await ready;
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok([...jobs.values()].some((job) => job.at === 16000));
    assert.equal(fixture.cdpCalls[0].params.timeout, 26000);
    assert.equal(fixture.cdpCalls[0].timeoutMs, 26000);
    tick(2000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(fixture.stats().closed, 0);
    tick(9000);
    const response = await pending;
    assert.equal(response.status, 504);
    assert.equal(response.body.error.code, 'TIMEOUT');
    assert.equal(fixture.stats().closed, 1);
    assert.equal(fixture.stats().socketsClosed, 1);
    assert.equal(jobs.size, 0);
  } finally { await bridge.close(); }
});

const pngFixture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const chatFixture = { ...account, model: 'fixture', prompt: 'describe fixtures' };
function imageFixture(bytes = pngFixture, mediaType = 'image/png', width = 1, height = 1, id = 'image_1') {
  return { id, mediaType, data: bytes.toString('base64'), width, height };
}
function pngSized(length) {
  assert.ok(length >= pngFixture.length + 12);
  const chunk = Buffer.alloc(length - pngFixture.length);
  chunk.writeUInt32BE(chunk.length - 12, 0);
  chunk.write('tEXt', 4);
  return Buffer.concat([pngFixture.subarray(0, -12), chunk, pngFixture.subarray(-12)]);
}
function webpFixture(kind = 'VP8L', width = 1, height = 1) {
  const content = Buffer.alloc(kind === 'VP8L' ? 5 : 10);
  if (kind === 'VP8L') {
    content[0] = 47;
    content.writeUInt32LE(((height - 1) << 14) | (width - 1), 1);
  } else {
    content.set([157, 1, 42], 3);
    content.writeUInt16LE(width, 6); content.writeUInt16LE(height, 8);
  }
  const bytes = Buffer.alloc(20 + content.length + (content.length & 1));
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WEBP', 8);
  bytes.write(kind === 'VP8L' ? 'VP8L' : 'VP8 ', 12); bytes.writeUInt32LE(content.length, 16); content.copy(bytes, 20);
  return bytes;
}
function jpegFixture(width = 1, height = 1) {
  // SOI + one-component SOF0 + SOS + bounded fixture scan + EOI.
  const bytes = Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,218,0,8,1,1,0,0,63,0,0,255,217]);
  bytes.writeUInt16BE(height, 7); bytes.writeUInt16BE(width, 9);
  return bytes;
}

test('image bridge preserves exact validated PNG, JPEG and WebP image descriptors', async () => {
  const calls = [];
  const bridge = await createTraeBridge({ runOperation: async (input) => { calls.push(input); return { text: 'fixture' }; } });
  try {
    for (const image of [imageFixture(), imageFixture(jpegFixture(2, 3), 'image/jpeg', 2, 3),
      imageFixture(webpFixture('VP8L', 5, 7), 'image/webp', 5, 7), imageFixture(webpFixture('VP8 ', 9, 11), 'image/webp', 9, 11)]) {
      const response = await request(bridge, { route: '/chat', body: { ...chatFixture, images: [image] } });
      assert.equal(response.status, 200);
      assert.deepEqual(calls.at(-1).images, [image]);
    }
    const four = Array.from({ length: 4 }, (_, i) => imageFixture(pngFixture, 'image/png', 1, 1, `image_${i + 1}`));
    assert.equal((await request(bridge, { route: '/chat', body: { ...chatFixture, images: four } })).status, 200);
    await request(bridge, { route: '/chat', body: chatFixture });
    assert.equal(Object.hasOwn(calls.at(-1), 'images'), false);
  } finally { await bridge.close(); }
});

test('all malformed image descriptors fail before operation, discovery or inspector activity', async () => {
  let touched = 0;
  const bridge = await createTraeBridge({ runOperation: async () => { touched++; return {}; },
    discover: () => { touched++; }, owners: () => { touched++; }, fetch: () => { touched++; } });
  const valid = imageFixture();
  const badBase64 = [valid.data.slice(0, -1), valid.data + '\n', 'data:image/png;base64,' + valid.data,
    valid.data.replace(/.$/, '-'), 'Zh==', 'Zg=', 'Zg===', 'Zg==AAAA', ''];
  try {
    const invalid = [null, {}, [], [null], [valid, valid],
      Array.from({ length: 5 }, (_, i) => ({ ...valid, id: `image_${i + 1}` })),
      ...badBase64.map(data => [{ ...valid, data }]),
      ...[{ id: 'image_0' }, { mediaType: 'image/gif' }, { mediaType: 'image/jpeg' },
        { width: 2 }, { width: 0 }, { height: 16385 }, { width: 1.5 }, { height: '1' },
        { width: 10000, height: 4001 }, { url: 'https://private.invalid' }, { private: 'secret' }].map(change => [{ ...valid, ...change }]),
      [Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'data'))],
      [imageFixture(Buffer.from('not a PNG'))], [imageFixture(pngFixture.subarray(0, -1))],
      [imageFixture(jpegFixture().subarray(0, -2), 'image/jpeg')],
      [imageFixture(webpFixture().subarray(0, -1), 'image/webp')]];
    for (const images of invalid) {
      const response = await request(bridge, { route: '/chat', body: { ...chatFixture, images } });
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'BAD_REQUEST');
      assert.doesNotMatch(JSON.stringify(response.body), /private\.invalid|secret|base64/);
    }
    assert.equal((await request(bridge, { body: { ...account, images: [valid] } })).status, 400);
    assert.equal(touched, 0);
  } finally { await bridge.close(); }
});

test('image byte and body limits are independent, route-scoped and preserve response ceiling', async () => {
  let calls = 0;
  let oversizedResult = false;
  const bridge = await createTraeBridge({ runOperation: async () => {
    calls++; return oversizedResult ? { text: 'x'.repeat(1024 * 1024) } : { text: 'fixture' };
  } });
  const unit = 1024 * 1024;
  try {
    const exact = imageFixture(pngSized(4 * unit));
    assert.equal((await request(bridge, { route: '/chat', body: { ...chatFixture, images: [exact] } })).status, 200);
    assert.equal((await request(bridge, { route: '/chat', body: { ...chatFixture, images: [exact, { ...exact, id: 'image_2' }] } })).status, 200);
    for (const images of [[imageFixture(pngSized(4 * unit + 1))],
      Array.from({ length: 3 }, (_, i) => imageFixture(pngSized(3 * unit), 'image/png', 1, 1, `image_${i + 1}`))]) {
      assert.equal((await request(bridge, { route: '/chat', body: { ...chatFixture, images } })).status, 400);
    }
    assert.equal(calls, 2);
    assert.equal((await request(bridge, { route: '/catalog', raw: ' '.repeat(unit + 1) })).status, 413);
    assert.equal((await request(bridge, { route: '/chat', raw: 'x', headers: { 'Content-Length': String(16 * unit + 1) } })).status, 413);
    assert.equal((await request(bridge, { route: '/chat', raw: ' '.repeat(16 * unit + 1), headers: { 'Transfer-Encoding': 'chunked' } })).status, 413);
    assert.equal(calls, 2);
    oversizedResult = true;
    assert.equal((await request(bridge, { route: '/chat', body: chatFixture })).body.error.code, 'NATIVE_FAILED');
  } finally { await bridge.close(); }
});

test('declared image dimensions and WebP canvas are bounded and agree with actual headers', async () => {
  let calls = 0;
  const bridge = await createTraeBridge({ runOperation: async () => { calls++; return {}; } });
  try {
    for (const [width, height, accepted] of [[16384, 1, true], [8000, 5000, true], [8000, 5001, false], [16385, 1, false]]) {
      const bytes = Buffer.from(pngFixture);
      bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
      assert.equal((await request(bridge, { route: '/chat', body: {
        ...chatFixture, images: [imageFixture(bytes, 'image/png', width, height)]
      } })).status, accepted ? 200 : 400);
    }
    const simple = webpFixture('VP8L', 5, 7);
    const canvasChunk = Buffer.alloc(18);
    canvasChunk.write('VP8X', 0); canvasChunk.writeUInt32LE(10, 4);
    canvasChunk.writeUIntLE(4, 12, 3); canvasChunk.writeUIntLE(6, 15, 3);
    const extended = Buffer.concat([simple.subarray(0, 12), canvasChunk, simple.subarray(12)]);
    extended.writeUInt32LE(extended.length - 8, 4);
    assert.equal((await request(bridge, { route: '/chat', body: { ...chatFixture, images: [imageFixture(extended, 'image/webp', 5, 7)] } })).status, 200);
    extended.writeUIntLE(5, 24, 3);
    assert.equal((await request(bridge, { route: '/chat', body: { ...chatFixture, images: [imageFixture(extended, 'image/webp', 6, 7)] } })).status, 400);
    assert.equal(calls, 3);
  } finally { await bridge.close(); }
});

test('catalog keeps strict boolean supports_vision declarations only', async () => {
  let capability = true;
  const bridge = await createTraeBridge({ runOperation: async () => ({ models: [{ id: 'fixture', supports_vision: capability }] }) });
  try {
    for (const value of [true, false]) {
      capability = value;
      assert.equal((await request(bridge)).body.models[0].supports_vision, value);
    }
    for (const value of ['true', 1, {}, null]) {
      capability = value;
      const response = await request(bridge);
      assert.equal(response.status, 502);
      assert.equal(response.body.error.code, 'INVALID_NATIVE_RESPONSE');
    }
  } finally { await bridge.close(); }
});

test('official discovery selects the sole same-EXE root rather than untyped descendants', () => {
  const expected = 'C:\\fixture\\Programs\\Trae CN\\Trae CN.exe';
  const row = (ProcessId, ParentProcessId, HasType = false) => ({ ProcessId, ParentProcessId, HasType, ExecutablePath: expected });
  assert.deepEqual(selectOfficialTraeRoot([row(48356, 11332), row(10544, 48356, true), row(53784, 10544)], expected), { pid: 48356 });
  assert.deepEqual(selectOfficialTraeRoot([row(1, 100)], expected.toLowerCase()), { pid: 1 });
  for (const rows of [[], [row(1, 100), row(2, 200)], [row(1, 1)], [row(1, 2), row(2, 1)],
    [row(1, 100, true)], [row(1, 100), row(1, 100)], [{ ...row(1, 100), HasType: 'false' }],
    [{ ...row(1, 100), ParentProcessId: null }], [{ ...row(1, 100), ExecutablePath: expected + '.evil' }]]) {
    assert.throws(() => selectOfficialTraeRoot(rows, expected), error => error.code === 'TRAE_NOT_RUNNING');
  }
});
