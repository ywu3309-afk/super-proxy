import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as agents from './src/agents.mjs';
import { Automation } from './src/automation.mjs';
import * as atrest from './src/atrest.mjs';
import * as desktop from './src/desktop.mjs';
import * as keyhunt from './src/keyhunt.mjs';
import { cdpPortsFromEnv, findClientExe, grabCredential as cdpGrabCredential, relaunchWithCdp, scan as cdpScan } from './src/cdp.mjs';
import { parseCurl } from './src/curl.mjs';
import { describeAccount, Scheduler } from './src/scheduler.mjs';
import { Store, settingsForClient } from './src/store.mjs';
import { resolveUpstreamModel, Upstream, upstreamErrorBrief } from './src/upstream.mjs';
import { isVault, open as openVault, seal as sealVault } from './src/vault.mjs';
import { parseCredential as wbParseCredential, pollLogin as wbPollLogin, startLogin as wbStartLogin } from './src/workbuddy.mjs';
import { clampInt, localDate, maskSecret, nowIso, safeNumber } from './src/util.mjs';

const PROJECT_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(PROJECT_DIR, 'web');
const MAX_BODY_BYTES = 12 * 1024 * 1024;

// 模型定价表（每百万 token 的 OpenRouter 参考价），移植自公开项目 workbuddy2api-hub，
// 用于看板「等价花费」折算。缺失时降级为空表，不影响其它功能。
const PRICING_FILE = join(PROJECT_DIR, 'pricing', 'pricing.json');
let PRICING = { meta: {}, models: {} };
try {
  PRICING = JSON.parse(await readFile(PRICING_FILE, 'utf8'));
} catch {
  PRICING = { meta: {}, models: {} };
}

// 单笔请求的等价花费：input 按缓存未命中价、output 按输出价，单位 USD → CNY。
function pricingCostFor(model, inputTokens, outputTokens) {
  const entry = PRICING.models?.[model] || PRICING.models?.[resolveUpstreamModel(model)] || null;
  if (!entry || !entry.flat) return null;
  const unit = safeNumber(entry.unit, 1000000);
  const inMiss = safeNumber(entry.flat.input_cache_miss ?? entry.flat.input, 0);
  const out = safeNumber(entry.flat.output, 0);
  const usd = (inMiss * safeNumber(inputTokens, 0) + out * safeNumber(outputTokens, 0)) / unit;
  const cny = usd * safeNumber(PRICING.meta?.usd_cny, 7.1);
  return { usd, cny };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

/**
 * 网关对外的模型别名 → 上游真实模型 ID（定义在 src/upstream.mjs 里，便于单测）。
 * 客户端（DSH / Claude Code / Codex）只看到这三个名字；上游要的是它自己那张表里的 ID，
 * 直接把别名转发上去会被判 400。
 */


function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text)
  });
  res.end(text);
}

// ---------- SSE 输出：客户端要 stream:true 时，任何上游形态都必须吐 text/event-stream ----------
function sseWriter(res, extraHeaders = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...extraHeaders
  });
  return {
    event(name, data) {
      if (name) res.write(`event: ${name}\n`);
      res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    },
    close() {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  };
}

function sliceText(text, size = 16) {
  const value = String(text || '');
  if (!value) return [''];
  const out = [];
  for (let i = 0; i < value.length; i += size) out.push(value.slice(i, i + size));
  return out;
}

// 把一份完整 chat.completion 拆成 OpenAI SSE 分片
function streamChatCompletion(res, completion, extraHeaders = {}) {
  const sse = sseWriter(res, extraHeaders);
  const created = completion.created || Math.floor(Date.now() / 1000);
  const id = completion.id || `chatcmpl_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const model = completion.model || 'workbuddy-gateway';
  const text = completion.choices?.[0]?.message?.content || '';
  const base = { id, object: 'chat.completion.chunk', created, model };
  sse.event(null, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  for (const piece of sliceText(text)) {
    sse.event(null, { ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
  }
  sse.event(null, { ...base, choices: [{ index: 0, delta: {}, finish_reason: completion.choices?.[0]?.finish_reason || 'stop' }] });
  if (completion.usage) sse.event(null, { ...base, choices: [], usage: completion.usage });
  sse.close();
}

// 把一份完整 Anthropic message 拆成 Anthropic SSE 事件流
function streamAnthropicMessage(res, message, extraHeaders = {}) {
  const sse = sseWriter(res, extraHeaders);
  const text = message.content?.map((part) => part?.text || '').join('') || '';
  const usage = message.usage || {};
  sse.event('message_start', {
    type: 'message_start',
    message: {
      id: message.id,
      type: 'message',
      role: 'assistant',
      model: message.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: usage.input_tokens || 0, output_tokens: 0 }
    }
  });
  sse.event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  for (const piece of sliceText(text)) {
    sse.event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
  }
  sse.event('content_block_stop', { type: 'content_block_stop', index: 0 });
  sse.event('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason || 'end_turn', stop_sequence: null },
    usage: { output_tokens: usage.output_tokens || 0 }
  });
  sse.event('message_stop', { type: 'message_stop' });
  sse.close();
}

// 把一份完整 Responses 对象拆成 Responses SSE 事件流
function streamResponsesObject(res, response, extraHeaders = {}) {
  const sse = sseWriter(res, extraHeaders);
  const text = response.output?.[0]?.content?.[0]?.text || '';
  const itemId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const shell = { ...response, status: 'in_progress', output: [] };
  sse.event('response.created', { type: 'response.created', response: shell });
  sse.event('response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 0,
    item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] }
  });
  sse.event('response.content_part.added', {
    type: 'response.content_part.added',
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] }
  });
  for (const piece of sliceText(text)) {
    sse.event('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: piece
    });
  }
  sse.event('response.output_text.done', {
    type: 'response.output_text.done',
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    text
  });
  sse.event('response.completed', { type: 'response.completed', response });
  sse.close();
}

// 按端点选合适的 SSE 编码
function streamByPath(res, pathname, body, extraHeaders = {}) {
  if (pathname === '/v1/messages') return streamAnthropicMessage(res, body, extraHeaders);
  if (pathname === '/v1/responses') return streamResponsesObject(res, body, extraHeaders);
  return streamChatCompletion(res, body, extraHeaders);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return { raw: '', json: {} };
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return { raw, json: JSON.parse(raw) };
  } catch {
    return { raw, json: {} };
  }
}

function estimateTokens(payload) {
  const explicit = Number(payload?.estimatedTokens ?? payload?.metadata?.estimatedTokens);
  if (Number.isFinite(explicit) && explicit > 0) return Math.ceil(explicit);
  const source = payload?.messages ?? payload?.input ?? payload?.prompt ?? payload ?? '';
  const text = typeof source === 'string' ? source : JSON.stringify(source);
  return Math.max(1, Math.ceil(text.length / 3.2));
}

function completionText(payload) {
  const last = Array.isArray(payload?.messages) ? payload.messages.filter((message) => message?.role === 'user').pop() : null;
  const prompt = typeof last?.content === 'string'
    ? last.content
    : Array.isArray(last?.content)
      ? last.content.map((part) => part?.text || '').join(' ')
      : typeof payload?.input === 'string'
        ? payload.input
        : '';
  const trimmed = String(prompt || '').trim();
  return trimmed ? `[本地模拟] 已收到请求（${trimmed.slice(0, 40)}${trimmed.length > 40 ? '…' : ''}），未调用真实 WorkBuddy 上游。` : '[本地模拟] 已收到请求，未调用真实 WorkBuddy 上游。';
}

// ---------- 端点格式互转：Responses / Anthropic → Chat，再转回 ----------

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text' || part?.type === 'input_text') return part.text || '';
      return '';
    }).join('');
  }
  return '';
}

function toChatPayload(pathname, payload) {
  if (pathname === '/v1/chat/completions') return payload;
  const messages = [];
  if (pathname === '/v1/messages') {
    const system = contentToText(payload.system);
    if (system) messages.push({ role: 'system', content: system });
    for (const message of payload.messages || []) {
      const text = contentToText(message.content);
      messages.push({ role: message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user', content: text });
    }
  } else {
    const input = payload.input;
    if (typeof input === 'string') {
      messages.push({ role: 'user', content: input });
    } else if (Array.isArray(input)) {
      for (const item of input) {
        if (typeof item === 'string') { messages.push({ role: 'user', content: item }); continue; }
        const role = item?.role === 'assistant' ? 'assistant' : 'user';
        messages.push({ role, content: contentToText(item?.content) || String(item?.text || '') });
      }
    }
    if (payload.instructions) messages.unshift({ role: 'system', content: String(payload.instructions) });
  }
  const chat = { model: payload.model, messages };
  const maxTokens = payload.max_tokens ?? payload.max_output_tokens;
  if (maxTokens) chat.max_tokens = maxTokens;
  if (payload.temperature !== undefined) chat.temperature = payload.temperature;
  if (payload.top_p !== undefined) chat.top_p = payload.top_p;
  if (payload.stream) chat.stream = true;
  return chat;
}

function fromChatResult(pathname, chat, model) {
  const message = chat?.choices?.[0]?.message || { role: 'assistant', content: '' };
  const text = message.content || '';
  const usage = chat?.usage || {};
  if (pathname === '/v1/messages') {
    return {
      id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: safeNumber(usage.prompt_tokens, 0),
        output_tokens: safeNumber(usage.completion_tokens, 0)
      }
    };
  }
  if (pathname === '/v1/responses') {
    return {
      id: `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model,
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      usage: {
        input_tokens: safeNumber(usage.prompt_tokens, 0),
        output_tokens: safeNumber(usage.completion_tokens, 0),
        total_tokens: safeNumber(usage.total_tokens, 0)
      }
    };
  }
  return chat;
}

const SNIFF_SKIP = /\/(log|logs|track|tracking|report|collect|metrics|sentry|beacon|analytics|event|events|stat|stats|ping|heartbeat)(\/|\?|$)/i;
const SNIFF_CHAT = /(chat\/completions|completions|\/messages|conversation|generate|inference|chat)/i;
const SNIFF_MODELS = /(\/models|model\/list|model_list)/i;
const SNIFF_BALANCE = /(quota|balance|credit|remaining|capacity|usage|limit)/i;
const SNIFF_CHECKIN = /(check-?in|sign-?in|attendance|daily)/i;
const SNIFF_TASK = /(task|mission)/i;
const SNIFF_CLAIM = /(claim|reward|receive|redeem|draw|collect)/i;

function sniffPath(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    return null;
  }
}

