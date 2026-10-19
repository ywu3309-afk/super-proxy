// WorkBuddy / CodeBuddy 上游对接层
// 接口与请求头取自开源实现：
//   - wangmingdong/workbuddy-signin（签到、额度、成长任务）
//   - ardeyouxipianyi/workbuddy2api-hub（/v2/plugin/auth/* 扫码授权、区域切换）
//   - wicm84266964/Buddy2api（官方客户端指纹头、token 刷新）
//   - zqcccc/workbuddy-cliproxy（模型清单、国际/国内域名一致）
import { randomUUID } from 'node:crypto';

export const REALMS = {
  cn: {
    realm: 'cn',
    label: '国内版',
    base: 'https://copilot.tencent.com',
    origin: 'https://www.codebuddy.cn',
    domain: 'copilot.tencent.com',
    ua: 'WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1',
    billingUa: 'WorkBuddy/5.5.6',
    ideVersion: '5.5.6',
    hasCheckin: true
  },
  intl: {
    realm: 'intl',
    label: '国际版',
    base: 'https://www.workbuddy.ai',
    origin: 'https://www.workbuddy.ai',
    domain: 'www.workbuddy.ai',
    ua: 'WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0',
    billingUa: 'WorkBuddy/5.8.4',
    ideVersion: '5.8.4',
    hasCheckin: false
  }
};

export const WB_PATHS = {
  authState: '/v2/plugin/auth/state',
  authToken: '/v2/plugin/auth/token',
  loginAccount: '/v2/plugin/login/account',
  refresh: '/v2/plugin/auth/token/refresh',
  chat: '/v2/chat/completions',
  queueStatus: '/v2/chat/queue/status',
  queueCancel: '/v2/chat/queue/cancel',
  models: '/v2/enterprises/personal/models',
  checkin: '/v2/billing/meter/daily-checkin',
  // 客户端 5.8.x 用的是 checkin-status；旧版是 checkin-activity-status，两个都试
  checkinStatusList: ['/v2/billing/meter/checkin-status', '/v2/billing/meter/checkin-activity-status'],
  resourceSummary: '/v2/billing/meter/get-user-resource-summary',
  resourcePaid: '/v2/billing/meter/get-user-resource-paid-packages',
  resourceFree: '/v2/billing/meter/get-user-resource-free-packages',
  resourceLegacy: '/v2/billing/meter/get-user-resource',
  enterpriseUsage: '/v2/billing/meter/get-enterprise-user-usage',
  tasks: '/v2/activity/growth/tasks',
  taskAccept: '/v2/activity/growth/tasks/accept',
  taskClaim: 'https://www.workbuddy.cn/activity/growth/tasks/{code}/claim',
  growthInfo: '/v2/activity/growth/buddy/info',
  // 客户端 claimTravelReward 用的是不带 /v2 的路径 + X-Product-Code，逆向确认
  travelClaim: '/activity/growth/buddy/travel/claim',
  growthProfile: '/v2/activity/growth/profile'
};

// 客户端 user-resource-capacity.js：CapacityType===4 是「切片包」，额度要看 SlicePeriodUsageDetails
export const CAPACITY_TYPE_SLICE = 4;

export const PAID_PACKAGE_CODES = [
  'proMon', 'proMonPlus', 'proYear', 'freeMon', 'youth', 'advanced', 'flagship',
  'bonus28', 'freeMonIntl', 'proTrialMon', 'proTrialYear', 'bonusIntl', 'extra', 'extra38', 'bonus29', 'bonus30', 'extraIntl', 'activity', 'gift'
];

export const FREE_PACKAGE_CODES = ['free'];

export function resourceCapacity(raw) {
  const count = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  if (Number(raw?.CapacityType) === CAPACITY_TYPE_SLICE) {
    const slice = raw?.SlicePeriodUsageDetails?.[0];
    if (slice) {
      const total = count(slice.SlicePeriodCapacitySizePrecise);
      const left = count(slice.SlicePeriodCapacityRemainPrecise);
      return { total, left, used: Math.max(0, total - left), slice: true };
    }
  }
  const total = count(raw?.CycleCapacitySizePrecise);
  const left = count(raw?.CycleCapacityRemainPrecise);
  return { total, left, used: Math.max(0, total - left), slice: false };
}

