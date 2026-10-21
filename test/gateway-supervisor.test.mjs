import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createGatewaySupervisor } = require('../desktop/gateway-supervisor.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function fixture(options = {}) {
  let time = 0;
  let serial = 0;
  const timers = new Map();
  const resources = [];
  const states = [];
  const failures = [];
  const supervisor = createGatewaySupervisor({
    launch: options.launch || (async ({ signal }) => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      const resource = {
        child, info: { port: 8787, gatewayPid: resources.length + 1 },
        signal, disposed: 0,
        ready: options.ready || (() => Promise.resolve()),
        async dispose() { resource.disposed++; }
      };
      resources.push(resource);
      return resource;
    }),
    now: () => time,
    setTimer: (callback, delay) => { const id = ++serial; timers.set(id, { callback, delay }); return id; },
    clearTimer: id => timers.delete(id),
    onState: (state, details) => states.push({ state, ...details }),
    onFailure: error => failures.push(error)
  });
  return {
    supervisor, resources, states, failures, timers,
    advance(ms) { time += ms; },
    async tick() {
      assert.equal(timers.size, 1);
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      time += timer.delay;
      timer.callback();
      await flush();
    },
    async exit(index = resources.length - 1, code = 1) {
      const child = resources[index].child;
      child.exitCode = code;
      child.emit('exit', code, null);
      await flush();
    }
  };
}

test('concurrent starts are single-flight and reuse a running child', async () => {
  const f = fixture();
  const first = f.supervisor.start();
  assert.equal(f.supervisor.start(), first);
  const info = await first;
  assert.equal(info.port, 8787);
  assert.equal(f.resources.length, 1);
  assert.deepEqual(await f.supervisor.start(), info);
  assert.equal(f.resources.length, 1);
  assert.equal(f.supervisor.state, 'running');
  await f.supervisor.stop();
});

test('an unexpected exit invalidates running state and restarts only after backoff', async () => {
  const f = fixture();
  await f.supervisor.start();
  await f.exit();
  assert.equal(f.resources[0].disposed, 1);
  assert.equal(f.supervisor.state, 'recovering');
  assert.deepEqual(f.states.map(x => x.state), ['starting', 'running', 'offline', 'recovering']);
  assert.equal([...f.timers.values()][0].delay, 1000);
  await assert.rejects(f.supervisor.start(), /正在恢复/);
  await f.tick();
  assert.equal(f.resources.length, 2);
  assert.equal(f.supervisor.state, 'running');
  assert.equal(f.states.at(-1).recovered, true);
  assert.equal(f.states.at(-1).info.port, 8787);
  await f.supervisor.stop();
});

test('a repeated start cannot race asynchronous disposal of a crashed child', async () => {
  const gate = deferred();
  const f = fixture();
  await f.supervisor.start();
  f.resources[0].dispose = () => gate.promise;
  await f.exit();
  assert.equal(f.supervisor.state, 'offline');
  await assert.rejects(f.supervisor.start(), /正在恢复/);
  assert.equal(f.resources.length, 1);
  assert.equal(f.timers.size, 0);
  gate.resolve();
  await flush();
  assert.equal(f.timers.size, 1);
  await f.supervisor.stop();
});

test('a launch exception before a child exists is propagated without a fabricated healthy state', async () => {
  const f = fixture({ launch: async () => { throw new Error('fixture bridge unavailable'); } });
  await assert.rejects(f.supervisor.start(), /fixture bridge unavailable/);
  assert.equal(f.states.some(x => x.state === 'running'), false);
  assert.equal(f.timers.size, 0);
  await f.supervisor.stop();
});

test('three recovery starts per five minutes are bounded with exponential backoff', async () => {
  const f = fixture();
  await f.supervisor.start();
  for (const delay of [1000, 2000, 4000]) {
    await f.exit();
    assert.equal([...f.timers.values()][0].delay, delay);
    await f.tick();
  }
  await f.exit();
  assert.equal(f.resources.length, 4);
  assert.equal(f.timers.size, 0);
  assert.equal(f.supervisor.state, 'failed');
  assert.equal(f.failures.length, 1);
  await assert.rejects(f.supervisor.start(), /恢复上限/);
  await f.supervisor.stop();
});

test('the restart budget becomes available after a stable five-minute interval', async () => {
  const f = fixture();
  await f.supervisor.start();
  await f.exit();
  await f.tick();
  f.advance(300001);
  await f.exit();
  assert.equal(f.states.at(-1).attempt, 1);
  assert.equal([...f.timers.values()][0].delay, 1000);
  await f.supervisor.stop();
});

test('normal shutdown cancels scheduled recovery and prevents further starts', async () => {
  const f = fixture();
  await f.supervisor.start();
  await f.exit();
  await f.supervisor.stop();
  assert.equal(f.timers.size, 0);
  assert.equal(f.supervisor.state, 'stopped');
  await assert.rejects(f.supervisor.start(), /已停止/);
  assert.equal(f.resources.length, 1);
});

