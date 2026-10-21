import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { createAutostart, installAutostartIPC, LOGIN_ITEM_NAME, LOGIN_ARGS, STATUS_CHANNEL, SET_CHANNEL } = require('../desktop/autostart.cjs');
const executablePath = 'E:\\朋友的软件\\Super Proxy\\WorkBuddy Gateway.exe';

function fixture({ platform = 'win32', packaged = true, registered = false, approved = true, ignoreWrites = false } = {}) {
  const reads = [], writes = [];
  const app = {
    isPackaged: packaged,
    getLoginItemSettings(options) {
      reads.push(options);
      return {
        // Electron's legacy field ignores custom startup entry names.
        openAtLogin: false, executableWillLaunchAtLogin: registered && approved,
        // Chromium's GetArgs strips --switches from launchItems.args.
        launchItems: registered ? [{ name: LOGIN_ITEM_NAME, scope: 'user', enabled: approved, args: [] }] : []
      };
    },
    setLoginItemSettings(options) {
      writes.push(options);
      if (!ignoreWrites) { registered = options.openAtLogin; approved = options.enabled; }
    }
  };
  return { app, reads, writes, autostart: createAutostart({ app, platform, executablePath }) };
}

test('Windows startup uses the current EXE path including spaces and Chinese, not a build-machine directory', () => {
  const f = fixture();
  assert.deepEqual(f.autostart.getStatus(), { supported: true, enabled: false, blocked: false, registered: false, executablePath });
  assert.equal(f.autostart.setEnabled(true).enabled, true);
  assert.deepEqual(f.writes[0], { path: executablePath, args: LOGIN_ARGS, name: 'SuperProxy', openAtLogin: true, enabled: true });
  assert.deepEqual(f.reads.at(-1), { path: `"${executablePath}"`, args: LOGIN_ARGS });
});

test('disabling removes the login entry and does not modify unrelated startup items', () => {
  const f = fixture({ registered: true });
  assert.equal(f.autostart.setEnabled(false).registered, false);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.writes[0], { path: executablePath, args: ['--autostart'], name: LOGIN_ITEM_NAME, openAtLogin: false, enabled: false });
});

test('Task Manager disabled entries are shown as blocked, and can be explicitly enabled again', () => {
  const f = fixture({ registered: true, approved: false });
  assert.equal(f.autostart.getStatus().enabled, false);
  assert.equal(f.autostart.getStatus().blocked, true);
  assert.equal(f.autostart.setEnabled(true).enabled, true);
});

test('reading status never creates or re-enables a Windows startup entry', () => {
  const f = fixture({ registered: true, approved: false });
  f.autostart.getStatus();
  f.autostart.getStatus();
  assert.equal(f.writes.length, 0);
});

test('unrelated startup names and machine-scope entries cannot be mistaken for this setting', () => {
  for (const entry of [
    { name: 'AnotherApp', scope: 'user', args: LOGIN_ARGS },
    { name: LOGIN_ITEM_NAME, scope: 'machine', args: LOGIN_ARGS }
  ]) {
    const f = fixture();
    f.app.getLoginItemSettings = () => ({ openAtLogin: true, executableWillLaunchAtLogin: true, launchItems: [{ ...entry, enabled: true }] });
    assert.equal(f.autostart.getStatus().enabled, false);
    assert.equal(f.autostart.getStatus().registered, false);
  }
});

test('source runs and unsupported platforms cannot register the Electron development executable', () => {
  for (const options of [{ packaged: false }, { platform: 'linux' }, { platform: 'darwin' }]) {
    const f = fixture(options);
    assert.equal(f.autostart.getStatus().supported, false);
    assert.throws(() => f.autostart.setEnabled(true), /桌面软件/);
    assert.equal(f.reads.length, 0);
    assert.equal(f.writes.length, 0);
  }
});

test('non-boolean settings are rejected before any operating-system write', () => {
  const f = fixture();
  for (const value of [1, 0, 'true', 'false', null, {}, undefined]) {
    assert.throws(() => f.autostart.setEnabled(value), TypeError);
  }
  assert.equal(f.writes.length, 0);
});

test('a failed native write is reported rather than displaying a successful checkbox', () => {
  const f = fixture({ ignoreWrites: true });
  assert.throws(() => f.autostart.setEnabled(true), /Windows 未保存/);
  assert.equal(f.autostart.getStatus().enabled, false);
});

function ipcFixture() {
  const f = fixture();
  const handlers = new Map();
  const contents = { mainFrame: { url: 'http://127.0.0.1:8787/?tab=settings' } };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  let changes = 0;
  installAutostartIPC({
    ipcMain: { handle: (key, callback) => handlers.set(key, callback) }, autostart: f.autostart,
    getWindow: () => ({ webContents: contents }), getOrigin: () => 'http://127.0.0.1:8787',
    onChange: () => { changes++; }
  });
  return { ...f, handlers, contents, event, get changes() { return changes; } };
}