// 与客户端 buildSlicePeriodRange 一致：免费月包是切片包，必须带当日窗口
export function slicePeriodRange(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const fmt = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 0);
  return { SlicePeriodStartTime: fmt(start), SlicePeriodEndTime: fmt(end) };
}

export const LOGIN_PENDING_CODE = 11217;

// 官方模型目录：从 WorkBuddy 5.8.3 客户端 app.asar 的模型配置表反解出来的
// credits 是官方定价倍率（null = 免费/不限），换号调度时按倍率折算消耗更接近官方
export const MODEL_CATALOG = [
  { id: 'auto', name: 'Auto', credits: 0.4 },
  { id: 'glm-5.1', name: 'GLM-5.1', credits: 1.06 },
  { id: 'glm-5.0', name: 'GLM-5.0', credits: null },
  { id: 'glm-5.0-turbo', name: 'GLM-5.0-Turbo', credits: 0.95 },
  { id: 'glm-5v-turbo', name: 'GLM-5v-Turbo', credits: null },
  { id: 'glm-4.7', name: 'GLM-4.7', credits: 0.23 },
  { id: 'glm-4.6', name: 'GLM-4.6', credits: 0.23 },
  { id: 'glm-4.6v', name: 'GLM-4.6V', credits: 0.11 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', credits: 0.51 },
  { id: 'deepseek-v4-pro-exclusive', name: 'DeepSeek-V4-Pro (独占)', credits: 0.51 },
  { id: 'deepseek-v3-2-volc', name: 'DeepSeek-V3.2', credits: 0.29 },
  { id: 'deepseek-v3.1', name: 'DeepSeek-V3.1-Terminus', credits: 0.52 },
  { id: 'deepseek-v3-0324', name: 'DeepSeek-V3', credits: 0.78 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', credits: 0.59 },
  { id: 'kimi-k2.5', name: 'Kimi-K2.5', credits: 0.45 },
  { id: 'kimi-k2-thinking', name: 'Kimi-K2-Thinking', credits: 0.54 },
  { id: 'minimax-m2.7', name: 'MiniMax-M2.7', credits: 0.26 },
  { id: 'minimax-m2.5', name: 'MiniMax-M2.5', credits: 0.18 },
  { id: 'hunyuan-chat', name: 'Hunyuan-Turbos', credits: 0.1 },
  { id: 'hunyuan-2.0-instruct', name: 'Hunyuan-2.0-Instruct', credits: 0.04 },
  { id: 'hunyuan-image-v3.0', name: 'Hunyuan Image V3', credits: 5, tags: ['text-to-image'] }
];

// 对话模型（排除文生图等非 chat 模型），网关 /v1/models 只列这些
export const CHAT_MODEL_IDS = MODEL_CATALOG
  .filter((item) => !(item.tags || []).includes('text-to-image'))
  .map((item) => item.id);

export function isChatModel(id) {
  const entry = modelInfo(id);
  if (entry) return !(entry.tags || []).includes('text-to-image');
  // 目录外的实验模型默认当对话模型放行
  return !/image|tts|whisper|embed/i.test(String(id || ''));
}

// 兼容旧引用：所有模型 ID 的平铺列表（含实验性前缀，客户端也认）
export const WB_MODELS = [
  ...MODEL_CATALOG.map((item) => item.id),
  'glm-5.2',
  'kimi-k2.7',
  'minimax-m3-pay',
  'hy3',
  'hy3-preview',
  'hy3-preview-agent',
  'deepseek-v4-flash'
];

export function modelInfo(id) {
  const key = String(id || '').toLowerCase();
  return MODEL_CATALOG.find((item) => item.id.toLowerCase() === key) || null;
}

// 允许用环境变量把某个区域指到自建反代 / 本地 mock（团队内网、测试环境常用）
function withOverride(cfg) {
  const suffix = String(cfg.realm || '').toUpperCase();
  const base = process.env[`WB_BASE_${suffix}`];
  const claim = process.env[`WB_CLAIM_BASE_${suffix}`];
  return {
    ...cfg,
    base: (base || cfg.base).replace(/\/+$/, ''),
    claimBase: claim || WB_PATHS.taskClaim
  };
}

export function realmOf(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('intl') || text.includes('global') || text.includes('国际')) return withOverride(REALMS.intl);
  if (text.includes('cn') || text.includes('china') || text.includes('国内')) return withOverride(REALMS.cn);
  return withOverride(REALMS.cn);
}

export function detectRealm({ domain, token } = {}) {
  const text = `${domain || ''} ${token || ''}`.toLowerCase();
  if (/workbuddy\.ai|codebuddy\.ai/.test(text)) return REALMS.intl;
  return REALMS.cn;
}

// ---------- 请求头（官方客户端指纹） ----------

function traceId() {
  return randomUUID().replace(/-/g, '');
}

function conversationId() {
  return randomUUID();
}

export function buildHeaders({ token, uid, domain, enterpriseId, department, realm }, kind = 'chat') {
  const cfg = realmOf(realm || detectRealm({ domain, token }).realm);
  const rid = traceId();
  const span = traceId().slice(0, 16);
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/plain, */*',
    'x-product': 'SaaS',
    'x-product-code': 'workbuddy',
    'user-agent': kind === 'billing' ? cfg.billingUa : cfg.ua,
    'x-domain': domain || cfg.domain,
    'x-request-id': rid,
    'x-trace-id': rid,
    'x-b3-traceid': rid,
    'x-b3-spanid': span,
    'x-b3-sampled': '1',
    b3: `${rid}-${span}-1-`,
    origin: cfg.origin,
    referer: `${cfg.origin}/`,
    'x-requested-with': 'XMLHttpRequest'
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (uid) headers['x-user-id'] = String(uid);
  if (enterpriseId) {
    headers['x-enterprise-id'] = String(enterpriseId);
    headers['x-tenant-id'] = String(enterpriseId);
  }
  if (department) headers['x-department-info'] = String(department);

  if (kind === 'chat') {
    headers['x-ide-type'] = 'WorkBuddy';
    headers['x-ide-name'] = 'WorkBuddy';
    headers['x-ide-version'] = cfg.ideVersion;
    headers['x-agent-intent'] = 'craft';
    headers['x-agent-purpose'] = 'conversation';
    headers['x-agent-type'] = 'main';
    headers['x-conversation-id'] = conversationId();
    headers['x-conversation-request-id'] = traceId();
    headers['x-conversation-message-id'] = traceId();
    headers['x-root-request-id'] = traceId();
  }
  if (kind === 'growth') {
    // 客户端 GrowthFacade：Bearer + X-User-Id/X-Enterprise-Id/X-Tenant-Id/X-Domain/X-Department-Info
    // 不带 SaaS 的 x-product，保留 X-Product-Code（claimTravelReward 的 productHeaders）
    delete headers['x-product'];
    delete headers['x-requested-with'];
    headers.accept = 'application/json';
    headers['cache-control'] = 'no-cache';
  }
  if (kind === 'refresh') {
    headers['x-auth-refresh-source'] = 'plugin';
    headers['cache-control'] = 'no-cache';
    headers.pragma = 'no-cache';
    headers.accept = 'application/json';
  }
  return headers;
}

export function buildRefreshHeaders({ token, refreshToken, uid, domain, enterpriseId, realm }) {
  const headers = buildHeaders({ token, uid, domain, enterpriseId, realm }, 'refresh');
  headers['x-refresh-token'] = String(refreshToken || '');
  return headers;
}

// ---------- 会话解析 ----------

export function parseCredential(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return normalizeCredential(raw);
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  return normalizeCredential(data);
}

export function normalizeCredential(data) {
  if (!data || typeof data !== 'object') return null;
  const auth = data.auth || {};
  const account = data.account || (Array.isArray(data.accounts) ? data.accounts[0] : null) || {};
  const token = data.accessToken || data.access_token || auth.accessToken || data.token;
  if (!token || typeof token !== 'string') return null;
  const refreshToken = data.refreshToken || data.refresh_token || auth.refreshToken || '';
  const domain = data.domain || auth.domain || account.domain || '';
  const realm = data.realm || detectRealm({ domain, token }).realm;
  return {
    token,
    refreshToken: String(refreshToken || ''),
    uid: String(data.uid || data.userId || account.uid || ''),
    domain: String(domain || ''),
    enterpriseId: String(data.enterpriseId || data.enterprise_id || account.enterpriseId || ''),
    department: String(data.departmentFullName || data.department || account.departmentFullName || account.department || ''),
    expiresAt: Number(data.expiresAt || auth.expiresAt || 0) || null,
    realm
  };
}

export function jwtExp(token) {
  try {
    const segment = String(token).split('.')[1];
    const padded = segment + '='.repeat((4 - (segment.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8'));
    return Number(payload.exp || 0) || null;
  } catch {
    return null;
  }
}

export function jwtUid(token) {
  try {
    const segment = String(token).split('.')[1];
    const padded = segment + '='.repeat((4 - (segment.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8'));
    return String(payload.sub || '');
  } catch {
    return '';
  }
}

// ---------- 网络 ----------

async function request(url, { method = 'GET', headers, body, timeout = 30000, signal } = {}) {
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    signal: signal || AbortSignal.timeout(timeout)
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, text, json };
}

export async function startLogin(realmName = 'cn', platform = 'web') {
  const cfg = realmOf(realmName);
  const url = `${cfg.base}${WB_PATHS.authState}?platform=${encodeURIComponent(platform)}`;
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/plain, */*',
    'user-agent': cfg.billingUa,
    origin: cfg.origin,
    referer: `${cfg.origin}/`,
    'x-requested-with': 'XMLHttpRequest'
  };
  const { json, text, response } = await request(url, { method: 'POST', headers, body: {} });
  const data = json?.data || {};
  if (!response.ok || !data.state || !data.authUrl) {
    return { ok: false, error: `auth_state_failed_${response.status}`, body: String(text).slice(0, 300) };
  }
  return { ok: true, state: data.state, authUrl: data.authUrl, realm: cfg.realm, platform };
}

