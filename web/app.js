const view = document.getElementById('view');
const toastEl = document.getElementById('toast');
const modal = document.getElementById('modal');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');

let S = null;
let currentTab = 'overview';
let busy = new Set();
let timer = null;
let lastError = null;

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (value) => Number(value || 0).toLocaleString('zh-CN');

const STEP_LABELS = { refresh: '刷新额度', keepalive: '保活', inspect: '巡检', checkin: '签到', tasks: '做任务', claim: '领取积分' };
// 官方模型目录：优先用 /api/catalog 拿真实清单与倍率，这里只是兜底
const FALLBACK_MODELS = [
  'auto', 'glm-5.1', 'glm-5.0', 'glm-5.0-turbo', 'glm-5v-turbo', 'glm-4.7', 'glm-4.6', 'glm-4.6v',
  'deepseek-v4-pro', 'deepseek-v4-pro-exclusive', 'deepseek-v3-2-volc', 'deepseek-v3.1', 'deepseek-v3-0324',
  'kimi-k2.6', 'kimi-k2.5', 'kimi-k2-thinking', 'minimax-m2.7', 'minimax-m2.5',
  'hunyuan-chat', 'hunyuan-2.0-instruct', 'hunyuan-image-v3.0'
];
let CATALOG = [];

function catalogEntries() {
  if (CATALOG.length) return CATALOG;
  return FALLBACK_MODELS.map((id) => ({ id, name: id, credits: null }));
}

function modelPills() {
  return catalogEntries().map((item) => {
    const image = (item.tags || []).includes('text-to-image');
    const rate = item.credits === null || item.credits === undefined
      ? '免费'
      : `×${item.credits}`;
    const title = `${item.name || item.id}${image ? '（文生图，不走对话）' : ''} · ${rate}`;
    return `<span class="pill ${image ? 'info' : 'ok'} mono" title="${esc(title)}">${esc(item.id)}<em class="rate">${esc(rate)}</em></span>`;
  }).join('');
}
const stepPlanText = (steps) => (Array.isArray(steps) ? steps : []).map((step) => STEP_LABELS[step] || step).join(' → ');

function toast(message, kind = '') {
  toastEl.textContent = message;
  toastEl.className = `toast show ${kind}`.trim();
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => { toastEl.className = 'toast'; }, 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error || `请求失败（${response.status}）`;
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  return payload;
}

