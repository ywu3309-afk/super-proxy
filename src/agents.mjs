/**
 * 智能体一键配置
 *
 * 移植自 workbuddy2api-hub（AGPL-3.0）的 wb_agents.py：把本网关写进各家 CLI
 * 客户端的配置里，改前自动备份，随时可字节级还原。只用标准库做文本级
 * YAML / TOML / JSON 增量编辑——只插入或更新 provider 那一段，绝不重排、
 * 不抹掉用户自己的注释和其他 provider。
 *
 * 支持：DSH / Claude Code / Codex CLI / OpenCode / Crush / ZCode
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';

export const PROVIDER_ID = 'wb-gateway';
export const PROVIDER_NAME = 'WorkBuddy Gateway';
export const CREDENTIAL_REF = 'WB_GATEWAY_API_KEY';
export const STATE_FILE = 'integration-state.json';
export const BACKUP_DIRNAME = 'agent-backups';
export const BACKUP_KEEP = 10;

export class AgentConfigError extends Error {}

// ------------------------------------------------------------------ 文件 IO
function targetMode(path) {
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077 || !(mode & 0o400)) return 0o600;
    return mode;
  } catch {
    return 0o600;
  }
}

/** 先写临时文件再 rename，崩在中途也不会留下半个配置。 */
export function atomicWrite(path, data) {
  const dir = dirname(path);
  if (dir) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  const mode = targetMode(path);
  try { unlinkSync(tmp); } catch { /* 上次残留 */ }
  writeFileSync(tmp, data, { flag: 'w', mode });
  try { chmodSync(tmp, mode); } catch { /* Windows 上无意义 */ }
  renameSync(tmp, path);
}

function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