export async function pollLogin(state, realmName = 'cn') {
  const cfg = realmOf(realmName);
  const url = `${cfg.base}${WB_PATHS.authToken}?state=${encodeURIComponent(state)}`;
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/plain, */*',
    'user-agent': cfg.billingUa,
    origin: cfg.origin,
    referer: `${cfg.origin}/`,
    'x-requested-with': 'XMLHttpRequest'
  };
  const { json, text, response } = await request(url, { method: 'GET', headers });
  if (!response.ok) return { status: 'error', message: `http_${response.status}`, body: String(text).slice(0, 300) };
  const code = json?.code;
  if (code === LOGIN_PENDING_CODE) return { status: 'pending', message: json?.msg || '等待浏览器扫码登录' };
  if (code !== 0 && code !== '0') return { status: 'error', message: `code=${code} ${json?.msg || ''}`.trim(), body: String(text).slice(0, 300) };
  const data = json?.data || {};
  const token = data.accessToken;
  if (!token) return { status: 'pending', message: '等待令牌下发' };
  const uid = jwtUid(token);
  const domain = data.domain || cfg.domain;
  let nickname = '';
  try {
    const profileUrl = `${cfg.base}${WB_PATHS.loginAccount}?state=${encodeURIComponent(state)}`;
    const profile = await request(profileUrl, {
      method: 'GET',
      headers: { ...headers, authorization: `Bearer ${token}` }
    });
    nickname = String(profile.json?.data?.nickname || '');
  } catch { /* 昵称拿不到不影响登录 */ }
  return {
    status: 'ok',
    credential: {
      accessToken: token,
      refreshToken: data.refreshToken || '',
      uid,
      domain,
      realm: cfg.realm,
      expiresAt: Number(data.expiresAt) || jwtExp(token) || null,
      nickname
    }
  };
}

