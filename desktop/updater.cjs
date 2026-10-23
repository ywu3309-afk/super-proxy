const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const github = require('./github.cjs');

const ARCHIVE_ROOT = 'WorkBuddy Gateway-win32-x64';
const EXE = 'WorkBuddy Gateway.exe';
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function compareVersions(a, b) {
  if (!VERSION_RE.test(a) || !VERSION_RE.test(b)) throw new Error('版本号必须采用 X.Y.Z');
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

function selectRelease(releases) {
  if (!Array.isArray(releases)) throw new Error('发布列表格式无效');
  return releases.filter((release) => !release.draft && !release.prerelease &&
    /^v\d+\.\d+\.\d+$/.test(release.tag_name || '') && VERSION_RE.test(release.tag_name.slice(1)))
    .sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)))[0] || null;
}

function validateManifest(manifest, release, repository) {
  const version = release.tag_name.slice(1);
  const assetName = `super-proxy-v${version}-win32-x64.zip`;
  if (!manifest || manifest.schemaVersion !== 1 || manifest.repository !== repository ||
      manifest.version !== version || manifest.platform !== 'win32' || manifest.arch !== 'x64' ||
      manifest.root !== ARCHIVE_ROOT || manifest.executable !== EXE || manifest.asset !== assetName ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256 || '') ||
      !Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size > 1024 * 1024 * 1024) {
    throw new Error('更新清单与当前仓库、版本或平台不一致');
  }
  const asset = (release.assets || []).find((entry) => entry.name === assetName && entry.state === 'uploaded');
  if (!asset || asset.size !== manifest.size) throw new Error('发布附件缺失或大小与清单不一致');
  if (asset.digest && asset.digest !== `sha256:${manifest.sha256}`) throw new Error('GitHub 附件摘要与更新清单不一致');
  return asset;
}

