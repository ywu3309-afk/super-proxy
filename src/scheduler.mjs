import { localDate, nowIso, safeNumber } from './util.mjs';

export function availableOf(account) {
  const total = safeNumber(account?.quota?.total, 0);
  const used = safeNumber(account?.quota?.used, 0);
  return Math.max(0, Math.round(total - used));
}

export function isCoolingDown(account, at = Date.now()) {
  if (!account?.cooldownUntil) return false;
  const until = new Date(account.cooldownUntil).getTime();
  return Number.isFinite(until) && until > at;
}

export function cooldownRemainingMs(account, at = Date.now()) {
  if (!account?.cooldownUntil) return 0;
  const until = new Date(account.cooldownUntil).getTime();
  if (!Number.isFinite(until)) return 0;
  return Math.max(0, until - at);
}

export function usability(account, at = Date.now()) {
  if (account.disabled) return { usable: false, reason: 'disabled' };
  if (account.status === 'auth_error') return { usable: false, reason: 'auth_error' };
  if (isCoolingDown(account, at)) return { usable: false, reason: 'cooldown', remainingMs: cooldownRemainingMs(account, at) };
  if (account.errorCount >= 4 && account.lastError) {
    const lastErrorAt = account.updatedAt ? new Date(account.updatedAt).getTime() : 0;
    if (Number.isFinite(lastErrorAt) && at - lastErrorAt > 30 * 60 * 1000) {
      // 长时间无新错误后自动恢复，避免永久拉黑
      return { usable: true, reason: 'recovered' };
    }
  }
  if (availableOf(account) <= 0) return { usable: false, reason: 'empty' };
  return { usable: true, reason: 'ok' };
}

export function describeAccount(account, at = Date.now(), inFlight = 0) {
  const state = usability(account, at);
  const stats = account.stats || {};
  const requests = safeNumber(stats.requests, 0);
  const totalLatency = safeNumber(stats.totalLatencyMs, 0);
  return {
    ...account,
    available: availableOf(account),
    cooling: isCoolingDown(account, at),
    cooldownRemainingMs: cooldownRemainingMs(account, at),
    usable: state.usable,
    unusableReason: state.usable ? null : state.reason,
    inFlight,
    avgLatencyMs: requests ? Math.round(totalLatency / requests) : null,
    tokensPerSecond: totalLatency > 0 && safeNumber(stats.outputTokens, 0) > 0
      ? Math.max(1, Math.round((safeNumber(stats.outputTokens, 0) / totalLatency) * 1000))
      : null
  };
}

export class Scheduler {
  constructor(store) {
    this.store = store;
    this.inFlight = new Map();
  }

  beginRequest(accountId) {
    this.inFlight.set(accountId, (this.inFlight.get(accountId) || 0) + 1);
  }

  endRequest(accountId) {
    const current = (this.inFlight.get(accountId) || 0) - 1;
    if (current <= 0) this.inFlight.delete(accountId);
    else this.inFlight.set(accountId, current);
  }

  inFlightOf(accountId) {
    return this.inFlight.get(accountId) || 0;
  }

  async recordRequest(accountId, { ok = true, tokens = 0, outputTokens = 0, latencyMs = 0 } = {}) {
    const account = this.store.getAccount(accountId);
    if (!account) return null;
    const stats = account.stats || {};
    const next = {
      success: safeNumber(stats.success, 0) + (ok ? 1 : 0),
      fail: safeNumber(stats.fail, 0) + (ok ? 0 : 1),
      requests: safeNumber(stats.requests, 0) + 1,
      tokens: safeNumber(stats.tokens, 0) + Math.max(0, Math.round(tokens)),
      outputTokens: safeNumber(stats.outputTokens, 0) + Math.max(0, Math.round(outputTokens)),
      todayTokens: (stats.todayDate === localDate() ? safeNumber(stats.todayTokens, 0) : 0) + Math.max(0, Math.round(tokens)),
      todayDate: localDate(),
      totalLatencyMs: safeNumber(stats.totalLatencyMs, 0) + Math.max(0, Math.round(latencyMs)),
      lastLatencyMs: Math.max(0, Math.round(latencyMs)),
      lastSuccessAt: ok ? nowIso() : stats.lastSuccessAt || null,
      lastRequestAt: nowIso()
    };
    return this.store.updateAccount(accountId, { stats: next });
  }