export async function refreshCredential(cred) {
  const cfg = realmOf(cred.realm);
  const url = `${cfg.base}${WB_PATHS.refresh}`;
  const { json, response, text } = await request(url, {
    method: 'POST',
    headers: buildRefreshHeaders(cred),
    body: {}
  });
  const data = json?.data || {};
  if (!response.ok || (json?.code !== 0 && json?.code !== '0') || !data.accessToken) {
    return { ok: false, status: response.status, code: json?.code, message: json?.msg || String(text).slice(0, 200) };
  }
  return {
    ok: true,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || cred.refreshToken,
    expiresAt: Number(data.expiresAt) || jwtExp(data.accessToken) || null,
    domain: data.domain || cred.domain
  };
}

export async function fetchModels(cred) {
  const cfg = realmOf(cred.realm);
  const local = MODEL_CATALOG.map((item) => ({ ...item, source: 'static' }));
  try {
    // 客户端同款：个人版模型清单
    const { json, response } = await request(`${cfg.base}${WB_PATHS.models}`, {
      method: 'GET',
      headers: buildHeaders(cred, 'billing')
    });
    if (response.ok && json) {
      const list = Array.isArray(json.models) ? json.models : Array.isArray(json.data?.models) ? json.data.models : [];
      const entries = list
        .filter((item) => !(Array.isArray(item?.tags) && item.tags.map(String).includes('text-to-image')))
        .map((item) => {
          const id = typeof item === 'string' ? item : item.id || item.model || item.ModelId;
          if (!id) return null;
          const known = modelInfo(id);
          return {
            id,
            name: (typeof item === 'object' && (item.name || item.displayName || item.ModelName)) || known?.name || id,
            credits: known ? known.credits : null,
            source: 'upstream'
          };
        })
        .filter(Boolean);
      if (entries.length) {
        // 官方接口没给的模型（新上线的）也能从静态表补进来，前端据此展示倍率
        const seen = new Set(entries.map((item) => item.id));
        for (const item of MODEL_CATALOG) {
          if (!seen.has(item.id)) entries.push({ ...item, source: 'static' });
        }
        return {
          ok: true,
          models: entries.filter((item) => isChatModel(item.id)).map((item) => item.id),
          catalog: entries,
          source: 'upstream'
        };
      }
    }
  } catch { /* 落到静态清单 */ }
  return {
    ok: true,
    models: CHAT_MODEL_IDS.slice(),
    catalog: local,
    source: 'static'
  };
}