function readBytes(path) {
  try { return readFileSync(path); } catch { return Buffer.alloc(0); }
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// -------------------------------------------------------------- JSON 工具
function loadJson(path, what) {
  const text = readText(path);
  if (!text.trim()) return {};
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new AgentConfigError(`${what} 不是合法 JSON（${path}）：${error.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new AgentConfigError(`${what} 必须是 JSON 对象：${path}`);
  }
  return data;
}

function dumpJson(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** 递归合并：patch 之外的兄弟键原样保留。 */
export function deepMerge(base, patch) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) return patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])
      ? deepMerge(out[key], value)
      : value;
  }
  return out;
}

// -------------------------------------------------------------- YAML 工具
function yamlIndent(line) {
  return line.length - line.replace(/^ +/, '').length;
}

function yamlKey(line) {
  const stripped = line.trim();
  if (!stripped || stripped.startsWith('#') || stripped.startsWith('-')) return null;
  const m = line.replace(/^ +/, '').match(/^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?:\s|$)/);
  return m ? m[1] : null;
}

function yamlBlockEnd(lines, start, indent) {
  let idx = start + 1;
  while (idx < lines.length) {
    const line = lines[idx];
    if (line.trim() && yamlIndent(line) <= indent) break;
    idx += 1;
  }
  return idx;
}

function yamlInsertPoint(lines, start, end) {
  let idx = end;
  while (idx > start && !lines[idx - 1].trim()) idx -= 1;
  return idx > start ? idx : end;
}

function yamlInlineToBlock(lines, idx, key, inlineValue) {
  const indent = yamlIndent(lines[idx]);
  const value = inlineValue.trim();
  if (value.startsWith('{') && value.endsWith('}')) {
    const inner = value.slice(1, -1).trim();
    const out = [`${' '.repeat(indent)}${key}:`];
    if (inner) {
      for (const part of inner.split(',')) {
        const piece = part.trim();
        if (piece) out.push(`${' '.repeat(indent + 2)}${piece}`);
      }
    }
    lines.splice(idx, 1, ...out);
    return;
  }
  if (value === '') return;
  throw new AgentConfigError(`无法在 \`${key}: ${inlineValue}\` 下展开子键——只支持内联 {..} 映射`);
}

function yamlUpsertAt(lines, start, end, indent, keys, valueJson) {
  const key = keys[0];
  let idx = start;
  while (idx < end) {
    const line = lines[idx];
    if (line.trim() && !line.trim().startsWith('#') && yamlIndent(line) === indent && yamlKey(line) === key) {
      const after = line.split(/:(.*)/s)[1] ? line.slice(line.indexOf(':') + 1).trim() : '';
      let childEnd = yamlBlockEnd(lines, idx, indent);
      if (keys.length === 1) {
        lines[idx] = `${' '.repeat(indent)}${key}: ${valueJson}`;
        return lines;
      }
      if (after) {
        yamlInlineToBlock(lines, idx, key, after);
        childEnd = yamlBlockEnd(lines, idx, indent);
        return yamlUpsertAt(lines, idx + 1, childEnd, indent + 2, keys.slice(1), valueJson);
      }
      return yamlUpsertAt(lines, idx + 1, childEnd, indent + 2, keys.slice(1), valueJson);
    }
    idx += 1;
  }
  const insert = yamlInsertPoint(lines, start, end);
  let block;
  if (keys.length === 1) {
    block = [`${' '.repeat(indent)}${key}: ${valueJson}`];
  } else {
    block = [`${' '.repeat(indent)}${key}:`, ...yamlUpsertAt([], 0, 0, indent + 2, keys.slice(1), valueJson)];
  }
  lines.splice(insert, 0, ...block);
  return lines;
}

/** 把嵌套键写成内联 flow 值（JSON 兼容），只动到的那一行。 */
export function yamlUpsertInline(text, keyPath, value) {
  const keys = String(keyPath).split('.').map((part) => part.trim()).filter(Boolean);
  if (!keys.length) throw new AgentConfigError('yamlUpsertInline: 空键路径');
  const lines = text.split('\n');
  const out = yamlUpsertAt(lines, 0, lines.length, 0, keys, JSON.stringify(value));
  return out.join('\n');
}

/** 在顶层 refs: 块里 upsert 一个 `key: value`。 */
export function yamlRefsUpsert(text, key, value) {
  const lines = text.split('\n');
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    if (line.trim() && !line.trim().startsWith('#') && yamlIndent(line) === 0 && yamlKey(line) === 'refs') {
      const after = line.slice(line.indexOf(':') + 1).trim();
      if (after) {
        throw new AgentConfigError(`不支持在 \`refs: ${after}\` 里写条目——只支持块状 refs 映射`);
      }
      const end = yamlBlockEnd(lines, idx, 0);
      for (let j = idx + 1; j < end; j += 1) {
        if (lines[j].trim() && yamlIndent(lines[j]) === 2 && yamlKey(lines[j]) === key) {
          lines[j] = `  ${key}: ${value}`;
          return lines.join('\n');
        }
      }
      const insert = yamlInsertPoint(lines, idx + 1, end);
      lines.splice(insert, 0, `  ${key}: ${value}`);
      return lines.join('\n');
    }
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  lines.push('refs:', `  ${key}: ${value}`);
  return `${lines.join('\n')}\n`;
}

// -------------------------------------------------------------- TOML 工具
const TOML_TABLE_RE = /^\s*\[([^\]]+)\]\s*$/;
const TOML_KEY_RE = /^\s*([A-Za-z0-9_-]+)\s*=/;

function tomlValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 顶层键（必须写在第一个 [table] 之前）。 */
export function tomlUpsertTopKey(text, key, value) {
  const rendered = `${key} = ${tomlValue(value)}`;
  const lines = text.split('\n');
  let lastTop = -1;
  for (let idx = 0; idx < lines.length; idx += 1) {
    if (TOML_TABLE_RE.test(lines[idx])) break;
    const m = lines[idx].match(TOML_KEY_RE);
    if (m) {
      lastTop = idx;
      if (m[1] === key) {
        lines[idx] = rendered;
        return lines.join('\n');
      }
    }
  }
  lines.splice(lastTop + 1, 0, rendered);
  return lines.join('\n');
}

export function tomlUpsertTable(text, table, mapping) {
  const lines = text.split('\n');
  for (let idx = 0; idx < lines.length; idx += 1) {
    const m = lines[idx].match(TOML_TABLE_RE);
    if (m && m[1] === table) {
      let end = idx + 1;
      while (end < lines.length && !TOML_TABLE_RE.test(lines[end])) end += 1;
      return tomlUpsertInRange(lines, idx + 1, end, mapping).join('\n');
    }
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length) lines.push('');
  lines.push(`[${table}]`);
  for (const [key, value] of Object.entries(mapping)) lines.push(`${key} = ${tomlValue(value)}`);
  return `${lines.join('\n')}\n`;
}