  candidates({ requiredTokens = 1, exclude = new Set(), includeDisabled = false } = {}) {
    const at = Date.now();
    return this.store.listAccounts()
      .filter((account) => !exclude.has(account.id))
      .filter((account) => includeDisabled || !account.disabled)
      .filter((account) => account.status !== 'auth_error')
      .filter((account) => !isCoolingDown(account, at))
      .filter((account) => availableOf(account) >= requiredTokens)
      .sort((a, b) => {
        const diff = availableOf(b) - availableOf(a);
        if (diff !== 0) return diff;
        return String(a.lastRefreshAt || '').localeCompare(String(b.lastRefreshAt || ''));
      });
  }

  pick({ requiredTokens = 1, exclude = [], includeDisabled = false } = {}) {
    const excluded = new Set(exclude);
    const list = this.candidates({ requiredTokens, exclude: excluded, includeDisabled });
    return list[0] || null;
  }

  async reserve(accountId, tokens) {
    const account = this.store.getAccount(accountId);
    if (!account) return null;
    const quota = account.quota || { total: 0, used: 0 };
    await this.store.updateAccount(accountId, {
      quota: { total: quota.total, used: Math.min(quota.total, Math.round(quota.used + Math.max(0, tokens))) },
      successCount: safeNumber(account.successCount, 0) + 1
    });
    return this.store.getAccount(accountId);
  }

  async release(accountId, tokens) {
    const account = this.store.getAccount(accountId);
    if (!account) return null;
    const quota = account.quota || { total: 0, used: 0 };
    await this.store.updateAccount(accountId, {
      quota: { total: quota.total, used: Math.max(0, Math.round(quota.used - Math.max(0, tokens))) }
    });
    return this.store.getAccount(accountId);
  }

  async markSuccess(accountId, patch = {}) {
    const account = this.store.getAccount(accountId);
    if (!account) return null;
    return this.store.updateAccount(accountId, {
      ...patch,
      status: 'available',
      lastError: null,
      errorCount: 0,
      cooldownUntil: null
    });
  }

  async markFailure(accountId, { reason, cooldownMs = 0, fatal = false, status } = {}) {
    const account = this.store.getAccount(accountId);
    if (!account) return null;
    const nextErrorCount = safeNumber(account.errorCount, 0) + 1;
    const cooldownUntil = cooldownMs > 0 ? new Date(Date.now() + cooldownMs).toISOString() : account.cooldownUntil;
    const nextStatus = status || (fatal ? 'auth_error' : nextErrorCount >= 3 ? 'degraded' : account.status === 'unknown' ? 'unknown' : account.status);
    return this.store.updateAccount(accountId, {
      lastError: { reason, at: nowIso(), detail: String(reason).slice(0, 300) },
      errorCount: nextErrorCount,
      cooldownUntil,
      status: nextStatus
    });
  }

  async clearError(accountId) {
    return this.store.updateAccount(accountId, {
      lastError: null,
      errorCount: 0,
      cooldownUntil: null,
      status: 'available'
    });
  }

  totals() {
    return this.store.listAccounts()
      .filter((account) => !account.disabled)
      .reduce((result, account) => {
        result.total += safeNumber(account.quota?.total, 0);
        result.used += safeNumber(account.quota?.used, 0);
        result.available += availableOf(account);
        if (isCoolingDown(account)) result.cooling += 1;
        if (account.status === 'auth_error') result.authError += 1;
        return result;
      }, { total: 0, used: 0, available: 0, cooling: 0, authError: 0 });
  }
}