test('a stale child exit cannot invalidate its replacement', async () => {
  const f = fixture();
  await f.supervisor.start();
  await f.exit();
  await f.tick();
  f.resources[0].child.emit('exit', 1, null);
  await flush();
  assert.equal(f.supervisor.state, 'running');
  assert.equal(f.timers.size, 0);
  assert.equal(f.resources[0].child.listenerCount('exit'), 0);
  await f.supervisor.stop();
});

test('an exit while waiting for health rejects promptly and disposes the child', async () => {
  const gate = deferred();
  const f = fixture({ ready: () => gate.promise });
  const started = f.supervisor.start();
  await flush();
  const rejected = assert.rejects(started, /网关进程退出/);
  await f.exit();
  await rejected;
  gate.resolve();
  assert.equal(f.resources[0].disposed, 1);
  assert.equal(f.resources[0].signal.aborted, true);
  assert.equal(f.states.some(x => x.state === 'running'), false);
  assert.equal(f.timers.size, 0);
  await f.supervisor.stop();
});

test('spawn errors never publish running or masquerade as a successful health response', async () => {
  const f = fixture({ ready: () => new Promise(() => {}) });
  const started = f.supervisor.start();
  await flush();
  const rejected = assert.rejects(started, /fixture spawn failed/);
  f.resources[0].child.emit('error', new Error('fixture spawn failed'));
  await rejected;
  assert.equal(f.resources[0].disposed, 1);
  assert.equal(f.states.some(x => x.state === 'running'), false);
  await f.supervisor.stop();
});

test('synchronous readiness errors are cleaned without leaking an unhandled exit rejection', async () => {
  const f = fixture({ ready: () => { throw new Error('fixture synchronous readiness error'); } });
  await assert.rejects(f.supervisor.start(), /fixture synchronous readiness error/);
  assert.equal(f.resources[0].disposed, 1);
  assert.equal(f.resources[0].child.listenerCount('exit'), 0);
  await f.supervisor.stop();
});

test('failed restart launches count toward the same restart limit', async () => {
  // Inject failure through readiness to cover cleanup as well as the common budget.
  let count = 0;
  const g = fixture({ ready: () => ++count === 1 ? Promise.resolve() : Promise.reject(new Error('fixture health failed')) });
  await g.supervisor.start();
  await g.exit();
  await g.tick();
  await g.tick();
  await g.tick();
  assert.equal(g.supervisor.state, 'failed');
  assert.equal(g.resources.length, 4);
  assert.equal(g.resources.slice(1).every(x => x.disposed === 1), true);
  assert.match(g.failures[0].message, /fixture health failed/);
  await g.supervisor.stop();
});

test('failure to dispose a crashed child is terminal rather than spawning duplicates', async () => {
  const f = fixture();
  await f.supervisor.start();
  f.resources[0].dispose = async () => { throw new Error('fixture stop timeout'); };
  await f.exit();
  assert.equal(f.supervisor.state, 'failed');
  assert.equal(f.timers.size, 0);
  assert.match(f.failures[0].message, /网关清理失败.*fixture stop timeout/);
  await f.supervisor.stop();
});