function tomlUpsertInRange(lines, start, end, mapping) {
  const remaining = { ...mapping };
  let lastContent = start;
  for (let idx = start; idx < end; idx += 1) {
    const stripped = lines[idx].trim();
    if (stripped && !stripped.startsWith('#')) {
      lastContent = idx + 1;
      const m = lines[idx].match(TOML_KEY_RE);
      if (m && m[1] in remaining) {
        lines[idx] = `${m[1]} = ${tomlValue(remaining[m[1]])}`;
        delete remaining[m[1]];
      }
    }
  }
  let insert = lastContent;
  for (const [key, value] of Object.entries(remaining)) {
    lines.splice(insert, 0, `${key} = ${tomlValue(value)}`);
    insert += 1;
  }
  return lines;
}

// ---------------------------------------------------------- 客户端定义
function claudePath(home) {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return override ? join(override, 'settings.json') : join(home, '.claude', 'settings.json');
}

function codexHome(home) {
  return process.env.CODEX_HOME || join(home, '.codex');
}

/** DSH 的模型条目：只带它认的字段（id / contextWindow / maxTokens / reasoningEfforts）。 */
export function dshModelEntry(entry) {
  const item = { id: entry.id };
  if (entry.context_window) item.contextWindow = entry.context_window;
  if (entry.max_output) {
    const value = Number(entry.max_output);
    if (Number.isFinite(value)) item.maxTokens = value;
  }
  const levels = dshReasoningLevels(entry.reasoning_efforts);
  if (levels) item.reasoningEfforts = levels;
  if (entry.supports_vision || entry.supportsVision) item.supportsVision = true;
  return item;
}

/** {档位: 线上拼写}；固定档位的模型不给列表（给了也改不了上游实际跑的档位）。 */
export function dshReasoningLevels(raw) {
  let pairs;
  if (Array.isArray(raw)) pairs = raw.map((level) => [level, level]);
  else if (raw && typeof raw === 'object') pairs = Object.entries(raw);
  else return null;
  const levels = {};
  for (const [level, wire] of pairs) {
    const name = String(level || '').trim();
    if (!name) continue;
    levels[name] = String(wire || '').trim() || name;
  }
  return Object.keys(levels).length ? levels : null;
}

/** 保留用户在 agent-default-model 里设的其他键（比如 reasoningEffort）。 */
export function dshDefaultModel(text, provider, model) {
  let out = { provider, model };
  for (const line of String(text || '').split('\n')) {
    const stripped = line.trim();
    if (!stripped.startsWith('agent-default-model:')) continue;
    const raw = stripped.slice(stripped.indexOf(':') + 1).trim();
    if (raw.startsWith('{')) {
      try {
        const current = JSON.parse(raw);
        if (current && typeof current === 'object') out = { ...current };
      } catch { /* 解析不了就用裸的 provider/model */ }
    }
    break;
  }
  out.provider = provider;
  out.model = model;
  return out;
}

function applyClaude(paths, ctx) {
  const data = loadJson(paths.settings, 'claude settings');
  const env = { ...(data.env || {}) };
  // Claude Code 自己会拼 /v1，这里给裸根地址
  env.ANTHROPIC_BASE_URL = ctx.baseUrl.replace(/\/v1\/?$/, '');
  env.ANTHROPIC_AUTH_TOKEN = ctx.apiKey;
  if (ctx.model) {
    for (const name of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']) {
      env[name] = ctx.model;
    }
  }
  data.env = env;
  return { [paths.settings]: dumpJson(data) };
}

function applyCodex(paths, ctx) {
  let text = readText(paths.config);
  text = tomlUpsertTopKey(text, 'model_provider', PROVIDER_ID);
  if (ctx.model) text = tomlUpsertTopKey(text, 'model', ctx.model);
  text = tomlUpsertTable(text, `model_providers.${PROVIDER_ID}`, {
    name: PROVIDER_NAME,
    base_url: ctx.baseUrlV1,
    wire_api: 'responses',
    env_key: 'OPENAI_API_KEY'
  });
  const auth = deepMerge(loadJson(paths.auth, 'codex auth'), { OPENAI_API_KEY: ctx.apiKey });
  return { [paths.config]: text, [paths.auth]: dumpJson(auth) };
}