function classifySniffed(requests, pageUrl) {
  const items = (requests || []).filter((item) => /^https?:\/\//i.test(String(item.url || '')));
  const api = items.filter((item) => {
    const pathname = sniffPath(item.url);
    if (!pathname) return false;
    if (/\.(js|css|png|jpe?g|gif|svg|webp|woff2?|ttf|ico|map)(\?|$)/i.test(pathname)) return false;
    return !SNIFF_SKIP.test(pathname);
  });

  const hostCount = new Map();
  for (const item of api) {
    try {
      const origin = new URL(item.url).origin;
      hostCount.set(origin, (hostCount.get(origin) || 0) + 1);
    } catch { /* ignore */ }
  }
  let baseUrl = '';
  let pageOrigin = '';
  try { pageOrigin = new URL(pageUrl).origin; } catch { /* ignore */ }
  const ranked = [...hostCount.entries()].sort((a, b) => b[1] - a[1]);
  baseUrl = ranked[0]?.[0] || pageOrigin;

  const scoped = api
    .filter((item) => String(item.url).startsWith(baseUrl))
    .map((item) => ({ ...item, path: sniffPath(item.url) }))
    .filter((item) => item.path);

  const pick = (re, preferMethod) => {
    const hits = scoped.filter((item) => re.test(item.path));
    if (!hits.length) return null;
    const preferred = preferMethod ? hits.find((item) => item.method === preferMethod) : null;
    const target = preferred || hits[hits.length - 1];
    return { path: target.path, method: target.method, body: target.body || null, url: target.url, status: target.status };
  };

  const chat = pick(SNIFF_CHAT, 'POST');
  const models = pick(SNIFF_MODELS, 'GET');
  const balance = pick(SNIFF_BALANCE, 'GET') || pick(SNIFF_BALANCE);
  const checkin = pick(SNIFF_CHECKIN, 'POST');
  const tasks = pick(SNIFF_TASK, 'GET') || pick(SNIFF_TASK);
  const claim = pick(SNIFF_CLAIM, 'POST');

  return {
    baseUrl,
    chatPath: chat?.path || '',
    modelsPath: models?.path || '',
    balancePath: balance?.path || '',
    checkinPath: checkin?.path || '',
    tasksPath: tasks?.path || '',
    claimPath: claim?.path || '',
    details: { chat, models, balance, checkin, tasks, claim },
    totalRequests: api.length
  };
}

function guessQuotaPaths(payload) {
  const found = { total: null, used: null, available: null };
  const rules = [
    ['total', /^(total|total_?capacity|capacity|quota_?size|limit|max|total_?quota|amount)$/i],
    ['used', /^(used|used_?quota|consumed|consumption|spent|usage|total_?capacity_?used)$/i],
    ['available', /^(available|remaining|remain|left|balance|credit|surplus)$/i]
  ];
  const walk = (node, trail, depth) => {
    if (!node || depth > 5) return;
    if (Array.isArray(node)) {
      node.slice(0, 5).forEach((child, index) => walk(child, [...trail, String(index)], depth + 1));
      return;
    }
    if (typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const nextTrail = [...trail, key];
      if (value && typeof value === 'object') {
        walk(value, nextTrail, depth + 1);
        continue;
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      for (const [slot, re] of rules) {
        if (found[slot]) continue;
        if (re.test(key)) found[slot] = nextTrail.join('.');
      }
    }
  };
  walk(payload, [], 0);
  return found;
}

function providerFromUrl(url) {
  try {
    const host = new URL(String(url || '')).hostname.toLowerCase();
    if (!host) return 'WorkBuddy';
    if (host.includes('workbuddy')) return 'WorkBuddy';
    if (host.includes('trae')) return 'Trae';
    if (host.includes('codebuddy')) return 'codebuddy';
    const parts = host.split('.').filter(Boolean);
    const core = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return core ? core.charAt(0).toUpperCase() + core.slice(1) : 'WorkBuddy';
  } catch {
    return 'WorkBuddy';
  }
}

export async function createServer(options = {}) {
  const dataDir = options.dataDir || process.env.WBSIM_DATA_DIR || join(PROJECT_DIR, 'data');
  const stateFile = options.stateFile || process.env.WBSIM_STATE_FILE || join(dataDir, 'state.json');
  const secretsFile = options.secretsFile || join(dataDir, 'secrets.json');

  const store = new Store({ stateFile, secretsFile });
  await store.load();
  const upstream = new Upstream(store);
  const scheduler = new Scheduler(store);
  const automation = new Automation({ store, upstream, scheduler });
  automation.start();
  const loginBridge = options.loginBridge || null;
  const pendingLogins = new Map();
  const sniffSessions = new Map();

  let gatewayPort = options.port ?? null;
  // 定址路由当前请求的 ref（每个请求开头重置，keep-alive 不会串）
  let pinnedRef = null;
  const startedAt = nowIso();

  function accountView(account) {
    const described = describeAccount(account, Date.now(), scheduler.inFlightOf(account.id));
    const meta = store.secretMeta(account.id);
    return {
      ...described,
      uid: String(account.uid || ''),
      hasSecret: store.hasSecret(account.id),
      secretMeta: meta ? { authType: meta.authType, updatedAt: meta.updatedAt } : null,
      secretMasked: meta ? '••••••••' : ''
    };
  }

  function maskedAccounts() {
    return store.listAccounts().map(accountView);
  }

  /**
   * 解析定址路由里的 <ref>：账号 id → 昵称 → uid 精确 → uid 前缀。
   * 同一层命中多个就是歧义，直接报错，绝不猜。
   */
  async function resolvePinnedAccount(ref) {
    const wanted = String(ref || '').trim();
    if (!wanted) return { ok: false, status: 404, reason: 'was not found' };
    const accounts = store.listAccounts();

    const byId = accounts.filter((account) => account.id === wanted);
    if (byId.length === 1) return { ok: true, account: byId[0] };

    const byName = accounts.filter((account) => String(account.label || '').trim() === wanted);
    if (byName.length === 1) return { ok: true, account: byName[0] };
    if (byName.length > 1) return { ok: false, status: 409, reason: 'is ambiguous' };

    // 老账号可能没落 uid，这里从保险箱里补读一次
    const withUid = [];
    for (const account of accounts) {
      let uid = String(account.uid || '');
      if (!uid) {
        const stored = await store.getSecret(account.id).catch(() => null);
        if (stored?.authType === 'workbuddy') {
          const parsed = wbParseCredential(stored.value);
          uid = String(parsed?.uid || '');
        }
      }
      if (!uid) continue;
      withUid.push({ account, uid, exact: uid === wanted });
    }
    const exact = withUid.filter((item) => item.exact);
    if (exact.length === 1) return { ok: true, account: exact[0].account };
    if (exact.length > 1) return { ok: false, status: 409, reason: 'is ambiguous' };

    const prefixed = withUid.filter((item) => item.uid.startsWith(wanted));
    if (prefixed.length === 1) return { ok: true, account: prefixed[0].account };
    if (prefixed.length > 1) return { ok: false, status: 409, reason: 'is ambiguous' };
    return { ok: false, status: 404, reason: 'was not found' };
  }

  function snapshot() {
    const accounts = maskedAccounts();
    const totals = accounts.filter((account) => !account.disabled).reduce((result, account) => {
      result.total += safeNumber(account.quota.total, 0);
      result.used += safeNumber(account.quota.used, 0);
      result.available += account.available;
      if (account.cooling) result.cooling += 1;
      if (account.status === 'auth_error') result.authError += 1;
      return result;
    }, { total: 0, used: 0, available: 0, cooling: 0, authError: 0, count: accounts.length });
    return {
      version: 2,
      mode: store.settings.gateway.mock ? 'simulation' : 'live',
      startedAt,
      today: localDate(new Date(), store.settings.timezone),
      gateway: {
        port: gatewayPort,
        baseUrl: gatewayPort ? `http://127.0.0.1:${gatewayPort}/v1` : null,
        model: store.settings.model,
        mock: Boolean(store.settings.gateway.mock),
        upstreamConfigured: upstream.configured
      },
      settings: settingsForClient(store.settings),
      accounts,
      totals,
      pendingLogins: [...pendingLogins.values()]
        .filter((record) => !record.consumed)
        .map((record) => ({ id: record.id, label: record.label, url: record.url, createdAt: record.createdAt })),
      capabilities: {
        scanLogin: Boolean(loginBridge),
        workbuddyLogin: true,
        liveUpstream: upstream.liveReady
      },
      automation: automation.describe(),
      jobs: store.state.jobs.slice(0, 30),
      events: store.state.events.slice(0, 60),
      requests: store.state.requests.slice(0, 30)
    };
  }

  // ---------- 数据看板：token 与积分消耗的对应关系聚合 ----------
  // 本地账本 reserve 按 1:1 把 token 数记入 quota.used（积分），所以每笔请求的 credits = tokens；
  // 官方另有定价倍率（MODEL_CATALOG.credits），这里一并给出 token×倍率 的官方折算积分作参考。
  // range：today（网关时区的自然日）/ 24h / 7d / all，只影响汇总与分组，趋势图固定最近 24 小时。
  const DASH_RANGES = ['today', '24h', '7d', 'all'];

  function buildDashboard(range = 'all') {
    const wanted = DASH_RANGES.includes(range) ? range : 'all';
    const requests = store.state.requests || [];
    const now = new Date();
    const todayStr = localDate(now, store.settings.timezone);
    const catalogMap = new Map(upstream.modelCatalog().map((item) => [item.id, item]));
    const rangeStart = wanted === '24h' ? now.getTime() - 24 * 3600000
      : wanted === '7d' ? now.getTime() - 7 * 24 * 3600000
        : null;

    const inRange = (iso) => {
      if (!iso) return false;
      const time = new Date(iso).getTime();
      if (!Number.isFinite(time)) return false;
      if (rangeStart !== null && time < rangeStart) return false;
      if (wanted === 'today' && localDate(new Date(time), store.settings.timezone) !== todayStr) return false;
      return true;
    };

    // 只统计成功完成的请求（它们才产生消耗）；失败/被拒的单独计数，用于成功率
    const done = requests.filter((request) => request.status === 'completed' && inRange(request.at));
    const failed = requests.filter((request) => request.status !== 'completed' && inRange(request.at)).length;

    let totalTokens = 0;
    let totalCredits = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalLatencyMs = 0;
    let totalCostCny = 0;
    let todayTokens = 0;
    let todayCredits = 0;
    const byAccount = new Map();
    const byModel = new Map();
    const byHour = new Map();

    for (const request of done) {
      const tokens = safeNumber(request.estimatedTokens ?? request.tokens, 0);
      const credits = safeNumber(request.credits, tokens);
      const input = safeNumber(request.inputTokens, Math.max(0, tokens - safeNumber(request.outputTokens, 0)));
      const output = safeNumber(request.outputTokens, Math.max(0, tokens - input));
      const at = request.at ? new Date(request.at) : null;
      const isToday = at && Number.isFinite(at.getTime()) && localDate(at, store.settings.timezone) === todayStr;

      totalTokens += tokens;
      totalCredits += credits;
      totalInput += input;
      totalOutput += output;
      totalLatencyMs += safeNumber(request.latencyMs, 0);
      const cost = pricingCostFor(request.model, input, output);
      if (cost) totalCostCny += cost.cny;
      if (isToday) { todayTokens += tokens; todayCredits += credits; }

      const accountId = request.accountId || 'unknown';
      if (!byAccount.has(accountId)) {
        byAccount.set(accountId, { accountId, label: request.label || accountId, tokens: 0, credits: 0, requests: 0 });
      }
      const accountRow = byAccount.get(accountId);
      accountRow.tokens += tokens;
      accountRow.credits += credits;
      accountRow.requests += 1;

      const model = request.model || 'unknown';
      if (!byModel.has(model)) byModel.set(model, { model, tokens: 0, credits: 0, inputTokens: 0, outputTokens: 0, costCny: 0, requests: 0 });
      const modelRow = byModel.get(model);
      modelRow.tokens += tokens;
      modelRow.credits += credits;
      modelRow.inputTokens += input;
      modelRow.outputTokens += output;
      if (cost) modelRow.costCny += cost.cny;
      modelRow.requests += 1;

      if (at && Number.isFinite(at.getTime())) {
        const hourKey = Math.floor(at.getTime() / 3600000) * 3600000;
        if (!byHour.has(hourKey)) byHour.set(hourKey, { hour: hourKey, tokens: 0, credits: 0 });
        const hourRow = byHour.get(hourKey);
        hourRow.tokens += tokens;
        hourRow.credits += credits;
      }
    }

    // 积分进项：签到 / 领取事件里带 amount 的部分（与消耗对照，看净值）
    let creditIncome = 0;
    let incomeCount = 0;
    for (const event of store.state.events || []) {
      if (event.type !== 'claim' && event.type !== 'checkin') continue;
      if (!inRange(event.at)) continue;
      const amount = safeNumber(event.amount, 0);
      if (amount > 0) { creditIncome += amount; incomeCount += 1; }
    }

    const accountRows = [...byAccount.values()]
      .sort((a, b) => b.tokens - a.tokens)
      .map((row) => {
        const account = store.getAccount(row.accountId);
        return {
          ...row,
          rate: row.tokens > 0 ? row.credits / row.tokens : null,
          quotaTotal: account?.quota?.total ?? null,
          quotaAvailable: account ? Math.max(0, safeNumber(account.quota?.total, 0) - safeNumber(account.quota?.used, 0)) : null,
          disabled: account?.disabled ?? null
        };
      });

    const modelRows = [...byModel.values()]
      .sort((a, b) => b.tokens - a.tokens)
      .map((row) => {
        const catalogEntry = catalogMap.get(resolveUpstreamModel(row.model)) || catalogMap.get(row.model) || null;
        return {
          ...row,
          name: catalogEntry?.name || row.model,
          officialRate: catalogEntry?.credits ?? null,
          officialCredits: catalogEntry?.credits != null ? Math.round(row.tokens * catalogEntry.credits * 100) / 100 : null,
          costCny: row.costCny > 0 ? Math.round(row.costCny * 10000) / 10000 : null,
          rate: row.tokens > 0 ? row.credits / row.tokens : null
        };
      });

    // 最近 24 小时按小时补全空桶，保证趋势图连续
    const startHour = Math.floor((now.getTime() - 23 * 3600000) / 3600000) * 3600000;
    const endHour = Math.floor(now.getTime() / 3600000) * 3600000;
    const timeline = [];
    for (let hour = startHour; hour <= endHour; hour += 3600000) {
      const hit = byHour.get(hour);
      timeline.push({ hour, tokens: hit?.tokens || 0, credits: hit?.credits || 0 });
    }

    const totalRequests = done.length;
    return {
      ok: true,
      generatedAt: nowIso(),
      range: wanted,
      summary: {
        totalTokens,
        totalCredits,
        totalRequests,
        failedRequests: failed,
        successRate: totalRequests + failed > 0 ? totalRequests / (totalRequests + failed) : null,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        avgLatencyMs: totalRequests > 0 ? Math.round(totalLatencyMs / totalRequests) : null,
        creditIncome,
        incomeCount,
        todayTokens,
        todayCredits,
        totalCostCny: totalCostCny > 0 ? Math.round(totalCostCny * 10000) / 10000 : 0,
        avgRate: totalTokens > 0 ? totalCredits / totalTokens : null
      },
      byAccount: accountRows,
      byModel: modelRows,
      timeline,
      requests: done.slice(0, 60).map((request) => ({
        at: request.at,
        accountId: request.accountId,
        label: request.label,
        model: request.model,
        tokens: safeNumber(request.estimatedTokens ?? request.tokens, 0),
        credits: safeNumber(request.credits, safeNumber(request.estimatedTokens ?? request.tokens, 0)),
        inputTokens: safeNumber(request.inputTokens, 0),
        outputTokens: safeNumber(request.outputTokens, 0),
        mode: request.mode,
        status: request.status,
        latencyMs: request.latencyMs,
        source: request.source
      }))
    };
  }

  function parseMaybeJson(text) {
    if (!text || typeof text !== 'string') return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async function applySniffed(requests, pageUrl, accountId = null, cookieHeader = null) {
    const found = classifySniffed(requests, pageUrl || store.settings.loginUrl || store.settings.officialUrl);
    const current = store.settings.upstream || {};
    const patch = {};

    if (!current.baseUrl && found.baseUrl) patch.baseUrl = found.baseUrl;
    if (!current.chatPath && found.chatPath) patch.chatPath = found.chatPath;
    if (!current.modelsPath && found.modelsPath) patch.modelsPath = found.modelsPath;
    if (!current.balancePath && found.balancePath) patch.balancePath = found.balancePath;
    if (!current.checkinPath && found.checkinPath) patch.checkinPath = found.checkinPath;
    if (!current.tasksPath && found.tasksPath) patch.tasksPath = found.tasksPath;
    if (!current.claimPath && found.claimPath) patch.claimPath = found.claimPath;

    const details = found.details || {};
    if (found.checkinPath && details.checkin) {
      patch.checkin = {
        method: details.checkin.method || 'POST',
        body: parseMaybeJson(details.checkin.body) ?? current.checkin?.body ?? null
      };
    }
    if (found.claimPath && details.claim) {
      patch.claim = {
        method: details.claim.method || 'POST',
        body: parseMaybeJson(details.claim.body) ?? current.claim?.body ?? null
      };
    }
    if (found.tasksPath && details.tasks) {
      patch.tasks = {
        ...(current.tasks || {}),
        method: details.tasks.method || 'GET'
      };
    }

    if (Object.keys(patch).length) {
      await store.patchSettings({ upstream: patch });
      await logEvent('upstream_discovered', {
        baseUrl: patch.baseUrl || current.baseUrl,
        fields: Object.keys(patch).join(',')
      });
    }

    let quotaPaths = null;
    {
      const balancePath = patch.balancePath || current.balancePath;
      const probeAccount = accountId ? store.getAccount(accountId) : { id: '__sniff__' };
      if (balancePath && (accountId || cookieHeader)) {
        try {
          {
            const account = probeAccount;
            const response = await upstream.rawRequest(account, {
              method: 'GET',
              path: balancePath,
              secretOverride: cookieHeader ? { value: cookieHeader, authType: 'cookie' } : null
            });
            const { json } = await upstream.readJsonSafe(response);
            if (response.ok && json) {
              const guessed = guessQuotaPaths(json);
              const clean = {};
              for (const key of ['total', 'used', 'available']) {
                if (guessed[key]) clean[key] = [guessed[key], ...((current.quotaPaths?.[key]) || [])].slice(0, 6);
              }
              if (Object.keys(clean).length) {
                quotaPaths = clean;
                await store.patchSettings({ upstream: { quotaPaths: clean } });
              }
            }
          }
        } catch (error) {
          await logEvent('quota_probe_failed', { message: String(error?.message || error).slice(0, 200) }, 'warn');
        }
      }
    }

    return { found, quotaPaths };
  }

  function logEvent(type, details, level = 'info') {
    return store.pushEvent(type, details, level);
  }

  async function serveStatic(req, res, pathname) {
    const name = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (name.includes('..')) return sendText(res, 400, 'bad path');
    const extension = name.includes('.') ? `.${name.split('.').pop()}` : '';
    try {
      if (extension === '.png' || extension === '.ico') {
        const binary = await readFile(join(WEB_DIR, name));
        res.writeHead(200, { 'content-type': MIME[extension] || 'application/octet-stream', 'cache-control': 'no-store' });
        return res.end(binary);
      }
      const content = await readFile(join(WEB_DIR, name), 'utf8');
      res.writeHead(200, { 'content-type': MIME[extension] || 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(content);
    } catch {
      return sendText(res, 404, 'not found');
    }
  }

  async function handleGateway(req, res, url) {
    const body = await readBody(req);
    const payload = body.json && typeof body.json === 'object' ? body.json : {};
    const estimated = estimateTokens(payload);
    const model = String(payload.model || store.settings.model);
    const cors = { 'access-control-allow-origin': '*' };
    // 网关对外只暴露三个别名，真正的上游模型 ID 在这里落定：
    // auto 让上游自己挑，max/fast 各指一个固定档位。客户端回显仍用请求时的别名。
    const upstreamModel = resolveUpstreamModel(model);

    const requiredKey = String(store.settings.gateway.apiKey || '').trim();
    if (requiredKey) {
      const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
        || String(req.headers['x-api-key'] || '').trim();
      if (provided !== requiredKey) {
        return sendJson(res, 401, { error: { message: 'invalid api key', type: 'authentication_error' } }, cors);
      }
    }

    if (url.pathname === '/v1/models' || url.pathname === '/models') {
      const created = Math.floor(Date.now() / 1000);
      const upstreamModels = [];
      let catalog = [];
      for (const account of store.listAccounts()) {
        if (account.disabled) continue;
        if (store.secretMeta(account.id)?.authType !== 'workbuddy') continue;
        const fetched = await upstream.fetchModels(account).catch(() => ({ models: [], catalog: [] }));
        upstreamModels.push(...(fetched.models || []));
        catalog = fetched.catalog || [];
        break;
      }
      if (!catalog.length) catalog = upstream.modelCatalog();
      const creditsOf = new Map(catalog.map((item) => [item.id, item]));
      // 对外只暴露默认别名 + V4/V4.1 两个 DeepSeek 型号；上游完整目录不外泄，
      // 否则 DSH 这类客户端拉模型目录时会把不可用的型号也列进下拉框。
      const ids = [...new Set([
        store.settings.model,
        'workbuddy-gateway-v1',
        'deepseek-v4-pro',
        'deepseek-v4.1-flash'
      ].filter(Boolean))];
      return sendJson(res, 200, {
        object: 'list',
        data: ids.map((id) => {
          const entry = creditsOf.get(id);
          return {
            id,
            object: 'model',
            created,
            owned_by: store.settings.gateway.mock ? 'local-simulation' : 'workbuddy-scheduler',
            ...(entry ? { name: entry.name, credits: entry.credits } : {})
          };
        })
      }, cors);
    }

    if (!['/v1/chat/completions', '/v1/responses', '/v1/messages'].includes(url.pathname)) {
      return sendJson(res, 404, { error: { message: 'not_found', type: 'invalid_request_error' } });
    }

    const maxAttempts = Math.max(1, Math.min(5, safeNumber(store.settings.gateway.maxAttempts, 3)));
    const tried = [];
    let lastError = null;

    // 定址调用：锁定指到的那一个账号，不参与轮换 / 亲和 / 自动换号
    let pinnedAccount = null;
    if (pinnedRef) {
      const resolved = await resolvePinnedAccount(pinnedRef);
      if (!resolved.ok) {
        return sendJson(res, resolved.status, {
          error: { message: `pinned account '${pinnedRef}' ${resolved.reason}`, type: 'invalid_request_error' }
        });
      }
      pinnedAccount = resolved.account;
      if (pinnedAccount.disabled) {
        return sendJson(res, 409, {
          error: { message: `pinned account '${pinnedRef}' is disabled`, type: 'invalid_request_error' }
        });
      }
      const cooldownUntil = pinnedAccount.cooldownUntil ? new Date(pinnedAccount.cooldownUntil).getTime() : 0;
      if (cooldownUntil > Date.now()) {
        return sendJson(res, 429, {
          error: { message: `pinned account '${pinnedRef}' is cooling down until ${pinnedAccount.cooldownUntil}`, type: 'rate_limit_error' }
        });
      }
    }

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      // 模拟模式按预估 token 硬过滤（本地账本要真实扣减）；live 模式不能这么卡——
      // DSH 这类 agent 客户端的 system prompt 很大，预估 token 轻易超过账号剩余积分，
      // 会导致「没有满足额度条件的可用账号」误杀。真实额度由上游判定（429/402 会进冷却）。
      const required = store.settings.gateway.mock ? estimated : 1;
      const account = pinnedAccount
        ? (attempt === 0 ? pinnedAccount : null)
        : scheduler.pick({ requiredTokens: required, exclude: tried });
      if (!account) break;
      tried.push(account.id);
      const startedAt = Date.now();
      scheduler.beginRequest(account.id);

      try {
        if (store.settings.gateway.mock) {
          const text = completionText(payload);
          const simulatedLatency = Math.round(520 + Math.random() * 700 + Math.min(1400, estimated / 18));
          const stamped = Math.floor(Date.now() / 1000);
          const usageTokens = estimated + 24;
          const accountId = account.id;
          let responseBody;
          if (url.pathname === '/v1/responses') {
            responseBody = {
              id: `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
              object: 'response',
              created_at: stamped,
              model,
              status: 'completed',
              output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
              usage: { input_tokens: estimated, output_tokens: 24, total_tokens: usageTokens },
              metadata: { scheduled_account_id: accountId, mode: 'simulation' }
            };
          } else if (url.pathname === '/v1/messages') {
            responseBody = {
              id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
              type: 'message',
              role: 'assistant',
              model,
              content: [{ type: 'text', text }],
              stop_reason: 'end_turn',
              usage: { input_tokens: estimated, output_tokens: 24 }
            };
          } else {
            responseBody = {
              id: `chatcmpl_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
              object: 'chat.completion',
              created: stamped,
              model,
              choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
              usage: { prompt_tokens: estimated, completion_tokens: 24, total_tokens: usageTokens },
              scheduled_account_id: accountId
            };
          }
          await scheduler.reserve(accountId, estimated);
          await scheduler.recordRequest(accountId, { ok: true, tokens: usageTokens, outputTokens: 24, latencyMs: simulatedLatency });
          await store.pushRequest({
            id: randomUUID(),
            source: payload.stream ? 'gateway-stream' : 'gateway',
            accountId,
            label: account.label,
            model,
            estimatedTokens: estimated,
            credits: estimated,
            inputTokens: estimated,
            outputTokens: 24,
            mode: 'simulation',
            status: 'completed',
            latencyMs: simulatedLatency
          });
          const simHeaders = {
            ...cors,
            'x-scheduled-account-id': accountId,
            'x-gateway-mode': 'simulation'
          };
          // 客户端要 stream:true 就必须给 SSE，不能塞回一份 JSON（否则客户端解析器会以为流没开始）
          if (payload.stream) {
            return streamByPath(res, url.pathname, responseBody, simHeaders);
          }
          return sendJson(res, 200, responseBody, simHeaders);
        }

        // 客户端发消息前会先查 /v2/chat/queue/status：排队中的号先冷冻 45s，换下一个号
        if (store.settings.gateway.queueProbe !== false) {
          const probe = await upstream.queueProbe(account, upstreamModel);
          if (probe.busy) {
            await scheduler.markFailure(account.id, { reason: `queue:${probe.raw || probe.status}`, cooldownMs: 45000 });
            await logEvent('gateway_queue_busy', { accountId: account.id, model, status: probe.raw }, 'warn');
            lastError = 'upstream_queue_busy';
            continue;
          }
        }

        // WorkBuddy 原生会话：走 /v2/chat/completions（只吃 stream，非流式在此聚合成完整 JSON）
        const chatPayload = toChatPayload(url.pathname, payload);
        if (url.pathname !== '/v1/chat/completions') delete chatPayload.stream;
        chatPayload.model = upstreamModel;
        let wbResult = null;
        try {
          wbResult = await upstream.chat(account, chatPayload);
        } catch (error) {
          lastError = String(error?.message || error);
          await scheduler.markFailure(account.id, { reason: `network:${lastError}` });
          await scheduler.recordRequest(account.id, { ok: false, tokens: 0, latencyMs: Date.now() - startedAt });
          continue;
        }

        if (wbResult && wbResult.mode === 'none') {
          const fatal = wbResult.status === 401 || wbResult.status === 403;
          await scheduler.markFailure(account.id, { reason: `http_${wbResult.status || 0}`, fatal, ...(fatal ? { status: 'auth_error' } : {}) });
          await scheduler.recordRequest(account.id, { ok: false, tokens: 0, latencyMs: Date.now() - startedAt });
          await logEvent('gateway_error', { accountId: account.id, status: wbResult.status || 0, body: String(wbResult.body || '').slice(0, 200) }, 'error');
          lastError = wbResult.status ? upstreamErrorBrief(wbResult) : 'workbuddy_chat_failed';
          continue;
        }

        if (wbResult && wbResult.mode === 'json') {
          const body = fromChatResult(url.pathname, wbResult.json, model);
          const usage = wbResult.json?.usage || {};
          const actual = safeNumber(usage.total_tokens, estimated);
          await scheduler.markSuccess(account.id);
          await scheduler.reserve(account.id, actual);
          await scheduler.recordRequest(account.id, {
            ok: true,
            tokens: actual,
            outputTokens: safeNumber(usage.completion_tokens, Math.max(8, Math.round(actual * 0.12))),
            latencyMs: Date.now() - startedAt
          });
          await store.pushRequest({
            id: randomUUID(),
            source: 'gateway',
            accountId: account.id,
            label: account.label,
            model,
            estimatedTokens: actual,
            credits: actual,
            inputTokens: safeNumber(usage.prompt_tokens, Math.max(0, actual - safeNumber(usage.completion_tokens, Math.max(8, Math.round(actual * 0.12))))),
            outputTokens: safeNumber(usage.completion_tokens, Math.max(8, Math.round(actual * 0.12))),
            mode: 'live',
            status: 'completed',
            latencyMs: Date.now() - startedAt
          });
          const liveHeaders = {
            'x-scheduled-account-id': account.id,
            'x-gateway-mode': 'live',
            'x-upstream': 'workbuddy'
          };
          // 上游被聚合成整包了（非流式回退），但客户端要的是流：这里补一层 SSE，避免客户端空等
          if (payload.stream) {
            return streamByPath(res, url.pathname, body, liveHeaders);
          }
          return sendJson(res, 200, body, liveHeaders);
        }

        if (wbResult && wbResult.mode === 'stream' && url.pathname === '/v1/chat/completions') {
          await scheduler.markSuccess(account.id);
          res.writeHead(200, {
            'content-type': wbResult.contentType?.includes('text/event-stream') ? wbResult.contentType : 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-scheduled-account-id': account.id,
            'x-gateway-mode': 'live',
            'x-upstream': 'workbuddy',
            ...cors
          });
          const reader = wbResult.stream.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(Buffer.from(value));
            }
          } catch { /* 客户端断开 */ } finally {
            res.end();
          }
          await scheduler.reserve(account.id, estimated);
          await scheduler.recordRequest(account.id, {
            ok: true,
            tokens: estimated,
            outputTokens: Math.max(8, Math.round(estimated * 0.12)),
            latencyMs: Date.now() - startedAt
          });
          await store.pushRequest({
            id: randomUUID(),
            source: 'gateway-stream',
            accountId: account.id,
            label: account.label,
            model,
            estimatedTokens: estimated,
            credits: estimated,
            inputTokens: Math.max(0, estimated - Math.max(8, Math.round(estimated * 0.12))),
            outputTokens: Math.max(8, Math.round(estimated * 0.12)),
            mode: 'live',
            status: 'completed',
            latencyMs: Date.now() - startedAt
          });
          return undefined;
        }

        const path = url.pathname === '/v1/messages'
          ? (store.settings.upstream.messagesPath || '/v1/messages')
          : (store.settings.upstream.chatPath || '/v1/chat/completions');
        let response;
        try {
          response = await upstream.rawRequest(account, {
            method: 'POST',
            path,
            body: payload,
            headers: { accept: payload.stream ? 'text/event-stream' : 'application/json' }
          });
        } catch (error) {
          lastError = String(error?.message || error);
          await scheduler.markFailure(account.id, { reason: `network:${lastError}` });
          await scheduler.recordRequest(account.id, { ok: false, tokens: 0, latencyMs: Date.now() - startedAt });
          await logEvent('gateway_error', { accountId: account.id, message: lastError }, 'error');
          continue;
        }

        if (response.status === 429) {
          await scheduler.markFailure(account.id, {
            reason: 'http_429',
            cooldownMs: safeNumber(store.settings.gateway.cooldownOn429Minutes, 20) * 60 * 1000
          });
          await scheduler.recordRequest(account.id, { ok: false, tokens: 0, latencyMs: Date.now() - startedAt });
          await logEvent('account_cooldown', { accountId: account.id, reason: 'rate_limited' }, 'warn');
          lastError = 'http_429';
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          await scheduler.markFailure(account.id, { reason: `http_${response.status}`, fatal: true, status: 'auth_error' });
          await scheduler.recordRequest(account.id, { ok: false, tokens: 0, latencyMs: Date.now() - startedAt });
          await logEvent('account_auth_error', { accountId: account.id, status: response.status }, 'error');
          lastError = `http_${response.status}`;
          continue;
        }
        if (!response.ok) {
          const failureText = await response.text().catch(() => '');
          await scheduler.markFailure(account.id, { reason: `http_${response.status}` });
          await scheduler.recordRequest(account.id, { ok: false, tokens: 0, latencyMs: Date.now() - startedAt });
          await logEvent('gateway_error', { accountId: account.id, status: response.status, body: failureText.slice(0, 200) }, 'error');
          lastError = `http_${response.status}${failureText ? ` ${failureText.replace(/\s+/g, ' ').slice(0, 80)}` : ''}`;
          continue;
        }

        await scheduler.markSuccess(account.id);
        const contentType = response.headers.get('content-type') || '';
        const isStream = contentType.includes('text/event-stream') || Boolean(payload.stream);

        if (isStream && response.body) {
          res.writeHead(200, {
            'content-type': contentType.includes('text/event-stream') ? contentType : 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-scheduled-account-id': account.id,
            'x-gateway-mode': 'live',
            ...cors
          });
          const reader = response.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(Buffer.from(value));
            }
          } catch {
            /* 客户端断开时静默结束 */
          } finally {
            res.end();
          }
          await scheduler.reserve(account.id, estimated);
          await scheduler.recordRequest(account.id, {
            ok: true,
            tokens: estimated,
            outputTokens: Math.max(8, Math.round(estimated * 0.12)),
            latencyMs: Date.now() - startedAt
          });
          await store.pushRequest({
            id: randomUUID(),
            source: 'gateway-stream',
            accountId: account.id,
            label: account.label,
            model,
            estimatedTokens: estimated,
            credits: estimated,
            inputTokens: Math.max(0, estimated - Math.max(8, Math.round(estimated * 0.12))),
            outputTokens: Math.max(8, Math.round(estimated * 0.12)),
            mode: 'live',
            status: 'completed',
            latencyMs: Date.now() - startedAt
          });
          return undefined;
        }

        const text = await response.text();
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        const usage = parsed?.usage || {};
        const actual = safeNumber(usage.total_tokens, safeNumber(safeNumber(usage.input_tokens, 0) + safeNumber(usage.output_tokens, 0), estimated));
        await scheduler.reserve(account.id, actual);
        await scheduler.recordRequest(account.id, {
          ok: true,
          tokens: actual,
          outputTokens: safeNumber(usage.completion_tokens ?? usage.output_tokens, Math.max(8, Math.round(actual * 0.12))),
          latencyMs: Date.now() - startedAt
        });
        await store.pushRequest({
          id: randomUUID(),
          source: 'gateway',
          accountId: account.id,
          label: account.label,
          model,
          estimatedTokens: actual,
          credits: actual,
          inputTokens: safeNumber(usage.prompt_tokens ?? usage.input_tokens, Math.max(0, actual - safeNumber(usage.completion_tokens ?? usage.output_tokens, Math.max(8, Math.round(actual * 0.12))))),
          outputTokens: safeNumber(usage.completion_tokens ?? usage.output_tokens, Math.max(8, Math.round(actual * 0.12))),
          mode: 'live',
          status: 'completed',
          latencyMs: Date.now() - startedAt
        });
        res.writeHead(200, {
          'content-type': contentType || 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(text),
          'x-scheduled-account-id': account.id,
          'x-gateway-mode': 'live',
          ...cors
        });
        return res.end(text);
      } finally {
        scheduler.endRequest(account.id);
      }
    }

    await store.pushRequest({
      id: randomUUID(),
      source: 'gateway',
      accountId: null,
      model,
      estimatedTokens: estimated,
      mode: store.settings.gateway.mock ? 'simulation' : 'live',
      status: 'rejected',
      error: lastError || 'no_usable_account'
    });
    return sendJson(res, lastError === 'http_429' ? 429 : 503, {
      error: {
        message: lastError ? `所有可用账号都失败了（最后错误：${lastError}）` : '没有满足额度与状态条件的可用账号',
        type: 'scheduler_error',
        tried
      }
    });
  }

  // 客户端 2026-09-24 起把 token 存成 $wbEncrypted 信封：先就地解密再用
  function decodeAtRestCredential(credential) {
    const out = { ...(credential || {}) };
    for (const field of ['accessToken', 'refreshToken', 'nickname']) {
      if (!(field in out)) continue;
      const result = atrest.decryptTokenField(out[field]);
      if (!result.encrypted) continue;
      if (!result.ok) return { ok: false, reason: result.reason === 'key_required' ? 'atrest_key_required' : result.reason };
      out[field] = result.value;
    }
    return { ok: true, credential: out };
  }

  // 把一份 WorkBuddy 登录态登记成账号；同 uid 已存在则只换凭据（相当于「刷新登录」）
  async function registerWorkbuddyAccount(credential, { label } = {}) {
    const decoded = decodeAtRestCredential(credential);
    if (!decoded.ok) return { ok: false, reason: decoded.reason };
    const parsed = wbParseCredential(JSON.stringify(decoded.credential || {}));
    if (!parsed) return { ok: false, reason: 'invalid_workbuddy_session' };

    let target = null;
    if (parsed.uid) {
      for (const account of store.listAccounts()) {
        if (store.secretMeta(account.id)?.authType !== 'workbuddy') continue;
        const stored = await store.getSecret(account.id).catch(() => null);
        if (!stored) continue;
        const current = wbParseCredential(stored.value);
        if (current?.uid && String(current.uid) === String(parsed.uid)) { target = account; break; }
      }
    }

    let account;
    let updated = false;
    if (target) {
      await store.setSecret(target.id, JSON.stringify(parsed), 'workbuddy');
      await store.updateAccount(target.id, { uid: String(parsed.uid || '') });
      await scheduler.clearError(target.id).catch(() => {});
      account = store.getAccount(target.id);
      updated = true;
    } else {
      account = await store.addAccount({
        label: label || parsed.uid || 'WorkBuddy 账号',
        provider: 'WorkBuddy',
        region: parsed.realm === 'intl' ? '国际服' : '国服',
        uid: String(parsed.uid || ''),
        secret: JSON.stringify(parsed),
        authType: 'workbuddy',
        status: 'available'
      });
    }

    // 立刻拉一次额度，顺带验证凭据还能用
    let balance = null;
    try {
      balance = await upstream.fetchBalance(account);
    } catch (error) {
      balance = { ok: false, reason: String(error?.message || error) };
    }
    if (balance?.ok) {
      await store.updateAccount(account.id, {
        quota: { total: safeNumber(balance.total, 0), used: safeNumber(balance.used, 0) },
        status: 'available',
        health: 'healthy',
        lastError: null,
        errorCount: 0,
        cooldownUntil: null,
        lastRefreshAt: nowIso()
      });
    } else {
      await store.updateAccount(account.id, {
        health: 'error',
        status: 'auth_error',
        lastError: { reason: balance?.reason || 'balance_failed', at: nowIso(), detail: String(balance?.body || '').slice(0, 300) }
      });
    }
    return {
      ok: true,
      account: store.getAccount(account.id),
      updated,
      balance: balance?.ok ? { total: balance.total, available: balance.available, used: balance.used } : null,
      balanceError: balance?.ok ? null : (balance?.reason || 'balance_failed')
    };
  }

  async function handleApi(req, res, url) {
    const method = req.method;
    const path = url.pathname;

    if (method === 'GET' && path === '/api/state') return sendJson(res, 200, snapshot());

    // 数据看板：token 与积分消耗的对应关系（汇总 / 按账号 / 按模型 / 24h 趋势 / 明细）
    if (method === 'GET' && path === '/api/dashboard') {
      return sendJson(res, 200, buildDashboard(url.searchParams.get('range') || 'all'));
    }

    // 官方模型目录（带 credits 倍率），前端展示与选型用
    if (method === 'GET' && path === '/api/catalog') {
      return sendJson(res, 200, {
        ok: true,
        catalog: upstream.modelCatalog(),
        default: store.settings.model
      });
    }

    // ---------- 智能体一键配置（DSH / Claude Code / Codex / OpenCode / Crush / ZCode） ----------
    if (method === 'GET' && path === '/api/agents') {
      return sendJson(res, 200, {
        ok: true,
        clients: agents.overview(store.dataDir || dataDir),
        gateway: {
          baseUrl: gatewayPort ? `http://127.0.0.1:${gatewayPort}` : null,
          baseUrlV1: gatewayPort ? `http://127.0.0.1:${gatewayPort}/v1` : null,
          model: store.settings.model,
          apiKey: String(store.settings.gateway.apiKey || '')
        }
      });
    }

    if (method === 'POST' && path === '/api/agents/apply') {
      const { json: body } = await readBody(req);
      const clientId = String(body.client || '').trim();
      if (!agents.CLIENTS[clientId]) {
        return sendJson(res, 400, { error: 'unknown_client', known: Object.keys(agents.CLIENTS) });
      }
      const apiKey = String(store.settings.gateway.apiKey || '').trim() || 'sk-local-gateway';
      const model = String(body.model || store.settings.model || '').trim();
      // 用户只用 DeepSeek V4 与 V4.1 两个型号：DSH 列表固定三项（默认别名 + 两个真实型号），
      // 其余型号（含 v4-flash / v3 系）一律不列。
      const deepseekIds = [
        'workbuddy-gateway-v1',   // → deepseek-v4-pro（默认）
        'deepseek-v4-pro',
        'deepseek-v4.1-flash'
      ];
      const models = deepseekIds.map((id) => ({
        id,
        context_window: 200000,
        max_output: 64000,
        reasoning_efforts: null,
        supports_vision: true
      }));
      if (model && !models.some((item) => item.id === model)) {
        models.unshift({ id: model, context_window: 200000, max_output: 64000, reasoning_efforts: null, supports_vision: true });
      }
      try {
        const result = agents.apply(clientId, {
          baseUrl: gatewayPort ? `http://127.0.0.1:${gatewayPort}` : 'http://127.0.0.1:8787',
          baseUrlV1: gatewayPort ? `http://127.0.0.1:${gatewayPort}/v1` : 'http://127.0.0.1:8787/v1',
          apiKey,
          model,
          models
        }, { dataDir: store.dataDir || dataDir });
        await store.pushEvent('agent_configured', { client: clientId, files: result.files }, 'info');
        return sendJson(res, 200, { ok: true, ...result, snapshot: snapshot() });
      } catch (error) {
        return sendJson(res, 400, { error: 'apply_failed', message: String(error?.message || error) });
      }
    }

    if (method === 'POST' && path === '/api/agents/restore') {
      const { json: body } = await readBody(req);
      const clientId = String(body.client || '').trim();
      try {
        const result = agents.restore(clientId, { dataDir: store.dataDir || dataDir });
        await store.pushEvent('agent_restored', { client: clientId }, 'info');
        return sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        return sendJson(res, 400, { error: 'restore_failed', message: String(error?.message || error) });
      }
    }

    // ---------- 从桌面客户端 .info 文件导入（客户端没开也能用，需要密钥） ----------
    if (method === 'GET' && path === '/api/desktop/scan') {
      const items = desktop.scanDesktopCredentials().map((item) => ({
        path: item.path,
        realm: item.realm,
        ok: item.ok,
        encrypted: item.encrypted,
        keyRequired: item.keyRequired,
        reason: item.reason || null,
        account: item.account ? {
          uid: item.account.uid,
          nickname: item.account.nickname,
          expiresAt: item.account.expiresAt,
          hasToken: Boolean(item.account.accessToken)
        } : null
      }));
      return sendJson(res, 200, { ok: true, items, key: atrest.hasKey(), dirs: desktop.desktopAuthDirs() });
    }

    if (method === 'POST' && path === '/api/desktop/import') {
      const items = desktop.scanDesktopCredentials().filter((item) => item.ok);
      if (!items.length) {
        const any = desktop.scanDesktopCredentials();
        const needKey = any.some((item) => item.keyRequired);
        return sendJson(res, 409, {
          error: needKey ? 'atrest_key_required' : 'no_credential_file',
          message: needKey ? '凭据是加密信封，先回收或粘贴密钥' : '没找到可导入的 .info 凭据文件'
        });
      }
      const results = [];
      for (const item of items) {
        const registered = await registerWorkbuddyAccount(JSON.parse(desktop.toSessionJson(item)), {
          label: item.account.nickname || item.account.uid
        });
        results.push({
          path: item.path,
          uid: item.account.uid,
          ok: Boolean(registered.ok),
          reason: registered.reason || null,
          accountId: registered.account?.id || null,
          updated: Boolean(registered.updated)
        });
      }
      await store.pushEvent('desktop_imported', { count: results.filter((item) => item.ok).length }, 'info');
      return sendJson(res, 200, { ok: true, imported: results.filter((item) => item.ok).length, results, snapshot: snapshot() });
    }

    // ---------- 桌面客户端 at-rest 凭据密钥 ----------
    if (method === 'GET' && path === '/api/atrest') {
      return sendJson(res, 200, { ok: true, ...atrest.status() });
    }

    if (method === 'POST' && path === '/api/atrest/key') {
      const { json: body } = await readBody(req);
      try {
        const result = atrest.adoptKey(body.key);
        await store.pushEvent('atrest_key_adopted', { keyId: result.keyId }, 'info');
        return sendJson(res, 200, { ok: true, ...result, ...atrest.status() });
      } catch (error) {
        return sendJson(res, 400, { error: 'key_rejected', message: String(error?.message || error) });
      }
    }

    if (method === 'POST' && path === '/api/atrest/forget') {
      atrest.forgetKey();
      return sendJson(res, 200, { ok: true, ...atrest.status() });
    }

    // 从运行中的客户端进程内存里回收密钥（只读，通常 40~90 秒）
    if (method === 'POST' && path === '/api/atrest/recover') {
      const { json } = await readBody(req);
      if (!atrest.status().keyblob) {
        return sendJson(res, 400, { error: 'no_keyblob', message: '没找到 keyblob，说明这台机器的客户端还没用加密凭据' });
      }
      const result = await keyhunt.recoverKey({ processName: json?.process || null });
      if (!result.ok) {
        await store.pushEvent('atrest_recover_failed', { reason: result.reason }, 'warn');
        return sendJson(res, 409, { error: 'recover_failed', message: result.reason });
      }
      await store.pushEvent('atrest_key_recovered', { keyId: result.keyId, process: result.process, candidates: result.candidates }, 'info');
      return sendJson(res, 200, { ok: true, ...result, ...atrest.status() });
    }

    // ---------- 账号池加密备份（换电脑迁移用） ----------
    if (method === 'POST' && path === '/api/vault/export') {
      const { json } = await readBody(req);
      const password = String(json?.password || '');
      if (password.length < 6) {
        return sendJson(res, 400, { ok: false, error: 'password_too_short', message: '口令至少 6 位' });
      }
      const accounts = [];
      for (const account of store.listAccounts()) {
        const stored = await store.getSecret(account.id).catch(() => null);
        accounts.push({
          label: account.label,
          provider: account.provider,
          region: account.region,
          batch: account.batch || '',
          role: account.role || '',
          notes: account.notes || '',
          officialUrl: account.officialUrl || '',
          authType: stored?.authType || null,
          secret: stored?.value || null,
          quota: account.quota,
          disabled: Boolean(account.disabled),
          auto: account.auto || null
        });
      }
      let blob;
      try {
        blob = sealVault({
          app: 'workbuddy-gateway',
          version: 1,
          exportedAt: nowIso(),
          accounts,
          settings: { model: store.settings.model }
        }, password);
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: String(error?.message || error) });
      }
      await logEvent('vault_exported', { accounts: accounts.length });
      return sendJson(res, 200, {
        ok: true,
        count: accounts.length,
        filename: `WorkBuddy-账号备份-${localDate()}.json`,
        vault: blob
      });
    }

    if (method === 'POST' && path === '/api/vault/import') {
      const { json } = await readBody(req);
      const password = String(json?.password || '');
      const payload = openVault(json?.vault, password);
      if (!payload || !Array.isArray(payload.accounts)) {
        return sendJson(res, 400, { ok: false, error: 'vault_open_failed', message: '口令不对，或备份文件已损坏' });
      }
      const results = { total: payload.accounts.length, imported: 0, updated: 0, skipped: 0, failed: 0, details: [] };
      for (const item of payload.accounts) {
        if (!item?.secret) { results.skipped += 1; continue; }
        try {
          if (item.authType === 'workbuddy') {
            const registered = await registerWorkbuddyAccount(JSON.parse(item.secret), { label: item.label });
            if (registered.ok) {
              if (registered.updated) results.updated += 1;
              else {
                results.imported += 1;
                if (item.batch || item.role || item.notes) {
                  await store.updateAccount(registered.account.id, {
                    batch: item.batch || undefined,
                    role: item.role || undefined,
                    notes: item.notes || undefined
                  });
                }
              }
            } else {
              results.failed += 1;
              results.details.push(`${item.label}:${registered.reason}`);
            }
          } else {
            await store.addAccount({
              label: item.label || '导入账号',
              provider: item.provider || 'WorkBuddy',
              region: item.region || '国服',
              batch: item.batch || '',
              role: item.role || '',
              notes: item.notes || '',
              officialUrl: item.officialUrl || '',
              secret: item.secret,
              authType: item.authType || 'cookie',
              total: safeNumber(item.quota?.total, 0),
              used: safeNumber(item.quota?.used, 0),
              disabled: Boolean(item.disabled),
              status: 'available'
            });
            results.imported += 1;
          }
        } catch (error) {
          results.failed += 1;
          results.details.push(`${item.label}:${String(error?.message || error).slice(0, 120)}`);
        }
      }
      await logEvent('vault_imported', { ...results, details: undefined, at: nowIso() });
      return sendJson(res, 200, { ok: true, results, snapshot: snapshot() });
    }

    // ---------- 从本机客户端直接取登录态（CDP） ----------
    if (method === 'GET' && path === '/api/cdp/scan') {
      const portsParam = String(url.searchParams.get('ports') || '').trim();
      const ports = portsParam
        ? portsParam.split(/[,\s]+/).map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0 && item < 65536)
        : cdpPortsFromEnv();
      const targets = await cdpScan({ ports }).catch(() => []);
      return sendJson(res, 200, {
        ok: true,
        ports,
        targets,
        ready: targets.length > 0,
        clientExe: findClientExe(),
        hint: targets.length
          ? '已找到调试端口，可以直接导入'
          : '没检测到调试端口。点「以调试模式重启客户端」，客户端重开后再点导入'
      });
    }

    if (method === 'POST' && path === '/api/cdp/import') {
      const { json } = await readBody(req);
      const port = Number(json?.port) || 9222;
      const grabbed = await cdpGrabCredential({
        port,
        webSocketDebuggerUrl: json?.webSocketDebuggerUrl,
        waitMs: clampInt(json?.waitMs, 2000, 30000, 12000)
      });
      if (!grabbed.ok) {
        return sendJson(res, 409, {
          ok: false,
          error: 'cdp_credential_failed',
          message: '没从客户端里读到登录态。确认客户端已登录，然后点「以调试模式重启客户端」再试',
          detail: grabbed.reason || null
        });
      }
      const registered = await registerWorkbuddyAccount(grabbed.credential, { label: json?.label });
      if (!registered.ok) return sendJson(res, 400, { ok: false, error: registered.reason });
      await logEvent('account_imported', {
        accountId: registered.account.id,
        label: registered.account.label,
        source: `cdp:${grabbed.source}`,
        updated: registered.updated
      });
      return sendJson(res, registered.updated ? 200 : 201, {
        ok: true,
        source: grabbed.source,
        updated: registered.updated,
        balance: registered.balance,
        balanceError: registered.balanceError,
        account: accountView(registered.account),
        snapshot: snapshot()
      });
    }

    if (method === 'POST' && path === '/api/cdp/relaunch') {
      const { json } = await readBody(req);
      const result = await relaunchWithCdp({
        port: Number(json?.port) || 9222,
        exe: json?.exe ? String(json.exe) : undefined
      }).catch((error) => ({ ok: false, reason: String(error?.message || error) }));
      if (result.ok) await logEvent('client_relaunched', { port: result.port, exe: result.exe });
      return sendJson(res, result.ok ? 200 : 409, result);
    }

    if (method === 'PATCH' && path === '/api/settings') {
      const { json } = await readBody(req);
      await store.patchSettings(json || {});
      automation.scheduleNext();
      automation.scheduleIntervals();
      await logEvent('settings_updated', { keys: Object.keys(json || {}) });
      return sendJson(res, 200, snapshot());
    }

    if (method === 'POST' && path === '/api/sniff/start') {
      if (!loginBridge) return sendJson(res, 501, { error: 'sniff_unavailable', message: '命令行模式不支持接口嗅探，请用桌面版' });
      const { json } = await readBody(req);
      const url = String(json?.url || store.settings.loginUrl || store.settings.officialUrl || '').trim();
      if (!/^https?:\/\//i.test(url)) return sendJson(res, 400, { error: 'invalid_url' });
      const started = await loginBridge.start({ url, label: '接口嗅探', sniff: true });
      sniffSessions.set(started.id, { url, createdAt: Date.now() });
      await logEvent('sniff_started', { url });
      return sendJson(res, 202, { ok: true, id: started.id, url });
    }

    if (method === 'POST' && path === '/api/sniff/finish') {
      if (!loginBridge?.finish) return sendJson(res, 501, { error: 'sniff_unavailable' });
      const { json } = await readBody(req);
      const id = String(json?.id || '');
      const session = sniffSessions.get(id);
      if (!session) return sendJson(res, 404, { error: 'sniff_not_found' });
      const status = await loginBridge.finish(id);
      sniffSessions.delete(id);
      const result = await applySniffed(status.requests || [], session.url, json?.accountId || null, status.cookieHeader || null);
      const found = result.found;
      return sendJson(res, 200, {
        ok: true,
        baseUrl: found.baseUrl,
        chatPath: found.chatPath,
        modelsPath: found.modelsPath,
        balancePath: found.balancePath,
        checkinPath: found.checkinPath,
        tasksPath: found.tasksPath,
        claimPath: found.claimPath,
        totalRequests: found.totalRequests,
        quotaPaths: result.quotaPaths,
        cookieHeader: status.cookieHeader || null,
        snapshot: snapshot()
      });
    }

    if (method === 'POST' && path === '/api/login/start') {
      const { json } = await readBody(req);
      const label = String(json?.label || '').trim().slice(0, 64) || '扫码账号';
      const wantWorkbuddy = json?.mode === 'workbuddy' || json?.realm !== undefined || (!json?.url && !json?.mode);
      const realm = String(json?.realm || 'cn');

      // 优先走官方插件扫码授权：POST /v2/plugin/auth/state → 扫码 → GET /v2/plugin/auth/token
      if (wantWorkbuddy) {
        const started = await wbStartLogin(realm).catch((error) => ({ ok: false, error: String(error?.message || error) }));
        if (started.ok) {
          let bridgeId = null;
          if (loginBridge) {
            try {
              // sniff 模式会关掉「Cookie 变化即完成」的自动判定，改由服务端轮询授权结果
              const opened = await loginBridge.start({ url: started.authUrl, label, sniff: true });
              bridgeId = opened.id;
            } catch (error) {
              await logEvent('login_window_failed', { message: String(error?.message || error).slice(0, 200) }, 'warn');
            }
          } else if (json?.external !== false) {
            // 命令行模式：把授权页丢给系统浏览器
            const { spawn } = await import('node:child_process');
            try { spawn('cmd', ['/c', 'start', '', started.authUrl], { detached: true, stdio: 'ignore' }).unref(); } catch { /* 忽略 */ }
          }
          const id = bridgeId || `wb-${started.state.slice(0, 10)}`;
          pendingLogins.set(id, {
            id,
            kind: 'workbuddy',
            bridgeId,
            state: started.state,
            realm: started.realm,
            label,
            url: started.authUrl,
            createdAt: Date.now(),
            consumed: false
          });
          await logEvent('login_started', { loginId: id, label, mode: 'workbuddy', realm: started.realm });
          return sendJson(res, 202, { ok: true, id, label, url: started.authUrl, mode: 'workbuddy', realm: started.realm });
        }
        if (json?.mode === 'workbuddy') {
          return sendJson(res, 502, { error: 'workbuddy_auth_state_failed', message: started.error || '' });
        }
      }

      if (!loginBridge) return sendJson(res, 501, { error: 'scan_login_unavailable', message: '命令行模式不支持内置登录窗口，请用桌面版或手动粘贴凭据' });
      const url = String(json?.url || store.settings.loginUrl || store.settings.officialUrl || '').trim();
      if (!/^https?:\/\//i.test(url)) return sendJson(res, 400, { error: 'invalid_url' });
      const started = await loginBridge.start({ url, label, external: Boolean(json?.external) });
      if (started.external) {
        if (json?.url) await store.patchSettings({ loginUrl: url });
        return sendJson(res, 200, { ok: true, external: true, url });
      }
      if (json?.url) await store.patchSettings({ loginUrl: url });
      pendingLogins.set(started.id, { id: started.id, kind: 'cookie', label, url, createdAt: Date.now(), consumed: false });
      await logEvent('login_started', { loginId: started.id, label, mode: 'cookie' });
      return sendJson(res, 202, { ok: true, id: started.id, label, url, mode: 'cookie' });
    }

    if (method === 'GET' && path === '/api/login/status') {
      const id = url.searchParams.get('id') || '';
      const record = pendingLogins.get(id);
      if (!record) return sendJson(res, 404, { error: 'login_not_found' });

      // WorkBuddy 授权轮询
      if (record.kind === 'workbuddy') {
        const polled = await wbPollLogin(record.state, record.realm).catch((error) => ({ status: 'error', message: String(error?.message || error) }));
        if (polled.status === 'pending') return sendJson(res, 200, { state: 'pending', message: polled.message });
        if (polled.status !== 'ok') {
          pendingLogins.delete(id);
          return sendJson(res, 200, { state: 'failed', error: polled.message || '授权失败' });
        }
        record.consumed = true;
        const credential = polled.credential;
        const account = await store.addAccount({
          label: record.label,
          uid: credential.uid || '',
          provider: 'WorkBuddy',
          region: credential.realm === 'intl' ? '国际版' : '国服',
          officialUrl: credential.realm === 'intl' ? 'https://www.workbuddy.ai/' : 'https://www.workbuddy.cn/',
          secret: JSON.stringify({
            accessToken: credential.accessToken,
            refreshToken: credential.refreshToken,
            uid: credential.uid,
            domain: credential.domain,
            realm: credential.realm,
            expiresAt: credential.expiresAt
          }),
          authType: 'workbuddy',
          status: 'available'
        });
        // 授权成功后立刻补齐额度与签到状态
        const balance = await upstream.fetchBalance(account).catch(() => null);
        if (balance?.ok) {
          await store.updateAccount(account.id, {
            quota: { total: balance.total, used: balance.used },
            lastRefreshAt: nowIso(),
            health: 'healthy'
          });
        }
        if (record.bridgeId && loginBridge) await loginBridge.cancel(record.bridgeId).catch(() => {});
        pendingLogins.delete(id);
        await logEvent('account_login', { accountId: account.id, label: account.label, mode: 'workbuddy', nickname: credential.nickname || '' });
        return sendJson(res, 200, {
          state: 'done',
          mode: 'workbuddy',
          accountId: account.id,
          account: accountView(store.getAccount(account.id)),
          nickname: credential.nickname || '',
          snapshot: snapshot()
        });
      }

      if (!loginBridge) return sendJson(res, 501, { error: 'scan_login_unavailable' });
      const status = await loginBridge.poll(id);
      if (status.state === 'done' && !record.consumed) {
        if (!status.cookieHeader) return sendJson(res, 200, { state: 'pending' });
        record.consumed = true;
        const account = await store.addAccount({
          label: record.label,
          provider: providerFromUrl(record.url),
          region: '国服',
          officialUrl: record.url,
          secret: status.cookieHeader,
          authType: 'cookie',
          status: 'available'
        });
        pendingLogins.delete(id);
        await logEvent('account_login', { accountId: account.id, label: account.label });
        let sniffed = null;
        try {
          sniffed = await applySniffed(status.requests, record.url, account.id);
        } catch (error) {
          await logEvent('sniff_failed', { message: String(error?.message || error).slice(0, 200) }, 'warn');
        }
        return sendJson(res, 200, {
          state: 'done',
          accountId: account.id,
          account: accountView(account),
          discovered: sniffed?.found || null,
          quotaPaths: sniffed?.quotaPaths || null,
          snapshot: snapshot()
        });
      }
      if (['cancelled', 'timeout', 'failed'].includes(status.state)) pendingLogins.delete(id);
      return sendJson(res, 200, { state: status.state, error: status.error || null });
    }

    if (method === 'POST' && path === '/api/login/finish') {
      if (!loginBridge?.finish) return sendJson(res, 501, { error: 'scan_login_unavailable' });
      const { json } = await readBody(req);
      const id = String(json?.id || '');
      const record = pendingLogins.get(id);
      if (!record) return sendJson(res, 404, { error: 'login_not_found' });
      if (record.kind === 'workbuddy') {
        // 授权模式没有 Cookie 可抓，只能等官方回执
        return sendJson(res, 409, { error: 'wait_for_scan', message: '请在授权页完成扫码，程序会自动完成登录' });
      }
      const status = await loginBridge.finish(id);
      if (status.state !== 'done' || !status.cookieHeader) {
        return sendJson(res, 409, { error: 'login_not_completed' });
      }
      if (!record.consumed) {
        record.consumed = true;
        const account = await store.addAccount({
          label: record.label,
          provider: providerFromUrl(record.url),
          region: '国服',
          officialUrl: record.url,
          secret: status.cookieHeader,
          authType: 'cookie',
          status: 'available'
        });
        await logEvent('account_login', { accountId: account.id, label: account.label, manual: true });
        let sniffed = null;
        try {
          sniffed = await applySniffed(status.requests, record.url, account.id);
        } catch (error) {
          await logEvent('sniff_failed', { message: String(error?.message || error).slice(0, 200) }, 'warn');
        }
        return sendJson(res, 200, {
          state: 'done',
          accountId: account.id,
          account: accountView(account),
          discovered: sniffed?.found || null,
          quotaPaths: sniffed?.quotaPaths || null,
          snapshot: snapshot()
        });
      }
      return sendJson(res, 200, { state: 'done', alreadyConsumed: true });
    }

    if (method === 'POST' && path === '/api/login/cancel') {
      const { json } = await readBody(req);
      const id = String(json?.id || '');
      const record = pendingLogins.get(id);
      const bridgeId = record?.bridgeId || id;
      if (loginBridge && bridgeId) await loginBridge.cancel(bridgeId).catch(() => {});
      pendingLogins.delete(id);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && path === '/api/accounts') {
      const { json } = await readBody(req);
      if (!json || typeof json !== 'object') return sendJson(res, 400, { error: 'invalid_body' });
      const label = String(json.label || '').trim();
      if (!label) return sendJson(res, 400, { error: 'label_required' });
      if (json.authType === 'workbuddy') {
        const parsed = wbParseCredential(String(json.secret || ''));
        if (!parsed) {
          return sendJson(res, 400, {
            error: 'invalid_workbuddy_session',
            message: 'WorkBuddy 会话需要 {"accessToken":"...","refreshToken":"...","realm":"cn"} 这样的 JSON'
          });
        }
      }
      const account = await store.addAccount({
        label,
        provider: String(json.provider || '').trim() || providerFromUrl(json.officialUrl || store.settings.officialUrl),
        region: String(json.region || '').trim() || '国服',
        officialUrl: json.officialUrl,
        notes: json.notes,
        uid: json.uid,
        batch: json.batch,
        role: json.role,
        total: json.total,
        used: json.used,
        secret: json.secret,
        authType: json.authType,
        status: json.total !== undefined ? 'available' : 'unknown'
      });
      await logEvent('account_added', { accountId: account.id, label: account.label });
      return sendJson(res, 201, { ok: true, account: accountView(account), snapshot: snapshot() });
    }

    const accountMatch = path.match(/^\/api\/accounts\/([^/]+)(?:\/([a-z-]+))?$/);
    if (accountMatch) {
      const accountId = decodeURIComponent(accountMatch[1]);
      const action = accountMatch[2] || null;
      const account = store.getAccount(accountId);
      if (!account) return sendJson(res, 404, { error: 'account_not_found' });

      if (method === 'PATCH' && !action) {
        const { json } = await readBody(req);
        if (json?.secret !== undefined) {
          const nextAuth = json.authType || store.secretMeta(accountId)?.authType || 'cookie';
          if (nextAuth === 'workbuddy' && !wbParseCredential(String(json.secret || ''))) {
            return sendJson(res, 400, {
              error: 'invalid_workbuddy_session',
              message: 'WorkBuddy 会话需要 {"accessToken":"...","refreshToken":"...","realm":"cn"} 这样的 JSON'
            });
          }
          await store.setSecret(accountId, json.secret, nextAuth);
        }
        const { secret, authType, ...rest } = json || {};
        await store.updateAccount(accountId, rest);
        await logEvent('account_updated', { accountId, fields: Object.keys(rest) });
        return sendJson(res, 200, { ok: true, account: accountView(store.getAccount(accountId)) });
      }

      if (method === 'DELETE' && !action) {
        await store.removeAccount(accountId);
        await logEvent('account_removed', { accountId, label: account.label }, 'warn');
        return sendJson(res, 200, { ok: true, snapshot: snapshot() });
      }

      if (method === 'POST' && action === 'toggle') {
        const { json } = await readBody(req);
        const disabled = json?.disabled !== undefined ? Boolean(json.disabled) : !account.disabled;
        await store.updateAccount(accountId, { disabled });
        await logEvent('account_toggled', { accountId, disabled });
        return sendJson(res, 200, { ok: true, account: accountView(store.getAccount(accountId)) });
      }

      if (method === 'POST' && action === 'secret') {
        const { json } = await readBody(req);
        await store.setSecret(accountId, String(json?.secret || ''), json?.authType || 'cookie');
        await logEvent('account_secret_updated', { accountId });
        return sendJson(res, 200, { ok: true, hasSecret: store.hasSecret(accountId) });
      }

      if (method === 'POST' && action === 'clear-error') {
        await scheduler.clearError(accountId);
        return sendJson(res, 200, { ok: true, account: accountView(store.getAccount(accountId)) });
      }

      if (method === 'POST' && ['refresh', 'keepalive', 'inspect', 'checkin', 'tasks', 'claim', 'run-all'].includes(action)) {
        const steps = action === 'run-all' ? automation.enabledSteps() : [action];
        const result = await automation.runAccount(accountId, { steps, trigger: 'manual' });
        return sendJson(res, result.status === 'failed' ? 502 : 200, { ...result, snapshot: snapshot() });
      }

      if (method === 'POST' && action === 'auto') {
        const { json } = await readBody(req);
        const current = account.auto || {};
        const nextAuto = { ...current };
        for (const key of ['checkin', 'tasks', 'claim', 'keepalive', 'inspect']) {
          if (json?.[key] !== undefined) nextAuto[key] = Boolean(json[key]);
        }
        await store.updateAccount(accountId, { auto: nextAuto });
        return sendJson(res, 200, { ok: true, account: accountView(store.getAccount(accountId)) });
      }

      if (method === 'GET' && action === 'models') {
        const fetched = await upstream.fetchModels(account).catch((error) => ({ ok: false, models: [], reason: String(error?.message || error) }));
        return sendJson(res, 200, {
          provider: account.provider,
          region: account.region,
          authType: store.secretMeta(accountId)?.authType || null,
          gatewayModels: [...new Set([store.settings.model, 'workbuddy-gateway-v1', 'workbuddy-gateway-max', 'workbuddy-gateway-fast'])],
          upstream: fetched.ok ? fetched.models : [],
          upstreamSource: fetched.source || null,
          upstreamError: fetched.ok ? null : fetched.reason || 'models_failed'
        });
      }

      if (method === 'POST' && action === 'discover') {
        const { json } = await readBody(req);
        const defaults = [
          '/api/user/info', '/api/user/quota', '/api/user/balance', '/api/quota', '/api/balance',
          '/api/checkin', '/api/signin', '/api/user/checkin', '/api/tasks', '/api/task/list',
          '/api/reward', '/api/claim', '/api/user/reward', '/v1/models', '/api/me'
        ];
        const paths = Array.isArray(json?.paths) && json.paths.length ? json.paths.slice(0, 40) : defaults;
        const results = await upstream.probe(account, paths);
        return sendJson(res, 200, { ok: true, results });
      }
    }

    // 批量操作：一键巡检 / 全部刷新 / 全部签到 / 全部领奖 / 批量启停删 / 批量开关自动化
    if (method === 'POST' && (path === '/api/bulk' || path === '/api/inspect')) {
      const { json } = await readBody(req);
      const action = String(json?.action || (path === '/api/inspect' ? 'inspect' : '')).trim();
      const ids = Array.isArray(json?.ids) && json.ids.length
        ? json.ids.map((id) => String(id))
        : store.listAccounts().map((account) => account.id);
      const targets = ids.map((id) => store.getAccount(id)).filter(Boolean);
      if (!targets.length) return sendJson(res, 400, { error: 'no_accounts' });

      if (action === 'enable' || action === 'disable') {
        for (const account of targets) await store.updateAccount(account.id, { disabled: action === 'disable' });
        await logEvent('bulk_toggle', { action, count: targets.length }, 'warn');
        return sendJson(res, 200, { ok: true, count: targets.length, snapshot: snapshot() });
      }

      if (action === 'delete') {
        for (const account of targets) await store.removeAccount(account.id);
        await logEvent('bulk_delete', { count: targets.length }, 'warn');
        return sendJson(res, 200, { ok: true, count: targets.length, snapshot: snapshot() });
      }

      if (action === 'clear-error') {
        for (const account of targets) await scheduler.clearError(account.id);
        return sendJson(res, 200, { ok: true, count: targets.length, snapshot: snapshot() });
      }

      if (action === 'auto') {
        const patch = {};
        for (const key of ['checkin', 'tasks', 'claim', 'keepalive', 'inspect']) {
          if (json?.[key] !== undefined) patch[key] = Boolean(json[key]);
        }
        for (const account of targets) await store.updateAccount(account.id, { auto: { ...(account.auto || {}), ...patch } });
        return sendJson(res, 200, { ok: true, count: targets.length, snapshot: snapshot() });
      }

      const steps = action === 'run-all'
        ? automation.enabledSteps()
        : [action].filter((step) => ['refresh', 'keepalive', 'inspect', 'checkin', 'tasks', 'claim'].includes(step));
      if (!steps.length) return sendJson(res, 400, { error: 'invalid_action' });

      const result = await automation.runAll({ trigger: 'manual', accountIds: targets.map((account) => account.id), steps });
      return sendJson(res, 200, { ...result, snapshot: snapshot() });
    }

    if (method === 'POST' && path === '/api/automation/run') {
      const { json } = await readBody(req);
      const target = json?.accountId ? [json.accountId] : null;
      const allowed = ['refresh', 'keepalive', 'inspect', 'checkin', 'tasks', 'claim'];
      const steps = Array.isArray(json?.steps) && json.steps.length ? json.steps.filter((step) => allowed.includes(step)) : null;
      automation.scheduleNext();
      const result = await automation.runAll({ trigger: 'manual', accountIds: target, steps });
      return sendJson(res, 200, { ...result, snapshot: snapshot() });
    }

    if (method === 'POST' && path === '/api/automation/toggle') {
      const { json } = await readBody(req);
      const enabled = json?.enabled !== undefined ? Boolean(json.enabled) : !store.settings.automation.enabled;
      await store.patchSettings({ automation: { enabled } });
      automation.scheduleNext();
      automation.scheduleIntervals();
      return sendJson(res, 200, { ok: true, automation: automation.describe(), snapshot: snapshot() });
    }

    if (method === 'POST' && path === '/api/import/curl') {
      const { json } = await readBody(req);
      const parsed = parseCurl(json?.command || '');
      if (!parsed.ok) return sendJson(res, 400, { error: parsed.error });
      return sendJson(res, 200, parsed);
    }

    if (method === 'POST' && path === '/api/reset') {
      const { json } = await readBody(req);
      await store.reset({ keepAccounts: json?.keepAccounts !== false, keepSecrets: json?.keepSecrets !== false });
      return sendJson(res, 200, { ok: true, snapshot: snapshot() });
    }

    if (method === 'GET' && path === '/api/export') {
      return sendJson(res, 200, store.exportSafe());
    }

    if (method === 'GET' && path === '/api/logs') {
      const limit = clampInt(url.searchParams.get('limit'), 1, 400, 120);
      return sendJson(res, 200, {
        events: store.state.events.slice(0, limit),
        jobs: store.state.jobs.slice(0, limit)
      });
    }

    if (method === 'POST' && path === '/api/simulate/request') {
      const { json } = await readBody(req);
      const tokens = Math.max(1, Math.round(safeNumber(json?.estimatedTokens, 250)));
      const account = scheduler.pick({ requiredTokens: tokens });
      if (!account) return sendJson(res, 429, { error: 'no_usable_account' });
      await scheduler.reserve(account.id, tokens);
      await store.pushRequest({
        id: randomUUID(),
        source: 'dashboard-simulate',
        accountId: account.id,
        label: account.label,
        model: store.settings.model,
        estimatedTokens: tokens,
        mode: 'simulation',
        status: 'completed'
      });
      return sendJson(res, 200, { ok: true, accountId: account.id, estimatedTokens: tokens, snapshot: snapshot() });
    }

    return sendJson(res, 404, { error: 'not_found' });
  }

  async function route(req, res) {
    let url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    pinnedRef = null;
    // 定址路由 /u/<ref>/v1/...：把前缀剥掉再交给网关主循环，只打这一个账号
    if (url.pathname.startsWith('/u/')) {
      const rest = url.pathname.slice(3);
      const slash = rest.indexOf('/');
      if (slash <= 0) {
        return sendJson(res, 404, {
          error: { message: 'pinned account route must be /u/<ref>/v1/...', type: 'invalid_request_error' }
        });
      }
      pinnedRef = decodeURIComponent(rest.slice(0, slash)).trim();
      const tail = rest.slice(slash);
      if (!tail.startsWith('/v1')) {
        return sendJson(res, 404, {
          error: { message: 'pinned account route must be /u/<ref>/v1/...', type: 'invalid_request_error' }
        });
      }
      url = new URL(`${tail}${url.search}`, `http://${req.headers.host || '127.0.0.1'}`);
    }

    const isGateway = url.pathname.startsWith('/v1/') || url.pathname === '/v1' || url.pathname === '/models';

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization, x-api-key, anthropic-version',
        'access-control-max-age': '86400'
      });
      return res.end();
    }

    try {
      if (url.pathname === '/health') {
        return sendJson(res, 200, {
          ok: true,
          mode: store.settings.gateway.mock ? 'simulation' : 'live',
          accounts: store.listAccounts().length,
          usable: scheduler.candidates({ requiredTokens: 1 }).length,
          port: gatewayPort,
          startedAt
        });
      }
      if (isGateway) return await handleGateway(req, res, url);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method === 'GET') return await serveStatic(req, res, url.pathname);
      return sendText(res, 405, 'method not allowed');
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      if (status >= 500) {
        await store.pushEvent('server_error', { path: url.pathname, message: String(error?.message || error).slice(0, 300) }, 'error');
      }
      return sendJson(res, status, { error: status === 500 ? 'internal_error' : String(error?.message || error) });
    }
  }

  const server = http.createServer((req, res) => { route(req, res); });

  server.on('listening', () => {
    const address = server.address();
    if (address && typeof address === 'object') gatewayPort = address.port;
  });

  const close = () => {
    automation.stop();
    return new Promise((resolveClose) => server.close(() => resolveClose()));
  };

  return {
    server,
    close,
    setPort(port) { gatewayPort = port; },
    get port() { return gatewayPort; },
    store,
    upstream,
    scheduler,
    automation,
    snapshot
  };
}

export async function startGateway({ host = '127.0.0.1', port = 8787, dataDir, tries = 10, loginBridge = null } = {}) {
  const app = await createServer({ dataDir, loginBridge });
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const candidate = port + attempt;
    try {
      await new Promise((resolveListen, rejectListen) => {
        const onError = (error) => rejectListen(error);
        app.server.once('error', onError);
        app.server.listen(candidate, host, () => {
          app.server.removeListener('error', onError);
          resolveListen();
        });
      });
      app.setPort(candidate);
      return { app, host, port: candidate };
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('no available port');
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  const port = Number(process.env.SIM_PORT || 8787);
  const host = process.env.SIM_HOST || '127.0.0.1';
  const { port: actual } = await startGateway({ host, port, dataDir: process.env.WBSIM_DATA_DIR });
  console.log(`[gateway] http://${host}:${actual}/`);
  console.log(`[gateway] OpenAI base URL: http://${host}:${actual}/v1`);
}
