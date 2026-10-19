import { pickFirst, safeNumber, toNumberDeep } from './util.mjs';
import {
  MODEL_CATALOG,
  WB_MODELS,
  aggregateStream as wbAggregateStream,
  acceptTasks as wbAcceptTasks,
  buildHeaders as wbBuildHeaders,
  chatCompletion as wbChatCompletion,
  checkinStatus as wbCheckinStatus,
  claimTask as wbClaimTask,
  claimTravel as wbClaimTravel,
  dailyCheckin as wbDailyCheckin,
  fetchBalance as wbFetchBalance,
  fetchModels as wbFetchModels,
  growthInfo as wbGrowthInfo,
  jwtExp as wbJwtExp,
  listTasks as wbListTasks,
  modelInfo as wbModelInfo,
  parseCredential as wbParseCredential,
  queueStatus as wbQueueStatus,
  realmOf as wbRealmOf,
  refreshCredential as wbRefreshCredential
} from './workbuddy.mjs';

const TIMEOUT_MS = 45000;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const WORKBUDDY_UA = 'WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1';

function joinUrl(base, path) {
  if (!path) return base;
  if (/^https?:\/\//i.test(path)) return path;
  const trimmedBase = String(base).replace(/\/+$/, '');
  const trimmedPath = String(path).startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

function truthyFlag(value) {
  if (value === true) return true;
  if (typeof value === 'number') return value === 0 || value === 200;
  if (typeof value === 'string') return ['0', '200', 'ok', 'true', 'success'].includes(value.toLowerCase());
  if (value && typeof value === 'object') {
    if ('success' in value) return Boolean(value.success);
    if ('ok' in value) return Boolean(value.ok);
    if ('code' in value) return truthyFlag(value.code);
  }
  return false;
}

function hashSeed(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash;
}

/** 上游是不是在说「这个思考档位我模型不支持」（code 11150 / 文案 reasoning effort）。 */
function isEffortRejection(result) {
  if (!result || result.ok) return false;
  if (result.status !== 400) return false;
  const body = String(result.body || '');
  return body.includes('11150') || /reasoning effort/i.test(body);
}

/**
 * 网关对外的模型别名 → 上游真实模型 ID。
 * 客户端只看到这三个名字；上游认的是它自己那张表，不换算会被判 400。
 */
export const GATEWAY_ALIAS = {
  'workbuddy-gateway-v1': 'deepseek-v4-pro',
  'workbuddy-gateway-max': 'deepseek-v4-pro',
  'workbuddy-gateway-fast': 'deepseek-v4.1-flash'
};

export function resolveUpstreamModel(model) {
  const name = String(model || '').trim();
  return GATEWAY_ALIAS[name] || name;
}

/** 从上游错误体里抠出一句人话，用于网关错误信息。 */
export function upstreamErrorBrief(result) {
  const body = String(result?.body || '');
  if (!body) return `http_${result?.status || 0}`;
  try {
    const json = JSON.parse(body);
    const detail = json.displayMsg?.zh || json.msg || json.message || json.error?.message || '';
    return `http_${result.status}${json.code ? `(${json.code})` : ''}${detail ? ` ${String(detail).slice(0, 80)}` : ''}`;
  } catch {
    return `http_${result?.status || 0} ${body.slice(0, 80)}`;
  }
}

export class Upstream {
  constructor(store) {
    this.store = store;
    // 排队预检缓存：accountId -> { at, status, busy }
    this.queueCache = new Map();
  }

  get settings() {
    return this.store.settings;
  }

  get mock() {
    return Boolean(this.settings.gateway?.mock);
  }

  // 是否要打真实上游：WorkBuddy 会话自带域名，不依赖 baseUrl
  get live() {
    return !this.mock;
  }

  get configured() {
    return Boolean(String(this.settings.upstream?.baseUrl || '').trim());
  }

  get liveReady() {
    return this.configured && !this.mock;
  }

  parseWorkbuddySecret(value) {
    if (!value) return null;
    let data = null;
    try {
      data = JSON.parse(value);
    } catch {
      return null;
    }
    if (!data || typeof data !== 'object') return null;
    const auth = data.auth || {};
    const account = data.account || (Array.isArray(data.accounts) ? data.accounts[0] : null) || {};
    const token = data.accessToken || data.access_token || auth.accessToken || data.token;
    if (!token || typeof token !== 'string') return null;
    return {
      token,
      uid: String(data.uid || data.userId || account.uid || auth.uid || ''),
      domain: data.domain || auth.domain || 'copilot.tencent.com'
    };
  }

  buildHeaders(secret, extra = {}) {
    const settings = this.settings.upstream;
    const headers = {
      'user-agent': settings.userAgent || 'WorkBuddyScheduler/1.0',
      accept: 'application/json, text/plain, */*',
      ...(settings.extraHeaders || {}),
      ...extra
    };
    if (secret?.value) {
      if (secret.authType === 'workbuddy') {
        const parsed = this.parseWorkbuddySecret(secret.value);
        if (parsed) {
          headers.authorization = `Bearer ${parsed.token}`;
          if (parsed.uid) headers['x-user-id'] = parsed.uid;
          headers['x-domain'] = parsed.domain;
          if (!settings.userAgent) headers['user-agent'] = WORKBUDDY_UA;
        }
      } else if (secret.authType === 'bearer') {
        headers.authorization = `Bearer ${secret.value}`;
      } else if (secret.authType === 'cookie') {
        headers.cookie = secret.value;
      } else if (secret.authType === 'header') {
        headers['x-api-key'] = secret.value;
      }
    }
    return headers;
  }

  // 取出 WorkBuddy 会话；expiresAt 缺失时从 JWT exp 兜底；临界过期自动续期并落盘
  async workbuddyCredential(account, { autoRefresh = true, force = false } = {}) {
    let cred = null;
    try {
      const secret = await this.store.getSecret(account.id);
      if (secret?.authType !== 'workbuddy') return null;
      cred = wbParseCredential(secret.value);
    } catch {
      return null;
    }
    if (!cred) return null;
    if (!cred.expiresAt) cred.expiresAt = wbJwtExp(cred.token) || null;
    if (!autoRefresh || !cred.refreshToken) return cred;
    const exp = Number(cred.expiresAt || 0);
    const near = !force && (!exp || exp * 1000 - Date.now() > 5 * 60 * 1000);
    if (near) return cred;
    const renewed = await this.refreshWorkbuddyCredential(account, cred).catch(() => null);
    return renewed || cred;
  }

  async refreshWorkbuddyCredential(account, cred) {
    const source = cred || await this.workbuddyCredential(account, { autoRefresh: false });
    if (!source?.refreshToken) return null;
    const result = await wbRefreshCredential(source);
    if (!result.ok) return null;
    const merged = {
      ...source,
      token: result.accessToken,
      refreshToken: result.refreshToken || source.refreshToken,
      expiresAt: result.expiresAt || wbJwtExp(result.accessToken) || null,
      domain: result.domain || source.domain
    };
    await this.store.setSecret(account.id, JSON.stringify({
      accessToken: merged.token,
      refreshToken: merged.refreshToken,
      uid: merged.uid,
      domain: merged.domain,
      enterpriseId: merged.enterpriseId,
      realm: merged.realm,
      expiresAt: merged.expiresAt
    }), 'workbuddy');
    return merged;
  }

  async isWorkbuddy(account) {
    try {
      const meta = this.store.secretMeta(account.id);
      return meta?.authType === 'workbuddy';
    } catch {
      return false;
    }
  }

  async rawRequest(account, { method = 'GET', path, body, headers = {}, signal, secretOverride = null, retried = false } = {}) {
    const secret = secretOverride || await this.store.getSecret(account.id);
    if (secret?.authType === 'workbuddy') {
      const cred = secretOverride
        ? wbParseCredential(secret.value)
        : await this.workbuddyCredential(account);
      if (cred) {
        const cfg = wbRealmOf(cred.realm);
        const kind = /\/chat\//i.test(String(path)) ? 'chat' : 'billing';
        const target = /^https?:\/\//i.test(String(path))
          ? path
          : `${cfg.base}${String(path).startsWith('/') ? '' : '/'}${path}`;
        const init = {
          method,
          headers: { ...wbBuildHeaders(cred, kind), ...headers },
          signal: signal || AbortSignal.timeout(TIMEOUT_MS),
          redirect: 'follow'
        };
        if (body && method !== 'GET' && method !== 'HEAD') {
          init.body = typeof body === 'string' ? body : JSON.stringify(body);
        }
        const response = await fetch(target, init);
        // 令牌过期时不打断上层重试链：本地续期一次后立刻重放
        if ((response.status === 401 || response.status === 403) && !retried && !secretOverride) {
          const renewed = await this.refreshWorkbuddyCredential(account, cred).catch(() => null);
          if (renewed) {
            return this.rawRequest(account, { method, path, body, headers, signal, retried: true });
          }
        }
        return response;
      }
    }
    const settings = this.settings.upstream;
    const url = joinUrl(settings.baseUrl, path);
    const init = {
      method,
      headers: this.buildHeaders(secret, {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers
      }),
      signal: signal || AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow'
    };
    if (body && method !== 'GET' && method !== 'HEAD') {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    return fetch(url, init);
  }

  async readJsonSafe(response) {
    const text = await response.text().catch(() => '');
    if (!text) return { json: null, text: '' };
    try {
      return { json: JSON.parse(text), text };
    } catch {
      return { json: null, text };
    }
  }

  async fetchBalance(account) {
    if (!this.live) return this.mockBalance(account);
    const wbCred = await this.workbuddyCredential(account);
    if (wbCred) {
      const result = await wbFetchBalance(wbCred).catch((error) => ({ ok: false, status: 0, body: String(error?.message || error) }));
      if (!result.ok) {
        return {
          ok: false,
          status: result.status || 0,
          reason: `http_${result.status || 0}`,
          total: null,
          used: null,
          available: null,
          body: result.body || ''
        };
      }
      return { ok: true, total: result.total, used: result.used, available: result.available, packages: result.packages, raw: result.raw };
    }
    const settings = this.settings.upstream;
    if (!settings.balancePath) {
      return { ok: false, reason: 'balance_path_not_configured', total: null, used: null, available: null };
    }
    const conf = settings.balance || {};
    const response = await this.rawRequest(account, {
      method: conf.method || 'GET',
      path: settings.balancePath,
      body: conf.body ?? undefined,
      headers: {
        // 上游网关会拒 Python/自定义 UA，必须带浏览器 UA
        'user-agent': BROWSER_UA,
        ...(conf.headers || {})
      }
    });
    const { json, text } = await this.readJsonSafe(response);
    if (!response.ok) {
      return { ok: false, status: response.status, reason: `http_${response.status}`, total: null, used: null, available: null, body: text.slice(0, 500) };
    }
    const paths = settings.quotaPaths || {};
    const total = toNumberDeep(pickFirst(json, paths.total || []));
    const usedRaw = toNumberDeep(pickFirst(json, paths.used || []));
    const availableRaw = toNumberDeep(pickFirst(json, paths.available || []));
    let resolvedTotal = total;
    let resolvedUsed = usedRaw;
    let resolvedAvailable = availableRaw;
    if (resolvedTotal === undefined && resolvedUsed !== undefined && resolvedAvailable !== undefined) {
      resolvedTotal = resolvedUsed + resolvedAvailable;
    }
    if (resolvedUsed === undefined && resolvedTotal !== undefined && resolvedAvailable !== undefined) {
      resolvedUsed = Math.max(0, resolvedTotal - resolvedAvailable);
    }
    if (resolvedAvailable === undefined && resolvedTotal !== undefined && resolvedUsed !== undefined) {
      resolvedAvailable = Math.max(0, resolvedTotal - resolvedUsed);
    }
    if (resolvedTotal === undefined) {
      return { ok: false, reason: 'quota_not_parsed', body: text.slice(0, 500) };
    }
    return {
      ok: true,
      total: Math.round(resolvedTotal),
      used: Math.round(resolvedUsed ?? 0),
      available: Math.round(resolvedAvailable ?? Math.max(0, resolvedTotal - (resolvedUsed ?? 0))),
      raw: json
    };
  }

  mockBalance(account) {
    const total = safeNumber(account.quota?.total, 0);
    const used = safeNumber(account.quota?.used, 0);
    return { ok: true, total, used, available: Math.max(0, total - used), mock: true };
  }

  async chatPing(account, conf = {}) {
    const settings = this.settings.upstream;
    const path = conf.path || settings.chatPath;
    const body = {
      model: conf.model || settings.chatModel || 'glm-5.2',
      messages: [{ role: 'user', content: conf.prompt || '你好' }],
      stream: false,
      max_tokens: Math.max(8, Number(conf.maxTokens || 32))
    };
    // WorkBuddy 上游只接受 stream:true，交给 chat() 走强制流式 + 聚合
    if (await this.workbuddyCredential(account)) {
      const result = await this.chat(account, body).catch((error) => ({ ok: false, reason: String(error?.message || error) }));
      return result.ok ? { status: 200, mode: result.mode } : { status: 0, reason: result.reason || 'chat_failed' };
    }
    if (!path) return { status: 0, reason: 'chat_path_not_configured' };
    const response = await this.rawRequest(account, {
      method: 'POST',
      path,
      body,
      headers: { accept: 'application/json' }
    });
    return { status: response.status };
  }

  async checkIn(account) {
    if (!this.live) return this.mockCheckIn(account);
    const wbCred = await this.workbuddyCredential(account);
    if (wbCred) {
      // 国际版没有签到活动，直接跳过，不制造假成功
      if (wbRealmOf(wbCred.realm).realm === 'intl') {
        return { ok: true, skipped: true, message: '国际版没有签到活动' };
      }
      const conf0 = this.settings.upstream.checkin || {};
      let preChat = null;
      // 官方要求当天存在一次对话才记录签到，默认补一条极简对话（可在设置里关掉）
      if (conf0.preChat?.enabled !== false) {
        preChat = await this.chatPing(account, conf0.preChat || {}).catch(() => null);
      }
      const result = await wbDailyCheckin(wbCred).catch((error) => ({ ok: false, reason: String(error?.message || error) }));
      if (!result.ok) return { ok: false, reason: result.reason || `code_${result.code}`, message: result.message, preChat };
      return {
        ok: true,
        alreadyDone: Boolean(result.alreadyDone),
        message: result.alreadyDone ? '今日已签到' : '签到成功',
        preChat,
        raw: result.raw
      };
    }
    const settings = this.settings.upstream;
    const conf = settings.checkin || {};
    if (!settings.checkinPath) return { ok: false, reason: 'checkin_path_not_configured' };

    let preChat = null;
    if (conf.preChat?.enabled) {
      // 官方要求当天存在一次对话才记录签到，先补一条极简对话（失败不阻断）
      preChat = await this.chatPing(account, conf.preChat).catch((error) => ({ status: 0, reason: String(error?.message || error) }));
    }

    const response = await this.rawRequest(account, {
      method: conf.method || 'POST',
      path: settings.checkinPath,
      body: conf.body ?? {}
    });
    const { json, text } = await this.readJsonSafe(response);
    if (!response.ok) return { ok: false, status: response.status, reason: `http_${response.status}`, body: text.slice(0, 500) };

    const code = json?.code;
    const doneCodes = Array.isArray(conf.doneCodes) ? conf.doneCodes : [];
    if (code !== undefined && doneCodes.includes(code)) {
      return { ok: true, alreadyDone: true, message: '今日已签到', preChat, raw: json ?? null };
    }
    const flags = (conf.successPaths || []).map((path) => pickFirst(json, [path]));
    const flagged = flags.some((value) => value !== undefined && truthyFlag(value));
    const mentionsSuccess = /成功|已签到|already|success|签到成功/i.test(text);
    const alreadyDone = /已签到|already\s*(checked|signed)|重复/i.test(text);
    if (json === null && !mentionsSuccess) {
      return { ok: false, reason: 'unparsed_response', body: text.slice(0, 300) };
    }
    return {
      ok: flagged || mentionsSuccess || response.ok,
      alreadyDone,
      message: mentionsSuccess ? (alreadyDone ? '今日已签到' : '签到成功') : (conf.body !== undefined ? '签到成功' : '请求已发出'),
      preChat,
      raw: json ?? text.slice(0, 300)
    };
  }

  mockCheckIn(account) {
    const seed = hashSeed(`${account.id}-${new Date().toDateString()}`);
    const reward = 80 + (seed % 8) * 10;
    return { ok: true, mock: true, alreadyDone: false, reward, message: `模拟签到成功，+${reward}` };
  }

  async listTasks(account) {
    if (!this.live) return this.mockTasks(account);
    const wbCred = await this.workbuddyCredential(account);
    if (wbCred) {
      const result = await wbListTasks(wbCred).catch((error) => ({ ok: false, tasks: [], reason: String(error?.message || error) }));
      if (!result.ok) return { ok: false, reason: result.reason || `http_${result.status || 0}`, body: result.body || '', tasks: [] };
      return { ok: true, tasks: result.tasks, pending: result.tasks.filter((task) => !task.done), real: true };
    }
    const settings = this.settings.upstream;
    if (!settings.tasksPath) return { ok: false, reason: 'tasks_path_not_configured', tasks: [] };
    const conf = settings.tasks || {};
    const response = await this.rawRequest(account, { method: conf.method || 'GET', path: settings.tasksPath });
    const { json, text } = await this.readJsonSafe(response);
    if (!response.ok) return { ok: false, status: response.status, reason: `http_${response.status}`, body: text.slice(0, 500), tasks: [] };
    const list = pickFirst(json, conf.listPaths || []);
    if (!Array.isArray(list)) return { ok: false, reason: 'tasks_not_parsed', body: text.slice(0, 300), tasks: [] };
    const tasks = list.map((task) => ({
      id: task.code ?? task.task_code ?? task.id ?? task.taskId ?? task.key ?? null,
      title: task.title ?? task.name ?? task.task_name ?? task.desc ?? '未命名任务',
      done: Boolean(task.done ?? task.completed ?? task.finished ?? task.status === 'done' ?? false),
      raw: task
    }));
    return { ok: true, tasks, pending: tasks.filter((task) => !task.done) };
  }

  mockTasks(account) {
    const seed = hashSeed(`${account.id}-tasks-${new Date().toDateString()}`);
    const total = 1 + (seed % 3);
    const completed = seed % (total + 1);
    const tasks = Array.from({ length: total }, (_, index) => ({
      id: `mock-task-${index + 1}`,
      title: `模拟每日任务 ${index + 1}`,
      done: index < completed,
      raw: null
    }));
    return { ok: true, mock: true, tasks, pending: tasks.filter((task) => !task.done) };
  }

  async completeTask(account, task) {
    if (!this.live) return { ok: true, mock: true, taskId: task.id, message: '模拟任务完成' };
    const settings = this.settings.upstream;
    const conf = settings.tasks || {};
    if (!conf.completePath) return { ok: false, reason: 'complete_path_not_configured' };
    const path = String(conf.completePath)
      .replace(':id', encodeURIComponent(task.id ?? ''))
      .replace('{id}', encodeURIComponent(task.id ?? ''));
    const response = await this.rawRequest(account, { method: conf.completeMethod || 'POST', path, body: { taskId: task.id } });
    const { json, text } = await this.readJsonSafe(response);
    if (!response.ok) return { ok: false, status: response.status, reason: `http_${response.status}`, body: text.slice(0, 300) };
    return { ok: true, taskId: task.id, raw: json ?? text.slice(0, 200) };
  }

  async acceptTasks(account, codes) {
    if (!this.live) return { ok: true, mock: true, skipped: Boolean(!codes.length) };
    const wbCred = await this.workbuddyCredential(account);
    if (wbCred) {
      if (!codes.length) return { ok: true, skipped: true };
      const result = await wbAcceptTasks(wbCred, codes).catch((error) => ({ ok: false, reason: String(error?.message || error) }));
      return result.ok ? { ok: true, raw: result.raw } : { ok: false, reason: result.reason || `http_${result.status || 0}`, body: result.body || '' };
    }
    const conf = this.settings.upstream.tasks || {};
    if (!conf.acceptPath || !codes.length) return { ok: true, skipped: true };
    const response = await this.rawRequest(account, {
      method: conf.acceptMethod || 'POST',
      path: conf.acceptPath,
      body: { task_codes: codes }
    });
    const { json, text } = await this.readJsonSafe(response);
    if (!response.ok) return { ok: false, status: response.status, reason: `http_${response.status}`, body: text.slice(0, 200) };
    return { ok: true, raw: json ?? text.slice(0, 200) };
  }

  async claimTask(account, code) {
    if (!this.live) return { ok: true, mock: true, taskId: code, message: '模拟领取记录' };
    const wbCred = await this.workbuddyCredential(account);
    if (wbCred) {
      const result = await wbClaimTask(wbCred, code).catch((error) => ({ ok: false, reason: String(error?.message || error) }));
      if (!result.ok) return { ok: false, reason: result.reason || `http_${result.status || 0}`, body: result.body || '' };
      return { ok: true, alreadyDone: Boolean(result.alreadyDone), raw: result.raw };
    }
    const conf = this.settings.upstream.tasks || {};
    if (!conf.claimPath) return { ok: false, reason: 'task_claim_path_not_configured' };
    const path = String(conf.claimPath)
      .replace('{code}', encodeURIComponent(code ?? ''))
      .replace(':code', encodeURIComponent(code ?? ''));
    const response = await this.rawRequest(account, { method: conf.claimMethod || 'POST', path, body: conf.claimBody ?? {} });
    const { json, text } = await this.readJsonSafe(response);
    if (!response.ok) return { ok: false, status: response.status, reason: `http_${response.status}`, body: text.slice(0, 200) };
    const code2 = json?.code;
    const replayed = /replayed|already|已领取|重复/i.test(text) || (Array.isArray(conf.doneCodes) && conf.doneCodes.includes(code2));
    return { ok: true, alreadyDone: replayed, raw: json ?? text.slice(0, 200) };
  }

  async hasTaskWorkflow(account) {
    if (account && await this.isWorkbuddy(account)) return true;
    const conf = this.settings.upstream.tasks || {};
    return Boolean(conf.acceptPath || conf.claimPath);
  }

  async runTasks(account) {
    const listing = await this.listTasks(account);
    if (!listing.ok) return listing;
    const wbCred = await this.workbuddyCredential(account);
    const conf = this.settings.upstream.tasks || {};
    const hasAccept = Boolean(wbCred) || Boolean(conf.acceptPath);
    const hasClaim = Boolean(wbCred) || Boolean(conf.claimPath);
    const pending = listing.tasks.filter((task) => !task.done && task.id);
    const failures = [];
    let accepted = 0;
    let claimed = 0;

    if (hasAccept && pending.length) {
      const result = await this.acceptTasks(account, pending.map((task) => task.id));
      if (result.ok) accepted = pending.length;
      else failures.push(`accept:${result.reason}`);
    }

    if (hasClaim) {
      for (const task of pending) {
        const result = await this.claimTask(account, task.id);
        if (result.ok) claimed += 1;
        else failures.push(`${task.title}:${result.reason}`);
      }
    }

    return {
      ok: failures.length === 0 || claimed > 0 || accepted > 0,
      total: listing.tasks.length,
      pending: pending.length,
      accepted,
      claimed,
      failures,
      message: `任务 ${listing.tasks.length} 个，待办 ${pending.length}，接受 ${accepted}，领取 ${claimed}`
    };
  }

  // 自动领奖：签到状态 → 成长体系（连签/旅行奖励）→ 成长任务
  async claimWorkbuddy(wbCred, account) {
    const status = await wbCheckinStatus(wbCred).catch(() => ({ ok: false }));
    const growth = await wbGrowthInfo(wbCred).catch((error) => ({ ok: false, reason: String(error?.message || error) }));
    const travel = await wbClaimTravel(wbCred).catch((error) => ({ ok: false, reason: String(error?.message || error) }));
    const listing = await this.runTasks(account);

    const travelOk = Boolean(travel.ok);
    const taskOk = Boolean(listing.ok);
    const nothingToDo = !travelOk && !taskOk;
    const reasons = [];
    if (!travelOk && travel.message) reasons.push(`travel:${travel.message}`);
    if (!travelOk && travel.reason) reasons.push(`travel:${travel.reason}`);
    if (!taskOk) reasons.push(...(listing.failures || []).slice(0, 3));

    return {
      ok: travelOk || taskOk,
      alreadyDone: nothingToDo && Boolean(growth.ok),
      amount: null,
      message: [
        `成长任务 ${listing.total || 0} 个，领取 ${listing.claimed || 0}`,
        travelOk ? '旅行奖励已领' : '旅行奖励无',
        growth.summary?.streakDays != null ? `连签 ${growth.summary.streakDays} 天` : ''
      ].filter(Boolean).join('，'),
      checkin: status.ok ? { total: status.total, today: status.today, streak: status.streak, checkedIn: status.checkedIn } : null,
      growth: growth.ok ? growth.summary : null,
      travel: travelOk ? { ok: true, raw: travel.raw } : { ok: false, reason: travel.reason || travel.message || 'no_travel_reward' },
      raw: listing,
      reasons
    };
  }

  async claim(account) {
    if (!this.live) return this.mockClaim(account);
    const wbCred = await this.workbuddyCredential(account);
    if (wbCred) return this.claimWorkbuddy(wbCred, account);
    const settings = this.settings.upstream;
    if (!settings.claimPath) return { ok: false, reason: 'claim_path_not_configured' };
    const conf = settings.claim || {};
    const response = await this.rawRequest(account, { method: conf.method || 'POST', path: settings.claimPath, body: conf.body ?? {} });
    const { json, text } = await this.readJsonSafe(response);
    if (!response.ok) return { ok: false, status: response.status, reason: `http_${response.status}`, body: text.slice(0, 500) };
    const amount = toNumberDeep(pickFirst(json, ['data.amount', 'data.reward', 'amount', 'reward', 'data.total_capacity_size']));
    const already = /已领取|already|重复/i.test(text);
    return { ok: true, alreadyDone: already, amount: amount ?? null, raw: json ?? text.slice(0, 300) };
  }

  mockClaim(account) {
    const seed = hashSeed(`${account.id}-claim-${new Date().toDateString()}`);
    const amount = 60 + (seed % 6) * 10;
    return { ok: true, mock: true, amount, message: `模拟领取成功，+${amount}` };
  }

  // 模型清单：WorkBuddy 走官方 10 个模型 ID，其它上游走 modelsPath
  async fetchModels(account) {
    const wbCred = await this.workbuddyCredential(account);
    if (wbCred) {
      const result = await wbFetchModels(wbCred).catch(() => ({ ok: true, models: WB_MODELS, source: 'static' }));
      return { ok: true, models: result.models || WB_MODELS, source: result.source || 'static' };
    }
    const settings = this.settings.upstream;
    if (!settings.modelsPath) return { ok: true, models: [settings.model].filter(Boolean), source: 'local' };
    const response = await this.rawRequest(account, { method: 'GET', path: settings.modelsPath });
    const { json } = await this.readJsonSafe(response);
    if (!response.ok || !json) return { ok: false, reason: `http_${response.status}`, models: [settings.model].filter(Boolean) };
    const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : Array.isArray(json) ? json : [];
    const ids = list.map((item) => (typeof item === 'string' ? item : item.id || item.model || item.name)).filter(Boolean);
    return { ok: true, models: ids.length ? ids : [settings.model].filter(Boolean), source: 'upstream' };
  }

  // 统一对话入口：mode=json 直接返回聚合结果，mode=stream 交给调用方透传
  // 返回 mode='passthrough' 表示交给通用 rawRequest 路径
  // 客户端发消息前会先 POST /v2/chat/queue/status：排队中就先等/换号
  // 网关这边做轻量预检，TTL 内复用结果，避免每个请求多一次 RTT
  async queueProbe(account, model, { ttlMs = 20000, force = false } = {}) {
    const skip = { ok: true, status: 'idle', busy: false, cached: false };
    if (!this.live) return skip;
    if (!account || !(await this.isWorkbuddy(account))) return skip;
    if (this.settings.gateway?.queueProbe === false) return { ...skip, status: 'skipped' };
    const key = account.id;
    const wanted = model || 'auto';
    const now = Date.now();
    const hit = this.queueCache.get(key);
    if (!force && hit && hit.model === wanted && now - hit.at < ttlMs) {
      return { ...hit, cached: true };
    }
    const wbCred = await this.workbuddyCredential(account);
    if (!wbCred) return skip;
    let result;
    try {
      result = await wbQueueStatus(wbCred, wanted);
    } catch (error) {
      result = { ok: false, status: 'error', message: String(error?.message || error) };
    }
    // 探测失败不影响正常发请求，只是拿不到排队信息
    const raw = result.ok ? String(result.queue?.status ?? result.status ?? 'unknown') : 'error';
    const status = raw.toLowerCase();
    const busy = result.ok && /queue|queued|waiting|pending|busy|排队|congest/.test(status);
    const record = { at: now, model: wanted, ok: Boolean(result.ok), status, raw, busy, queue: result.queue || null };
    this.queueCache.set(key, record);
    return { ...record, cached: false };
  }

  invalidateQueue(accountId) {
    this.queueCache.delete(accountId);
  }

  // 官方模型目录（带 credits 倍率），给 UI 与 /v1/models 用
  modelCatalog() {
    return MODEL_CATALOG.map((item) => ({ ...item }));
  }

  catalogEntry(model) {
    return wbModelInfo(model);
  }

  async chat(account, payload) {
    if (!this.live) return { ok: false, mode: 'none', reason: 'mock_mode' };
    const wbCred = await this.workbuddyCredential(account);
    if (!wbCred) return { ok: true, mode: 'passthrough' };
    let result = await wbChatCompletion(wbCred, payload).catch((error) => ({ ok: false, status: 0, body: String(error?.message || error) }));
    // 上游按模型校验思考档位：glm-5.1 只认 low/medium/high，客户端默认发 none 会被
    // 11150 顶回来。这种情况不是账号问题，降一档重试一次即可，不该换号也不该报错。
    if (!result.ok && isEffortRejection(result)) {
      const retry = await wbChatCompletion(wbCred, { ...payload, reasoning_effort: 'low' })
        .catch((error) => ({ ok: false, status: 0, body: String(error?.message || error) }));
      if (retry.ok) result = { ...retry, effortFallback: 'low' };
    }
    if (!result.ok) return { ok: false, mode: 'none', status: result.status || 0, body: result.body || '' };
    if (payload.stream) {
      return { ok: true, mode: 'stream', stream: result.stream, contentType: result.contentType, effortFallback: result.effortFallback };
    }
    const json = await wbAggregateStream(result.stream, { model: payload.model });
    return { ok: true, mode: 'json', json };
  }

  async checkinStatus(account) {
    const wbCred = await this.workbuddyCredential(account);
    if (!wbCred) return { ok: false, reason: 'not_workbuddy' };
    const result = await wbCheckinStatus(wbCred).catch((error) => ({ ok: false, reason: String(error?.message || error) }));
    return result;
  }

  async probe(account, paths) {
    const results = [];
    for (const path of paths) {
      try {
        const response = await this.rawRequest(account, { method: 'GET', path });
        const { text } = await this.readJsonSafe(response);
        results.push({
          path,
          status: response.status,
          contentType: response.headers.get('content-type') || '',
          length: text.length,
          snippet: text.slice(0, 220)
        });
      } catch (error) {
        results.push({ path, status: 0, error: String(error?.message || error).slice(0, 160) });
      }
    }
    return results;
  }
}
