// 从本机正在运行的 WorkBuddy / CodeBuddy 客户端直接取登录态
// 思路参考 WorkDaddy（babygoton/WorkDaddy，AGPL-3.0）的 CDP 注入方案：
//   客户端以 --remote-debugging-port=9222 启动 → GET /json/list 拿页面 → WebSocket 发 Runtime.evaluate
// 这里只做「读凭据」这一件事，不注入界面、不改安装包。
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// 四个 profile 的默认 CDP 端口（WorkDaddy 约定，WorkBuddy 主进程也常被这样启动）
export const DEFAULT_CDP_PORTS = [9222, 9223, 9224, 9225];

const CLIENT_HINTS = /workbuddy|codebuddy/i;

export function cdpPortsFromEnv() {
  const raw = String(process.env.WORKBUDDY_CDP_PORT || process.env.WB_CDP_PORT || '').trim();
  const extra = raw
    .split(/[,\s]+/)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0 && item < 65536);
  return [...new Set([...extra, ...DEFAULT_CDP_PORTS])];
}

async function fetchJson(url, timeoutMs = 1500) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`http_${response.status}`);
  return response.json();
}

export async function listTargets(port, { timeoutMs = 1500 } = {}) {
  const list = await fetchJson(`http://127.0.0.1:${port}/json/list`, timeoutMs);
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && item.webSocketDebuggerUrl)
    .map((item) => ({
      id: item.id,
      type: item.type,
      title: String(item.title || ''),
      url: String(item.url || ''),
      webSocketDebuggerUrl: item.webSocketDebuggerUrl,
      client: CLIENT_HINTS.test(`${item.title} ${item.url}`) ? 'workbuddy' : 'other'
    }));
}

// 扫描本机调试端口，返回可注入的页面
export async function scan({ ports = cdpPortsFromEnv(), timeoutMs = 1200 } = {}) {
  const results = [];
  await Promise.all(ports.map(async (port) => {
    try {
      const targets = await listTargets(port, { timeoutMs });
      if (!targets.length) return;
      const pages = targets.filter((item) => item.type === 'page');
      const preferred = pages.find((item) => item.client === 'workbuddy') || pages[0] || targets[0];
      results.push({
        port,
        targets: targets.length,
        pages: pages.length,
        url: preferred.url,
        title: preferred.title,
        client: preferred.client,
        webSocketDebuggerUrl: preferred.webSocketDebuggerUrl
      });
    } catch { /* 端口没开 */ }
  }));
  return results.sort((a, b) => a.port - b.port);
}

export class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
  }

  async connect({ timeoutMs = 5000 } = {}) {
    if (typeof WebSocket === 'undefined') throw new Error('node_websocket_unavailable');
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cdp_connect_timeout')), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', (event) => { clearTimeout(timer); reject(new Error(`cdp_connect_error:${event?.message || 'unknown'}`)); }, { once: true });
    });
    ws.addEventListener('message', (event) => {
      let payload;
      try { payload = JSON.parse(String(event.data)); } catch { return; }
      if (payload.id && this.pending.has(payload.id)) {
        const { resolve, reject } = this.pending.get(payload.id);
        this.pending.delete(payload.id);
        if (payload.error) reject(new Error(payload.error.message || 'cdp_error'));
        else resolve(payload.result);
        return;
      }
      if (payload.method) {
        for (const listener of this.listeners) {
          try { listener(payload); } catch { /* 忽略监听器异常 */ }
        }
      }
    });
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('cdp_closed'));
      this.pending.clear();
    });
    return this;
  }

  send(method, params = {}, timeoutMs = 10000) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('cdp_not_connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp_timeout:${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    try { this.ws?.close(); } catch { /* 已经关了 */ }
  }
}

// 在渲染进程里扫一遍存储，找形如 {accessToken, refreshToken} 的登录态
const STORAGE_PROBE = `(() => {
  const rows = [];
  const push = (scope, key, value) => {
    if (typeof value !== 'string' || value.length < 20 || value.length > 20000) return;
    rows.push([scope, key, value]);
  };
  try { for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i); push('local', k, localStorage.getItem(k)); } } catch (e) {}
  try { for (let i = 0; i < sessionStorage.length; i += 1) { const k = sessionStorage.key(i); push('session', k, sessionStorage.getItem(k)); } } catch (e) {}
  try { if (window.__WORKBUDDY_AUTH__) push('global', '__WORKBUDDY_AUTH__', JSON.stringify(window.__WORKBUDDY_AUTH__)); } catch (e) {}
  return JSON.stringify(rows);
})()`;

function findTokenish(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return out;
  for (const [key, value] of Object.entries(node)) {
    const lower = key.toLowerCase();
    if (typeof value === 'string') {
      if (/^accesstoken$|^access_token$/.test(lower) && value.length > 8) out.accessToken = out.accessToken || value;
      else if (/^refreshtoken$|^refresh_token$/.test(lower) && value.length > 8) out.refreshToken = out.refreshToken || value;
      else if (/^(uid|userid|user_id)$/.test(lower) && value) out.uid = out.uid || String(value);
      else if (/^(enterpriseid|tenantid|tenant_id)$/.test(lower) && value) out.enterpriseId = out.enterpriseId || String(value);
      else if (/^(domain)$/.test(lower) && value) out.domain = out.domain || String(value);
      else if (/^(departmentfullname|department)$/.test(lower) && value) out.department = out.department || String(value);
      else if (/^expiresat$|^expire_time$|^expires_at$/.test(lower) && Number(value) > 1e12) out.expiresAt = out.expiresAt || Number(value);
    } else if (typeof value === 'number') {
      if (/^expiresat$|^expire_time$|^expires_at$|^expiretime$/.test(lower) && value > 1e12) {
        out.expiresAt = out.expiresAt || value;
      }
    } else if (value && typeof value === 'object') {
      findTokenish(value, out, depth + 1);
    }
  }
  return out;
}

