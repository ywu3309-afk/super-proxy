import { backoffDelay, localDate, nextDailyRunAt, nowIso, safeNumber, sleep } from './util.mjs';

const STEP_LABELS = {
  refresh: '刷新额度',
  keepalive: '自动保活',
  checkin: '自动签到',
  tasks: '一键做任务',
  claim: '自动领奖',
  inspect: '自动巡检'
};

// 把上游错误映射成卡片上的健康状态（对应参考图的 正常/限流/无权限/违规/过期/未激活）
function classifyHealth(reason, extra = {}) {
  const text = `${reason || ''} ${extra.body || ''}`.toLowerCase();
  if (/http_429|rate.?limit|too.?many|限流/.test(text)) return 'limited';
  if (/http_401|unauthorized|invalid.?token|登录已失效|token.?expired/.test(text)) return 'expired';
  if (/http_403|forbidden|no.?permission|无权限|无授权/.test(text)) return 'no_permission';
  if (/ban|blocked|violat|违规|封禁/.test(text)) return 'violation';
  if (/inactive|未激活|not.?activated|no.?subscription|未订阅/.test(text)) return 'inactive';
  if (!reason) return 'healthy';
  return 'error';
}

const FATAL_PATTERNS = /http_401|http_403|auth|unauthorized|forbidden|invalid.?token|未登录|登录已失效/i;

export class Automation {
  constructor({ store, upstream, scheduler }) {
    this.store = store;
    this.upstream = upstream;
    this.scheduler = scheduler;
    this.locks = new Map();
    this.timer = null;
    this.nextRunAt = null;
    this.lastRunAt = null;
    this.lastRunTrigger = null;
  }

  get settings() {
    return this.store.settings;
  }

  withLock(accountId, task) {
    const previous = this.locks.get(accountId) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.locks.set(accountId, next.catch(() => {}));
    return next;
  }