// 排队状态：客户端在发消息前会查这个，参考它的 body 与返回
export async function queueStatus(cred, model) {
  const cfg = realmOf(cred.realm);
  const { json, response, text } = await request(`${cfg.base}${WB_PATHS.queueStatus}`, {
    method: 'POST',
    headers: buildHeaders(cred, 'chat'),
    body: { model: model || 'auto' },
    timeout: 15000
  });
  if (!response.ok) return { ok: false, status: `http_${response.status}`, body: text.slice(0, 200) };
  const data = json?.data || {};
  return { ok: true, status: String(data.status || 'unknown'), queue: data };
}

// 上游只接受 stream:true，非流式会被 11101 拒绝；这里统一聚合成完整 JSON
// 注意：不能走 request()，它会把 body 读干，导致流被锁
export async function chatCompletion(cred, payload) {
  const cfg = realmOf(cred.realm);
  const body = { ...payload, stream: true };
  delete body.stream_options;
  const response = await fetch(`${cfg.base}${WB_PATHS.chat}`, {
    method: 'POST',
    headers: { ...buildHeaders(cred, 'chat'), accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000)
  });
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    return { ok: false, status: response.status, body: text.slice(0, 600) };
  }
  return { ok: true, stream: response.body, contentType: response.headers.get('content-type') || '' };
}

export async function aggregateStream(stream, { model = '' } = {}) {
  const decoder = new TextDecoder();
  let buffer = '';
  const content = [];
  const reasoning = [];
  let role = 'assistant';
  let finishReason = null;
  let usage = null;
  const toolCalls = [];

  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('data:')) continue;
      const chunk = line.slice(5).trim();
      if (!chunk || chunk === '[DONE]') continue;
      let obj = null;
      try {
        obj = JSON.parse(chunk);
      } catch {
        continue;
      }
      const choice = (obj.choices || [])[0] || {};
      const delta = choice.delta || {};
      if (delta.role) role = delta.role;
      if (typeof delta.content === 'string' && delta.content) content.push(delta.content);
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) reasoning.push(delta.reasoning_content);
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index2 = Number(call.index || 0);
          toolCalls[index2] = toolCalls[index2] || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (call.id) toolCalls[index2].id = call.id;
          if (call.function?.name) toolCalls[index2].function.name += call.function.name;
          if (call.function?.arguments) toolCalls[index2].function.arguments += call.function.arguments;
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (obj.usage) usage = obj.usage;
    }
  }

  const message = { role, content: content.join('') || null };
  if (reasoning.length) message.reasoning_content = reasoning.join('');
  if (toolCalls.length) message.tool_calls = toolCalls.filter(Boolean);
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason || 'stop' }],
    usage
  };
}