function applyOpenCode(paths, ctx) {
  const data = loadJson(paths.config, 'opencode config');
  if (!data.$schema) data.$schema = 'https://opencode.ai/config.json';
  const models = {};
  for (const entry of ctx.models || []) if (entry.id) models[entry.id] = {};
  const provider = {
    npm: '@ai-sdk/openai-compatible',
    name: PROVIDER_NAME,
    options: { baseURL: ctx.baseUrlV1, apiKey: ctx.apiKey }
  };
  if (Object.keys(models).length) provider.models = models;
  data.provider = deepMerge(data.provider || {}, { [PROVIDER_ID]: provider });
  if (ctx.model) data.model = `${PROVIDER_ID}/${ctx.model}`;
  return { [paths.config]: dumpJson(data) };
}

function applyCrush(paths, ctx) {
  const data = loadJson(paths.config, 'crush config');
  const models = [];
  for (const entry of ctx.models || []) {
    if (!entry.id) continue;
    models.push({ id: entry.id, name: entry.id });
  }
  const provider = {
    name: PROVIDER_NAME,
    type: 'openai',
    base_url: ctx.baseUrlV1,
    api_key: ctx.apiKey
  };
  if (models.length) provider.models = models;
  data.providers = deepMerge(data.providers || {}, { [PROVIDER_ID]: provider });
  return { [paths.config]: dumpJson(data) };
}

function applyZcode(paths, ctx) {
  const data = loadJson(paths.config, 'zcode config');
  const models = (ctx.models || []).filter((entry) => entry.id).map((entry) => entry.id);
  const entry = {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    type: 'openai-chat-completions',
    baseURL: ctx.baseUrlV1,
    apiKey: ctx.apiKey
  };
  if (models.length) entry.models = models;
  const list = Array.isArray(data.providers) ? data.providers : [];
  const index = list.findIndex((item) => item && item.id === PROVIDER_ID);
  if (index >= 0) list[index] = { ...list[index], ...entry };
  else list.push(entry);
  data.providers = list;
  return { [paths.config]: dumpJson(data) };
}

function applyDsh(paths, ctx) {
  let text = readText(paths.settings);
  const models = (ctx.models || []).filter((entry) => entry.id).map(dshModelEntry);
  const provider = {
    displayName: PROVIDER_NAME,
    apiKeyEnv: CREDENTIAL_REF,
    api: 'openai-completions',
    baseURL: ctx.baseUrlV1,
    // 本网关不在 DSH 的内置目录里，推理字段的线上形状必须自己说明：
    // 走标准 reasoning_effort，不发 thinking 块（DeepSeek 系要的 reasoning_content 由网关补）
    compat: { thinkingFormat: 'openai', supportsReasoningEffort: true }
  };
  if (models.length) provider.models = models;
  text = yamlUpsertInline(text, `llm-pi-ai.providers.${PROVIDER_ID}`, provider);
  if (ctx.model) {
    text = yamlUpsertInline(text, 'agent-default-model', dshDefaultModel(text, PROVIDER_ID, ctx.model));
  }
  const credText = yamlRefsUpsert(readText(paths.credentials), CREDENTIAL_REF, ctx.apiKey);
  return { [paths.settings]: text, [paths.credentials]: credText };
}