test('only the trusted main-frame panel can read or change startup through IPC', () => {
  const f = ipcFixture();
  assert.equal(f.handlers.get(STATUS_CHANNEL)(f.event).enabled, false);
  assert.equal(f.handlers.get(SET_CHANNEL)(f.event, true).enabled, true);
  assert.equal(f.changes, 1);
  assert.equal(f.writes.length, 1);
});

test('external navigations, another port, nested frames, and other windows cannot access startup IPC', () => {
  const f = ipcFixture();
  for (const url of ['https://github.com/', 'http://127.0.0.1:8788/', 'http://127.0.0.1:8787/other', 'not-a-url']) {
    f.contents.mainFrame.url = url;
    assert.throws(() => f.handlers.get(STATUS_CHANNEL)(f.event), /本机网关/);
    assert.throws(() => f.handlers.get(SET_CHANNEL)(f.event, true), /本机网关/);
  }
  f.contents.mainFrame.url = 'http://127.0.0.1:8787/';
  assert.throws(() => f.handlers.get(SET_CHANNEL)({ ...f.event, sender: {} }, true), /桌面主窗口/);
  assert.throws(() => f.handlers.get(SET_CHANNEL)({ ...f.event, senderFrame: { url: f.contents.mainFrame.url } }, true), /桌面主窗口/);
  assert.equal(f.writes.length, 0);
});

test('sandbox preload exposes only two fixed methods, with no generic IPC or Node access', async () => {
  let exposed;
  const calls = [];
  const source = readFileSync(new URL('../desktop/preload.cjs', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    require: name => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, 'superProxyDesktop'); exposed = value; } },
        ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve({ enabled: false }); } }
      };
    }
  });
  assert.deepEqual(Object.keys(exposed).sort(), ['getAutostart', 'setAutostart']);
  await exposed.getAutostart();
  await exposed.setAutostart(true);
  await assert.rejects(exposed.setAutostart('true'), /布尔值/);
  assert.deepEqual(calls, [[STATUS_CHANNEL], [SET_CHANNEL, true]]);
});

function panelFixture(bridge) {
  const elements = Object.fromEntries(['desktopStartupToggle', 'desktopStartupStatus', 'desktopStartupPath'].map(id => [id, { checked: false, disabled: true, textContent: '', style: {} }]));
  const messages = [];
  const source = readFileSync(new URL('../hub/dashboard.html', import.meta.url), 'utf8');
  const start = source.indexOf('let DESKTOP_STARTUP_BUSY = false;');
  const end = source.indexOf('async function loadSettings(showToast)', start);
  assert.ok(start > 0 && end > start);
  const context = {
    window: { superProxyDesktop: bridge }, document: { getElementById: id => elements[id] },
    toast: (...args) => messages.push(args)
  };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.panel = {loadDesktopAutostart, saveDesktopAutostart};', context);
  return { ...context.panel, elements, messages };
}

test('ordinary browser settings clearly show that Windows startup requires the desktop app', async () => {
  const f = panelFixture();
  await f.loadDesktopAutostart();
  assert.equal(f.elements.desktopStartupToggle.disabled, true);
  assert.match(f.elements.desktopStartupStatus.textContent, /请在桌面软件/);
});

test('panel saves and re-reads native state, displaying the actual executable and outcome', async () => {
  let enabled = false;
  const status = () => ({ supported: true, enabled, executablePath });
  const f = panelFixture({ getAutostart: async () => status(), setAutostart: async value => { enabled = value; return status(); } });
  await f.loadDesktopAutostart();
  assert.equal(f.elements.desktopStartupToggle.disabled, false);
  f.elements.desktopStartupToggle.checked = true;
  await f.saveDesktopAutostart(f.elements.desktopStartupToggle);
  assert.equal(f.elements.desktopStartupToggle.checked, true);
  assert.equal(f.elements.desktopStartupToggle.disabled, false);
  assert.equal(f.elements.desktopStartupPath.textContent, executablePath);
  assert.match(f.elements.desktopStartupStatus.textContent, /已开启/);
});

test('save failure restores the old checkbox and leaves a visible inline error', async () => {
  const f = panelFixture({
    getAutostart: async () => ({ supported: true, enabled: false }),
    setAutostart: async () => { throw new Error('fixture denied'); }
  });
  f.elements.desktopStartupToggle.checked = true;
  await f.saveDesktopAutostart(f.elements.desktopStartupToggle);
  assert.equal(f.elements.desktopStartupToggle.checked, false);
  assert.equal(f.elements.desktopStartupToggle.disabled, false);
  assert.match(f.elements.desktopStartupStatus.textContent, /设置失败.*fixture denied/);
});

test('a stale status read cannot override a completed toggle', async () => {
  let resolveRead;
  const f = panelFixture({
    getAutostart: () => new Promise(resolve => { resolveRead = resolve; }),
    setAutostart: async () => ({ supported: true, enabled: true })
  });
  const read = f.loadDesktopAutostart();
  f.elements.desktopStartupToggle.checked = true;
  await f.saveDesktopAutostart(f.elements.desktopStartupToggle);
  resolveRead({ supported: true, enabled: false });
  await read;
  assert.equal(f.elements.desktopStartupToggle.checked, true);
});
