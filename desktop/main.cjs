const { app, BrowserWindow, Menu, Tray, shell, dialog, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const metadata = require('../package.json');
const { createUpdater } = require('./updater.cjs');
const { createTraeBridge } = require('./trae-native.cjs');
const { createGatewaySupervisor } = require('./gateway-supervisor.cjs');

const projectRoot = path.resolve(__dirname, '..');
const runtimeRoot = process.env.WBSIM_RUNTIME_DIR || (app.isPackaged ? path.dirname(process.execPath) : projectRoot);
// 打包后 hub/ 经 extraResource 物化到 resources/hub/（磁盘，Python 才能读写 dashboard.html 与数据目录）
const hubDir = app.isPackaged ? path.join(process.resourcesPath, 'hub') : path.join(projectRoot, 'hub');
const dataDir = process.env.WBSIM_DATA_DIR || path.join(runtimeRoot, 'data');
const accountsDir = path.join(dataDir, 'accounts');
const usageDir = path.join(dataDir, 'usage');
const portFile = path.join(dataDir, 'gateway.json');
const PREFERRED_PORT = Number(process.env.WBSIM_PORT || 8787);

let mainWindow = null;
let gateway = null; // { port, host, child }
let tray = null;
let quitting = false;
let traeBridge = null;
let gatewayPort = null;
let gatewayChild = null;
const desktopUpdater = createUpdater({
  app, dialog, repository: metadata.updateRepository, runtimeRoot,
  getGateway: () => gateway,
  beforeQuit: () => { quitting = true; },
  log: (message) => log(message)
});

function log(message) {
  try {
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.appendFileSync(path.join(runtimeRoot, 'desktop-startup.log'), `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    /* 日志失败不影响启动 */
  }
}

// —— 启动诊断：不依赖 electron，先把进程启动事实落盘，便于定位「无日志即退出」 ——
{
  try {
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.appendFileSync(path.join(runtimeRoot, 'desktop-startup.log'),
      `${new Date().toISOString()} [boot] pid=${process.pid} execPath=${process.execPath}\n`, 'utf8');
  } catch { /* 忽略 */ }
}

process.on('uncaughtException', (error) => log(`[uncaughtException] ${error?.stack || error}`));
process.on('unhandledRejection', (error) => log(`[unhandledRejection] ${error?.stack || error}`));

app.setPath('userData', path.join(runtimeRoot, 'electron-user-data'));

// ---------- Python 网关（workbuddy2api-hub）定位与启动 ----------

function findPython() {
  const candidates = [];
  // 1. 便携包自带运行时（extraResource 物化到 resources/python/，开发态在项目根 python/）
  candidates.push(path.join(process.resourcesPath, 'python', 'python.exe'));
  candidates.push(path.join(process.resourcesPath, 'python', 'pythonw.exe'));
  candidates.push(path.join(runtimeRoot, 'python', 'python.exe'));
  candidates.push(path.join(runtimeRoot, 'python', 'pythonw.exe'));
  candidates.push(path.join(projectRoot, 'python', 'python.exe'));
  candidates.push(path.join(runtimeRoot, '.venv', 'Scripts', 'python.exe'));
  // 2. Codex 自带运行时
  const codexRoot = path.join(process.env.USERPROFILE || process.env.HOME || '', '.cache', 'codex-runtimes');
  if (fs.existsSync(codexRoot)) {
    try {
      for (const dir of fs.readdirSync(codexRoot)) {
        const exe = path.join(codexRoot, dir, 'python.exe');
        if (fs.existsSync(exe)) candidates.push(exe);
      }
    } catch { /* 忽略 */ }
  }
  // 3. 系统 PATH 上的 python / py
  candidates.push('python', 'py', 'python3');
  for (const candidate of candidates) {
    const isPath = candidate.includes('\\') || candidate.includes('/');
    if (isPath) {
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    try {
      const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true });
      if (result.status === 0) return candidate;
    } catch { /* 忽略 */ }
  }
  return null;
}

function findFreePort(startPort) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > startPort + 40) return reject(new Error('无可用端口'));
      const server = http.createServer();
      server.once('error', () => { server.close(); tryPort(port + 1); });
      server.once('listening', () => {
        const actualPort = server.address().port;
        server.close(() => resolve(actualPort));
      });
      server.listen(port, '127.0.0.1');
    };
    tryPort(startPort);
  });
}

function waitForHealthy(port, instanceId, signal, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let timer;
    let request;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      request?.destroy();
      error ? reject(error) : resolve();
    };
    const aborted = () => finish(signal.reason || new Error('网关启动已取消'));
    signal.addEventListener('abort', aborted, { once: true });
    const retry = () => {
      if (settled) return;
      clearTimeout(timer);
      if (Date.now() - started > timeoutMs) return finish(new Error('网关健康检查超时'));
      timer = setTimeout(attempt, 400);
    };
    const attempt = () => {
      if (signal.aborted) return aborted();
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
        let size = 0;
        const chunks = [];
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 262144) req.destroy(new Error('健康检查响应过大'));
          else chunks.push(chunk);
        });
        res.once('error', retry);
        res.once('aborted', retry);
        res.once('end', () => {
          if (settled) return;
          try {
            const health = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (res.statusCode === 200 && health.ok === true && health.desktop_instance_id === instanceId) return finish();
          } catch { /* A different service or invalid JSON is not our healthy child. */ }
          retry();
        });
      });
      request = req;
      req.once('error', retry);
      req.once('timeout', () => req.destroy(new Error('健康检查请求超时')));
    };
    attempt();
  });
}

function stopGatewayChild(child) {
  if (!child.pid || child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', exited);
      reject(new Error('网关子进程未在停止期限内退出，已停止自动重启'));
    }, 5000);
    const exited = () => { clearTimeout(timer); resolve(); };
    child.once('exit', exited);
    try {
      if (!child.killed && !child.kill()) {
        clearTimeout(timer);
        child.removeListener('exit', exited);
        reject(new Error('无法停止网关子进程，已停止自动重启'));
      }
    } catch (error) {
      clearTimeout(timer);
      child.removeListener('exit', exited);
      reject(error);
    }
  });
}

async function launchGateway({ signal }) {
  const python = findPython();
  if (!python) {
    throw new Error('未找到 Python 3.9+。请安装 Python 并勾选 "Add to PATH"，或使用自带运行时的便携包。');
  }
  const script = path.join(hubDir, 'wb_proxy.py');
  if (!fs.existsSync(script)) throw new Error(`网关脚本缺失：${script}`);

  fs.mkdirSync(accountsDir, { recursive: true });
  fs.mkdirSync(usageDir, { recursive: true });

  // Only the first launch may choose a free port. Recovery must keep client URLs valid.
  if (gatewayPort === null) gatewayPort = await findFreePort(PREFERRED_PORT);
  else if (await findFreePort(gatewayPort) !== gatewayPort) throw new Error(`原网关端口 ${gatewayPort} 已被占用，恢复不会改用其他端口`);
  const port = gatewayPort;
  if (signal.aborted) throw signal.reason;
  // This bearer is per-launch and memory-only; never put it in gateway.json/logs.
  // Reuse the desktop-owned bridge across Python restarts; do not leak a new server.
  traeBridge ||= await createTraeBridge();
  if (signal.aborted) {
    const bridge = traeBridge;
    traeBridge = null;
    await bridge.close();
    throw signal.reason;
  }
  const instanceId = randomBytes(16).toString('hex');
  const child = spawn(python, [script, '--port', String(port), '--host', '127.0.0.1'], {
    cwd: hubDir,
    env: {
      ...process.env,
      ACCOUNTS_DIR: accountsDir,
      WB_PROXY_USAGE_DIR: usageDir,
      WB_DESKTOP_VERSION: app.getVersion(),
      WB_DESKTOP_INSTANCE_ID: instanceId,
      WB_UPDATE_REPO: metadata.updateRepository,
      WB_TRAE_BRIDGE_URL: traeBridge.url,
      WB_TRAE_BRIDGE_TOKEN: traeBridge.token,
      // 本地单机面板免密直进；要密码保护就去掉这一行（回到默认 admin）
      WB_PANEL_NO_PASSWORD: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  gatewayChild = child;
  child.stdout.on('data', (chunk) => log(`[py] ${String(chunk).trim()}`));
  child.stderr.on('data', (chunk) => log(`[py-err] ${String(chunk).trim()}`));
  child.on('error', (error) => log(`[py-spawn-error] ${error?.message}`));
  child.on('exit', (code, exitSignal) => {
    if (!quitting) log(`[py-exit] code=${code} signal=${exitSignal}`);
  });
  const info = {
    port,
    host: '127.0.0.1',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    dashboard: `http://127.0.0.1:${port}/`,
    python,
    pid: process.pid,
    gatewayPid: child.pid,
    startedAt: new Date().toISOString(),
    version: app.getVersion()
  };
  return {
    child, info,
    ready: (abortSignal) => waitForHealthy(port, instanceId, abortSignal),
    async dispose() {
      await stopGatewayChild(child);
      if (gatewayChild === child) gatewayChild = null;
    }
  };
}

function gatewayStatusPage(state, details) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const failed = state === 'failed';
  const title = failed ? '网关自动恢复已停止' : '网关连接中断，正在恢复';
  const message = failed
    ? '为避免连续故障或重复进程，自动恢复已停止（每 5 分钟最多重启 3 次）。请查看 desktop-startup.log，排除原因后完整退出并重新启动软件。'
    : `正在使用原端口恢复本地服务${details.attempt ? `（第 ${details.attempt}/3 次，${details.delayMs / 1000} 秒后重试）` : '…'}。账号与设置不会更改。`;
  const html = `<!doctype html><meta charset="utf-8"><title>超级反代</title><body style="margin:0;background:#0f1115;color:#e6edf3;font:16px system-ui;display:grid;place-content:center;height:100vh"><main style="max-width:680px;padding:40px"><h1 style="color:#71b7ff">${title}</h1><p>${message}</p><p>日志位置：${path.join(runtimeRoot, 'desktop-startup.log').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</p></main>`;
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(error => log(`[gateway-status-ui-error] ${error?.message || error}`));
}

const gatewaySupervisor = createGatewaySupervisor({
  launch: launchGateway,
  onState(state, details) {
    log(`[gateway-supervisor] state=${state}${details.attempt ? ` attempt=${details.attempt}/3 delayMs=${details.delayMs}` : ''}${details.error ? ` error=${details.error.message}` : ''}`);
    if (state === 'running') {
      const { info, resource, recovered } = details;
      gateway = { port: info.port, host: info.host, child: resource.child };
      try { fs.writeFileSync(portFile, JSON.stringify(info, null, 2), 'utf8'); }
      catch (error) { log(`[port-file-error] ${error?.message || error}`); }
      log(`[gateway-started] ${info.dashboard} (python=${info.python})`);
      if (recovered && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(info.dashboard).catch(error => log(`[gateway-reload-error] ${error?.message || error}`));
      }
      if (tray) tray.setToolTip(`超级反代 v${app.getVersion()} — 网关正常`);
    } else if (['offline', 'recovering', 'restarting', 'failed', 'stopped'].includes(state)) {
      gateway = null;
      try { fs.rmSync(portFile, { force: true }); }
      catch (error) { log(`[port-file-error] ${error?.message || error}`); }
      if (!quitting && state !== 'stopped') {
        gatewayStatusPage(state, details);
        if (tray) tray.setToolTip(`超级反代 v${app.getVersion()} — ${state === 'failed' ? '网关已停止' : '网关恢复中'}`);
      }
    }
  },
  onFailure(error) {
    log(`[gateway-recovery-failed] ${error?.stack || error}`);
    if (!quitting) dialog.showErrorBox('网关恢复失败', `本地网关自动恢复已停止：${error.message}\n\n请完整退出并重新打开软件。日志：${path.join(runtimeRoot, 'desktop-startup.log')}`);
  }
});

function bootGateway() { return gatewaySupervisor.start(); }

function createTray(port) {
  const candidates = [
    path.join(projectRoot, 'assets', 'icon.png'),
    path.join(projectRoot, 'assets', 'icon.ico'),
    path.join(__dirname, 'icon.png')
  ];
  const iconPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!iconPath) return;
  try {
    tray = new Tray(nativeImage.createFromPath(iconPath));
    tray.setToolTip(`超级反代 v${app.getVersion()}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `网关端口 ${port}`, enabled: false },
      { label: `桌面版本 v${app.getVersion()}`, enabled: false },
      { type: 'separator' },
      { label: '打开控制面板', click: () => showWindow() },
      { label: '用浏览器打开', click: () => shell.openExternal(`http://127.0.0.1:${port}/`) },
      { label: '打开数据目录', click: () => shell.openPath(dataDir) },
      { label: '检查桌面更新…', click: () => desktopUpdater.check(mainWindow) },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('double-click', () => showWindow());
  } catch (error) {
    log(`[tray-error] ${error?.message || error}`);
  }
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1080,
    minHeight: 720,
    title: `超级反代 v${app.getVersion()} — WorkBuddy Gateway`,
    backgroundColor: '#0f1115',
    autoHideMenuBar: false,
    icon: path.join(projectRoot, 'assets', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow.setTitle(`超级反代 v${app.getVersion()} — WorkBuddy Gateway`);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
    log('[window-hidden] 已最小化到托盘，网关继续运行');
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log('[single-instance] lock busy, quit');
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    try {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: '软件', submenu: [
          { label: `超级反代 v${app.getVersion()}`, enabled: false },
          { label: '检查桌面更新…', click: () => desktopUpdater.check(mainWindow) },
          { type: 'separator' },
          { label: '退出', click: () => { quitting = true; app.quit(); } }
        ] },
        { label: '视图', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] }
      ]));
      const info = await bootGateway();
      await createWindow(info.port);
      createTray(info.port);
    } catch (error) {
      log(`[startup-error] ${error?.stack || error}`);
      dialog.showErrorBox('启动失败', `本地网关没能启动：${error?.message || error}\n\n详见 ${path.join(runtimeRoot, 'desktop-startup.log')}`);
      app.quit();
    }
  }).catch((error) => {
    log(`[when-ready-error] ${error?.stack || error}`);
    app.quit();
  });
}

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  if (!tray) app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow(gateway?.port || PREFERRED_PORT);
  else showWindow();
});

app.on('before-quit', async () => {
  quitting = true;
  gatewaySupervisor.stop().catch(error => log(`[gateway-stop-error] ${error?.message || error}`));
  if (traeBridge) { traeBridge.close().catch(error => log(`[trae-bridge-close-error] ${error?.message || error}`)); traeBridge = null; }
  try {
    fs.rmSync(portFile, { force: true });
  } catch { /* 忽略 */ }
  if (gatewayChild) {
    try { gatewayChild.kill(); } catch (error) { log(`[gateway-kill-error] ${error?.message || error}`); }
  }
});