export const CLIENTS = {
  dsh: {
    id: 'dsh',
    label: 'DeepSeek Harness (DSH)',
    desc: '往 ~/.dsh/settings.yaml 注册 wb-gateway provider，思考档位与上下文窗口一并写入',
    protocol: 'openai',
    files: (home) => ({
      settings: join(home, '.dsh', 'settings.yaml'),
      credentials: join(home, '.dsh', '.credentials.yaml')
    }),
    probe: (home) => existsSync(join(home, '.dsh')) || existsSync(join(home, '.dsh', 'settings.yaml')),
    apply: applyDsh
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    desc: '往 ~/.claude/settings.json 写 ANTHROPIC_BASE_URL / AUTH_TOKEN（走 /v1/messages）',
    protocol: 'anthropic',
    files: (home) => ({ settings: claudePath(home) }),
    probe: (home) => existsSync(join(home, '.claude')),
    apply: applyClaude
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    desc: '往 ~/.codex/config.toml 注册 model_provider，走 Responses API',
    protocol: 'responses',
    files: (home) => ({ config: join(codexHome(home), 'config.toml'), auth: join(codexHome(home), 'auth.json') }),
    probe: (home) => existsSync(codexHome(home)),
    apply: applyCodex
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    desc: '往 ~/.config/opencode/opencode.json 注册 openai-compatible provider',
    protocol: 'openai',
    files: (home) => ({ config: join(home, '.config', 'opencode', 'opencode.json') }),
    probe: (home) => existsSync(join(home, '.config', 'opencode')),
    apply: applyOpenCode
  },
  crush: {
    id: 'crush',
    label: 'Crush',
    desc: '往 ~/.config/crush/crush.json 注册 provider',
    protocol: 'openai',
    files: (home) => ({ config: join(home, '.config', 'crush', 'crush.json') }),
    probe: (home) => existsSync(join(home, '.config', 'crush')),
    apply: applyCrush
  },
  zcode: {
    id: 'zcode',
    label: 'ZCode',
    desc: '往 ~/.zcode/v2/provider_config.json 注册 provider（配置前先退出 ZCode）',
    protocol: 'openai',
    files: (home) => ({ config: join(home, '.zcode', 'v2', 'provider_config.json') }),
    probe: (home) => existsSync(join(home, '.zcode')),
    apply: applyZcode
  }
};

// ------------------------------------------------------- 备份 / 状态
function statePath(dataDir) {
  return join(dataDir, STATE_FILE);
}