  async runStep(account, step, retries) {
    const startedAt = nowIso();
    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        const result = await this.executeStep(account, step);
        if (result.ok) {
          return { step, status: 'ok', attempts: attempt, startedAt, finishedAt: nowIso(), message: result.message || STEP_LABELS[step] };
        }
        lastError = result.reason || 'unknown_error';
        if (FATAL_PATTERNS.test(String(lastError))) {
          return { step, status: 'failed', attempts: attempt, startedAt, finishedAt: nowIso(), error: lastError, fatal: true };
        }
        if (attempt < retries) await sleep(backoffDelay(attempt, this.settings.automation.retryBaseMs || 4000));
      } catch (error) {
        lastError = String(error?.message || error).slice(0, 200);
        if (FATAL_PATTERNS.test(lastError)) {
          return { step, status: 'failed', attempts: attempt, startedAt, finishedAt: nowIso(), error: lastError, fatal: true };
        }
        if (attempt < retries) await sleep(backoffDelay(attempt, this.settings.automation.retryBaseMs || 4000));
      }
    }
    return { step, status: 'failed', attempts: retries, startedAt, finishedAt: nowIso(), error: lastError || 'retries_exhausted' };
  }

  async executeStep(account, step) {
    if (step === 'refresh') {
      const balance = await this.upstream.fetchBalance(account);
      if (!balance.ok) {
        await this.scheduler.markFailure(account.id, { reason: balance.reason || 'balance_failed', fatal: FATAL_PATTERNS.test(String(balance.reason)) });
        await this.store.updateAccount(account.id, { health: classifyHealth(balance.reason, balance) });
        return { ok: false, reason: balance.reason };
      }
      await this.store.updateAccount(account.id, {
        quota: { total: balance.total, used: balance.used },
        lastRefreshAt: nowIso(),
        status: 'available',
        health: 'healthy',
        errorCount: 0,
        lastError: null
      });
      return { ok: true, message: `可用 ${balance.available}` };
    }

    // 保活：把会话续上（WorkBuddy 走 refresh token），再用一次轻量额度查询确认在线
    if (step === 'keepalive') {
      const renewed = await this.upstream.refreshWorkbuddyCredential?.(account).catch(() => null);
      const balance = await this.upstream.fetchBalance(account).catch((error) => ({ ok: false, reason: String(error?.message || error) }));
      const ok = Boolean(balance.ok) || Boolean(renewed);
      await this.store.updateAccount(account.id, {
        lastKeepaliveAt: nowIso(),
        health: ok ? 'healthy' : classifyHealth(balance.reason, balance),
        status: ok ? 'available' : 'error',
        ...(balance.ok ? { quota: { total: balance.total, used: balance.used }, lastRefreshAt: nowIso() } : {}),
        ...(ok ? { errorCount: 0, lastError: null } : { lastError: balance.reason || 'keepalive_failed' })
      });
      if (!ok) {
        await this.scheduler.markFailure(account.id, {
          reason: balance.reason || 'keepalive_failed',
          fatal: FATAL_PATTERNS.test(String(balance.reason))
        });
        return { ok: false, reason: balance.reason || 'keepalive_failed' };
      }
      return { ok: true, message: renewed ? '会话已续期' : '账号在线' };
    }

    // 巡检：签到状态 + 额度 + 健康分级，对应参考图顶部「一键巡检」
    if (step === 'inspect') {
      const status = await this.upstream.checkinStatus?.(account).catch(() => ({ ok: false }));
      const balance = await this.upstream.fetchBalance(account).catch((error) => ({ ok: false, reason: String(error?.message || error) }));
      const health = balance.ok ? 'healthy' : classifyHealth(balance.reason, balance);
      const patch = {
        lastInspectAt: nowIso(),
        health,
        ...(balance.ok ? { quota: { total: balance.total, used: balance.used }, lastRefreshAt: nowIso() } : {}),
        ...(status?.ok && status.checkedIn ? { lastCheckInDate: localDate(new Date(), this.settings.timezone) } : {})
      };
      await this.store.updateAccount(account.id, patch);
      await this.store.pushEvent('inspect', {
        accountId: account.id,
        label: account.label,
        health,
        available: balance.ok ? balance.available : null,
        checkedIn: Boolean(status?.ok && status.checkedIn)
      }, health === 'healthy' ? 'info' : 'warn');
      if (!balance.ok && FATAL_PATTERNS.test(String(balance.reason))) {
        await this.scheduler.markFailure(account.id, { reason: balance.reason, fatal: true, status: 'auth_error' });
      }
      return {
        ok: balance.ok,
        reason: balance.ok ? undefined : balance.reason,
        message: balance.ok ? `巡检正常，可用 ${balance.available}` : `巡检异常：${balance.reason}`
      };
    }

    if (step === 'checkin') {
      const today = localDate(new Date(), this.settings.timezone);
      if (account.lastCheckInDate === today) return { ok: true, message: '今日已签到（本地记录）' };
      const result = await this.upstream.checkIn(account);
      if (!result.ok) {
        await this.scheduler.markFailure(account.id, { reason: result.reason || 'checkin_failed', fatal: FATAL_PATTERNS.test(String(result.reason)) });
        return { ok: false, reason: result.reason };
      }
      await this.store.updateAccount(account.id, {
        lastCheckInAt: nowIso(),
        lastCheckInDate: today,
        status: 'available',
        health: 'healthy',
        errorCount: 0,
        lastError: null
      });
      await this.store.pushEvent('checkin', { accountId: account.id, label: account.label, mock: Boolean(result.mock), message: result.message || '' });
      if (result.reward && Number.isFinite(Number(result.reward))) {
        const current = this.store.getAccount(account.id);
        await this.store.updateAccount(account.id, {
          quota: { total: safeNumber(current.quota.total, 0) + Number(result.reward), used: safeNumber(current.quota.used, 0) }
        });
      }
      return { ok: true, message: result.message || '签到完成' };
    }

    if (step === 'tasks') {
      if (await this.upstream.hasTaskWorkflow?.(account)) {
        const result = await this.upstream.runTasks(account);
        if (!result.ok) {
          await this.scheduler.markFailure(account.id, { reason: (result.failures || []).join('; ') || 'tasks_failed' });
          return { ok: false, reason: (result.failures || []).join('; ') || 'tasks_failed' };
        }
        await this.store.updateAccount(account.id, {
          lastTaskAt: nowIso(),
          lastTaskStatus: result.claimed > 0 ? 'completed' : 'nothing_pending',
          lastTaskDetail: String(result.message || '').slice(0, 300)
        });
        await this.store.pushEvent('tasks', {
          accountId: account.id,
          label: account.label,
          total: result.total,
          pending: result.pending,
          accepted: result.accepted,
          claimed: result.claimed
        }, 'info');
        return { ok: true, message: result.message };
      }
      const listing = await this.upstream.listTasks(account);
      if (!listing.ok) {
        await this.scheduler.markFailure(account.id, { reason: listing.reason || 'tasks_failed' });
        return { ok: false, reason: listing.reason };
      }
      const pending = listing.pending || [];
      let completed = 0;
      const failures = [];
      for (const task of pending) {
        const result = await this.upstream.completeTask(account, task);
        if (result.ok) completed += 1;
        else failures.push(`${task.title}:${result.reason || 'failed'}`);
      }
      const status = failures.length === 0 ? (pending.length ? 'completed' : 'nothing_pending') : 'partial';
      await this.store.updateAccount(account.id, {
        lastTaskAt: nowIso(),
        lastTaskStatus: status,
        lastTaskDetail: failures.length ? failures.join('; ').slice(0, 300) : `${completed}/${pending.length} 完成`
      });
      await this.store.pushEvent('tasks', {
        accountId: account.id,
        label: account.label,
        mock: Boolean(listing.mock),
        completed,
        pending: pending.length
      }, failures.length ? 'warn' : 'info');
      return { ok: failures.length === 0 || completed > 0, reason: failures.join('; '), message: `${completed}/${pending.length} 任务完成` };
    }

    if (step === 'claim') {
      const today = localDate(new Date(), this.settings.timezone);
      if (account.lastClaimDate === today) return { ok: true, message: '今日已领取（本地记录）' };
      const settle = safeNumber(this.settings.automation.settleBeforeClaimMs, 0);
      if (settle > 0) await sleep(settle);
      const result = await this.upstream.claim(account);
      if (!result.ok) {
        await this.scheduler.markFailure(account.id, { reason: result.reason || 'claim_failed', fatal: FATAL_PATTERNS.test(String(result.reason)) });
        return { ok: false, reason: result.reason };
      }
      const amount = Number.isFinite(Number(result.amount)) ? Number(result.amount) : 0;
      const current = this.store.getAccount(account.id);
      // 成长体系（连签/等级/旅行奖励）随领取结果一起落库，卡片与详情直接展示
      const growth = result.growth
        ? {
          level: result.growth.level ?? null,
          levelName: result.growth.levelName || '',
          streakDays: result.growth.streakDays ?? null,
          points: result.growth.points ?? null,
          travel: result.travel?.ok ? 'claimed' : (result.travel?.reason || 'unknown'),
          at: nowIso()
        }
        : current.growth || null;
      await this.store.updateAccount(account.id, {
        lastClaimAt: nowIso(),
        lastClaimDate: today,
        lastClaimAmount: amount || null,
        growth,
        quota: amount > 0
          ? { total: safeNumber(current.quota.total, 0) + amount, used: safeNumber(current.quota.used, 0) }
          : current.quota,
        status: 'available',
        health: 'healthy',
        errorCount: 0,
        lastError: null
      });
      await this.store.pushEvent('claim', { accountId: account.id, label: account.label, mock: Boolean(result.mock), amount }, 'info');
      return { ok: true, message: amount ? `领取 ${amount}` : (result.message || '领取完成') };
    }

    return { ok: false, reason: `unknown_step:${step}` };
  }

  async runAccount(accountId, { steps, trigger = 'manual' } = {}) {
    const account = this.store.getAccount(accountId);
    if (!account) return { ok: false, error: 'account_not_found' };
    const plan = this.planFor(account, steps);
    if (!plan.length) return { ok: true, skipped: true, status: 'skipped', message: '该账号已关闭全部自动化开关' };
    const retries = Math.max(1, safeNumber(this.settings.automation.retries, 3));
    return this.withLock(accountId, async () => {
      const job = await this.store.createJob({
        accountId,
        label: account.label,
        trigger,
        steps: plan
      });
      const stepResults = [];
      let fatal = false;
      for (const step of plan) {
        const current = this.store.getAccount(accountId) || account;
        if (current.disabled) {
          stepResults.push({ step, status: 'skipped', error: 'account_disabled' });
          fatal = true;
          break;
        }
        const result = await this.runStep(current, step, retries);
        stepResults.push(result);
        if (result.fatal) { fatal = true; break; }
      }
      const failed = stepResults.filter((item) => item.status === 'failed');
      const status = failed.length === 0 ? 'completed' : failed.length === stepResults.length ? 'failed' : 'partial';
      await this.store.updateJob(job.id, { status, steps: stepResults });
      await this.store.pushEvent('automation_job', {
        jobId: job.id,
        accountId,
        label: account.label,
        status,
        trigger,
        steps: stepResults.map((item) => `${item.step}:${item.status}`).join(',')
      }, status === 'failed' ? 'error' : status === 'partial' ? 'warn' : 'info');
      return { ok: status !== 'failed', jobId: job.id, status, steps: stepResults, fatal };
    });
  }

  enabledSteps() {
    const steps = this.settings.automation.steps || {};
    return ['keepalive', 'refresh', 'inspect', 'checkin', 'tasks', 'claim'].filter((step) => steps[step] === true);
  }

  // 每个账号自己的开关（卡片上的 自动签到 / 自动巡检 / 自动领奖）参与裁剪
  planFor(account, steps) {
    const base = steps && steps.length ? steps : this.enabledSteps();
    const auto = account.auto || {};
    return base.filter((step) => {
      if ((step === 'checkin' || step === 'tasks' || step === 'claim' || step === 'keepalive' || step === 'inspect') && auto[step] === false) return false;
      return true;
    });
  }

  async runAll({ trigger = 'manual', accountIds = null, steps = null } = {}) {
    const targets = (accountIds && accountIds.length
      ? accountIds.map((id) => this.store.getAccount(id)).filter(Boolean)
      : this.store.listAccounts().filter((account) => !account.disabled));
    const jitter = Math.max(0, safeNumber(this.settings.automation.jitterSeconds, 0));
    const results = [];
    for (let index = 0; index < targets.length; index += 1) {
      const account = targets[index];
      if (index > 0 && jitter > 0) {
        await sleep(Math.min(15000, Math.round((jitter * 1000) / Math.max(1, targets.length))));
      }
      results.push({ accountId: account.id, label: account.label, ...(await this.runAccount(account.id, { trigger, steps: steps || undefined })) });
    }
    this.lastRunAt = nowIso();
    this.lastRunTrigger = trigger;
    return { ok: results.every((item) => item.status !== 'failed'), results };
  }

  scheduleNext() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.settings.automation.enabled) {
      this.nextRunAt = null;
      return null;
    }
    const next = nextDailyRunAt(this.settings.automation.time, this.settings.timezone, new Date());
    this.nextRunAt = next.toISOString();
    const delay = Math.max(1000, Math.min(next.getTime() - Date.now(), 2147483000));
    this.timer = setTimeout(async () => {
      try {
        await this.runAll({ trigger: 'schedule' });
      } catch (error) {
        await this.store.pushEvent('automation_error', { message: String(error?.message || error) }, 'error');
      } finally {
        this.scheduleNext();
      }
    }, delay);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this.nextRunAt;
  }

  start() {
    this.scheduleNext();
    this.scheduleIntervals();
    return this.nextRunAt;
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
    for (const key of ['keepaliveTimer', 'inspectTimer']) {
      if (this[key]) clearInterval(this[key]);
      this[key] = null;
    }
  }

  describe() {
    return {
      enabled: Boolean(this.settings.automation.enabled),
      time: this.settings.automation.time,
      timezone: this.settings.timezone,
      nextRunAt: this.nextRunAt,
      lastRunAt: this.lastRunAt,
      lastRunTrigger: this.lastRunTrigger,
      steps: this.enabledSteps(),
      keepalive: { ...(this.settings.automation.keepalive || {}), nextRunAt: this.nextKeepaliveAt || null },
      inspect: { ...(this.settings.automation.inspect || {}), nextRunAt: this.nextInspectAt || null },
      running: [...this.locks.keys()]
    };
  }

  // 保活/巡检是短周期任务，和每日签到各自独立计时
  scheduleIntervals() {
    for (const key of ['keepalive', 'inspect']) {
      const conf = this.settings.automation[key] || {};
      const timerKey = `${key}Timer`;
      if (this[timerKey]) {
        clearInterval(this[timerKey]);
        this[timerKey] = null;
      }
      this[`next${key[0].toUpperCase()}${key.slice(1)}At`] = null;
      if (!conf.enabled || !this.settings.automation.enabled) continue;
      const minutes = Math.max(5, safeNumber(conf.intervalMinutes, 45));
      const tick = async () => {
        try {
          const targets = this.store.listAccounts().filter((account) => !account.disabled && account.auto?.[key] !== false);
          for (const account of targets) {
            await this.runAccount(account.id, { trigger: key, steps: [key] }).catch(() => null);
          }
        } catch (error) {
          await this.store.pushEvent(`${key}_error`, { message: String(error?.message || error) }, 'error');
        }
        this[`next${key[0].toUpperCase()}${key.slice(1)}At`] = new Date(Date.now() + minutes * 60000).toISOString();
      };
      const timer = setInterval(tick, minutes * 60000);
      if (typeof timer.unref === 'function') timer.unref();
      this[timerKey] = timer;
      this[`next${key[0].toUpperCase()}${key.slice(1)}At`] = new Date(Date.now() + minutes * 60000).toISOString();
    }
  }
}
