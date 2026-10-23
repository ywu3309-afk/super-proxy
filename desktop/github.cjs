const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createReadStream, createWriteStream, existsSync, lstatSync, statSync } = require('node:fs');
const { unlink } = require('node:fs/promises');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ASSET_HEADERS_TIMEOUT_MS = 30000;
const ASSET_IDLE_TIMEOUT_MS = 180000;
const DOWNLOAD_ATTEMPTS = Math.max(1, Math.min(5,
  Number(process.env.SUPER_PROXY_UPDATE_ATTEMPTS || 3) || 3));

function loadToken(repository, { required = false } = {}) {
  if (!REPOSITORY_RE.test(repository)) throw new Error('更新仓库配置无效');
  const supplied = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
  if (supplied) return supplied;
  try {
    const output = execFileSync('git', ['credential', 'fill'], {
      input: `protocol=https\nhost=github.com\npath=${repository}.git\nusername=${repository.split('/')[0]}\n\n`,
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      maxBuffer: 65536, stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
    });
    const line = output.split(/\r?\n/).find((value) => value.startsWith('password='));
    if (line && line.slice(9)) return line.slice(9);
  } catch { /* 凭据输出和错误不进入日志或渲染进程。 */ }
  if (!required) return '';
  throw new Error('发布操作需要 GitHub 写权限。请使用 Git Credential Manager 或 GH_TOKEN 授权；不要将 Token 写入软件。');
}