test('shutdown during startup aborts health and disposes exactly once without recovery', async () => {
  const f = fixture({ ready: signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const started = f.supervisor.start();
  await flush();
  const rejected = assert.rejects(started, /退出/);
  await f.supervisor.stop();
  await rejected;
  assert.equal(f.resources[0].disposed, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.supervisor.state, 'stopped');
});

test('shutdown while launch is pending disposes the late child and never publishes healthy', async () => {
  const launched = deferred();
  let signal, disposed = 0;
  const f = fixture({ launch: async input => { signal = input.signal; return launched.promise; } });
  const started = f.supervisor.start();
  const rejected = assert.rejects(started, /退出/);
  const stopped = f.supervisor.stop();
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  launched.resolve({ child, info: { port: 8787 }, ready: async () => {}, dispose: async () => { disposed++; } });
  await stopped;
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(disposed, 1);
  assert.equal(f.states.some(x => x.state === 'running'), false);
  assert.equal(f.supervisor.state, 'stopped');
});

// Run the real main.cjs wiring with in-memory Electron/process/network doubles.
// No real app, process, account data, socket or filesystem write is involved.
function desktopFixture({ bridgeGate, wrongHealthId = false, delayedKill = false, launchArgs = [] } = {}) {
  const files = new Map();
  const children = [];
  const probes = [];
  const ports = [];
  const pages = [];
  const windows = [];
  const dialogs = [];
  const logs = [];
  const timers = new Map();
  let serial = 0, bridgeCreates = 0, bridgeCloses = 0, occupied = false;
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false, getVersion: () => '1.2.1', setPath() {},
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}),
    quit: () => app.emit('before-quit')
  });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      windows.push(options);
      this.webContents = { setWindowOpenHandler() {} };
    }
    loadURL(url) { pages.push(url); return Promise.resolve(); }
    isDestroyed() { return false; }
    setTitle() {}
  }
  const bridge = { url: 'http://127.0.0.1:49999', token: 'fixture-only-not-a-token', close: async () => { bridgeCloses++; } };
  const stubs = {
    electron: {
      app, BrowserWindow, Menu: { buildFromTemplate: x => x, setApplicationMenu() {} },
      Tray: class {}, shell: {}, nativeImage: {}, dialog: { showErrorBox: (...args) => dialogs.push(args) }
    },
    'node:fs': {
      existsSync: () => true, mkdirSync() {}, appendFileSync: (file, value) => logs.push(String(value)),
      writeFileSync: (file, value) => files.set(file, value), rmSync: file => files.delete(file)
    },
    'node:http': {
      createServer() {
        const server = new EventEmitter();
        let port;
        server.listen = (value, host) => {
          assert.equal(host, '127.0.0.1');
          port = value;
          ports.push(port);
          queueMicrotask(() => server.emit(occupied && port === 8787 ? 'error' : 'listening', new Error('fixture occupied')));
        };
        server.address = () => ({ port });
        server.close = callback => callback?.();
        return server;
      },
      get(options, callback) {
        const request = new EventEmitter();
        request.destroy = error => { if (error) queueMicrotask(() => request.emit('error', error)); };
        probes.push(options);
        queueMicrotask(() => {
          const response = new EventEmitter();
          response.statusCode = 200;
          callback(response);
          const id = wrongHealthId ? '0'.repeat(32) : children.at(-1)?.env.WB_DESKTOP_INSTANCE_ID;
          response.emit('data', Buffer.from(JSON.stringify({ ok: true, desktop_instance_id: id })));
          response.emit('end');
        });
        return request;
      }
    },
    'node:child_process': {
      spawn(python, args, options) {
        const child = new EventEmitter();
        child.pid = 1000 + children.length;
        child.exitCode = null;
        child.signalCode = null;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.env = options.env;
        child.args = args;
        child.killCalls = 0;
        child.kill = () => {
          child.killCalls++;
          if (delayedKill) {
            if (child.killed) return false;
            child.killed = true;
            setTimeout(() => {
              child.exitCode = 0;
              child.signalCode = 'SIGTERM';
              child.emit('exit', 0, 'SIGTERM');
            }, 10);
            return true;
          }
          if (child.exitCode === null) {
            child.exitCode = 0;
            child.signalCode = 'SIGTERM';
            child.emit('exit', 0, 'SIGTERM');
          }
          return true;
        };
        children.push(child);
        return child;
      }, spawnSync() { throw new Error('unexpected system Python probe'); }
    },
    '../package.json': { updateRepository: 'fixture/private', version: '1.2.1' },
    './updater.cjs': { createUpdater: () => ({ check() {} }) },
    './autostart.cjs': require('../desktop/autostart.cjs'),
    './trae-native.cjs': {
      createTraeBridge: async () => { bridgeCreates++; if (bridgeGate) await bridgeGate.promise; return bridge; }
    },
    './gateway-supervisor.cjs': {
      createGatewaySupervisor: options => createGatewaySupervisor({ ...options,
        setTimer: (callback, delay) => { const id = ++serial; timers.set(id, { callback, delay }); return id; },
        clearTimer: id => timers.delete(id)
      })
    }
  };
  const desktopPath = fileURLToPath(new URL('../desktop/main.cjs', import.meta.url));
  const context = {
    require: name => Object.hasOwn(stubs, name) ? stubs[name] : require(name),
    __dirname: path.dirname(desktopPath), module: { exports: {} },
    process: { env: { WBSIM_RUNTIME_DIR: 'D:/fixture-gateway' }, argv: ['fixture.exe', ...launchArgs], pid: 123, execPath: 'D:/fixture.exe', resourcesPath: 'D:/resources', platform: 'win32', on() {} },
    Buffer, AbortController, setTimeout, clearTimeout, console
  };
  vm.runInNewContext(readFileSync(desktopPath, 'utf8') + '\nmodule.exports = { bootGateway, createWindow, gatewaySupervisor, waitForHealthy };', context, { filename: desktopPath });
  return {
    ...context.module.exports, files, children, probes, ports, pages, windows, dialogs, timers, logs,
    get bridgeCreates() { return bridgeCreates; }, get bridgeCloses() { return bridgeCloses; },
    occupyPort() { occupied = true; },
    async crash() {
      const child = children.at(-1);
      child.exitCode = 4294967295;
      child.emit('exit', child.exitCode, null);
      await flush();
    },
    async tick() {
      assert.equal(timers.size, 1);
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.callback();
      await flush();
    },
    async quit() { app.quit(); await flush(); }
  };
}