function createUpdater({ app, dialog, repository, runtimeRoot, getGateway, beforeQuit, log = () => {} }) {
  let busy = false;
  const status = {
    state: 'idle',
    currentVersion: '',
    targetVersion: '',
    progress: 0,
    message: '',
    error: '',
    updatedAt: 0
  };
  function setStatus(patch) {
    Object.assign(status, patch, { updatedAt: Date.now() });
  }
  function getStatus() {
    return { ...status, busy };
  }
  async function check(window) {
    if (busy) return { ...status, busy: true };
    busy = true;
    setStatus({ state: 'checking', currentVersion: app.getVersion(), targetVersion: '', progress: 0,
      message: '正在连接 GitHub Release…', error: '' });
    try {
      const token = github.loadToken(repository);
      const release = selectRelease(await github.apiJSON(repository, '/releases?per_page=30', token));
      if (!release || compareVersions(release.tag_name.slice(1), app.getVersion()) <= 0) {
        setStatus({ state: 'latest', currentVersion: app.getVersion(), targetVersion: '', progress: 100,
          message: release ? '已经是最新稳定版本。' : '仓库还没有发布可安装的稳定版本。' });
        await dialog.showMessageBox(window, { type: 'info', title: '超级反代 · 桌面更新',
          message: `当前版本 v${app.getVersion()}`, detail: release ? '已经是最新稳定版本。' : '仓库还没有发布可安装的稳定版本。' });
        return getStatus();
      }
      if (!app.isPackaged || process.platform !== 'win32' || process.arch !== 'x64') {
        throw new Error('此更新包仅用于 Windows x64 便携桌面版；源码模式请通过 Git 更新。');
      }
      if (path.resolve(runtimeRoot) !== path.resolve(path.dirname(process.execPath))) {
        throw new Error('自定义运行目录与程序目录不同，请使用标准便携目录后再更新。');
      }
      if (process.env.WBSIM_DATA_DIR && path.resolve(process.env.WBSIM_DATA_DIR) !== path.join(path.resolve(runtimeRoot), 'data')) {
        throw new Error('自定义账号数据目录需要手动更新；本更新器不会迁移目录外的数据。');
      }
      const descriptor = (release.assets || []).find((asset) => asset.name === 'update-manifest.json' && asset.state === 'uploaded');
      if (!descriptor) throw new Error('此版本缺少桌面更新清单，未进行安装');
      const manifest = await github.readManifest(repository, descriptor, token);
      const asset = validateManifest(manifest, release, repository);
      setStatus({ state: 'available', currentVersion: app.getVersion(), targetVersion: manifest.version, progress: 100,
        message: `发现 v${manifest.version}，等待安装。`, error: '' });
      const choice = await dialog.showMessageBox(window, { type: 'question', title: '发现桌面更新',
        message: `v${app.getVersion()} → v${manifest.version}`,
        detail: '从 GitHub Release 下载并校验 SHA-256，然后重启软件。账号、密钥、设置和用量数据保留；上一版程序保留用于回滚。',
        buttons: ['下载并重启更新', '稍后'], defaultId: 1, cancelId: 1, noLink: true });
      if (choice.response !== 0) return;
      setStatus({ state: 'downloading', targetVersion: manifest.version, progress: 0,
        message: `正在下载 v${manifest.version}…` });
      const updateRoot = path.join(path.dirname(runtimeRoot), '.super-proxy-updates');
      fs.mkdirSync(updateRoot, { recursive: true });
      if (fs.lstatSync(updateRoot).isSymbolicLink()) throw new Error('更新暂存目录不能是符号链接');
      const jobDir = fs.mkdtempSync(path.join(updateRoot, `v${manifest.version}-`));
      const zipPath = path.join(jobDir, manifest.asset);
      log(`[desktop-update] downloading v${manifest.version}`);
      await github.downloadAsset(repository, asset, token, zipPath, manifest, ({ received, total }) => {
        const progress = total ? Math.min(99, Math.round(received / total * 100)) : 0;
        setStatus({ state: 'downloading', targetVersion: manifest.version, progress,
          message: `正在下载更新包… ${progress}%` });
      });
      setStatus({ state: 'verifying', targetVersion: manifest.version, progress: 99,
        message: '正在校验更新包…' });
      const sourcePython = path.join(process.resourcesPath, 'python');
      if (!fs.existsSync(path.join(sourcePython, 'python.exe'))) throw new Error('更新需要便携包内置的 Python 运行时');
      const helperPython = path.join(jobDir, 'python');
      fs.cpSync(sourcePython, helperPython, { recursive: true });
      const helperPath = path.join(jobDir, 'apply_update.py');
      fs.copyFileSync(path.join(__dirname, 'apply_update.py'), helperPath);
      const gateway = getGateway();
      const job = { schemaVersion: 1, installDir: runtimeRoot, jobDir, zipPath,
        sha256: manifest.sha256, version: manifest.version, repository, root: ARCHIVE_ROOT, executable: EXE,
        appPid: process.pid, gatewayPid: gateway?.child?.pid || 0 };
      const jobPath = path.join(jobDir, 'job.json');
      fs.writeFileSync(jobPath, JSON.stringify(job, null, 2), { mode: 0o600, flag: 'wx' });
      // 在退出当前软件之前，先用实际安装解析器核验 ZIP；校验失败时原窗口继续运行。
      await new Promise((resolve, reject) => execFile(path.join(helperPython, 'python.exe'), [helperPath, '--check', jobPath], {
        cwd: jobDir, timeout: 90000, windowsHide: true, maxBuffer: 4096,
        env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '' }
      }, (error) => error ? reject(new Error('更新包安装预检未通过，当前软件保持运行；请检查暂存目录和磁盘空间。')) : resolve()));
      setStatus({ state: 'restarting', targetVersion: manifest.version, progress: 100,
        message: '校验通过，正在重启安装…' });
      const child = spawn(path.join(helperPython, 'python.exe'), [helperPath, jobPath], {
        cwd: jobDir, detached: true, stdio: 'ignore', windowsHide: true,
        env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '' }
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      beforeQuit();
      app.quit();
      return getStatus();
    } catch (error) {
      // 仅输出自有安全错误，绝不输出请求头、凭据或带签名的附件 URL。
      const detail = String(error?.message || '请检查网络和仓库权限后重试。').replace(/[\r\n]+/g, ' ').slice(0, 240);
      log(`[desktop-update] update did not complete: ${detail}`);
      setStatus({ state: 'failed', progress: 0, error: detail,
        message: '更新未完成' });
      await dialog.showMessageBox(window, { type: 'error', title: '桌面更新未完成',
        message: '没有替换当前程序', detail });
      return getStatus();
    } finally { busy = false; }
  }
  function stop() {
    // A running download is cancelled by the process exit itself; this hook is
    // kept for callers that want a symmetric updater lifecycle.
    busy = false;
  }
  return { check, getStatus, stop };
}

module.exports = { ARCHIVE_ROOT, EXE, compareVersions, selectRelease, validateManifest, createUpdater };