function parseMaybeJson(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

export function extractCredentialFromRows(rows) {
  const candidates = [];
  for (const [scope, key, value] of rows || []) {
    const parsed = parseMaybeJson(value);
    if (parsed) {
      const found = findTokenish(parsed, {});
      if (found.accessToken) candidates.push({ ...found, source: `${scope}:${key}` });
      continue;
    }
    // 有的 key 直接存 JWT
    if (/^ey[A-Za-z0-9_-]{10,}\./.test(value) && /token|auth|cred/i.test(key)) {
      candidates.push({ accessToken: value, source: `${scope}:${key}` });
    }
  }
  if (!candidates.length) return null;
  // 优先带 refreshToken 的（能自动续期）
  candidates.sort((a, b) => Number(Boolean(b.refreshToken)) - Number(Boolean(a.refreshToken)));
  return candidates[0];
}

// 抓取登录态：先扫存储，扫不到就监听网络请求头里的 Bearer
export async function grabCredential({ port, webSocketDebuggerUrl, waitMs = 12000, onHint } = {}) {
  const targets = webSocketDebuggerUrl
    ? [{ webSocketDebuggerUrl, title: '', url: '', client: 'workbuddy' }]
    : await listTargets(port).then((list) => list.filter((item) => item.type === 'page'));
  if (!targets.length) return { ok: false, reason: 'no_cdp_target' };

  const errors = [];
  for (const target of targets) {
    const session = new CdpSession(target.webSocketDebuggerUrl);
    try {
      await session.connect();
      await session.send('Runtime.enable');

      let rows = [];
      try {
        const evaluated = await session.send('Runtime.evaluate', {
          expression: STORAGE_PROBE,
          returnByValue: true,
          awaitPromise: true
        });
        const raw = evaluated?.result?.value;
        rows = raw ? JSON.parse(raw) : [];
      } catch (error) {
        errors.push(`probe:${String(error?.message || error)}`);
      }

      const fromStorage = extractCredentialFromRows(rows);
      if (fromStorage) {
        session.close();
        return {
          ok: true,
          source: 'storage',
          credential: fromStorage,
          target: { title: target.title, url: target.url }
        };
      }

      // 存储里没有：监听网络，等客户端自己发一次带 Bearer 的请求
      onHint?.('storage_empty');
      const captured = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), waitMs);
        const off = session.onEvent((event) => {
          if (event.method !== 'Network.requestWillBeSent') return;
          const headers = event.params?.request?.headers || {};
          const auth = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization');
          if (!auth) return;
          const value = String(auth[1] || '');
          const match = /^Bearer\s+(.+)$/i.exec(value);
          if (!match) return;
          clearTimeout(timer);
          off();
          resolve({
            accessToken: match[1],
            uid: headers['x-user-id'] || headers['X-User-Id'] || undefined,
            enterpriseId: headers['x-enterprise-id'] || headers['X-Enterprise-Id'] || undefined,
            domain: headers['x-domain'] || headers['X-Domain'] || undefined,
            source: 'network'
          });
        });
        session.send('Network.enable').catch(() => {});
      });
      session.close();
      if (captured) {
        return { ok: true, source: 'network', credential: captured, target: { title: target.title, url: target.url } };
      }
      errors.push('network:timeout');
    } catch (error) {
      errors.push(String(error?.message || error));
      session.close();
    }
  }
  return { ok: false, reason: errors.join('; ') || 'credential_not_found' };
}

// ---------- 以调试模式重启客户端 ----------

const CANDIDATE_EXE = [
  process.env.WB_CLIENT_EXE,
  `${process.env.LOCALAPPDATA || ''}\\Programs\\WorkBuddy\\WorkBuddy.exe`,
  'C:\\Program Files\\WorkBuddy\\WorkBuddy.exe',
  'C:\\Program Files (x86)\\WorkBuddy\\WorkBuddy.exe',
  'D:\\.ollama\\WorkBuddy\\WorkBuddy.exe'
].filter(Boolean);

export function findClientExe() {
  for (const candidate of CANDIDATE_EXE) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch { /* 路径非法 */ }
  }
  return null;
}

async function killClient(exe) {
  const name = 'WorkBuddy.exe';
  try {
    await execFileAsync('taskkill', ['/IM', name, '/T', '/F'], { timeout: 15000 });
  } catch { /* 没在跑 */ }
  await new Promise((resolve) => setTimeout(resolve, 1200));
}

export async function relaunchWithCdp({ port = 9222, exe } = {}) {
  if (process.platform !== 'win32') return { ok: false, reason: 'windows_only' };
  const binary = exe || findClientExe();
  if (!binary) return { ok: false, reason: 'client_exe_not_found', tried: CANDIDATE_EXE };
  await killClient(binary);
  const child = spawn(binary, [`--remote-debugging-port=${port}`], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  // 等 CDP 起来
  for (let index = 0; index < 40; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const targets = await listTargets(port, { timeoutMs: 800 });
      if (targets.some((item) => item.type === 'page')) {
        return { ok: true, exe: binary, port, targets: targets.length };
      }
    } catch { /* 还没起来 */ }
  }
  return { ok: false, reason: 'cdp_not_ready', exe: binary, port };
}
