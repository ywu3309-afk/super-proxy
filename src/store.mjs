import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { SecretBox } from './crypto.mjs';
import { clone, localDate, normalizeId, nowIso, safeNumber } from './util.mjs';

export const DEFAULT_SETTINGS = {
  timezone: 'America/Los_Angeles',
  model: 'workbuddy-gateway-v1',
  officialUrl: 'https://www.workbuddy.cn/',
  loginUrl: '',
  gateway: {
    preferredPort: 8787,
    mock: true,
    apiKey: '',
    maxAttempts: 3,
    cooldownOn429Minutes: 20,
    errorThreshold: 4,
    // 发消息前查上游排队状态（客户端行为），排队中就换号
    queueProbe: true
  },
  automation: {
    enabled: true,
    time: '09:30',
    jitterSeconds: 300,
    retries: 3,
    retryBaseMs: 4000,
    steps: { refresh: true, keepalive: true, checkin: true, tasks: true, claim: true, inspect: false },
    keepalive: { enabled: true, intervalMinutes: 45 },
    inspect: { enabled: true, intervalMinutes: 120 },
    settleBeforeClaimMs: 1500
  },
  upstream: {
    baseUrl: '',
    chatPath: '/v1/chat/completions',
    modelsPath: '/v1/models',
    balancePath: '',
    checkinPath: '',
    tasksPath: '',
    claimPath: '',
    authType: 'cookie',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    extraHeaders: {},
    quotaPaths: {
      total: ['data.total_capacity_size', 'data.total_quota', 'data.quota.total', 'quota.total', 'total'],
      used: ['data.total_capacity_used', 'data.used_quota', 'data.quota.used', 'quota.used', 'used'],
      available: ['data.available', 'data.remaining', 'data.quota.available', 'available', 'remaining']
    },
    balance: { method: 'GET', body: null, headers: {} },
    checkin: {
      method: 'POST',
      body: {},
      successPaths: ['code', 'success', 'data.success'],
      doneCodes: [10001],
      preChat: { enabled: false, model: '', prompt: '你好', maxTokens: 32 }
    },
    tasks: {
      method: 'GET',
      acceptPath: '',
      acceptMethod: 'POST',
      claimPath: '',
      completePath: '',
      completeMethod: 'POST',
      listPaths: ['data.tasks', 'tasks', 'data.list']
    },
    claim: { method: 'POST', body: {} }
  }
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const result = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      result[key] = deepMerge(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function defaultStats(input = {}) {
  return {
    success: safeNumber(input.success, 0),
    fail: safeNumber(input.fail, 0),
    requests: safeNumber(input.requests, 0),
    tokens: safeNumber(input.tokens, 0),
    outputTokens: safeNumber(input.outputTokens, 0),
    todayTokens: safeNumber(input.todayTokens, 0),
    todayDate: input.todayDate || null,
    totalLatencyMs: safeNumber(input.totalLatencyMs, 0),
    lastLatencyMs: input.lastLatencyMs ?? null,
    lastSuccessAt: input.lastSuccessAt || null,
    lastRequestAt: input.lastRequestAt || null
  };
}

function defaultAuto(input = {}) {
  return {
    checkin: input.checkin !== false,
    tasks: input.tasks !== false,
    claim: input.claim !== false,
    keepalive: input.keepalive !== false,
    inspect: input.inspect !== false
  };
}

function createAccount(input = {}) {
  const total = safeNumber(input.total ?? input.total_capacity_size ?? input.quota?.total, 0);
  const used = safeNumber(input.used ?? input.total_capacity_used ?? input.quota?.used, 0);
  return {
    id: input.id || `acc-${randomUUID().slice(0, 8)}`,
    label: String(input.label || '未命名账号').slice(0, 64),
    provider: String(input.provider || 'WorkBuddy').slice(0, 40),
    region: String(input.region || '国服').slice(0, 24),
    batch: String(input.batch || '').slice(0, 40),
    role: String(input.role || '').slice(0, 24),
    officialUrl: String(input.officialUrl || DEFAULT_SETTINGS.officialUrl),
    notes: String(input.notes || '').slice(0, 500),
    disabled: Boolean(input.disabled),
    status: input.status || 'unknown',
    health: input.health || 'unknown',
    auto: defaultAuto(input.auto),
    quota: {
      total: Math.max(0, Math.round(total)),
      used: Math.max(0, Math.round(used))
    },
    cooldownUntil: input.cooldownUntil || null,
    lastRefreshAt: input.lastRefreshAt || null,
    lastInspectAt: input.lastInspectAt || null,
    lastKeepaliveAt: input.lastKeepaliveAt || null,
    lastCheckInAt: input.lastCheckInAt || null,
    lastCheckInDate: input.lastCheckInDate || null,
    lastTaskAt: input.lastTaskAt || null,
    lastTaskStatus: input.lastTaskStatus || null,
    lastTaskDetail: input.lastTaskDetail || null,
    lastClaimAt: input.lastClaimAt || null,
    lastClaimDate: input.lastClaimDate || null,
    uid: input.uid ? String(input.uid) : '',
    lastClaimAmount: input.lastClaimAmount ?? null,
    growth: input.growth ?? null,
    lastError: input.lastError || null,
    errorCount: safeNumber(input.errorCount, 0),
    successCount: safeNumber(input.successCount, 0),
    stats: defaultStats(input.stats),
    createdAt: input.createdAt || nowIso(),
    updatedAt: input.updatedAt || nowIso()
  };
}

export class Store {
  constructor({ stateFile, secretsFile }) {
    this.stateFile = stateFile;
    this.secretsFile = secretsFile;
    this.dataDir = dirname(stateFile);
    this.box = new SecretBox(this.dataDir);
    this.state = null;
    this.secrets = {};
    this.queue = Promise.resolve();
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true });
    let loaded = null;
    try {
      loaded = JSON.parse(await readFile(this.stateFile, 'utf8'));
    } catch {
      loaded = null;
    }
    const base = {
      version: 2,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      settings: clone(DEFAULT_SETTINGS),
      accounts: [],
      jobs: [],
      events: [],
      requests: []
    };
    if (loaded && typeof loaded === 'object') {
      this.state = {
        ...base,
        ...loaded,
        settings: deepMerge(clone(DEFAULT_SETTINGS), loaded.settings || {}),
        accounts: Array.isArray(loaded.accounts) ? loaded.accounts.map((account) => createAccount(account)) : [],
        jobs: Array.isArray(loaded.jobs) ? loaded.jobs : [],
        events: Array.isArray(loaded.events) ? loaded.events : [],
        requests: Array.isArray(loaded.requests) ? loaded.requests : []
      };
    } else {
      this.state = base;
    }
    await this.loadSecrets();
    await this.persist();
    return this.state;
  }

  async loadSecrets() {
    try {
      const raw = JSON.parse(await readFile(this.secretsFile, 'utf8'));
      this.secrets = raw && typeof raw === 'object' ? raw : {};
    } catch {
      this.secrets = {};
    }
  }

  persist() {
    const snapshot = JSON.stringify(this.state, null, 2);
    const secretSnapshot = JSON.stringify(this.secrets, null, 2);
    this.queue = this.queue.then(async () => {
      await mkdir(this.dataDir, { recursive: true });
      const stateTemp = `${this.stateFile}.tmp`;
      await writeFile(stateTemp, snapshot, 'utf8');
      await rename(stateTemp, this.stateFile);
      const secretTemp = `${this.secretsFile}.tmp`;
      await writeFile(secretTemp, secretSnapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(secretTemp, this.secretsFile);
    });
    return this.queue;
  }

  get settings() {
    return this.state.settings;
  }

  patchSettings(patch) {
    this.state.settings = deepMerge(this.state.settings, patch || {});
    this.state.updatedAt = nowIso();
    return this.persist();
  }

  listAccounts() {
    return this.state.accounts;
  }

  getAccount(id) {
    return this.state.accounts.find((account) => account.id === id) || null;
  }

  async addAccount(input) {
    const account = createAccount(input);
    const usedIds = new Set(this.state.accounts.map((item) => item.id));
    let id = normalizeId(account.id) || account.id;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${normalizeId(account.id)}-${suffix++}`;
    }
    account.id = id;
    this.state.accounts.push(account);
    if (input.secret) await this.setSecret(account.id, input.secret, input.authType);
    await this.persist();
    return account;
  }

  async updateAccount(id, patch) {
    const account = this.getAccount(id);
    if (!account) return null;
    const allowed = ['label', 'provider', 'region', 'batch', 'role', 'uid', 'auto', 'health', 'officialUrl', 'notes', 'disabled', 'status', 'cooldownUntil', 'lastError', 'errorCount', 'lastRefreshAt', 'lastInspectAt', 'lastKeepaliveAt', 'lastCheckInAt', 'lastCheckInDate', 'lastTaskAt', 'lastTaskStatus', 'lastTaskDetail', 'lastClaimAt', 'lastClaimDate', 'lastClaimAmount', 'growth', 'successCount', 'quota', 'stats'];
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        if (key === 'label') account.label = String(patch.label).slice(0, 64);
        else if (key === 'provider') account.provider = String(patch.provider).slice(0, 40);
        else if (key === 'region') account.region = String(patch.region).slice(0, 24);
        else if (key === 'notes') account.notes = String(patch.notes).slice(0, 500);
        else if (key === 'officialUrl') account.officialUrl = String(patch.officialUrl);
        else if (key === 'stats') account.stats = defaultStats({ ...account.stats, ...patch.stats });
        else if (key === 'quota') {
          account.quota = {
            total: Math.max(0, Math.round(safeNumber(patch.quota?.total, account.quota.total))),
            used: Math.max(0, Math.round(safeNumber(patch.quota?.used, account.quota.used)))
          };
        } else if (key === 'disabled') account.disabled = Boolean(patch.disabled);
        else if (key === 'errorCount' || key === 'successCount') account[key] = Math.max(0, Math.round(safeNumber(patch[key], 0)));
        else account[key] = patch[key];
      }
    }
    account.updatedAt = nowIso();
    await this.persist();
    return account;
  }

  async removeAccount(id) {
    const index = this.state.accounts.findIndex((account) => account.id === id);
    if (index === -1) return false;
    this.state.accounts.splice(index, 1);
    delete this.secrets[id];
    await this.persist();
    return true;
  }

  async setSecret(id, secret, authType) {
    if (!secret) {
      delete this.secrets[id];
    } else {
      const encrypted = await this.box.encrypt(String(secret));
      this.secrets[id] = { ...encrypted, authType: authType || 'cookie', updatedAt: nowIso() };
    }
    await this.persist();
  }

  async getSecret(id) {
    const entry = this.secrets[id];
    if (!entry) return null;
    const value = await this.box.decrypt(entry);
    if (value === null) return null;
    return { value, authType: entry.authType || 'cookie' };
  }

  hasSecret(id) {
    return Boolean(this.secrets[id]);
  }

  secretMeta(id) {
    const entry = this.secrets[id];
    if (!entry) return null;
    return { authType: entry.authType || 'cookie', updatedAt: entry.updatedAt || null };
  }

  async pushEvent(type, details = {}, level = 'info') {
    const event = { id: randomUUID(), type, level, at: nowIso(), ...details };
    this.state.events.unshift(event);
    this.state.events = this.state.events.slice(0, 400);
    await this.persist();
    return event;
  }

  async pushRequest(request) {
    const entry = { id: request.id || randomUUID(), at: nowIso(), ...request };
    this.state.requests.unshift(entry);
    this.state.requests = this.state.requests.slice(0, 300);
    await this.persist();
    return entry;
  }

  async createJob(job) {
    const entry = { id: randomUUID(), startedAt: nowIso(), finishedAt: null, status: 'running', steps: [], ...job };
    this.state.jobs.unshift(entry);
    this.state.jobs = this.state.jobs.slice(0, 200);
    await this.persist();
    return entry;
  }

  async updateJob(id, patch) {
    const job = this.state.jobs.find((item) => item.id === id);
    if (!job) return null;
    Object.assign(job, patch);
    if (patch.status && patch.status !== 'running' && !job.finishedAt) job.finishedAt = nowIso();
    await this.persist();
    return job;
  }

  today(timeZone = this.settings.timezone) {
    return localDate(new Date(), timeZone);
  }

  async reset({ keepAccounts = true, keepSecrets = true } = {}) {
    const keep = keepAccounts ? this.state.accounts.map((account) => ({
      ...account,
      quota: { total: 0, used: 0 },
      cooldownUntil: null,
      lastRefreshAt: null,
      lastCheckInAt: null,
      lastCheckInDate: null,
      lastTaskAt: null,
      lastTaskStatus: null,
      lastTaskDetail: null,
      lastClaimAt: null,
      lastClaimDate: null,
      lastClaimAmount: null,
      growth: null,
      lastError: null,
      errorCount: 0,
      successCount: 0
    })) : [];
    if (!keepSecrets) this.secrets = {};
    else if (!keepAccounts) this.secrets = {};
    this.state.accounts = keep;
    this.state.jobs = [];
    this.state.events = [];
    this.state.requests = [];
    this.state.updatedAt = nowIso();
    await this.persist();
    return this.state;
  }

  exportSafe() {
    return {
      exportedAt: nowIso(),
      settings: {
        ...clone(this.state.settings),
        upstream: { ...clone(this.state.settings.upstream) }
      },
      accounts: this.state.accounts.map(({ ...account }) => ({ ...account })),
      jobs: this.state.jobs.slice(0, 50),
      events: this.state.events.slice(0, 100),
      requests: this.state.requests.slice(0, 50)
    };
  }

  get statePathExists() {
    return existsSync(this.stateFile);
  }

  get paths() {
    return { stateFile: this.stateFile, secretsFile: this.secretsFile, dataDir: this.dataDir };
  }
}

export function settingsForClient(settings) {
  return {
    ...clone(settings),
    upstream: {
      ...clone(settings.upstream),
      hasBaseUrl: Boolean(settings.upstream.baseUrl)
    }
  };
}