function rel(input) {
  if (!input) return '—';
  const time = new Date(input).getTime();
  if (!Number.isFinite(time)) return '—';
  const diff = Date.now() - time;
  if (diff < 45000) return '刚刚';
  if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时前`;
  return new Date(time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function abs(input) {
  if (!input) return '—';
  const time = new Date(input);
  if (!Number.isFinite(time.getTime())) return '—';
  return time.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function cooldownText(account) {
  if (!account.cooldownUntil) return '';
  const remaining = new Date(account.cooldownUntil).getTime() - Date.now();
  if (remaining <= 0) return '';
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  return `冷却 ${minutes}分${String(seconds).padStart(2, '0')}秒`;
}

function statusPill(account) {
  if (account.disabled) return '<span class="pill muted"><i class="dot"></i>已禁用</span>';
  if (account.status === 'auth_error') return '<span class="pill err"><i class="dot"></i>授权失效</span>';
  if (account.cooling) return `<span class="pill warn" data-cooldown="${esc(account.cooldownUntil)}"><i class="dot"></i><span class="cd">${esc(cooldownText(account) || '冷却中')}</span></span>`;
  if (!account.lastRefreshAt && Number(account.quota?.total || 0) === 0) return '<span class="pill info"><i class="dot"></i>待刷新额度</span>';
  if (account.available <= 0) return '<span class="pill muted"><i class="dot"></i>额度耗尽</span>';
  if (account.lastError) return '<span class="pill warn"><i class="dot"></i>待重试</span>';
  return '<span class="pill ok"><i class="dot"></i>可调度</span>';
}

function taskPill(account) {
  const status = account.lastTaskStatus;
  if (!status) return '<span class="muted">—</span>';
  const map = { completed: ['ok', '已完成'], nothing_pending: ['info', '无待办'], partial: ['warn', '部分完成'], failed: ['err', '失败'] };
  const [kind, label] = map[status] || ['muted', status];
  return `<span class="pill ${kind}">${esc(label)}</span>`;
}

function mask(text) {
  const value = String(text || '');
  if (value.length <= 8) return value ? "••••" : '';
  return value.slice(0, 4) + "••••" + value.slice(-4);
}

let AGENTS = null;

const PROTOCOL_LABEL = { openai: 'OpenAI 兼容', anthropic: 'Anthropic', responses: 'Responses' };

async function renderAgents() {
  if (!S) return;
  if (!AGENTS) {
    view.innerHTML = '<div class="empty">正在探测本机已安装的客户端…</div>';
    try {
      AGENTS = await api('/api/agents');
      AGENTS._atrest = await api('/api/atrest').catch(() => null);
    } catch (error) {
      view.innerHTML = `<div class="empty">探测失败：${esc(error.message)}</div>`;
      return;
    }
  }
  const gateway = AGENTS.gateway || {};
  const clients = Object.values(AGENTS.clients || {});
  const atrest = AGENTS._atrest || {};
  const pinnedAccounts = (S.accounts || []).filter((account) => account.uid);
  const baseUrl = gateway.baseUrlV1 || `${location.origin}/v1`;
  const rootUrl = gateway.baseUrl || location.origin;

  view.innerHTML = `
    <section class="card">
      <div class="pool-head">
        <div>
          <h2 class="section-title">智能体一键配置</h2>
          <p class="hint">把本网关写进各家 CLI 的配置里，改前自动备份、随时可一键还原。DSH 会连带写入思考档位与上下文窗口。</p>
        </div>
        <div class="pool-head-actions">
          <button class="btn ghost" data-act="agents-refresh">重新探测</button>
        </div>
      </div>
      <div class="agent-endpoint">
        <div><span class="k">Base URL</span><span class="v mono">${esc(baseUrl)}</span></div>
        <div><span class="k">API Key</span><span class="v mono">${gateway.apiKey ? esc(mask(gateway.apiKey)) : '未设置（网关不校验）'}</span></div>
        <div><span class="k">默认模型</span><span class="v mono">${esc(gateway.model || '—')}</span></div>
      </div>
    </section>

    <div class="agent-grid">
      ${clients.map((client) => {
        const badge = client.applied
          ? `<span class="pill ok">已配置${client.external ? ' · 有外部改动' : ''}</span>`
          : client.detected ? '<span class="pill info">已安装未配置</span>' : '<span class="pill muted">未检测到</span>';
        return `
        <div class="agent-card${client.id === 'dsh' ? ' primary' : ''}">
          <div class="agent-top">
            <div class="agent-name">${esc(client.label)}${client.id === 'dsh' ? ' <span class="pill ok">推荐</span>' : ''}</div>
            ${badge}
          </div>
          <p class="hint">${esc(client.desc)}</p>
          <div class="agent-meta">
            <span class="pill">${esc(PROTOCOL_LABEL[client.protocol] || client.protocol)}</span>
            ${(client.existing || []).length ? `<span class="muted mono">${esc((client.existing || [])[0])}</span>` : '<span class="muted">配置文件尚未创建</span>'}
          </div>
          <div class="btn-row">
            <button class="btn${client.id === 'dsh' ? '' : ' ghost'}" data-act="agent-apply" data-client="${esc(client.id)}">${client.applied ? '重新写入' : '一键配置'}</button>
            ${client.applied ? `<button class="btn ghost" data-act="agent-restore" data-client="${esc(client.id)}">还原</button>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>

    <section class="card">
      <h3 class="section-title">桌面客户端加密凭据</h3>
      <p class="hint">客户端自 2026-09-24 起把 token 存成 <span class="mono">$wbEncrypted</span> 信封。从客户端导入账号时，需要先给它解码密钥——只留在内存，重启后重新录入。</p>
      <div class="agent-endpoint">
        <div><span class="k">配置目录</span><span class="v mono">${esc(atrest.configDir || '—')}</span></div>
        <div><span class="k">keyblob</span><span class="v">${atrest.keyblob ? '<span class="pill ok">已找到</span>' : '<span class="pill muted">没有</span>'}</span></div>
        <div><span class="k">内存密钥</span><span class="v">${atrest.key ? `<span class="pill ok mono">${esc(atrest.keyId || '')}</span>` : '<span class="pill warn">未录入</span>'}</span></div>
      </div>
      <div class="btn-row" style="margin-top:10px">
        <input id="atrest-key" class="input mono" placeholder="粘贴 64 位 hex 或 44 字符 base64 密钥" ${atrest.keyblob ? '' : 'disabled'}>
        <button class="btn" data-act="atrest-save" ${atrest.keyblob ? '' : 'disabled'}>采纳密钥</button>
        <button class="btn ghost" data-act="atrest-recover" ${atrest.keyblob ? '' : 'disabled'}>从客户端回收</button>
        <button class="btn ghost" data-act="atrest-forget" ${atrest.key ? '' : 'disabled'}>忘记</button>
      </div>
      <p class="hint">「从客户端回收」会只读扫描运行中的 WorkBuddy 进程内存（约 1 分钟），用 keyblob 校验命中后只留在内存里。</p>
    </section>

    <section class="card">
      <h3 class="section-title">定址调用（锁定单个账号）</h3>
      <p class="hint">把 <span class="mono">/u/&lt;ref&gt;/v1</span> 当 Base URL 用，就只会走这一个号，不参与轮换与自动换号。ref 支持完整 uid、uid 前几位、或账号昵称。</p>
      ${pinnedAccounts.length ? `<div class="agent-pins">
        ${pinnedAccounts.map((account) => `
          <div class="agent-pin">
            <span class="acct-name">${esc(account.label)}</span>
            <span class="mono muted">${esc(`${rootUrl}/u/${account.uid}/v1`)}</span>
          </div>`).join('')}
      </div>` : '<p class="hint">账号还没有 uid（扫码登录或从客户端导入后会自动带上）。</p>'}
    </section>
  `;
}

function render() {
  if (!S) return;
  const badge = document.getElementById('mode-badge');
  badge.textContent = S.gateway.mock ? '模拟模式' : (S.gateway.upstreamConfigured ? '真实上游' : '未配置上游');
  badge.className = `badge ${S.gateway.mock ? 'mock' : (S.gateway.upstreamConfigured ? 'live' : '')}`;

  if (currentTab === 'overview') renderOverview();
  else if (currentTab === 'dashboard') renderDashboard();
  else if (currentTab === 'accounts') renderAccounts();
  else if (currentTab === 'automation') renderAutomation();
  else if (currentTab === 'gateway') renderGateway();
  else if (currentTab === 'agents') renderAgents();
  else renderLogs();
}

function metric(label, value, foot) {
  return `<div class="card"><div class="metric-label">${esc(label)}</div><div class="metric-value">${value}</div>${foot ? `<div class="metric-foot">${foot}</div>` : ''}</div>`;
}

function compact(value) {
  const n = Number(value || 0);
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}b`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function latencyText(ms) {
  if (!ms && ms !== 0) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

function opsStatus(account) {
  if (account.disabled) return '<span class="status-text muted"><i class="dot"></i>已禁用</span>';
  if (account.status === 'auth_error') return '<span class="status-text err"><i class="dot"></i>授权失效</span>';
  if (account.cooling) return `<span class="status-text warn" data-cooldown="${esc(account.cooldownUntil)}"><i class="dot"></i><span class="cd">冷却中</span></span>`;
  if (!account.lastRefreshAt && Number(account.quota?.total || 0) === 0) return '<span class="status-text warn"><i class="dot"></i>待刷新</span>';
  if (account.available <= 0) return '<span class="status-text muted"><i class="dot"></i>额度耗尽</span>';
  if (account.lastError) return '<span class="status-text warn"><i class="dot"></i>待重试</span>';
  return '<span class="status-text ok"><i class="dot"></i>可用</span>';
}

function renderOverview() {
  const t = S.totals;
  const accounts = S.accounts;
  const usable = accounts.filter((a) => !a.disabled && !a.cooling && a.available > 0 && a.status !== 'auth_error').length;
  const cooling = accounts.filter((a) => a.cooling && !a.disabled).length;
  const disabled = accounts.filter((a) => a.disabled).length;
  const inFlight = accounts.reduce((sum, a) => sum + (a.inFlight || 0), 0);
  const auto = S.automation;

  const rows = accounts.map((account) => {
    const stats = account.stats || {};
    const total = Number(account.quota.total || 0);
    const used = Number(account.quota.used || 0);
    const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
    const barClass = pct >= 95 ? 'crit' : pct >= 75 ? 'warn' : '';
    return `
    <tr>
      <td class="acct-cell">
        <span class="acct-name" title="${esc(account.label)}">${esc(account.label)}</span>
        <span class="acct-id" title="${esc(account.id)}">${esc(account.id)}</span>
      </td>
      <td class="status-cell">${opsStatus(account)}</td>
      <td class="quota-cell">
        <div class="quota-line"><span class="used">${num(account.available)}</span><span class="sep">/</span><span class="total">${num(total)}</span></div>
        <div class="bar-mini ${barClass}"><span style="width:${pct}%"></span></div>
      </td>
      <td><span class="ok-num">${num(stats.success)}</span> <span class="muted">/</span> <span class="fail-num">${num(stats.fail)}</span></td>
      <td class="num">${account.inFlight ? `<strong>${account.inFlight}</strong>` : '<span class="muted">0</span>'}</td>
      <td class="usage-cell">
        <span class="chip-num blue">${compact(stats.requests)}次</span>
        <span class="chip-num cyan">${compact(stats.tokens)}tok</span>
        <span class="chip-num amber">${latencyText(account.avgLatencyMs)}</span>
        <span class="chip-num green">${account.tokensPerSecond ? `${account.tokensPerSecond}tok/s` : '—'}</span>
      </td>
      <td class="muted">${stats.lastSuccessAt ? rel(stats.lastSuccessAt) : '—'}</td>
      <td>
        <div class="row-links">
          <button class="link-btn" data-act="run" data-step="checkin" data-id="${esc(account.id)}">签到</button>
          <button class="link-btn gray" data-act="run" data-step="refresh" data-id="${esc(account.id)}">余额</button>
          <button class="link-btn gray" data-act="run" data-step="tasks" data-id="${esc(account.id)}">任务</button>
          <button class="link-btn amber" data-act="toggle" data-id="${esc(account.id)}">${account.disabled ? '启用' : '禁用'}</button>
          <button class="link-btn red" data-act="delete" data-id="${esc(account.id)}">移除</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  view.innerHTML = `
    <div class="stat-strip">
      <div class="stat"><div class="stat-num green">${usable}</div><div class="stat-label">可用</div></div>
      <div class="stat"><div class="stat-num amber">${cooling}</div><div class="stat-label">冷却中</div></div>
      <div class="stat"><div class="stat-num red">${disabled}</div><div class="stat-label">已禁用</div></div>
      <div class="stat-wide">
        <div class="stat-big">${num(t.available)}<span class="slash">/</span><span class="total">${num(t.total)}</span></div>
        <div class="stat-label">积分剩余 / 总额</div>
      </div>
      <div class="stat"><div class="stat-num">${inFlight}</div><div class="stat-label">在途请求</div></div>
      <div class="stat"><div class="stat-num" style="font-size:18px">${auto.enabled ? '已开启' : '已关闭'}</div><div class="stat-label">下次 ${auto.nextRunAt ? esc(new Date(auto.nextRunAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })) : '—'}</div></div>
    </div>

    <div class="card" style="padding:16px 18px">
      <div class="section-head" style="margin-bottom:4px">
        <div>
          <h2>账号池</h2>
          <p class="hint" style="margin:4px 0 0">按剩余积分从高到低调度；冷却、授权失效和已禁用的账号自动跳过。</p>
        </div>
        <div class="toolbar-links">
          <button class="link-btn" data-act="bulk" data-steps="checkin">全部签到</button>
          <button class="link-btn" data-act="bulk" data-steps="tasks">全部任务</button>
          <button class="link-btn" data-act="bulk" data-steps="claim">全部领取</button>
          <button class="link-btn gray" data-act="bulk" data-steps="refresh">全部余额</button>
          <button class="link-btn gray" data-act="clear-all-errors">全部清错</button>
          <button class="link-btn" data-act="goto-accounts">添加账号</button>
        </div>
      </div>
      <div class="table-wrap" style="border:0">
        <table class="ops-table">
          <thead><tr>
            <th>账号</th><th>状态</th><th>积分</th><th>成功 / 失败</th><th class="num">在途</th>
            <th>用量</th><th>最近成功</th><th>操作</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="8"><div class="empty">还没有账号，点右上「添加账号」</div></td></tr>'}</tbody>
        </table>
      </div>
    </div>

    <div class="grid cols-2 section">
      <div class="card">
        <div class="section-head"><h2>最近执行</h2><button class="link-btn gray" data-act="goto-automation">自动化设置</button></div>
        <div class="log-list">
          ${(S.jobs || []).slice(0, 8).map((job) => `
            <div class="log-item ${job.status === 'failed' ? 'err' : job.status === 'partial' ? 'warn' : ''}">
              <span class="time">${abs(job.startedAt)}</span>
              <span class="type">${esc(job.label || job.accountId)}</span>
              <span>${esc((job.steps || []).map((step) => `${step.step}:${step.status}`).join(' · ') || job.status)}</span>
            </div>`).join('') || '<div class="empty">还没有执行记录</div>'}
        </div>
      </div>
      <div class="card">
        <div class="section-head"><h2>最近网关请求</h2><button class="link-btn gray" data-act="goto-gateway">接入配置</button></div>
        <div class="log-list">
          ${(S.requests || []).slice(0, 8).map((r) => `
            <div class="log-item">
              <span class="time">${abs(r.at)}</span>
              <span class="type">${esc(r.label || r.accountId || '无可用账号')}</span>
              <span>${num(r.estimatedTokens)} tok${r.latencyMs ? ` · ${latencyText(r.latencyMs)}` : ''} · ${esc(r.status)}</span>
            </div>`).join('') || '<div class="empty">还没有请求</div>'}
        </div>
      </div>
    </div>
  `;
}

let DASH = null;
let DASH_RANGE = 'today';
const DASH_RANGE_LABELS = { today: '今日', '24h': '24小时', '7d': '7天', all: '累计' };

function fmtCny(value) {
  if (value == null) return '<span class="muted">—</span>';
  const n = Number(value);
  if (!Number.isFinite(n)) return '<span class="muted">—</span>';
  if (n > 0 && n < 0.01) return `¥${n.toFixed(4)}`;
  return `¥${n.toFixed(2)}`;
}

async function fetchDashboard(range = DASH_RANGE) {
  DASH = await api(`/api/dashboard?range=${encodeURIComponent(range)}`);
  return DASH;
}

function niceCeil(value) {
  if (!value || value <= 0) return 10;
  const mag = 10 ** Math.floor(Math.log10(value));
  const norm = value / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

// 24h 趋势图：统一 Y 轴尺度，token 柱状 + 积分折线，两条线的高度差就是折算倍率
function dashTimelineChart(timeline) {
  const W = 680;
  const H = 248;
  const padL = 50;
  const padR = 14;
  const padT = 14;
  const padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = Math.max(1, timeline.length);
  const maxVal = Math.max(1, ...timeline.map((p) => Math.max(p.tokens, p.credits)));
  const yMax = niceCeil(maxVal);
  const y = (v) => padT + plotH - (v / yMax) * plotH;
  const barW = Math.max(2.5, (plotW / n) * 0.5);

  const bars = timeline.map((p, i) => {
    const h = (p.tokens / yMax) * plotH;
    const cx = padL + (i + 0.5) * (plotW / n);
    const tip = `${abs(new Date(p.hour))} · ${num(p.tokens)} tok / ${num(p.credits)} 积分`;
    return `<rect x="${(cx - barW / 2).toFixed(1)}" y="${(padT + plotH - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="1.5" fill="var(--primary)" opacity="0.72"><title>${tip}</title></rect>`;
  }).join('');

  const linePts = timeline.map((p, i) => `${(padL + (i + 0.5) * (plotW / n)).toFixed(1)},${y(p.credits).toFixed(1)}`).join(' ');
  const dots = timeline.map((p, i) => `<circle cx="${(padL + (i + 0.5) * (plotW / n)).toFixed(1)}" cy="${y(p.credits).toFixed(1)}" r="2.3" fill="var(--green)"><title>${abs(new Date(p.hour))} · ${num(p.credits)} 积分</title></circle>`).join('');

  const ticks = [0, 0.5, 1].map((r) => {
    const v = yMax * r;
    const yy = y(v);
    return `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="var(--border)" stroke-width="1" />`
      + `<text x="${padL - 7}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--text-faint)">${compact(v)}</text>`;
  }).join('');

  const xLabels = timeline.map((p, i) => {
    if (i % 4 !== 0 && i !== n - 1) return '';
    const d = new Date(p.hour);
    const label = `${String(d.getHours()).padStart(2, '0')}:00`;
    const cx = padL + (i + 0.5) * (plotW / n);
    return `<text x="${cx.toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="var(--text-faint)">${label}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" class="dash-chart" role="img" aria-label="24 小时 token 与积分消耗趋势">
    ${ticks}
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="var(--border-strong)" stroke-width="1" />
    <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="var(--border-strong)" stroke-width="1" />
    ${bars}
    <polyline points="${linePts}" fill="none" stroke="var(--green)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
    ${dots}
    ${xLabels}
  </svg>`;
}

function renderDashboard() {
  if (!S) return;
  if (!DASH) {
    view.innerHTML = '<div class="empty">正在汇总 token 与积分消耗…</div>';
    fetchDashboard().then(() => renderDashboard()).catch((error) => {
      view.innerHTML = `<div class="empty">加载看板失败：${esc(error.message)}</div>`;
    });
    return;
  }

  const sum = DASH.summary || {};
  const rangeLabel = DASH_RANGE_LABELS[DASH.range] || DASH_RANGE_LABELS.all;
  const rate = sum.avgRate == null ? '—' : (Number(sum.avgRate) === 1 ? '1:1' : `×${Number(sum.avgRate).toFixed(3)}`);
  const successRate = sum.successRate == null ? '—' : `${(sum.successRate * 100).toFixed(1)}%`;

  const rangeChips = Object.entries(DASH_RANGE_LABELS).map(([key, label]) =>
    `<button class="filter-chip ${key === DASH_RANGE ? 'on' : ''}" data-act="dash-range" data-range="${key}">${label}</button>`).join('');

  const accountRows = (DASH.byAccount || []).map((row) => {
    const quota = row.quotaTotal != null
      ? `<span class="ok-num">${num(row.quotaAvailable ?? 0)}</span> <span class="muted">/ ${num(row.quotaTotal)}</span>`
      : '<span class="muted">—</span>';
    return `
    <tr>
      <td><span class="acct-name" title="${esc(row.accountId)}">${esc(row.label)}</span><span class="acct-id">${esc(row.accountId)}</span></td>
      <td class="num">${num(row.requests)}</td>
      <td class="num">${num(row.tokens)}</td>
      <td class="num">${num(row.credits)}</td>
      <td class="num">${row.rate == null ? '—' : `×${Number(row.rate).toFixed(3)}`}</td>
      <td class="num">${quota}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6"><div class="empty">还没有成功请求</div></td></tr>';

  const modelRows = (DASH.byModel || []).map((row) => `
    <tr>
      <td><span class="acct-name">${esc(row.name)}</span><span class="acct-id mono">${esc(row.model)}</span></td>
      <td class="num">${num(row.requests)}</td>
      <td class="num">${num(row.tokens)}</td>
      <td class="num">${num(row.credits)}</td>
      <td class="num">${row.officialRate == null ? '<span class="muted">免费</span>' : `×${esc(row.officialRate)}`}</td>
      <td class="num">${row.officialCredits == null ? '<span class="muted">—</span>' : num(row.officialCredits)}</td>
      <td class="num">${fmtCny(row.costCny)}</td>
    </tr>`).join('') || '<tr><td colspan="7"><div class="empty">还没有成功请求</div></td></tr>';

  const reqRows = (DASH.requests || []).map((r) => `
    <tr>
      <td class="time">${abs(r.at)}</td>
      <td><span class="acct-name">${esc(r.label || r.accountId || '—')}</span></td>
      <td class="mono">${esc(r.model || '—')}</td>
      <td class="num">${num(r.tokens)}</td>
      <td class="num">${num(r.credits)}</td>
      <td class="num muted">${num(r.inputTokens)} / ${num(r.outputTokens)}</td>
      <td class="num">${latencyText(r.latencyMs)}</td>
      <td>${r.mode === 'simulation' ? '<span class="pill warn">模拟</span>' : '<span class="pill ok">实时</span>'}</td>
    </tr>`).join('') || '<tr><td colspan="8"><div class="empty">还没有成功请求</div></td></tr>';

  view.innerHTML = `
    <div class="section-head">
      <div>
        <h2>数据看板</h2>
        <p class="hint">token 与积分消耗的对应关系。本地账本按 1:1 把 token 记入积分额度；「按模型」表附带官方定价倍率与折算积分作对照。</p>
      </div>
      <div class="dash-controls">
        <div class="dash-ranges">${rangeChips}</div>
        <button class="btn ghost small" data-act="dash-refresh">刷新</button>
      </div>
    </div>

    <div class="grid cols-4">
      ${metric(`${rangeLabel}Token 消耗`, `<span class="ok-num">${compact(sum.totalTokens)}</span>`, `输入 ${compact(sum.inputTokens)} / 输出 ${compact(sum.outputTokens)}`)}
      ${metric(`${rangeLabel}积分消耗`, `<span class="ok-num">${compact(sum.totalCredits)}</span>`, `倍率 ${rate} · 签到领取 +${compact(sum.creditIncome)}`)}
      ${metric(`${rangeLabel}请求数`, `${num(sum.totalRequests)}`, `成功率 ${successRate} · 失败 ${num(sum.failedRequests)}`)}
      ${metric('今日消耗', `<span style="font-size:19px">${compact(sum.todayTokens)} / ${compact(sum.todayCredits)}</span>`, `等价花费 ${fmtCny(sum.totalCostCny)} · 均耗时 ${latencyText(sum.avgLatencyMs)}`)}
    </div>

    <div class="card section">
      <div class="section-head">
        <h2>24 小时消耗趋势</h2>
        <div class="legend"><span class="lg"><i class="lg-swatch" style="background:var(--primary)"></i>Token</span><span class="lg"><i class="lg-swatch" style="background:var(--green)"></i>积分</span></div>
      </div>
      ${dashTimelineChart(DASH.timeline || [])}
    </div>

    <div class="grid cols-2 section">
      <div class="card">
        <div class="section-head"><h2>按账号消耗</h2></div>
        <div class="table-wrap" style="border:0">
          <table class="ops-table"><thead><tr><th>账号</th><th class="num">请求</th><th class="num">Token</th><th class="num">积分</th><th class="num">倍率</th><th class="num">积分剩余</th></tr></thead>
          <tbody>${accountRows}</tbody></table>
        </div>
      </div>
      <div class="card">
        <div class="section-head"><h2>按模型消耗</h2></div>
        <div class="table-wrap" style="border:0">
          <table class="ops-table"><thead><tr><th>模型</th><th class="num">请求</th><th class="num">Token</th><th class="num">积分</th><th class="num">官方倍率</th><th class="num">官方折算</th><th class="num">等价花费</th></tr></thead>
          <tbody>${modelRows}</tbody></table>
        </div>
      </div>
    </div>

    <div class="card section">
      <div class="section-head"><h2>请求明细（积分扣减记录）</h2><span class="hint">每笔成功请求的 token 与积分 1:1 对应</span></div>
      <div class="table-wrap" style="border:0">
        <table class="ops-table"><thead><tr><th>时间</th><th>账号</th><th>模型</th><th class="num">Token</th><th class="num">积分</th><th class="num">输入 / 输出</th><th class="num">耗时</th><th>模式</th></tr></thead>
        <tbody>${reqRows}</tbody></table>
      </div>
    </div>
  `;
}

const HEALTH_LABELS = {
  healthy: { text: '正常', cls: 'ok' },
  limited: { text: '限流', cls: 'warn' },
  no_permission: { text: '无权限', cls: 'err' },
  violation: { text: '违规', cls: 'err' },
  expired: { text: '过期', cls: 'err' },
  inactive: { text: '未激活', cls: 'off' },
  error: { text: '异常', cls: 'err' },
  unknown: { text: '待检测', cls: 'off' }
};

function cardState(account) {
  if (account.disabled) return '<span class="card-state off"><i></i>停用</span>';
  if (account.cooling) return `<span class="card-state warn"><i></i>冷却 ${esc(cooldownText(account) || '')}</span>`;
  if (!account.hasSecret) return '<span class="card-state off"><i></i>未登录</span>';
  const health = HEALTH_LABELS[account.health] || HEALTH_LABELS.unknown;
  if (health.cls !== 'ok') return `<span class="card-state ${health.cls}"><i></i>${health.text}</span>`;
  if (account.usable) return '<span class="card-state ok"><i></i>正常</span>';
  if (account.lastError) return '<span class="card-state err"><i></i>异常</span>';
  return '<span class="card-state warn"><i></i>受限</span>';
}

function providerMark(provider) {
  const caps = String(provider).replace(/[^A-Z]/g, '');
  if (caps.length >= 2) return caps.slice(0, 2);
  return String(provider).slice(0, 2).toUpperCase();
}

function providerHue(provider) {
  let hash = 0;
  const text = String(provider || 'WorkBuddy');
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) % 360;
  return hash;
}

function filterState() {
  window.__acctFilter = window.__acctFilter || { q: '', status: 'all', health: 'all', provider: 'all' };
  return window.__acctFilter;
}

function selectedSet() {
  window.__selected = window.__selected || new Set();
  return window.__selected;
}

function matchFilter(account, filter) {
  if (filter.q) {
    const hay = `${account.label} ${account.id} ${account.provider} ${account.region} ${account.batch || ''} ${account.notes || ''}`.toLowerCase();
    if (!hay.includes(filter.q.toLowerCase())) return false;
  }
  if (filter.provider !== 'all' && (account.provider || 'WorkBuddy') !== filter.provider) return false;
  if (filter.health !== 'all' && (account.health || 'unknown') !== filter.health) return false;
  if (filter.status === 'available' && (account.disabled || !account.usable)) return false;
  if (filter.status === 'disabled' && !account.disabled) return false;
  if (filter.status === 'cooling' && !account.cooling) return false;
  if (filter.status === 'today' && Number(account.stats?.todayTokens || 0) <= 0) return false;
  if (filter.status === 'unchecked' && account.lastCheckInDate === S.today) return false;
  return true;
}

function autoSwitch(account, key, label) {
  const on = account.auto?.[key] !== false;
  return `<button class="auto-switch ${on ? 'on' : ''}" data-act="auto-toggle" data-key="${key}" data-id="${esc(account.id)}" title="${esc(label)}">
    <span class="auto-track"><span class="auto-dot"></span></span>
    <span class="auto-label">${esc(label)}</span>
  </button>`;
}

function accountCard(account) {
  const provider = account.provider || 'WorkBuddy';
  const total = Number(account.quota?.total || 0);
  const used = Number(account.quota?.used || 0);
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const displayName = account.label || `${provider}-${String(account.id).slice(-8)}`;
  const id = esc(account.id);
  const barClass = pct >= 95 ? 'crit' : pct >= 75 ? 'warn' : '';
  const hue = providerHue(provider);
  const selection = selectedSet();
  const picked = selection.has(account.id);
  const todayTokens = Number(account.stats?.todayTokens || 0);
  const taskText = account.lastTaskStatus === 'completed'
    ? '任务已完成'
    : account.lastTaskStatus === 'nothing_pending'
      ? '无待办任务'
      : account.lastTaskStatus === 'partial'
        ? '部分完成'
        : account.lastTaskAt ? '已执行' : '任务待执行';
  const taskPct = account.lastTaskStatus === 'completed' ? 100 : account.lastTaskStatus === 'partial' ? 55 : account.lastTaskStatus === 'nothing_pending' ? 100 : 0;
  return `
    <div class="acct-card ${account.disabled ? 'is-off' : ''} ${picked ? 'is-picked' : ''}" style="--hue:${hue}">
      <div class="acct-card-head">
        <button class="pick ${picked ? 'on' : ''}" data-act="select-account" data-id="${id}" title="选择">${picked ? '✓' : ''}</button>
        <div class="acct-avatar">${esc(providerMark(provider))}</div>
        <div class="acct-title">
          <div class="acct-title-row">
            <span class="acct-name" title="${esc(displayName)}">${esc(displayName)}</span>
            ${account.role ? `<span class="role-badge">${esc(account.role)}</span>` : ''}
          </div>
          <div class="acct-sub">${cardState(account)}</div>
        </div>
      </div>

      <div class="acct-credit">
        <div class="credit-main">
          <span class="credit-num">${num(account.available)}</span>
          <span class="credit-unit">积分</span>
        </div>
        <div class="credit-side">
          <span>${account.lastRefreshAt ? `${esc(rel(account.lastRefreshAt))}更新` : '未刷新'}</span>
          <span class="muted">活跃 ${esc(rel(account.stats?.lastRequestAt || account.createdAt))}</span>
        </div>
      </div>

      <div class="acct-quick">
        <div><span>批次</span><b>${esc(account.batch || '默认')}</b></div>
        <div><span>凭据</span><b>${esc(account.secretMeta?.authType || '未设置')}</b></div>
        <div><span>区域</span><b>${esc(account.region || '国服')}</b></div>
        <div><span>今日</span><b>${num(todayTokens)} tok</b></div>
      </div>

      <div class="quota-block">
        <div class="quota-line">
          <span>剩余 <b>${num(account.available)}</b> / ${num(total)}</span>
          <span class="muted">使用率 ${pct}%</span>
        </div>
        <div class="bar-mini ${barClass}"><span style="width:${pct}%"></span></div>
      </div>

      <div class="acct-stats">
        <div><span class="k">冷却</span><span class="v">${account.cooling ? esc(cooldownText(account) || '中') : '无'}</span></div>
        <div><span class="k">签到</span><span class="v">${account.growth?.streakDays ? `连签${esc(account.growth.streakDays)}天` : (account.lastCheckInAt ? esc(rel(account.lastCheckInAt)) : '未签到')}</span></div>
        <div><span class="k">巡检</span><span class="v">${account.lastInspectAt ? esc(rel(account.lastInspectAt)) : '未巡检'}</span></div>
      </div>

      <div class="task-block">
        <div class="task-line">
          <span class="task-name">${esc(taskText)}</span>
          <span class="muted">${account.lastTaskAt ? esc(rel(account.lastTaskAt)) : '—'}</span>
        </div>
        <div class="bar-mini task"><span style="width:${taskPct}%"></span></div>
      </div>

      <div class="auto-row">
        ${autoSwitch(account, 'checkin', '自动签到')}
        ${autoSwitch(account, 'keepalive', '自动保活')}
        ${autoSwitch(account, 'claim', '自动领奖')}
      </div>

      <div class="acct-actions">
        <button class="chip-btn primary" data-act="run" data-step="checkin" data-id="${id}">立即签到</button>
        <button class="chip-btn" data-act="run" data-step="refresh" data-id="${id}">刷新状态</button>
        <button class="chip-btn" data-act="run" data-step="tasks" data-id="${id}">做任务</button>
        <button class="chip-btn" data-act="detail" data-id="${id}">详情</button>
        <button class="chip-btn" data-act="toggle" data-id="${id}">${account.disabled ? '启用' : '停用'}</button>
        <button class="chip-btn red" data-act="delete" data-id="${id}">删除</button>
      </div>
    </div>`;
}

function renderAccounts() {
  const filter = filterState();
  const selection = selectedSet();

  const healthCount = {};
  for (const account of S.accounts) {
    const key = account.health || 'unknown';
    healthCount[key] = (healthCount[key] || 0) + 1;
  }
  const providers = [...new Set(S.accounts.map((account) => account.provider || 'WorkBuddy'))];
  const cooling = S.accounts.filter((account) => account.cooling).length;
  const active = S.accounts.filter((account) => !account.disabled).length;
  const disabledCount = S.accounts.filter((account) => account.disabled).length;
  const checkedToday = S.accounts.filter((account) => account.lastCheckInDate === S.today).length;

  const visible = S.accounts.filter((account) => matchFilter(account, filter));

  const groups = new Map();
  for (const account of visible) {
    const key = String(account.batch || account.provider || 'WorkBuddy');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(account);
  }
  const collapsed = window.__collapsedProviders || new Set();

  const chip = (key, value, label, count) => `<button class="filter-chip ${filter[key] === value ? 'on' : ''}" data-act="acct-filter" data-key="${key}" data-value="${esc(value)}">${esc(label)}${count !== undefined ? `<b>${count}</b>` : ''}</button>`;

  const groupsHtml = [...groups.entries()].map(([batchName, list]) => {
    const usable = list.filter((item) => !item.disabled && item.usable).length;
    const isCollapsed = collapsed.has(batchName);
    const allPicked = list.every((item) => selection.has(item.id));
    return `
      <div class="vendor-group">
        <div class="vendor-head">
          <button class="pick ${allPicked ? 'on' : ''}" data-act="select-group" data-id="${esc(batchName)}">${allPicked ? '✓' : ''}</button>
          <span class="vendor-arrow ${isCollapsed ? 'collapsed' : ''}" data-act="collapse" data-id="${esc(batchName)}">⌄</span>
          <span class="vendor-name">${esc(batchName)}</span>
          <span class="vendor-count">${list.length} 个账号 · 可用 ${usable}</span>
          <div class="vendor-actions">
            <button class="link-btn gray" data-act="batch" data-batch="refresh" data-group="${esc(batchName)}">刷新</button>
            <button class="link-btn gray" data-act="batch" data-batch="inspect" data-group="${esc(batchName)}">巡检</button>
            <button class="link-btn" data-act="batch" data-batch="checkin" data-group="${esc(batchName)}">全部签到</button>
          </div>
        </div>
        ${isCollapsed ? '' : `<div class="acct-grid">${list.map(accountCard).join('')}</div>`}
      </div>`;
  }).join('');

  const pendingLogin = (S.pendingLogins || [])[0] || null;
  const pendingId = pendingLogin?.id;
  const showAdd = Boolean(pendingId) || window.__showAdd === true;
  view.innerHTML = `
    <div class="card pool-head">
      <div class="pool-head-main">
        <div class="pool-title">
          <h2>账号池</h2>
          <span class="pool-count">${S.accounts.length} 个账号</span>
        </div>
        <p class="hint">自己所有或已授权的 WorkBuddy 账号集中托管：自动签到、自动保活、一键做任务、自动领奖，额度汇总成一个虚拟额度池供 DSH 调度。凭据 AES-256-GCM 加密，界面永不回显。</p>
      </div>
      <div class="pool-head-actions">
        <button class="btn" data-act="toggle-add">＋ 添加账号</button>
        <button class="btn ghost" data-act="import-client" title="从本机正在运行的 WorkBuddy 客户端直接读登录态，不用重新扫码">⇩ 从客户端导入</button>
        <button class="btn ghost" data-act="desktop-import" title="读客户端的 .info 凭据文件（客户端没开也能用，需要 at-rest 密钥）">⇩ 从凭据文件导入</button>
        <button class="btn ghost" data-act="batch" data-batch="inspect">一键巡检</button>
        <button class="btn ghost" data-act="batch" data-batch="refresh">全部刷新</button>
        <button class="btn ghost" data-act="import-json">导入 JSON</button>
        <button class="btn ghost" data-act="export-json">导出（脱敏）</button>
        <button class="btn ghost" data-act="vault-export" title="用口令加密导出，含凭据，可拷到另一台电脑导入">🔒 加密备份</button>
        <input id="import-file" type="file" accept="application/json,.json" hidden>
      </div>
    </div>

    <div class="stat-strip">
      <div class="stat-cell"><span class="stat-k">会员账号</span><span class="stat-v">${S.accounts.length}</span></div>
      <div class="stat-cell"><span class="stat-k">健康</span><span class="stat-v ok">${healthCount.healthy || 0}</span></div>
      <div class="stat-cell"><span class="stat-k">限流</span><span class="stat-v warn">${healthCount.limited || 0}</span></div>
      <div class="stat-cell"><span class="stat-k">过期 / 无权限</span><span class="stat-v err">${(healthCount.expired || 0) + (healthCount.no_permission || 0)}</span></div>
      <div class="stat-cell"><span class="stat-k">今日已签</span><span class="stat-v">${checkedToday} / ${active}</span></div>
      <div class="stat-cell"><span class="stat-k">可用额度合计</span><span class="stat-v">${num(S.totals?.available || 0)}</span></div>
    </div>

    <div class="card ${showAdd ? '' : 'hidden'}">
      <div class="section-head" style="margin:0 0 6px">
        <h2>添加账号</h2>
        <button class="link-btn gray" data-act="toggle-add">收起</button>
      </div>
      <p class="hint">填个标签 → 点「扫码登录」→ 在弹出的官方窗口里扫码 → 登录成功后自动建号并读取额度，凭据全程不落明文。</p>
      <div class="scan-row">
        <input id="new-label" type="text" placeholder="账号标签，例如 主号 / 小号 A" maxlength="64" value="">
        <button class="btn" data-act="scan-login" ${S.capabilities?.scanLogin ? '' : 'disabled'}>扫码登录添加</button>
        <button class="btn ghost" data-act="toggle-manual">手动粘贴凭据</button>
      </div>
      <div class="scan-row sub-row">
        <span class="muted">登录页</span>
        <input id="login-url" type="text" value="${esc(S.settings.loginUrl || S.settings.officialUrl || '')}" placeholder="https://官方站点/登录 或扫码页地址">
        <button class="link-btn gray" data-act="save-login-url">保存</button>
        <button class="link-btn gray" data-act="open-external-login">在系统浏览器打开</button>
      </div>
      ${S.capabilities?.scanLogin ? '' : '<p class="hint" style="margin-top:8px">当前是命令行模式，扫码登录只在桌面版可用。</p>'}
      <div id="scan-status" class="scan-status ${pendingId ? '' : 'hidden'}">
        ${pendingId ? `
          <div class="scan-line">
            <span class="dot-pulse"></span>
            <span>已打开官方授权页，用 WorkBuddy App 扫码即可（自动识别登录状态）</span>
            ${pendingLogin.url ? `<button class="link-btn gray" data-act="open-pending-url" data-id="${esc(pendingLogin.url)}">重新打开授权页</button>` : ''}
            <button class="link-btn gray" data-act="finish-login">我已登录</button>
            <button class="link-btn red" data-act="cancel-login">取消</button>
          </div>` : ''}
      </div>

      <div id="manual-panel" class="manual-panel hidden">
        <div class="form-grid" style="margin-top:14px">
          <div class="field"><label>初始总额度</label><input id="new-total" type="number" min="0" step="1" placeholder="留空并从上游刷新"></div>
          <div class="field"><label>初始已用</label><input id="new-used" type="number" min="0" step="1" placeholder="0"></div>
          <div class="field"><label>凭据类型</label>
            <select id="new-auth">
              <option value="workbuddy">WorkBuddy 会话 JSON（推荐）</option>
              <option value="cookie">Cookie</option>
              <option value="bearer">Bearer Token</option>
              <option value="header">x-api-key</option>
            </select>
          </div>
          <div class="field"><label>官方页面地址</label><input id="new-url" type="text" value="${esc(S.settings.officialUrl || '')}"></div>
          <div class="field full"><label>凭据</label>
            <textarea id="new-secret" placeholder='WorkBuddy 会话填 {"accessToken":"...","refreshToken":"...","realm":"cn"}；其它上游填 Cookie 或 Token' spellcheck="false"></textarea>
            <span class="help">扫码登录会自动写入会话 JSON；手动时从 F12 → Network 复制 Cookie 请求头即可。</span>
          </div>
          <div class="field full"><label>备注</label><input id="new-notes" type="text" placeholder="可选"></div>
        </div>
        <div class="btn-row" style="margin-top:14px">
          <button class="btn" data-act="add-account">添加账号</button>
        </div>
      </div>
    </div>

    <div class="card pool-toolbar">
      <div class="toolbar-row">
        <input id="acct-search" class="search-input" type="search" placeholder="搜索账号 / ID / 批次 / 备注" value="${esc(filter.q)}">
        <div class="filter-chips">
          ${chip('status', 'all', '全部', S.accounts.length)}
          ${chip('status', 'available', '可用', active)}
          ${chip('status', 'disabled', '停用', disabledCount)}
          ${chip('status', 'cooling', '冷却', cooling)}
          ${chip('status', 'unchecked', '今日未签', Math.max(0, active - checkedToday))}
        </div>
      </div>
      <div class="toolbar-row">
        <div class="filter-chips">
          <span class="chip-label">健康</span>
          ${chip('health', 'all', '不限')}
          ${chip('health', 'healthy', '正常', healthCount.healthy || 0)}
          ${chip('health', 'limited', '限流', healthCount.limited || 0)}
          ${chip('health', 'expired', '过期', healthCount.expired || 0)}
          ${chip('health', 'no_permission', '无权限', healthCount.no_permission || 0)}
          ${chip('health', 'unknown', '待检测', healthCount.unknown || 0)}
        </div>
        <div class="filter-chips">
          <span class="chip-label">标签</span>
          ${chip('provider', 'all', '不限')}
          ${providers.map((name) => chip('provider', name, name)).join('')}
        </div>
      </div>
      <div class="toolbar-row bulk-row">
        <span class="muted">已选 ${selection.size} 个</span>
        <button class="link-btn" data-act="batch" data-batch="checkin">全部签到</button>
        <button class="link-btn" data-act="batch" data-batch="tasks">一键做任务</button>
        <button class="link-btn" data-act="batch" data-batch="claim">全部领奖</button>
        <button class="link-btn gray" data-act="batch" data-batch="keepalive">全部保活</button>
        <button class="link-btn gray" data-act="batch" data-batch="inspect">一键巡检</button>
        <button class="link-btn gray" data-act="batch" data-batch="enable">批量启用</button>
        <button class="link-btn gray" data-act="batch" data-batch="disable">批量停用</button>
        <button class="link-btn red" data-act="batch" data-batch="delete">批量删除</button>
        <button class="link-btn gray" data-act="select-clear">清空选择</button>
      </div>
      <div class="pool-tabs">
        <span class="pool-tab on">全部 ${S.accounts.length}</span>
        <span class="pool-tab">可用 ${active}</span>
        <span class="pool-tab">停用 ${disabledCount}</span>
        <span class="pool-tab">冷却 ${cooling}</span>
        <span class="pool-tab">今日已签 ${checkedToday}</span>
        <span class="pool-tab">可用额度 ${num(S.totals?.available || 0)}</span>
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <h2>账号列表<span class="muted" style="font-weight:400;margin-left:8px">${visible.length} / ${S.accounts.length}</span></h2>
        <div class="row-actions">
          <button class="link-btn gray" data-act="batch" data-batch="run-all">按计划跑一轮</button>
          <button class="link-btn gray" data-act="collapse-all">${collapsed.size ? '全部展开' : '全部折叠'}</button>
        </div>
      </div>
      ${groupsHtml || '<div class="empty">没有符合条件的账号</div>'}
    </div>

    <div class="pool-foot">
      <span>账号池 ${S.accounts.length} 个 · 自动化${S.automation?.enabled ? '已启动' : '已停止'} · 下次签到 ${esc(S.automation?.nextRunAt ? abs(S.automation.nextRunAt) : '—')}</span>
      <span>最后同步 ${esc(abs(S.startedAt) || '—')}</span>
    </div>
  `;
}

function renderAutomation() {
  const auto = S.settings.automation;
  const steps = auto.steps || {};
  const jobs = (S.jobs || []).slice(0, 20).map((job) => `
    <tr>
      <td>${abs(job.startedAt)}</td>
      <td>${esc(job.label || job.accountId || '全部')}</td>
      <td>${esc(job.trigger || 'manual')}</td>
      <td><span class="pill ${job.status === 'completed' ? 'ok' : job.status === 'failed' ? 'err' : 'warn'}">${esc(job.status)}</span></td>
      <td class="muted">${esc((job.steps || []).map((step) => `${step.step}:${step.status}${step.error ? `(${step.error})` : ''}`).join(' · '))}</td>
    </tr>`).join('');

  view.innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <h2>自动任务</h2>
        <p class="hint">每天在指定时间自动跑：刷新额度 → 签到 → 每日任务 → 领取体验积分。失败按指数退避重试。</p>
        <div class="form-grid">
          <div class="field"><label>每日执行时间</label><input id="auto-time" type="time" value="${esc(auto.time)}"></div>
          <div class="field"><label>时区</label><input id="auto-tz" type="text" value="${esc(S.settings.timezone)}"></div>
          <div class="field"><label>账号间隔抖动（秒）</label><input id="auto-jitter" type="number" min="0" max="3600" value="${Number(auto.jitterSeconds || 0)}"></div>
          <div class="field"><label>每步重试次数</label><input id="auto-retries" type="number" min="1" max="6" value="${Number(auto.retries || 3)}"></div>
        </div>
        <div class="step-row" style="margin-top:14px">
          <label><input type="checkbox" id="step-keepalive" ${steps.keepalive !== false ? 'checked' : ''}> 自动保活</label>
          <label><input type="checkbox" id="step-refresh" ${steps.refresh !== false ? 'checked' : ''}> 刷新额度</label>
          <label><input type="checkbox" id="step-inspect" ${steps.inspect === true ? 'checked' : ''}> 自动巡检</label>
          <label><input type="checkbox" id="step-checkin" ${steps.checkin !== false ? 'checked' : ''}> 自动签到</label>
          <label><input type="checkbox" id="step-tasks" ${steps.tasks !== false ? 'checked' : ''}> 一键做任务</label>
          <label><input type="checkbox" id="step-claim" ${steps.claim !== false ? 'checked' : ''}> 自动领奖</label>
        </div>
        <div class="form-grid" style="margin-top:12px">
          <div class="field"><label>保活间隔（分钟）</label><input id="auto-keepalive" type="number" min="5" max="720" value="${Number(auto.keepalive?.intervalMinutes || 45)}"></div>
          <div class="field"><label>巡检间隔（分钟）</label><input id="auto-inspect" type="number" min="5" max="1440" value="${Number(auto.inspect?.intervalMinutes || 120)}"></div>
        </div>
        <div class="btn-row" style="margin-top:16px">
          <button class="btn" data-act="save-automation">保存设置</button>
          <button class="btn ghost" data-act="toggle-automation">${auto.enabled ? '关闭自动任务' : '开启自动任务'}</button>
          <button class="btn ghost" data-act="run-all">立即执行全部账号</button>
          <button class="btn ghost" data-act="batch" data-batch="inspect">一键巡检</button>
        </div>
      </div>

      <div class="card">
        <h2>调度状态</h2>
        <dl class="kv" style="margin-top:12px">
          <dt>开关</dt><dd>${auto.enabled ? '<span class="pill ok">已开启</span>' : '<span class="pill muted">已关闭</span>'}</dd>
          <dt>下次签到</dt><dd>${auto.nextRunAt ? esc(new Date(auto.nextRunAt).toLocaleString('zh-CN')) : '—'}</dd>
          <dt>下次保活</dt><dd>${auto.keepalive?.nextRunAt ? esc(new Date(auto.keepalive.nextRunAt).toLocaleString('zh-CN')) : '—'}</dd>
          <dt>下次巡检</dt><dd>${auto.inspect?.nextRunAt ? esc(new Date(auto.inspect.nextRunAt).toLocaleString('zh-CN')) : '—'}</dd>
          <dt>上次执行</dt><dd>${auto.lastRunAt ? `${esc(new Date(auto.lastRunAt).toLocaleString('zh-CN'))}（${esc(auto.lastRunTrigger || '')}）` : '—'}</dd>
          <dt>执行步骤</dt><dd class="mono">${esc(stepPlanText(S.automation?.steps) || '—')}</dd>
          <dt>运行中</dt><dd>${auto.running?.length ? esc(auto.running.join(', ')) : '空闲'}</dd>
          <dt>当前模式</dt><dd>${S.gateway.mock ? '<span class="pill warn">模拟</span> 只改本地额度，不发真实请求' : '<span class="pill ok">真实上游</span> 会请求你配置的接口'}</dd>
        </dl>
        <div class="card" style="margin-top:14px;background:#f8fafd;box-shadow:none">
          <h3>步骤说明</h3>
          <p class="hint" style="margin:0">
            保活会刷新 WorkBuddy 会话令牌，再用一次轻量额度查询确认在线，避免长时间不动作导致掉登录；
            巡检会把签到状态、可用额度、健康分级一次性刷到卡片上。两者都是短周期轮询，和每日签到各自独立计时。
            每个账号还能在卡片上单独关掉某个开关，批量执行时会自动跳过。
          </p>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><h2>执行历史</h2></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>开始时间</th><th>账号</th><th>触发</th><th>结果</th><th>步骤</th></tr></thead>
          <tbody>${jobs || '<tr><td colspan="5"><div class="empty">还没有执行记录</div></td></tr>'}</tbody>
        </table>
      </div>
    </div>
  `;
}

function copyRow(label, value, mono = true) {
  return `
    <div class="copy-row">
      <div class="copy-label">${esc(label)}</div>
      <div class="copy-value ${mono ? 'mono' : ''}">${esc(value)}</div>
      <button class="link-btn gray" data-act="copy" data-copy="${esc(value)}">复制</button>
    </div>`;
}

function readinessRows(up) {
  const paths = up.quotaPaths || {};
  const hasQuotaFields = ['total', 'used', 'available'].some((key) => Array.isArray(paths[key]) && paths[key].length);
  const rows = [
    { name: '上游地址', ok: Boolean(String(up.baseUrl || '').trim()), need: 'Base URL', hint: '例如 https://api.example.com' },
    { name: '额度查询', ok: Boolean(up.balancePath) && hasQuotaFields, need: '额度路径 + 返回字段路径', hint: '要能解析出总额或可用额度' },
    { name: '自动签到', ok: Boolean(up.checkinPath), need: '签到路径（含方法/请求体）', hint: '导入 cURL 会自动填' },
    { name: '每日任务', ok: Boolean(up.tasksPath) && Boolean(up.tasks?.completePath), need: '任务列表路径 + 完成路径', hint: '先拉列表再逐个完成' },
    { name: '领取积分', ok: Boolean(up.claimPath), need: '领取路径（含方法/请求体）', hint: '一般是 POST' }
  ];
  return rows;
}

function renderGateway() {
  const up = S.settings.upstream;
  const mock = S.settings.gateway.mock;
  const ready = readinessRows(up);
  const missing = ready.filter((row) => !row.ok);
  const base = S.gateway.baseUrl || `http://127.0.0.1:${S.gateway.port}/v1`;
  const apiKey = S.settings.gateway.apiKey || 'local-gateway';
  const quotaPaths = up.quotaPaths || {};

  view.innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <h2>DSH 自定义模型 API 填法</h2>
        <p class="hint">对着 DSH「设置 → 模型 → 自定义模型 API」逐项照抄；网关只监听 127.0.0.1，不会外发凭据。</p>
        <div class="copy-list">
          ${copyRow('Provider ID', 'workbuddy-gateway')}
          ${copyRow('显示名称', 'WorkBuddy 多账号池', false)}
          ${copyRow('API 地址', base)}
          ${copyRow('API 协议', 'OpenAI Chat Completions（也支持 Anthropic Messages）', false)}
          ${copyRow('API 密钥', apiKey)}
        </div>
        <div class="card" style="margin-top:14px;background:#f8fafd;box-shadow:none;padding:14px">
          <h3>模型目录</h3>
          <p class="hint" style="margin:0 0 8px">网关自有别名（DSH 里随便选一个即可，网关只按额度选号，不改写模型名）：</p>
          <div class="btn-row">
            ${['workbuddy-gateway-v1', 'workbuddy-gateway-max', 'workbuddy-gateway-fast'].map((id) => `<span class="pill info mono">${esc(id)}</span>`).join('')}
          </div>
          <p class="hint" style="margin:12px 0 8px">接的是 WorkBuddy 会话时，网关还会把官方模型一起列进 <span class="mono">/v1/models</span>；后面的数字是官方 credits 倍率，用来对比换号时的消耗：</p>
          <div class="btn-row model-pills">
            ${modelPills()}
          </div>
          <div class="btn-row" style="margin-top:10px">
            <button class="btn ghost small" data-act="fetch-models">模拟「获取可用模型」</button>
            <button class="btn ghost small" data-act="test-gateway">发一次测试请求</button>
          </div>
          <div id="models-result" style="margin-top:10px"></div>
        </div>
        <div class="code-box light" style="margin-top:12px">curl ${esc(base)}/chat/completions \\
  -H "authorization: Bearer ${esc(apiKey)}" \\
  -H "content-type: application/json" \\
  -d '{"model":"${esc(S.settings.model)}","messages":[{"role":"user","content":"hello"}]}'</div>
      </div>

      <div class="card">
        <h2>调度与上游</h2>
        <p class="hint">模拟模式只扣本地额度，方便先联调 DSH；真实模式用账号凭据打到你的上游接口，失败自动换号。</p>
        <div class="ready-box ${missing.length ? 'warn' : 'ok'}">
          <div class="ready-head">
            <strong>接入检查</strong>
            <span class="pill ${missing.length ? 'warn' : 'ok'}">${missing.length ? `还缺 ${missing.length} 项` : '已就绪'}</span>
          </div>
          <table class="ready-table">
            <tbody>
              ${ready.map((row) => `
                <tr>
                  <td class="ready-name">${esc(row.name)}</td>
                  <td><span class="status-text ${row.ok ? 'ok' : 'err'}"><i class="dot"></i>${row.ok ? '已配置' : '缺 ' + esc(row.need)}</span></td>
                  <td class="muted">${esc(row.hint)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
          ${missing.length ? `<p class="hint" style="margin:8px 0 0">补齐这 ${missing.length} 项后，关掉「模拟模式」，签到 / 任务 / 领取才会打到真实账号。</p>` : ''}
          <div class="btn-row" style="margin-top:10px">
            <button class="btn small" data-act="sniff-start" ${S.capabilities?.scanLogin ? '' : 'disabled'}>嗅探上游接口</button>
            <span class="muted" style="font-size:12px">打开官方页面做一次签到 / 看额度 / 发一次对话，自动识别接口路径</span>
          </div>
          ${window.__sniffId ? `<div class="scan-line" style="margin-top:10px">
            <span class="dot-pulse"></span>
            <span>嗅探窗口已打开，操作完点右侧按钮</span>
            <button class="link-btn" data-act="sniff-finish">完成嗅探</button>
            <button class="link-btn red" data-act="sniff-cancel">取消</button>
          </div>` : ''}
        </div>
        <div class="switch-row">
          <input type="checkbox" id="gw-mock" ${mock ? 'checked' : ''}>
          <label for="gw-mock">模拟模式（不发送真实请求）</label>
        </div>
        <div class="switch-row">
          <input type="checkbox" id="gw-queue" ${S.settings.gateway.queueProbe === false ? '' : 'checked'}>
          <label for="gw-queue">发消息前查上游排队状态（排队中就换号）</label>
        </div>
        <div class="form-grid" style="margin-top:8px">
          <div class="field"><label>网关 API 密钥（留空=不校验）</label><input id="gw-key" type="text" value="${esc(S.settings.gateway.apiKey || '')}" placeholder="local-gateway"></div>
          <div class="field"><label>模型名</label><input id="gw-model" type="text" value="${esc(S.settings.model)}"></div>
          <div class="field"><label>最大换号次数</label><input id="gw-attempts" type="number" min="1" max="5" value="${Number(S.settings.gateway.maxAttempts || 3)}"></div>
          <div class="field"><label>429 冷却（分钟）</label><input id="gw-cooldown" type="number" min="1" max="1440" value="${Number(S.settings.gateway.cooldownOn429Minutes || 20)}"></div>
          <div class="field full"><label>上游 Base URL</label><input id="up-base" type="text" placeholder="https://你的上游域名" value="${esc(up.baseUrl || '')}"></div>
          <div class="field"><label>Chat 路径</label><input id="up-chat" type="text" value="${esc(up.chatPath || '/v1/chat/completions')}"></div>
          <div class="field"><label>额度查询路径</label><input id="up-balance" type="text" placeholder="/api/user/quota" value="${esc(up.balancePath || '')}"></div>
          <div class="field"><label>签到路径</label><input id="up-checkin" type="text" placeholder="/api/checkin" value="${esc(up.checkinPath || '')}"></div>
          <div class="field"><label>任务列表路径</label><input id="up-tasks" type="text" placeholder="/api/tasks" value="${esc(up.tasksPath || '')}"></div>
          <div class="field"><label>领取路径</label><input id="up-claim" type="text" placeholder="/api/claim" value="${esc(up.claimPath || '')}"></div>
          <div class="field full"><label>任务完成路径</label><input id="up-complete" type="text" placeholder="/api/tasks/:id/complete" value="${esc(up.tasks?.completePath || '')}"></div>
        </div>
        <div class="btn-row" style="margin-top:14px">
          <button class="btn" data-act="save-upstream">保存</button>
        </div>
      </div>
    </div>

    <div class="card section">
      <h2>从 curl 导入接口</h2>
      <p class="hint">在浏览器里对目标站点操作一次（签到 / 领积分 / 查额度），F12 → Network → 右键请求 → Copy as cURL，粘贴进来。自动解析 Base URL、路径、方法、请求体并识别 Cookie。</p>
      <div class="form-grid">
        <div class="field full"><textarea id="curl-input" placeholder="curl 'https://example.com/api/checkin' -H 'cookie: ...' -X POST" spellcheck="false"></textarea></div>
        <div class="field"><label>导入到</label>
          <select id="curl-target">
            <option value="balance">额度查询</option>
            <option value="checkin">签到</option>
            <option value="tasks">任务列表</option>
            <option value="claim">领取积分</option>
            <option value="complete">任务完成</option>
            <option value="chat">Chat 转发</option>
          </select>
        </div>
      </div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn" data-act="import-curl">解析并写入设置</button>
        <button class="btn ghost" data-act="apply-cookie" disabled id="apply-cookie-btn">把解析到的凭据应用到全部账号</button>
      </div>
      <div id="curl-result" style="margin-top:12px"></div>
    </div>

    <div class="grid cols-2 section">
      <div class="card">
        <h2>额度解析字段</h2>
        <p class="hint">上游返回结构不同时用点号路径指定，例如 <span class="mono">data.quota.remaining</span>。多个候选用逗号分隔。</p>
        <div class="form-grid">
          <div class="field full"><label>总额度路径</label><input id="qp-total" type="text" value="${esc((quotaPaths.total || []).join(', '))}"></div>
          <div class="field full"><label>已用路径</label><input id="qp-used" type="text" value="${esc((quotaPaths.used || []).join(', '))}"></div>
          <div class="field full"><label>可用路径</label><input id="qp-available" type="text" value="${esc((quotaPaths.available || []).join(', '))}"></div>
        </div>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn" data-act="save-quota-paths">保存</button>
        </div>
      </div>

      <div class="card">
        <h2>接口探测</h2>
        <p class="hint">用选中账号的凭据跑一遍常见路径，看哪些返回 200。只发 GET，不改数据。</p>
        <div class="form-grid">
          <div class="field full"><label>使用账号</label><select id="probe-account">${S.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('') || '<option value="">无账号</option>'}</select></div>
        </div>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn ghost" data-act="probe">开始探测</button>
        </div>
        <div id="probe-result" style="margin-top:12px"></div>
      </div>
    </div>
  `;
}

function renderLogs() {
  const events = S.events || [];
  const requests = S.requests || [];
  view.innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <div class="section-head"><h2>事件</h2><button class="btn ghost small" data-act="export">导出 JSON</button></div>
        <div class="log-list">
          ${events.map((event) => `
            <div class="log-item ${event.level === 'error' ? 'err' : event.level === 'warn' ? 'warn' : ''}">
              <span class="time">${abs(event.at)}</span>
              <span class="type">${esc(event.type)}</span>
              <span>${esc(event.label ? `${event.label} · ` : '')}${esc(JSON.stringify(Object.fromEntries(Object.entries(event).filter(([key]) => !['id', 'type', 'level', 'at', 'label'].includes(key)))).slice(0, 220))}</span>
            </div>`).join('') || '<div class="empty">还没有事件</div>'}
        </div>
      </div>
      <div class="card">
        <h2>网关请求</h2>
        <div class="log-list">
          ${requests.map((request) => `
            <div class="log-item">
              <span class="time">${abs(request.at)}</span>
              <span class="type">${esc(request.label || request.accountId || '—')}</span>
              <span>${num(request.estimatedTokens)} tokens · ${esc(request.status)} · ${esc(request.source || '')}${request.error ? ` · ${esc(request.error)}` : ''}</span>
            </div>`).join('') || '<div class="empty">还没有请求</div>'}
        </div>
      </div>
    </div>
  `;
}

function openModal(title, html, onSubmit) {
  modalTitle.textContent = title;
  modalBody.innerHTML = html;
  modal.classList.remove('hidden');
  modal._submit = onSubmit;
}

function closeModal() {
  modal.classList.add('hidden');
  modal._submit = null;
}

async function load({ silent = false } = {}) {
  try {
    S = await api('/api/state');
    lastError = null;
    if (!CATALOG.length) {
      api('/api/catalog').then((payload) => {
        CATALOG = Array.isArray(payload?.catalog) ? payload.catalog : [];
        if (S?.gateway && (location.hash === '#gateway' || currentTab === 'gateway')) render();
      }).catch(() => {});
    }
    render();
    // 看板页跟随轮询静默刷新；数据没变化就不重绘，避免图标悬停提示被频繁打断
    if (currentTab === 'dashboard' && DASH) {
      api(`/api/dashboard?range=${encodeURIComponent(DASH_RANGE)}`).then((payload) => {
        if (!payload) return;
        const strip = (x) => JSON.stringify({ s: x?.summary, t: x?.timeline, a: x?.byAccount, m: x?.byModel, r: x?.requests });
        if (strip(payload) !== strip(DASH)) {
          DASH = payload;
          render();
        }
      }).catch(() => {});
    }
  } catch (error) {
    if (!silent) toast(error.message, 'err');
    if (!S) view.innerHTML = `<div class="empty">无法连接本地网关：${esc(error.message)}</div>`;
  }
}


let loginPollTimer = null;

function stopLoginPoll() {
  if (loginPollTimer) clearInterval(loginPollTimer);
  loginPollTimer = null;
}

async function pollLogin(id) {
  stopLoginPoll();
  loginPollTimer = setInterval(async () => {
    try {
      const result = await api(`/api/login/status?id=${encodeURIComponent(id)}`);
      if (result.state === 'done') {
        stopLoginPoll();
        window.__loginPending = null;
        S = result.snapshot || S;
        render();
        toast(`已添加账号：${result.account?.label || ''}`, 'ok');
      } else if (['cancelled', 'timeout', 'failed', 'unknown'].includes(result.state)) {
        stopLoginPoll();
        window.__loginPending = null;
        render();
        toast(result.state === 'timeout' ? '登录超时，请重试' : '已取消登录', 'err');
      }
    } catch (error) {
      stopLoginPoll();
      window.__loginPending = null;
      render();
      toast(error.message, 'err');
    }
  }, 1500);
}

async function act(button, actionName, id, run = null) {
  const key = `${actionName}:${id || ''}`;
  if (busy.has(key)) return;
  busy.add(key);
  button.disabled = true;
  const label = button.textContent;
  button.textContent = '…';
  try {
    return typeof run === 'function' ? await run() : undefined;
  } finally {
    busy.delete(key);
    button.disabled = false;
    if (document.body.contains(button)) button.textContent = label;
  }
}

async function runStep(id, step) {
  const result = await api(`/api/accounts/${encodeURIComponent(id)}/${step}`, { method: 'POST', body: {} });
  S = result.snapshot || S;
  render();
  const failed = (result.steps || []).filter((item) => item.status === 'failed');
  if (failed.length) toast(`${step} 失败：${failed.map((item) => item.error).join('; ')}`, 'err');
  else toast('执行完成', 'ok');
}

view.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-act]');
  if (!button) return;
  const action = button.dataset.act;
  const id = button.dataset.id;

  try {
    if (action === 'goto-accounts') { switchTab('accounts'); return; }
    if (action === 'goto-logs') { switchTab('logs'); return; }
    if (action === 'goto-gateway') { switchTab('gateway'); return; }

    if (action === 'dash-refresh') {
      await fetchDashboard().catch(() => {});
      render();
      toast('看板已刷新', 'ok');
      return;
    }

    if (action === 'dash-range') {
      const range = button.dataset.range || 'today';
      if (range !== DASH_RANGE) {
        DASH_RANGE = range;
        try {
          await fetchDashboard(range);
        } catch (error) {
          toast(`加载失败：${error.message}`, 'err');
        }
        render();
      }
      return;
    }

    if (action === 'acct-filter') {
      const filter = filterState();
      filter[button.dataset.key] = button.dataset.value;
      render();
      return;
    }
    if (action === 'select-account') {
      const selection = selectedSet();
      if (selection.has(id)) selection.delete(id); else selection.add(id);
      render();
      return;
    }
    if (action === 'select-group') {
      const selection = selectedSet();
      const filter = filterState();
      const list = S.accounts.filter((account) => matchFilter(account, filter) && String(account.batch || account.provider || 'WorkBuddy') === id);
      const allPicked = list.every((account) => selection.has(account.id));
      for (const account of list) {
        if (allPicked) selection.delete(account.id); else selection.add(account.id);
      }
      render();
      return;
    }
    if (action === 'select-clear') {
      selectedSet().clear();
      render();
      return;
    }
    if (action === 'auto-toggle') {
      const key = button.dataset.key;
      const account = S.accounts.find((item) => item.id === id);
      if (!account) return;
      const next = account.auto?.[key] === false;
      await act(button, action, `${id}:${key}`, async () => {
        await api(`/api/accounts/${encodeURIComponent(id)}/auto`, { method: 'POST', body: { [key]: next } });
        account.auto = { ...(account.auto || {}), [key]: next };
        render();
        toast(`${account.label} ${next ? '开启' : '关闭'}${STEP_LABELS[key] || key}`, 'ok');
      });
      return;
    }
    if (action === 'batch') {
      const operation = button.dataset.batch;
      const group = button.dataset.group || null;
      const filter = filterState();
      const selection = selectedSet();
      let ids = [...selection];
      if (!ids.length) {
        ids = S.accounts
          .filter((account) => matchFilter(account, filter) && (!group || String(account.batch || account.provider || 'WorkBuddy') === group))
          .map((account) => account.id);
      }
      if (!ids.length) { toast('没有可操作的账号', 'err'); return; }
      if (operation === 'delete' && !confirm(`确定删除这 ${ids.length} 个账号？本地凭据会一并删除。`)) return;
      const label = { checkin: '全部签到', tasks: '一键做任务', claim: '全部领奖', keepalive: '全部保活', inspect: '一键巡检', refresh: '全部刷新', enable: '批量启用', disable: '批量停用', delete: '批量删除', 'run-all': '按计划执行' }[operation] || operation;
      await act(button, action, `${operation}:${ids.length}`, async () => {
        const result = await api('/api/bulk', { method: 'POST', body: { action: operation, ids } });
        S = result.snapshot || S;
        if (operation === 'delete') selection.clear();
        render();
        const failed = (result.results || []).filter((item) => item.status === 'failed');
        toast(failed.length ? `${label}：${failed.length} 个失败` : `${label}完成（${ids.length} 个）`, failed.length ? 'err' : 'ok');
      });
      return;
    }
    if (action === 'agent-apply' || action === 'agent-restore') {
      const clientId = button.dataset.client;
      await act(button, action, clientId, async () => {
        const result = await api(`/api/agents/${action === 'agent-apply' ? 'apply' : 'restore'}`, {
          method: 'POST',
          body: { client: clientId }
        });
        AGENTS = null;
        await renderAgents();
        toast(action === 'agent-apply'
          ? `已写入 ${result.files?.length || 0} 个配置文件`
          : `已还原（${result.restored?.length || 0} 个文件）`, 'ok');
      });
      return;
    }
    if (action === 'agents-refresh') {
      await act(button, 'agents-refresh', '', async () => {
        AGENTS = null;
        await renderAgents();
        toast('已重新探测', 'ok');
      });
      return;
    }
    if (action === 'atrest-save') {
      const input = document.getElementById('atrest-key');
      const key = input?.value.trim() || '';
      if (!key) { toast('先粘贴密钥', 'err'); return; }
      await act(button, 'atrest-save', '', async () => {
        await api('/api/atrest/key', { method: 'POST', body: { key } });
        AGENTS = null;
        await renderAgents();
        toast('密钥已采纳（只在内存里，重启要重来）', 'ok');
      });
      return;
    }
    if (action === 'atrest-forget') {
      await act(button, 'atrest-forget', '', async () => {
        await api('/api/atrest/forget', { method: 'POST', body: {} });
        AGENTS = null;
        await renderAgents();
        toast('已清除内存里的密钥', 'ok');
      });
      return;
    }
    if (action === 'atrest-recover') {
      toast('正在只读扫描客户端内存，约 1 分钟…', 'info');
      await act(button, 'atrest-recover', '', async () => {
        try {
          const result = await api('/api/atrest/recover', { method: 'POST', body: {} });
          AGENTS = null;
          await renderAgents();
          toast(`已回收密钥 ${result.keyId}（${result.candidates} 个候选里命中）`, 'ok');
        } catch (error) {
          toast(error.message, 'err');
        }
      });
      return;
    }
    if (action === 'import-json') {
      document.getElementById('import-file')?.click();
      return;
    }
    if (action === 'export-json') {
      await act(button, action, 'export', async () => {
        const data = await api('/api/export');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `workbuddy-accounts-${new Date().toISOString().slice(0, 10)}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
        toast('已导出（不含凭据明文）', 'ok');
      });
      return;
    }

    if (action === 'vault-export') {
      const password = window.prompt('给备份设一个口令（至少 6 位，用来加密账号凭据）：');
      if (!password) return;
      if (password.length < 6) { toast('口令至少 6 位', 'err'); return; }
      await act(button, action, 'vault', async () => {
        const result = await api('/api/vault/export', { method: 'POST', body: { password } });
        const blob = new Blob([JSON.stringify(result.vault, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = result.filename || `workbuddy-vault-${new Date().toISOString().slice(0, 10)}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
        toast(`已加密导出 ${result.count} 个账号（口令丢了就打不开）`, 'ok');
      });
      return;
    }
    if (action === 'run') {
      const step = button.dataset.step;
      await act(button, action, `${id}:${step}`, () => runStep(id, step));
      return;
    }
    if (action === 'run-all' || action === 'bulk') {
      const steps = button.dataset.steps ? button.dataset.steps.split(',').filter(Boolean) : undefined;
      await act(button, action, `all:${steps || 'auto'}`, async () => {
        const result = await api('/api/automation/run', { method: 'POST', body: steps ? { steps } : {} });
        S = result.snapshot || S;
        render();
        const failed = (result.results || []).filter((item) => item.status === 'failed');
        const label = steps ? steps.map((step) => STEP_LABELS[step] || step).join('/') : '全部步骤';
        toast(failed.length ? `${label}：${failed.length} 个账号失败` : `${label}执行完成`, failed.length ? 'err' : 'ok');
      });
      return;
    }
    if (action === 'clear-all-errors') {
      await act(button, action, 'clear', async () => {
        for (const account of S.accounts) {
          if (account.lastError || account.cooling) {
            await api(`/api/accounts/${encodeURIComponent(account.id)}/clear-error`, { method: 'POST', body: {} });
          }
        }
        await load({ silent: true });
        toast('已清除全部错误与冷却', 'ok');
      });
      return;
    }
    if (action === 'goto-automation') { switchTab('automation'); return; }
    if (action === 'toggle-add') {
      window.__showAdd = !(window.__showAdd === true);
      render();
      return;
    }
    if (action === 'collapse') {
      window.__collapsedProviders = window.__collapsedProviders || new Set();
      if (window.__collapsedProviders.has(id)) window.__collapsedProviders.delete(id);
      else window.__collapsedProviders.add(id);
      render();
      return;
    }
    if (action === 'collapse-all') {
      const collapse = !(window.__collapsedProviders && window.__collapsedProviders.size);
      window.__collapsedProviders = collapse
        ? new Set(S.accounts.map((item) => String(item.batch || item.provider || 'WorkBuddy')))
        : new Set();
      render();
      return;
    }
    if (action === 'detail') {
      const account = S.accounts.find((item) => item.id === id);
      if (!account) return;
      const rows = [
        ['账号 ID', account.id],
        ['供应商', account.provider || 'WorkBuddy'],
        ['区域', account.region || '国服'],
        ['状态', account.disabled ? '已停用' : account.usable ? '可用' : (account.unusableReason || '受限')],
        ['凭据', account.hasSecret ? `${account.secretMeta?.authType || 'cookie'}（${rel(account.secretMeta?.updatedAt)}更新）` : '未登录'],
        ['额度', `可用 ${num(account.available)} / 总额 ${num(account.quota.total)} / 已用 ${num(account.quota.used)}`],
        ['今日消耗', num(account.stats?.todayTokens || 0)],
        ['累计消耗', `${num(account.stats?.tokens || 0)} tok / ${num(account.stats?.requests || 0)} 次请求`],
        ['错误次数', String(account.errorCount || 0)],
        ['最近刷新', account.lastRefreshAt ? abs(account.lastRefreshAt) : '从未'],
        ['最近签到', account.lastCheckInAt ? abs(account.lastCheckInAt) : '未签到'],
        ['最近任务', account.lastTaskAt ? `${abs(account.lastTaskAt)}（${account.lastTaskStatus || ''}）` : '未执行'],
        ['最近领取', account.lastClaimAt ? `${abs(account.lastClaimAt)}（+${num(account.lastClaimAmount || 0)}）` : '未领取'],
        ['冷却', account.cooling ? `至 ${abs(account.cooldownUntil)}` : '无'],
        ['最近错误', account.lastError || '无']
      ];
      openModal(`账号详情 · ${account.label}`, `<dl class="kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`);
      return;
    }
    if (action === 'models') {
      const account = S.accounts.find((item) => item.id === id);
      await act(button, action, id, async () => {
        const data = await api(`/api/accounts/${encodeURIComponent(id)}/models`);
        const gateway = (data.gatewayModels || []).map((m) => `<span class="pill info mono">${esc(m)}</span>`).join(' ');
        const remote = (data.upstream || []).map((m) => `<span class="pill ok mono">${esc(m)}</span>`).join(' ');
        openModal(`可用模型 · ${account?.label || id}`, `
          <div class="field"><label>网关对外模型名（DSH 里填这些）</label><div class="btn-row" style="margin-top:6px">${gateway || '<span class="muted">—</span>'}</div></div>
          <div class="field" style="margin-top:12px"><label>上游返回的模型</label><div class="btn-row" style="margin-top:6px">${remote || `<span class="muted">${esc(data.upstreamError || '上游未返回模型列表')}</span>`}</div></div>
        `);
      });
      return;
    }
    if (action === 'toggle') {
      await act(button, action, id, async () => {
        const result = await api(`/api/accounts/${encodeURIComponent(id)}/toggle`, { method: 'POST', body: {} });
        await load({ silent: true });
        toast(result.account?.disabled ? '已禁用' : '已启用', 'ok');
      });
      return;
    }
    if (action === 'clear-error') {
      await act(button, action, id, async () => {
        await api(`/api/accounts/${encodeURIComponent(id)}/clear-error`, { method: 'POST', body: {} });
        await load({ silent: true });
        toast('已清除错误与冷却', 'ok');
      });
      return;
    }
    if (action === 'delete') {
      if (!confirm('确定删除这个账号？本地凭据会一并删除。')) return;
      await act(button, action, id, async () => {
        await api(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await load({ silent: true });
        toast('已删除', 'ok');
      });
      return;
    }
    if (action === 'edit') {
      const account = S.accounts.find((item) => item.id === id);
      if (!account) return;
      openModal(`编辑：${account.label}`, `
        <div class="form-grid">
          <div class="field full"><label>账号标签</label><input id="e-label" type="text" value="${esc(account.label)}"></div>
          <div class="field"><label>总额度</label><input id="e-total" type="number" min="0" value="${Number(account.quota.total)}"></div>
          <div class="field"><label>已用</label><input id="e-used" type="number" min="0" value="${Number(account.quota.used)}"></div>
          <div class="field"><label>凭据类型</label>
            <select id="e-auth">
              <option value="cookie" ${account.secretMeta?.authType === 'cookie' ? 'selected' : ''}>Cookie</option>
              <option value="bearer" ${account.secretMeta?.authType === 'bearer' ? 'selected' : ''}>Bearer Token</option>
              <option value="header" ${account.secretMeta?.authType === 'header' ? 'selected' : ''}>x-api-key</option>
            </select>
          </div>
          <div class="field"><label>官方页面</label><input id="e-url" type="text" value="${esc(account.officialUrl || '')}"></div>
          <div class="field full"><label>更换凭据</label><textarea id="e-secret" placeholder="留空表示不修改"></textarea></div>
          <div class="field full"><label>备注</label><input id="e-notes" type="text" value="${esc(account.notes || '')}"></div>
        </div>
      `, async () => {
        const patch = {
          label: document.getElementById('e-label').value.trim(),
          quota: {
            total: Number(document.getElementById('e-total').value || 0),
            used: Number(document.getElementById('e-used').value || 0)
          },
          officialUrl: document.getElementById('e-url').value.trim(),
          notes: document.getElementById('e-notes').value.trim()
        };
        const secret = document.getElementById('e-secret').value.trim();
        if (secret) {
          patch.secret = secret;
          patch.authType = document.getElementById('e-auth').value;
        }
        await api(`/api/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
        closeModal();
        await load({ silent: true });
        toast('已保存', 'ok');
      });
      return;
    }
    if (action === 'scan-login' || action === 'relogin') {
      const labelInput = document.getElementById('new-label');
      const label = action === 'relogin'
        ? (S.accounts.find((item) => item.id === id)?.label || '账号')
        : (labelInput?.value.trim() || '扫码账号');
      await act(button, action, id || 'new', async () => {
        const urlInput = document.getElementById('login-url');
        let started;
        try {
          started = await api('/api/login/start', { method: 'POST', body: { label, mode: 'workbuddy' } });
        } catch (error) {
          // 官方授权接口不可用时退回内置浏览器登录取 Cookie
          started = await api('/api/login/start', { method: 'POST', body: { label, url: urlInput?.value.trim() || undefined, mode: 'cookie' } });
        }
        window.__loginPending = { id: started.id, label, url: started.url };
        S.pendingLogins = [{ id: started.id, label, url: started.url, createdAt: Date.now() }];
        render();
        toast(started.mode === 'workbuddy' ? '已打开发官方授权页，用 WorkBuddy App 扫码即可' : '已打开登录窗口，登录后自动识别');
        pollLogin(started.id);
      });
      return;
    }
    if (action === 'save-login-url') {
      const value = document.getElementById('login-url').value.trim();
      await act(button, action, 'login-url', async () => {
        await api('/api/settings', { method: 'PATCH', body: { loginUrl: value } });
        S.settings.loginUrl = value;
        toast('登录页已保存', 'ok');
      });
      return;
    }
    if (action === 'open-pending-url') {
      const target = button.dataset.id || '';
      if (!target) return;
      try {
        window.open(target, '_blank', 'noopener');
        toast('已尝试在浏览器打开授权页');
      } catch {
        toast(target);
      }
      return;
    }
    if (action === 'open-external-login') {
      const url = document.getElementById('login-url').value.trim();
      await act(button, action, 'external', async () => {
        const result = await api('/api/login/start', { method: 'POST', body: { label: '外部登录', url, external: true } });
        toast(result.external ? '已在系统浏览器打开登录页，登录后请用「手动粘贴 Cookie」' : '已打开');
      });
      return;
    }
    if (action === 'finish-login') {
      const pending = window.__loginPending;
      if (!pending) return;
      await act(button, action, pending.id, async () => {
        const result = await api('/api/login/finish', { method: 'POST', body: { id: pending.id } });
        stopLoginPoll();
        window.__loginPending = null;
        S = result.snapshot || S;
        render();
        toast('已保存登录状态', 'ok');
      });
      return;
    }
    if (action === 'cancel-login') {
      const pending = window.__loginPending;
      if (!pending) return;
      await act(button, action, pending.id, async () => {
        await api('/api/login/cancel', { method: 'POST', body: { id: pending.id } });
        stopLoginPoll();
        window.__loginPending = null;
        render();
        toast('已取消');
      });
      return;
    }
    if (action === 'desktop-import') {
      await act(button, action, 'desktop', async () => {
        const scan = await api('/api/desktop/scan');
        if (!scan.items.length) { toast('没找到客户端的 .info 凭据文件', 'err'); return; }
        const needKey = scan.items.some((item) => item.keyRequired);
        if (needKey && !scan.key) {
          toast('凭据是加密信封：先到「智能体配置」页回收或粘贴 at-rest 密钥', 'warn');
          switchTab('agents');
          return;
        }
        const ready = scan.items.filter((item) => item.ok);
        if (!ready.length) { toast(scan.items[0]?.reason || '没有可导入的账号', 'err'); return; }
        const names = ready.map((item) => item.account?.nickname || item.account?.uid).join('、');
        if (!confirm(`将导入 ${ready.length} 个账号：${names}\n\n继续？`)) return;
        const result = await api('/api/desktop/import', { method: 'POST', body: {} });
        S = result.snapshot || S;
        render();
        toast(`已导入 ${result.imported} 个账号`, 'ok');
      });
      return;
    }
    if (action === 'import-client') {
      await act(button, action, 'cdp', async () => {
        let scan = await api('/api/cdp/scan');
        if (!scan.ready) {
          const go = window.confirm(
            '没检测到客户端调试端口。\n\n将以调试模式重启 WorkBuddy，重启后需要再点一次「从客户端导入」。\n\n现在重启吗？'
          );
          if (!go) { toast(scan.hint, 'warn'); return; }
          button.textContent = '重启客户端…';
          const relaunched = await api('/api/cdp/relaunch', { method: 'POST', body: {} });
          if (!relaunched.ok) throw new Error(`重启失败：${relaunched.reason || 'unknown'}`);
          scan = await api('/api/cdp/scan');
          if (!scan.ready) { toast('客户端已重启，等它加载完再点一次', 'warn'); return; }
        }
        button.textContent = '读取登录态…';
        const target = scan.targets[0];
        const result = await api('/api/cdp/import', {
          method: 'POST',
          body: { port: target.port, webSocketDebuggerUrl: target.webSocketDebuggerUrl }
        });
        await load({ silent: true });
        toast(result.updated ? '已更新该账号的登录态' : `已导入账号 ${result.account?.label || ''}`, 'ok');
        if (result.balanceError) toast(`额度没拉到：${result.balanceError}`, 'warn');
      });
      return;
    }
    if (action === 'toggle-manual') {
      document.getElementById('manual-panel').classList.toggle('hidden');
      return;
    }
    if (action === 'add-account') {
      const label = document.getElementById('new-label').value.trim();
      if (!label) { toast('先填账号标签', 'err'); return; }
      const totalRaw = document.getElementById('new-total').value;
      const usedRaw = document.getElementById('new-used').value;
      await act(button, action, 'new', async () => {
        await api('/api/accounts', {
          method: 'POST',
          body: {
            label,
            total: totalRaw === '' ? 0 : Number(totalRaw),
            used: usedRaw === '' ? 0 : Number(usedRaw),
            secret: document.getElementById('new-secret').value.trim() || undefined,
            authType: document.getElementById('new-auth').value,
            officialUrl: document.getElementById('new-url').value.trim(),
            notes: document.getElementById('new-notes').value.trim()
          }
        });
        await load({ silent: true });
        toast('账号已添加', 'ok');
      });
      return;
    }
    if (action === 'save-automation') {
      await act(button, action, 'auto', async () => {
        await api('/api/settings', {
          method: 'PATCH',
          body: {
            timezone: document.getElementById('auto-tz').value.trim() || 'America/Los_Angeles',
            automation: {
              time: document.getElementById('auto-time').value || '09:30',
              jitterSeconds: Number(document.getElementById('auto-jitter').value || 0),
              retries: Number(document.getElementById('auto-retries').value || 3),
              keepalive: {
                enabled: document.getElementById('step-keepalive').checked,
                intervalMinutes: Number(document.getElementById('auto-keepalive').value || 45)
              },
              inspect: {
                enabled: document.getElementById('step-inspect').checked,
                intervalMinutes: Number(document.getElementById('auto-inspect').value || 120)
              },
              steps: {
                keepalive: document.getElementById('step-keepalive').checked,
                refresh: document.getElementById('step-refresh').checked,
                inspect: document.getElementById('step-inspect').checked,
                checkin: document.getElementById('step-checkin').checked,
                tasks: document.getElementById('step-tasks').checked,
                claim: document.getElementById('step-claim').checked
              }
            }
          }
        });
        await load({ silent: true });
        toast('自动化设置已保存', 'ok');
      });
      return;
    }
    if (action === 'toggle-automation') {
      await act(button, action, 'auto', async () => {
        await api('/api/automation/toggle', { method: 'POST', body: {} });
        await load({ silent: true });
        toast(S.automation.enabled ? '自动任务已开启' : '自动任务已关闭', 'ok');
      });
      return;
    }
    if (action === 'save-upstream') {
      await act(button, action, 'up', async () => {
        await api('/api/settings', {
          method: 'PATCH',
          body: {
            gateway: {
              mock: document.getElementById('gw-mock').checked,
              queueProbe: document.getElementById('gw-queue').checked,
              apiKey: document.getElementById('gw-key').value.trim(),
              maxAttempts: Number(document.getElementById('gw-attempts').value || 3),
              cooldownOn429Minutes: Number(document.getElementById('gw-cooldown').value || 20)
            },
            model: document.getElementById('gw-model').value.trim() || 'workbuddy-gateway-v1',
            upstream: {
              baseUrl: document.getElementById('up-base').value.trim(),
              chatPath: document.getElementById('up-chat').value.trim(),
              balancePath: document.getElementById('up-balance').value.trim(),
              checkinPath: document.getElementById('up-checkin').value.trim(),
              tasksPath: document.getElementById('up-tasks').value.trim(),
              claimPath: document.getElementById('up-claim').value.trim(),
              tasks: { completePath: document.getElementById('up-complete').value.trim() }
            }
          }
        });
        await load({ silent: true });
        toast('上游设置已保存', 'ok');
      });
      return;
    }
    if (action === 'save-quota-paths') {
      await act(button, action, 'qp', async () => {
        const split = (value) => value.split(',').map((item) => item.trim()).filter(Boolean);
        await api('/api/settings', {
          method: 'PATCH',
          body: {
            upstream: {
              quotaPaths: {
                total: split(document.getElementById('qp-total').value),
                used: split(document.getElementById('qp-used').value),
                available: split(document.getElementById('qp-available').value)
              }
            }
          }
        });
        await load({ silent: true });
        toast('解析字段已保存', 'ok');
      });
      return;
    }
    if (action === 'import-curl') {
      await act(button, action, 'curl', async () => {
        const command = document.getElementById('curl-input').value;
        const target = document.getElementById('curl-target').value;
        const parsed = await api('/api/import/curl', { method: 'POST', body: { command } });
        window.__curlParsed = parsed;
        const output = document.getElementById('curl-result');
        output.innerHTML = `
          <div class="code-box light">${esc(JSON.stringify({
            method: parsed.method,
            origin: parsed.origin,
            path: parsed.path,
            headers: parsed.headers,
            body: parsed.body,
            authType: parsed.authType
          }, null, 2))}</div>`;
        document.getElementById('apply-cookie-btn').disabled = !parsed.secret;
        const patch = {
          upstream: { baseUrl: parsed.origin }
        };
        if (target === 'balance') patch.upstream.balancePath = parsed.path;
        if (target === 'checkin') { patch.upstream.checkinPath = parsed.path; patch.upstream.checkin = { method: parsed.method, body: parsed.body }; }
        if (target === 'tasks') patch.upstream.tasksPath = parsed.path;
        if (target === 'claim') { patch.upstream.claimPath = parsed.path; patch.upstream.claim = { method: parsed.method, body: parsed.body }; }
        if (target === 'complete') patch.upstream.tasks = { completePath: parsed.path, completeMethod: parsed.method };
        if (target === 'chat') patch.upstream.chatPath = parsed.path;
        await api('/api/settings', { method: 'PATCH', body: patch });
        if (parsed.secret && target === 'checkin') {
          toast('已解析并写入设置，凭据需要填到账号里', 'ok');
        } else {
          toast('已解析并写入设置', 'ok');
        }
        await load({ silent: true });
      });
      return;
    }
    if (action === 'apply-cookie') {
      const parsed = window.__curlParsed;
      if (!parsed?.secret) return;
      await act(button, action, 'cookie', async () => {
        for (const account of S.accounts) {
          await api(`/api/accounts/${encodeURIComponent(account.id)}/secret`, {
            method: 'POST',
            body: { secret: parsed.secret, authType: parsed.authType || 'cookie' }
          });
        }
        await load({ silent: true });
        toast(`已写入 ${S.accounts.length} 个账号的凭据`, 'ok');
      });
      return;
    }
    if (action === 'probe') {
      await act(button, action, 'probe', async () => {
        const accountId = document.getElementById('probe-account').value;
        if (!accountId) { toast('先添加账号', 'err'); return; }
        const result = await api(`/api/accounts/${encodeURIComponent(accountId)}/discover`, { method: 'POST', body: {} });
        document.getElementById('probe-result').innerHTML = `
          <div class="table-wrap"><table>
            <thead><tr><th>路径</th><th>状态</th><th>响应片段</th></tr></thead>
            <tbody>${result.results.map((item) => `
              <tr>
                <td class="mono">${esc(item.path)}</td>
                <td><span class="pill ${item.status === 200 ? 'ok' : item.status ? 'warn' : 'err'}">${item.status || 'ERR'}</span></td>
                <td class="mono truncate" title="${esc(item.snippet || item.error || '')}">${esc(item.snippet || item.error || '')}</td>
              </tr>`).join('')}</tbody>
          </table></div>`;
        toast('探测完成', 'ok');
      });
      return;
    }
    if (action === 'copy') {
      const value = button.dataset.copy || '';
      try { await navigator.clipboard.writeText(value); toast('已复制：' + value); }
      catch { toast(value); }
      return;
    }
    if (action === 'fetch-models') {
      await act(button, action, 'models', async () => {
        const response = await fetch('/v1/models');
        const payload = await response.json();
        document.getElementById('models-result').innerHTML = `<div class="code-box light">${esc(JSON.stringify(payload, null, 2))}</div>`;
        toast(`返回 ${payload.data?.length || 0} 个模型`, 'ok');
      });
      return;
    }
    if (action === 'sniff-start') {
      await act(button, action, 'sniff', async () => {
        const url = document.getElementById('login-url')?.value?.trim()
          || S.settings.loginUrl || S.settings.officialUrl;
        const started = await api('/api/sniff/start', { method: 'POST', body: { url } });
        window.__sniffId = started.id;
        render();
        toast('嗅探窗口已打开，操作后点「完成嗅探」');
      });
      return;
    }
    if (action === 'sniff-finish') {
      const id = window.__sniffId;
      if (!id) return;
      await act(button, action, id, async () => {
        const result = await api('/api/sniff/finish', { method: 'POST', body: { id } });
        window.__sniffId = null;
        S = result.snapshot || S;
        render();
        const hits = [result.baseUrl, result.chatPath, result.balancePath, result.checkinPath, result.tasksPath, result.claimPath].filter(Boolean);
        toast(hits.length ? `已识别 ${hits.length} 项并写入配置` : '没有抓到可识别的接口，换个页面多操作几次', hits.length ? 'ok' : 'err');
        if (hits.length) openModal('嗅探结果', `<dl class="kv">
          <dt>Base URL</dt><dd class="mono">${esc(result.baseUrl || '—')}</dd>
          <dt>Chat 路径</dt><dd class="mono">${esc(result.chatPath || '—')}</dd>
          <dt>模型列表</dt><dd class="mono">${esc(result.modelsPath || '—')}</dd>
          <dt>额度查询</dt><dd class="mono">${esc(result.balancePath || '—')}</dd>
          <dt>签到</dt><dd class="mono">${esc(result.checkinPath || '—')}</dd>
          <dt>任务列表</dt><dd class="mono">${esc(result.tasksPath || '—')}</dd>
          <dt>领取</dt><dd class="mono">${esc(result.claimPath || '—')}</dd>
          <dt>抓到的接口数</dt><dd>${Number(result.totalRequests || 0)}</dd>
        </dl>`);
      });
      return;
    }
    if (action === 'sniff-cancel') {
      window.__sniffId = null;
      render();
      return;
    }
    if (action === 'test-gateway') {
      await act(button, action, 'test', async () => {
        const result = await fetch('/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: S.settings.model, messages: [{ role: 'user', content: 'ping' }] })
        });
        const payload = await result.json().catch(() => null);
        const used = result.headers.get('x-scheduled-account-id') || payload?.scheduled_account_id || '';
        if (result.ok) {
          const label = S.accounts.find((item) => item.id === used)?.label || used || '本机模拟';
          toast(`调度到 ${label}`, 'ok');
        } else {
          toast(`失败：${payload?.error?.message || payload?.error || result.status}`, 'err');
        }
        await load({ silent: true });
      });
      return;
    }
    if (action === 'export') {
      const data = await api('/api/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `workbuddy-gateway-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      return;
    }
  } catch (error) {
    toast(error.message, 'err');
  }
});

function switchTab(tab) {
  currentTab = tab;
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
  render();
}

document.getElementById('tabs').addEventListener('click', (event) => {
  const button = event.target.closest('.tab');
  if (button) switchTab(button.dataset.tab);
});

// 搜索框实时过滤：重绘后把焦点与光标位置复原
let searchTimer = null;
view.addEventListener('input', (event) => {
  if (event.target.id !== 'acct-search') return;
  const value = event.target.value;
  filterState().q = value;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    render();
    const input = document.getElementById('acct-search');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }, 180);
});

// 导入 JSON：支持导出文件整份导入，也支持只给 accounts 数组
view.addEventListener('change', async (event) => {
  if (event.target.id !== 'import-file') return;
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    // 加密备份：走口令解密导入
    if (parsed && parsed.marker === 'workbuddy-gateway-vault') {
      const password = window.prompt('这是加密备份，输入导出时设的口令：');
      if (!password) return;
      const result = await api('/api/vault/import', { method: 'POST', body: { password, vault: parsed } });
      await load({ silent: true });
      const r = result.results || {};
      toast(`导入完成：新增 ${r.imported || 0}，更新 ${r.updated || 0}，失败 ${r.failed || 0}`, r.failed ? 'warn' : 'ok');
      if (r.failed) toast(`失败明细：${(r.details || []).slice(0, 2).join('；')}`, 'err');
      return;
    }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.accounts) ? parsed.accounts : [];
    if (!list.length) { toast('文件里没有 accounts 数组', 'err'); return; }
    let created = 0;
    for (const item of list.slice(0, 200)) {
      const label = String(item.label || item.name || '').trim();
      if (!label) continue;
      await api('/api/accounts', {
        method: 'POST',
        body: {
          label,
          provider: item.provider || 'WorkBuddy',
          region: item.region || '国服',
          total: item.quota?.total ?? item.total ?? 0,
          used: item.quota?.used ?? item.used ?? 0,
          notes: item.notes || '',
          secret: item.secret || undefined,
          authType: item.authType || undefined
        }
      });
      created += 1;
    }
    await load({ silent: true });
    toast(`已导入 ${created} 个账号`, 'ok');
  } catch (error) {
    toast(`导入失败：${error.message}`, 'err');
  } finally {
    event.target.value = '';
  }
});

function applyTheme(theme) {
  const next = theme || 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('wb-theme', next); } catch { /* 忽略 */ }
  const button = document.getElementById('btn-theme');
  if (button) button.textContent = next === 'dark' ? '☀ 浅色' : '🌙 深色';
}

document.getElementById('btn-theme')?.addEventListener('click', () => {
  const current = document.documentElement.dataset.theme || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});
applyTheme((() => {
  const param = new URLSearchParams(location.search).get('theme');
  if (param === 'dark' || param === 'light') return param;
  try { return localStorage.getItem('wb-theme') || 'light'; } catch { return 'light'; }
})());

document.getElementById('btn-refresh').addEventListener('click', () => load().then(() => toast('已刷新', 'ok')));
document.getElementById('copy-base').addEventListener('click', async () => {
  const url = S?.gateway?.baseUrl || `http://127.0.0.1:${S?.gateway?.port}/v1`;
  try {
    await navigator.clipboard.writeText(url);
    toast('已复制 Base URL', 'ok');
  } catch {
    toast(url);
  }
});

document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-cancel').addEventListener('click', closeModal);
document.getElementById('modal-ok').addEventListener('click', async () => {
  if (!modal._submit) return closeModal();
  try {
    await modal._submit();
  } catch (error) {
    toast(error.message, 'err');
  }
});
modal.addEventListener('click', (event) => { if (event.target === modal) closeModal(); });

const initialTab = location.hash.replace('#', '');
if (['overview', 'dashboard', 'accounts', 'automation', 'gateway', 'agents', 'logs'].includes(initialTab)) {
  currentTab = initialTab;
  document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === initialTab));
}
load();
timer = setInterval(() => { load({ silent: true }); }, 5000);
setInterval(() => {
  // 只更新冷却倒计时文本，避免整页闪烁
  document.querySelectorAll('[data-cooldown]').forEach((pill) => {
    const target = pill.querySelector('.cd');
    if (!target) return;
    const remaining = new Date(pill.dataset.cooldown).getTime() - Date.now();
    if (remaining <= 0) {
      target.textContent = '可重试';
      return;
    }
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    target.textContent = `冷却 ${minutes}分${String(seconds).padStart(2, '0')}秒`;
  });
}, 1000);