export async function checkinStatus(cred) {
  const cfg = realmOf(cred.realm);
  let lastBody = '';
  let fallback = null;
  for (const path of WB_PATHS.checkinStatusList) {
    const { json, response, text } = await request(`${cfg.base}${path}`, {
      method: 'POST',
      headers: buildHeaders(cred, 'billing'),
      body: {}
    });
    if (!response.ok) { lastBody = `http_${response.status} ${text.slice(0, 120)}`; continue; }
    const data = json?.data || {};
    const built = {
      ok: true,
      path,
      checkedIn: Boolean(
        data.today_checked_in ?? data.checkedIn ?? data.checked_in ?? data.signed ??
        data.todayChecked ?? data.is_checked_in ?? data.checkin_status === 1
      ),
      total: Number(data.total_credits ?? data.totalCredit ?? 0),
      today: Number(data.today_credit ?? data.todayCredit ?? 0),
      streak: Number(data.streak_days ?? data.streakDays ?? data.continuous_days ?? 0),
      activity: data.activity_name || data.activityName || '',
      raw: json
    };
    // 新接口 checkin-status 可能返回 active:false（活动未生效、数据全 0），
    // 此时要继续试旧接口 checkin-activity-status，那里才有真实签到数据。
    if (data.active === false) { if (!fallback) fallback = built; continue; }
    return built;
  }
  return fallback || { ok: false, body: lastBody };
}

export async function dailyCheckin(cred) {
  const cfg = realmOf(cred.realm);
  const { json, response, text } = await request(`${cfg.base}${WB_PATHS.checkin}`, {
    method: 'POST',
    headers: buildHeaders(cred, 'billing'),
    body: {}
  });
  // 上游把「今天已签到」用 HTTP 400 + code 10001 返回，这其实是成功态，不是失败
  if (!response.ok) {
    if (json?.code === 10001) return { ok: true, alreadyDone: true, raw: json, message: json?.msg };
    return { ok: false, status: response.status, reason: `http_${response.status}`, body: text.slice(0, 300) };
  }
  const code = json?.code;
  if (code === 0 || code === '0') return { ok: true, raw: json, data: json?.data };
  if (code === 10001) return { ok: true, alreadyDone: true, raw: json };
  return { ok: false, code, message: json?.msg || String(text).slice(0, 200) };
}