async function apiJSON(repository, suffix, token, options = {}) {
  if (!REPOSITORY_RE.test(repository) || (suffix !== '' && !suffix.startsWith('/'))) throw new Error('GitHub 请求配置无效');
  const headers = { 'User-Agent': 'SuperProxy-Desktop-Updater', Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com/repos/${repository}${suffix}`, {
    method: options.method || 'GET', redirect: 'error',
    headers: { ...headers, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30000)
  }).catch(() => { throw new Error('GitHub 网络请求失败，请检查网络后重试'); });
  if (!response.ok) throw new Error(`GitHub 请求失败（HTTP ${response.status}）。请检查仓库权限或授权是否有效。`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('GitHub 响应超过大小限制');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('GitHub 返回了无效的版本信息'); }
}

function directAssetUrl(repository, value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const target = new URL(text);
    const prefix = `/${repository}/releases/download/`;
    if (target.protocol !== 'https:' || target.hostname !== 'github.com' || target.port ||
        target.username || target.password || !target.pathname.startsWith(prefix)) return '';
    return target.href;
  } catch { return ''; }
}

async function assetResponse(repository, asset, token, { start = 0 } = {}) {
  if (!REPOSITORY_RE.test(repository) || !asset || !Number.isSafeInteger(asset.id) || asset.id < 1) {
    if (!directAssetUrl(repository, asset?.browser_download_url)) throw new Error('发布附件编号无效');
  }
  const urls = [];
  if (Number.isSafeInteger(asset.id) && asset.id > 0) {
    urls.push(`https://api.github.com/repos/${repository}/releases/assets/${asset.id}`);
  }
  const direct = directAssetUrl(repository, asset.browser_download_url);
  if (direct && !urls.includes(direct)) urls.push(direct);
  let lastError = null;
  for (const initial of urls) {
    let url = initial;
    for (let i = 0; i < 4; i++) {
      let target;
      try { target = new URL(url); }
      catch { lastError = new Error('GitHub 下载重定向地址无效'); break; }
      const api = target.origin === 'https://api.github.com';
      const signedAsset = target.protocol === 'https:' && !target.port &&
        target.hostname.endsWith('.githubusercontent.com');
      const browserAsset = target.protocol === 'https:' && target.hostname === 'github.com' &&
        target.pathname.startsWith(`/${repository}/releases/download/`);
      if (target.username || target.password || (!api && !signedAsset && !browserAsset)) {
        lastError = new Error('更新下载地址不属于 GitHub，已停止');
        break;
      }
      const headers = { 'User-Agent': 'SuperProxy-Desktop-Updater', Accept: 'application/octet-stream' };
      if (start > 0) headers.Range = `bytes=${start}-`;
      if (api && token) headers.Authorization = `Bearer ${token}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ASSET_HEADERS_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(url, { headers, redirect: 'manual', signal: controller.signal });
      } catch {
        lastError = Object.assign(new Error('下载更新附件失败，请检查网络后重试'), { retryable: true });
        clearTimeout(timer);
        break;
      }
      clearTimeout(timer);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = response.headers.get('location');
        controller.abort();
        await response.body?.cancel().catch(() => {});
        if (!next) { lastError = new Error('GitHub 下载重定向缺少地址'); break; }
        try { url = new URL(next, url).href; }
        catch { lastError = new Error('GitHub 下载重定向地址无效'); break; }
        continue;
      }
      if (!response.ok) {
        lastError = Object.assign(new Error(`更新附件下载失败（HTTP ${response.status}）`), {
          retryable: response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500
        });
        controller.abort();
        await response.body?.cancel().catch(() => {});
        break;
      }
      return { response, controller, resumed: start > 0 && response.status === 206 };
    }
  }
  throw lastError || new Error('更新附件下载失败，请检查网络后重试');
}

// 响应头有独立期限；正文只在连续三分钟没有非空数据时取消。
// 不对整个正文设置三分钟总时限，避免仍在正常传输的大附件被中止。
async function* assetChunks({ response, controller }, onProgress = null, received = 0, total = 0) {
  let timer;
  const watch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), ASSET_IDLE_TIMEOUT_MS);
  };
  watch();
  try {
    for await (const chunk of response.body) {
      controller.signal.throwIfAborted();
      if (chunk.length) watch();
      if (chunk.length && typeof onProgress === 'function') {
        received += chunk.length;
        try { onProgress({ received, total }); } catch { /* UI progress is best effort */ }
      }
      yield chunk;
    }
    controller.signal.throwIfAborted();
  } catch {
    throw Object.assign(new Error('下载更新附件中断或长时间无进度，请重试'), { retryable: true });
  }
  finally { clearTimeout(timer); controller.abort(); }
}

async function readManifest(repository, asset, token) {
  if (asset.size > 65536) throw new Error('更新清单过大');
  const response = await assetResponse(repository, asset, token);
  const chunks = [];
  let size = 0;
  for await (const chunk of assetChunks(response)) {
    size += chunk.length;
    if (size > 65536) throw new Error('更新清单超过大小限制');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('更新清单不是有效 JSON'); }
}

async function hashFile(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, digest: hash.digest('hex') };
}

async function downloadAttempt(repository, asset, token, destination, manifest, start, onProgress) {
  if (start > 0 && lstatSync(destination).isSymbolicLink()) throw new Error('更新暂存文件不能是符号链接');
  const response = await assetResponse(repository, asset, token, { start });
  const resumed = start > 0 && response.resumed;
  const offset = resumed ? start : 0;
  if (start > 0 && !resumed) {
    try { await unlink(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const previous = offset ? await hashFile(destination) : { size: 0, digest: '' };
  if (previous.size !== offset) throw new Error('更新暂存文件大小不一致');
  const hash = offset ? createHash('sha256') : createHash('sha256');
  if (offset) {
    for await (const chunk of createReadStream(destination)) hash.update(chunk);
  }
  let size = offset;
  const guard = new Transform({ transform(chunk, encoding, done) {
    size += chunk.length;
    if (size > manifest.size) return done(new Error('更新包超过清单声明的大小'));
    hash.update(chunk); done(null, chunk);
  } });
  const output = createWriteStream(destination, { flags: offset ? 'a' : 'w', mode: 0o600 });
  try {
    await pipeline(Readable.from(assetChunks(response, onProgress, offset, manifest.size)), guard, output);
    if (size !== manifest.size) throw new Error('更新包下载未完成');
    if (hash.digest('hex') !== manifest.sha256) throw new Error('更新包 SHA-256 或大小不匹配，未安装');
  } finally { response.controller.abort(); }
}

async function downloadAsset(repository, asset, token, destination, manifest, onProgress = null) {
  if (!manifest || !Number.isSafeInteger(manifest.size) || manifest.size < 1 ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256 || '')) throw new Error('更新清单无效');
  let owned = false;
  let lastError;
  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
    let start = 0;
    if (existsSync(destination)) {
      if (!owned) throw Object.assign(new Error('更新目标文件已存在'), { code: 'EEXIST' });
      const info = statSync(destination);
      if (info.size > manifest.size) {
        await unlink(destination).catch(() => {});
      } else {
        start = info.size;
      }
    }
    try {
      await downloadAttempt(repository, asset, token, destination, manifest, start, onProgress);
      return;
    } catch (error) {
      lastError = error;
      owned = existsSync(destination);
      if (!error?.retryable || error?.message?.includes('SHA-256') || error?.message?.includes('超过清单')) break;
      // 让失败的连接彻底释放后立即重连；不设置固定总时限，慢速但持续的下载可以完成。
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  if (owned) await unlink(destination).catch(() => {});
  throw lastError || new Error('下载更新附件失败，请检查网络后重试');
}

module.exports = { loadToken, apiJSON, readManifest, downloadAsset };