function loadState(dataDir) {
  try {
    const data = JSON.parse(readFileSync(statePath(dataDir), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function saveState(dataDir, state) {
  mkdirSync(dataDir, { recursive: true });
  atomicWrite(statePath(dataDir), dumpJson(state));
}

function backupDir(dataDir, clientId) {
  return join(dataDir, BACKUP_DIRNAME, clientId);
}

function pruneBackups(directory, keep = BACKUP_KEEP) {
  let entries;
  try { entries = readdirSync(directory).sort(); } catch { return; }
  const byName = new Map();
  for (const name of entries) {
    const base = name.replace(/^\d{8}-\d{6}-/, '');
    if (!byName.has(base)) byName.set(base, []);
    byName.get(base).push(name);
  }
  for (const names of byName.values()) {
    for (const stale of names.slice(0, Math.max(0, names.length - keep))) {
      try { unlinkSync(join(directory, stale)); } catch { /* ignore */ }
    }
  }
}

function backupFile(dataDir, clientId, path, original) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const name = `${stamp}-${basename(path) || 'config'}`;
  const directory = backupDir(dataDir, clientId);
  mkdirSync(directory, { recursive: true });
  let target = join(directory, name);
  let seq = 1;
  while (existsSync(target)) {
    target = join(directory, `${name}-${seq}`);
    seq += 1;
  }
  atomicWrite(target, original);
  pruneBackups(directory);
  return target;
}

// ------------------------------------------------------------- 公共 API
function clientOf(clientId) {
  const client = CLIENTS[clientId];
  if (!client) throw new AgentConfigError(`未知客户端 ${clientId}（已知：${Object.keys(CLIENTS).join(', ')}）`);
  return client;
}

/** 探测本机装了哪些客户端，以及是否已经被本网关接管。 */
export function overview(dataDir, home = homedir()) {
  const state = loadState(dataDir);
  const out = {};
  for (const clientId of Object.keys(CLIENTS)) {
    const client = CLIENTS[clientId];
    const paths = client.files(home);
    const existing = Object.values(paths).filter((path) => existsSync(path));
    const record = state[clientId];
    let applied = false;
    let external = false;
    if (record && Array.isArray(record.files)) {
      applied = true;
      for (const entry of record.files) {
        if (!entry.path || !existsSync(entry.path)) {
          external = true;
          continue;
        }
        if (sha256(readBytes(entry.path)) !== entry.sha256) external = true;
      }
    }
    out[clientId] = {
      id: clientId,
      label: client.label,
      desc: client.desc,
      protocol: client.protocol,
      detected: client.probe(home) || existing.length > 0,
      files: paths,
      existing,
      applied,
      external,
      appliedAt: record?.applied_at || null
    };
  }
  return out;
}

/** 把网关写进指定客户端配置；改前备份原件。 */
export function apply(clientId, ctx, { dataDir, home = homedir() } = {}) {
  const client = clientOf(clientId);
  const paths = client.files(home);
  const state = loadState(dataDir);
  const record = state[clientId] && Array.isArray(state[clientId].files) ? state[clientId] : { files: [] };
  const known = new Set(record.files.map((entry) => entry.path));

  const originals = {};
  for (const path of Object.values(paths)) {
    if (existsSync(path)) originals[path] = readBytes(path);
  }

  const outputs = client.apply(paths, ctx);

  const written = [];
  for (const [path, content] of Object.entries(outputs)) {
    if (originals[path] !== undefined && !known.has(path)) {
      // 首次接入：原件永久保留一份
      backupFile(dataDir, clientId, path, originals[path]);
    }
    if (originals[path] !== undefined) {
      backupFile(dataDir, clientId, path, originals[path]);
    }
    atomicWrite(path, content);
    written.push({ path, sha256: sha256(Buffer.from(content, 'utf8')), created: originals[path] === undefined });
  }

  const merged = new Map(record.files.map((entry) => [entry.path, entry]));
  for (const entry of written) {
    const previous = merged.get(entry.path);
    // created 一旦为 true 就不能被后来的 apply 改回 false：那个文件是我们建的，
    // 还原时必须删掉，否则会留下一个空配置。
    merged.set(entry.path, {
      path: entry.path,
      sha256: entry.sha256,
      created: Boolean(entry.created || previous?.created)
    });
  }
  // 原件只在**第一次**接入时记录：之后再 apply 不能把「已改过的内容」当成原件，
  // 否则还原就回不到最初的样子了。
  const original = { ...(record.original || {}) };
  for (const [path, buf] of Object.entries(originals)) {
    // 只记录「首次接入前就存在」的文件；第二次 apply 时看到的已经是我们写过的内容
    if (!original[path] && !known.has(path)) original[path] = { base64: buf.toString('base64'), sha256: sha256(buf) };
  }
  state[clientId] = {
    applied_at: new Date().toISOString(),
    files: [...merged.values()],
    original
  };
  saveState(dataDir, state);
  return { ok: true, client: clientId, files: written.map((entry) => entry.path) };
}

/** 还原到首次配置前的状态；网关新建的文件会被清掉。 */
export function restore(clientId, { dataDir, home = homedir() } = {}) {
  clientOf(clientId);
  const state = loadState(dataDir);
  const record = state[clientId];
  if (!record) throw new AgentConfigError(`${clientId} 没有配置记录，无法还原`);

  const restored = [];
  const removed = [];
  for (const entry of record.files || []) {
    const original = record.original?.[entry.path];
    if (original) {
      atomicWrite(entry.path, Buffer.from(original.base64, 'base64'));
      restored.push(entry.path);
    } else if (entry.created && existsSync(entry.path)) {
      unlinkSync(entry.path);
      removed.push(entry.path);
    }
  }
  delete state[clientId];
  saveState(dataDir, state);
  return { ok: true, client: clientId, restored, removed };
}

/** 把网关的模型清单转成 ctx.models 需要的形状。 */
export function modelsForAgents(catalog, { limit = 40, reasoning = null } = {}) {
  const list = Array.isArray(catalog) ? catalog : [];
  return list.filter((item) => item && item.id && !(item.tags || []).includes('text-to-image')).slice(0, limit).map((item) => ({
    id: item.id,
    context_window: item.contextWindow || item.context_window || 0,
    max_output: item.maxOutput || item.max_output || 0,
    reasoning_efforts: reasoning || item.reasoningEfforts || item.reasoning_efforts || null,
    supports_vision: Boolean(item.vision || item.supportsVision)
  }));
}