test('desktop recovery preserves port, reuses TRAE bridge and republishes the new child PID', async () => {
  const f = desktopFixture();
  const initial = await f.bootGateway();
  await f.createWindow(initial.port);
  assert.equal(f.files.size, 1);
  await f.crash();
  assert.equal(f.files.size, 0, 'stale gateway.json must disappear immediately');
  assert.match(f.pages.at(-1), /^data:text\/html/);
  await f.tick();
  const info = JSON.parse([...f.files.values()][0]);
  assert.equal(info.port, initial.port);
  assert.notEqual(info.gatewayPid, initial.gatewayPid);
  assert.equal(f.bridgeCreates, 1);
  assert.equal(f.bridgeCloses, 0);
  assert.equal(f.children[0].env.WB_TRAE_BRIDGE_TOKEN, f.children[1].env.WB_TRAE_BRIDGE_TOKEN);
  assert.match(f.children[0].env.WB_DESKTOP_INSTANCE_ID, /^[a-f0-9]{32}$/);
  assert.notEqual(f.children[0].env.WB_DESKTOP_INSTANCE_ID, f.children[1].env.WB_DESKTOP_INSTANCE_ID);
  assert.equal(f.pages.at(-1), 'http://127.0.0.1:8787/');
  assert.equal(f.probes.every(probe => probe.port === 8787 && probe.host === '127.0.0.1'), true);
  assert.equal(f.children.every(child => child.args.includes('8787')), true);
  await f.quit();
  assert.equal(f.files.size, 0);
  assert.equal(f.bridgeCloses, 1);
  assert.equal(f.gatewaySupervisor.state, 'stopped');
  assert.equal(f.timers.size, 0);
});

test('desktop quit waits for an already-signalled child instead of killing it twice', async () => {
  const f = desktopFixture({ delayedKill: true });
  await f.bootGateway();
  await f.quit();
  await new Promise(resolve => setTimeout(resolve, 25));
  await flush();
  assert.equal(f.children[0].killCalls, 1);
  assert.equal(f.children[0].exitCode, 0);
  assert.equal(f.logs.some(line => line.includes('[gateway-stop-error]')), false);
  assert.equal(f.gatewaySupervisor.state, 'stopped');
});

test('desktop health rejects an unrelated HTTP 200 with the wrong launch identity', async () => {
  const f = desktopFixture({ wrongHealthId: true });
  const started = f.bootGateway();
  const rejected = assert.rejects(started, /退出/);
  await flush();
  assert.equal(f.probes.length, 1);
  assert.equal(f.files.size, 0);
  await f.quit();
  await rejected;
  assert.equal(f.children[0].exitCode, 0);
  assert.equal(f.gatewaySupervisor.state, 'stopped');
});

test('quitting while TRAE bridge creation is pending closes the late bridge without spawning Python', async () => {
  const gate = deferred();
  const f = desktopFixture({ bridgeGate: gate });
  const started = f.bootGateway();
  const rejected = assert.rejects(started, /退出/);
  await flush();
  assert.equal(f.bridgeCreates, 1);
  await f.quit();
  gate.resolve();
  await rejected;
  assert.equal(f.children.length, 0);
  assert.equal(f.bridgeCloses, 1);
  assert.equal(f.files.size, 0);
});

test('desktop never drifts to a different port when the original port becomes occupied', async () => {
  const f = desktopFixture();
  await f.bootGateway();
  await f.createWindow(8787);
  await f.crash();
  f.occupyPort();
  for (let n = 0; n < 3; n++) await f.tick();
  assert.equal(f.children.length, 1, 'do not spawn on the alternative port');
  assert.equal(f.files.size, 0);
  assert.equal(f.gatewaySupervisor.state, 'failed');
  assert.equal(f.dialogs.length, 1);
  assert.match(f.dialogs[0][1], /8787.*已被占用/);
  assert.match(decodeURIComponent(f.pages.at(-1)), /自动恢复已停止/);
  assert.equal(f.bridgeCreates, 1);
  await f.quit();
});

test('manual desktop launches show the panel while keeping sandbox and context isolation enabled', async () => {
  const f = desktopFixture();
  await f.createWindow(8787);
  const options = f.windows[0];
  assert.equal(options.show, true);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.match(options.webPreferences.preload, /desktop[\\/]preload\.cjs$/);
});

test('Windows autostart launches load the gateway panel without showing a window', async () => {
  const f = desktopFixture({ launchArgs: ['--autostart'] });
  await f.createWindow(8787);
  assert.equal(f.windows[0].show, false);
  assert.equal(f.pages[0], 'http://127.0.0.1:8787/');
});
