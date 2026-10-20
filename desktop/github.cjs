const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { unlink } = require('node:fs/promises');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ASSET_HEADERS_TIMEOUT_MS = 30000;
const ASSET_IDLE_TIMEOUT_MS = 180000;

function loadToken(repository) {
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
  throw new Error('私人仓库需要本机 GitHub 授权。请先使用 Git Credential Manager 登录 GitHub，再检查更新。不要将 Token 写入软件。');
}

async function apiJSON(repository, suffix, token, options = {}) {
  if (!REPOSITORY_RE.test(repository) || (suffix !== '' && !suffix.startsWith('/'))) throw new Error('GitHub 请求配置无效');
  const response = await fetch(`https://api.github.com/repos/${repository}${suffix}`, {
    method: options.method || 'GET', redirect: 'error',
    headers: { 'User-Agent': 'SuperProxy-Desktop-Updater', Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
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

async function assetResponse(repository, assetId, token) {
  if (!REPOSITORY_RE.test(repository) || !Number.isSafeInteger(assetId) || assetId < 1) throw new Error('发布附件编号无效');
  let url = `https://api.github.com/repos/${repository}/releases/assets/${assetId}`;
  for (let i = 0; i < 4; i++) {
    let target;
    try { target = new URL(url); }
    catch { throw new Error('GitHub 下载重定向地址无效'); }
    const api = target.origin === 'https://api.github.com';
    if (target.username || target.password || (!api && !(target.protocol === 'https:' && !target.port && target.hostname.endsWith('.githubusercontent.com')))) {
      throw new Error('更新下载地址不属于 GitHub，已停止');
    }
    const headers = { 'User-Agent': 'SuperProxy-Desktop-Updater', Accept: 'application/octet-stream' };
    if (api) headers.Authorization = `Bearer ${token}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ASSET_HEADERS_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, { headers, redirect: 'manual', signal: controller.signal });
    } catch { throw new Error('下载更新附件失败，请检查网络后重试'); }
    finally { clearTimeout(timer); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = response.headers.get('location');
      controller.abort();
      await response.body?.cancel().catch(() => {});
      if (!next) throw new Error('GitHub 下载重定向缺少地址');
      try { url = new URL(next, url).href; }
      catch { throw new Error('GitHub 下载重定向地址无效'); }
      continue;
    }
    if (!response.ok) {
      controller.abort();
      await response.body?.cancel().catch(() => {});
      throw new Error(`更新附件下载失败（HTTP ${response.status}）`);
    }
    return { response, controller };
  }
  throw new Error('更新附件的重定向次数过多');
}

// 响应头有独立期限；正文只在连续三分钟没有非空数据时取消。
// 不对整个正文设置三分钟总时限，避免仍在正常传输的大附件被中止。
async function* assetChunks({ response, controller }) {
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
      yield chunk;
    }
    controller.signal.throwIfAborted();
  } catch { throw new Error('下载更新附件中断或长时间无进度，请重试'); }
  finally { clearTimeout(timer); controller.abort(); }
}

async function readManifest(repository, asset, token) {
  if (asset.size > 65536) throw new Error('更新清单过大');
  const response = await assetResponse(repository, asset.id, token);
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

async function downloadAsset(repository, asset, token, destination, manifest) {
  const response = await assetResponse(repository, asset.id, token);
  const hash = createHash('sha256');
  let size = 0;
  const guard = new Transform({ transform(chunk, encoding, done) {
    size += chunk.length;
    if (size > manifest.size) return done(new Error('更新包超过清单声明的大小'));
    hash.update(chunk); done(null, chunk);
  } });
  let created = false;
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  output.once('open', () => { created = true; });
  try {
    await pipeline(Readable.from(assetChunks(response)), guard, output);
    if (size !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new Error('更新包 SHA-256 或大小不匹配，未安装');
  } catch (error) {
    // wx 打开失败时文件不属于本次下载，不得删除或覆盖已有文件。
    if (created) {
      try { await unlink(destination); }
      catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') throw new Error('更新下载失败，未能清理本次下载文件，请检查暂存目录');
      }
    }
    throw error;
  } finally { response.controller.abort(); }
}

module.exports = { loadToken, apiJSON, readManifest, downloadAsset };
