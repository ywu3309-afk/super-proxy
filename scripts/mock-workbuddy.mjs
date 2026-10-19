// 本地 WorkBuddy 上游 mock：按官方路径与返回结构实现，用于端到端验证
// 用法：node scripts/mock-workbuddy.mjs [port]
import http from 'node:http';

const port = Number(process.argv[2] || 8799);

const calls = [];

function json(res, code, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ code, msg: code === 0 ? 'ok' : 'mock', data: body }));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({ raw }); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const path = url.pathname;
  const body = req.method === 'POST' ? await readBody(req) : {};
  calls.push({ method: req.method, path, auth: Boolean(req.headers.authorization), ua: req.headers['user-agent'] || '', ide: req.headers['x-ide-type'] || '', body });

  // 额度：客户端 5.8.x 三段式（summary + 付费包 + 免费切片包）
  // 付费包 1200/剩 700，免费切片包 300/剩 200 → 合计 1500/900
  if (path === '/v2/billing/meter/get-user-resource-summary') {
    return json(res, 0, { IsPaidUser: true, SubscriptionPackageCode: 'proMon', Packages: [] });
  }
  if (path === '/v2/billing/meter/get-user-resource-paid-packages') {
    return json(res, 0, {
      TotalCount: 1,
      Accounts: [{
        ResourceId: 'paid-proMon',
        PackageCode: 'proMon',
        PackageName: '专业版月包',
        CapacityType: 1,
        CycleCapacitySizePrecise: 1200,
        CycleCapacityRemainPrecise: 700
      }]
    });
  }
  if (path === '/v2/billing/meter/get-user-resource-free-packages') {
    // 切片包（CapacityType=4）额度必须读 SlicePeriodUsageDetails
    return json(res, 0, {
      TotalCount: 1,
      Accounts: [{
        ResourceId: 'free-daily',
        PackageCode: 'free',
        PackageName: '每日免费额度',
        CapacityType: 4,
        CycleCapacitySizePrecise: 300,
        CycleCapacityRemainPrecise: 200,
        SlicePeriodUsageDetails: [{ SlicePeriodCapacitySizePrecise: 300, SlicePeriodCapacityRemainPrecise: 200 }]
      }]
    });
  }

  // 旧链路保留，用来验证兜底
  if (path === '/v2/billing/meter/get-user-resource') {
    return json(res, 0, {
      Response: {
        Data: {
          Accounts: [
            { CapacityRemainPrecise: 1200, CycleCapacityRemainPrecise: 800 },
            { CapacityRemainPrecise: 300, CycleCapacityRemainPrecise: 100 }
          ]
        }
      }
    });
  }

  if (path === '/v2/billing/meter/daily-checkin') return json(res, 0, { today_credit: 100 });
  // 客户端 5.8.x 走 checkin-status，旧版才是 checkin-activity-status
  if (path === '/v2/billing/meter/checkin-status') {
    return json(res, 0, { today_checked_in: true, total_credits: 300, today_credit: 100, streak_days: 3 });
  }
  if (path === '/v2/billing/meter/checkin-activity-status') {
    return json(res, 0, { today_checked_in: true, total_credits: 300, today_credit: 100, streak_days: 3 });
  }

  // 成长体系（连签 / 旅行奖励）
  if (path === '/v2/activity/growth/buddy/info') {
    return json(res, 0, { level: 3, level_name: '探索者', streak_days: 5, total_days: 12, points: 260 });
  }
  if (path === '/activity/growth/buddy/travel/claim') return json(res, 0, { claimed: true, amount: 20 });

  if (path === '/v2/activity/growth/tasks') {
    return json(res, 0, {
      tasks: [
        { code: 'task-daily-chat', title: '每日对话一次', status: 'pending' },
        { code: 'task-invite', title: '邀请一位好友', status: 'claimed' }
      ]
    });
  }
  if (path === '/v2/activity/growth/tasks/accept') return json(res, 0, { accepted: (body.task_codes || []).length });
  if (/^\/activity\/growth\/tasks\/[^/]+\/claim$/.test(path)) return json(res, 0, { claimed: true });

  // 个人版模型清单（客户端真实路径）
  if (path === '/v2/enterprises/personal/models') {
    return json(res, 0, {
      models: [
        { id: 'glm-5.1', name: 'GLM-5.1', tags: ['text'] },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', tags: ['text'] },
        { id: 'hunyuan-image-v3.0', name: 'Hunyuan Image V3', tags: ['text-to-image'] }
      ]
    });
  }

  if (path === '/v2/models') {
    return json(res, 0, [{ id: 'glm-5.2' }, { id: 'kimi-k2.7' }]);
  }

  // 排队预检：model 带 queue-busy，或该账号 uid 是 u-busy（按账号模拟排队）
  if (path === '/v2/chat/queue/status') {
    const busy = String(body.model || '').includes('queue-busy') || req.headers['x-user-id'] === 'u-busy';
    return json(res, 0, busy
      ? { status: 'queueing', position: 7, estimatedWaitSeconds: 40 }
      : { status: 'idle' });
  }

  // 对话：只接受 stream:true，否则返回 11101
  if (path === '/v2/chat/completions') {
    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 11101, msg: 'stream required' }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    const chunks = [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' } }] },
      { choices: [{ index: 0, delta: { content: ' from workbuddy' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } }
    ];
    for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }

  if (path === '/__calls') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(calls));
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 404, msg: `no mock for ${path}` }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-workbuddy] http://127.0.0.1:${port}`);
});