// 成长体系（连签/旅行奖励）：桌面端 Bearer 通道走 /v2/activity/growth/buddy/*
// 客户端 GrowthFacade 只传这几个头，这里按原样对齐
function pickDeep(source, matchers, depth = 0) {
  if (!source || typeof source !== 'object' || depth > 3) return undefined;
  for (const [key, value] of Object.entries(source)) {
    const lower = key.toLowerCase();
    if (matchers.some((re) => re.test(lower)) && (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string')) {
      return value;
    }
  }
  for (const value of Object.values(source)) {
    if (value && typeof value === 'object') {
      const found = pickDeep(value, matchers, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function summarizeGrowth(data) {
  if (!data || typeof data !== 'object') return null;
  const num = (value) => (value === undefined || value === null || value === '' ? null : Number(value));
  return {
    level: num(pickDeep(data, [/^level$/, /level_?id/, /grade/])),
    levelName: pickDeep(data, [/(level|grade).*(name|title)/]) || null,
    streakDays: num(pickDeep(data, [/streak/, /continuous/, /^days?$/, /serial/])),
    totalDays: num(pickDeep(data, [/total.*day/, /sign.*count/, /^count$/])),
    points: num(pickDeep(data, [/point/, /credit/, /coin/])),
    canClaim: pickDeep(data, [/can_?claim/, /claimable/, /^unclaimed/]) ?? null,
    claimed: pickDeep(data, [/^claimed$/, /is_?claim/]) ?? null,
    travel: data.travel ?? data.Travel ?? data.travelInfo ?? null,
    raw: data
  };
}

export async function growthInfo(cred) {
  const cfg = realmOf(cred.realm);
  const { json, response, text } = await request(`${cfg.base}${WB_PATHS.growthInfo}`, {
    method: 'GET',
    headers: buildHeaders(cred, 'growth')
  });
  if (!response.ok) return { ok: false, status: response.status, body: text.slice(0, 200) };
  if (json?.code !== 0 && json?.code !== '0') return { ok: false, code: json?.code, message: json?.msg || '' };
  const data = json?.data || null;
  return { ok: true, data, summary: summarizeGrowth(data) };
}

export async function claimTravel(cred) {
  const cfg = realmOf(cred.realm);
  const { json, response, text } = await request(`${cfg.base}${WB_PATHS.travelClaim}`, {
    method: 'POST',
    headers: buildHeaders(cred, 'growth'),
    body: {}
  });
  if (!response.ok) return { ok: false, status: response.status, body: text.slice(0, 200) };
  if (typeof json?.code === 'number' && json.code !== 0) {
    return { ok: false, code: json.code, message: json.msg || '' };
  }
  return { ok: true, raw: json };
}

// 额度：优先走客户端 5.8.x 的三段式（summary + 付费包 + 免费切片包），失败再退回旧接口
async function fetchResourcePage(cred, path, packageCodes, extra) {
  const cfg = realmOf(cred.realm);
  const collected = [];
  let totalCount = 0;
  for (let page = 1; page <= 5; page += 1) {
    const { json, response } = await request(`${cfg.base}${path}`, {
      method: 'POST',
      headers: { ...buildHeaders(cred, 'billing'), 'accept-language': cred.realm === 'intl' ? 'en' : 'zh' },
      body: {
        PageNumber: page,
        PageSize: 200,
        PackageCodes: packageCodes,
        Status: [0, 3],
        ...extra
      }
    });
    if (!response.ok) break;
    const data = json?.data;
    if (!data) break;
    const accounts = Array.isArray(data.Accounts) ? data.Accounts : [];
    collected.push(...accounts);
    totalCount = Number(data.TotalCount) || totalCount;
    if (accounts.length < 200 || collected.length >= totalCount) break;
  }
  return collected;
}

export async function fetchBalance(cred) {
  const cfg = realmOf(cred.realm);
  const errors = [];

  let summary = null;
  try {
    const { json, response } = await request(`${cfg.base}${WB_PATHS.resourceSummary}`, {
      method: 'POST',
      headers: { ...buildHeaders(cred, 'billing'), 'accept-language': cred.realm === 'intl' ? 'en' : 'zh' },
      body: {}
    });
    if (response.ok && json?.data) summary = json.data;
  } catch (error) {
    errors.push(`summary:${String(error?.message || error).slice(0, 60)}`);
  }

  let resources = [];
  try {
    const window = slicePeriodRange();
    const paid = await fetchResourcePage(cred, WB_PATHS.resourcePaid, PAID_PACKAGE_CODES, { NeedRenewInfo: true });
    const free = await fetchResourcePage(cred, WB_PATHS.resourceFree, FREE_PACKAGE_CODES, window);
    resources = [...paid, ...free];
  } catch (error) {
    errors.push(`packages:${String(error?.message || error).slice(0, 60)}`);
  }

  if (resources.length || summary?.Packages?.length) {
    const seen = new Set();
    let total = 0;
    let left = 0;
    const packages = [];
    for (const raw of resources) {
      const key = String(raw?.ResourceId ?? `${raw?.PackageCode}-${raw?.CycleStartTime ?? ''}`);
      if (seen.has(key)) continue;
      seen.add(key);
      const capacity = resourceCapacity(raw);
      total += capacity.total;
      left += capacity.left;
      packages.push({
        code: raw?.PackageCode || '',
        name: raw?.PackageName || '',
        total: capacity.total,
        left: capacity.left,
        slice: capacity.slice
      });
    }
    // 明细接口全挂时，退到 summary 的聚合口径
    if (!packages.length && Array.isArray(summary?.Packages)) {
      for (const item of summary.Packages) {
        const t = Number(item?.CycleTotalCapacity) || 0;
        const l = Number(item?.CycleRemainCapacity) || 0;
        total += t;
        left += l;
        packages.push({ code: item?.PackageCode || '', name: '', total: t, left: l, slice: false });
      }
    }
    if (total > 0 || left > 0) {
      return {
        ok: true,
        total: Math.round(total * 100) / 100,
        available: Math.round(left * 100) / 100,
        used: Math.max(0, Math.round((total - left) * 100) / 100),
        packages: packages.length,
        detail: packages.slice(0, 20),
        isPaidUser: Boolean(summary?.IsPaidUser),
        subscription: summary?.SubscriptionPackageCode || '',
        source: 'v2',
        warnings: errors
      };
    }
  }

  // 兼容旧链路：get-user-resource（部分账号/老版本仍只认这个）
  const legacyBody = {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageStartTimeRangeBegin: '2024-12-01 21:25:00',
    PackageStartTimeRangeEnd: '2030-12-31 23:59:59'
  };
  const { json, response, text } = await request(`${cfg.base}${WB_PATHS.resourceLegacy}`, {
    method: 'POST',
    headers: buildHeaders(cred, 'billing'),
    body: legacyBody
  });
  if (!response.ok) return { ok: false, status: response.status, body: text.slice(0, 300), warnings: errors };
  const accounts = json?.data?.Response?.Data?.Accounts || [];
  let lifetime = 0;
  let cycle = 0;
  let cycleKnown = false;
  for (const item of accounts) {
    lifetime += Number(item.CapacityRemainPrecise || 0);
    if (item.CycleCapacityRemainPrecise !== undefined && item.CycleCapacityRemainPrecise !== null) {
      cycle += Number(item.CycleCapacityRemainPrecise || 0);
      cycleKnown = true;
    }
  }
  const available = cycleKnown ? Math.min(lifetime, cycle) : lifetime;
  return {
    ok: true,
    total: Math.round(lifetime * 100) / 100,
    available: Math.round(available * 100) / 100,
    used: Math.max(0, Math.round((lifetime - available) * 100) / 100),
    packages: accounts.length,
    source: 'legacy',
    warnings: errors,
    raw: json
  };
}

export async function listTasks(cred) {
  const cfg = realmOf(cred.realm);
  const { json, response, text } = await request(`${cfg.base}${WB_PATHS.tasks}`, {
    method: 'GET',
    headers: buildHeaders(cred, 'billing')
  });
  if (!response.ok) return { ok: false, status: response.status, tasks: [], body: text.slice(0, 300) };
  const list = json?.data?.tasks || [];
  return {
    ok: true,
    tasks: list.map((task) => ({
      id: task.code || task.task_code || task.id || null,
      title: task.title || task.name || task.task_name || '未命名任务',
      done: Boolean(task.claimed || task.completed || task.done || task.status === 'claimed'),
      status: task.status || '',
      raw: task
    }))
  };
}

export async function acceptTasks(cred, codes) {
  if (!codes.length) return { ok: true, skipped: true };
  const cfg = realmOf(cred.realm);
  const { json, response, text } = await request(`${cfg.base}${WB_PATHS.taskAccept}`, {
    method: 'POST',
    headers: buildHeaders(cred, 'chat'),
    body: { task_codes: codes }
  });
  if (!response.ok) return { ok: false, status: response.status, body: text.slice(0, 300) };
  return { ok: true, raw: json };
}

export async function claimTask(cred, code) {
  const cfg = realmOf(cred.realm);
  const url = String(cfg.claimBase || WB_PATHS.taskClaim).replace('{code}', encodeURIComponent(code || ''));
  const { json, response, text } = await request(url, {
    method: 'POST',
    headers: buildHeaders(cred, 'billing'),
    body: {}
  });
  if (!response.ok) return { ok: false, status: response.status, body: text.slice(0, 300) };
  return { ok: true, raw: json, alreadyDone: /replayed|already/i.test(text) };
}
