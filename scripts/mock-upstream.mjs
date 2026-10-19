// 模拟上游站点：登录后自动发几个 XHR，用于验证嗅探与额度字段猜测
import http from 'node:http';

const state = { checkin: 0, claim: 0 };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:8900');
  const json = (payload, code = 200) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  };

  if (url.pathname === '/' || url.pathname === '/login') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>模拟上游</title>
<body style="font-family:system-ui;padding:24px">
<h3>模拟上游站点</h3>
<p id="s">加载中…</p>
<script>
document.cookie = 'sid=mock-session-abc; path=/';
document.cookie = 'uid=4242; path=/';
const hit = (method, path, body) => fetch(path, {
  method,
  headers: { 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined
}).then(r => r.json()).catch(() => null);
(async () => {
  await hit('GET', '/api/user/quota');
  await hit('GET', '/api/models');
  await hit('POST', '/api/checkin', { source: 'web' });
  await hit('GET', '/api/tasks');
  await hit('POST', '/api/tasks/12/complete', { taskId: 12 });
  await hit('POST', '/api/reward/claim', { amount: 100 });
  await hit('POST', '/v1/chat/completions', { model: 'workbuddy', messages: [{ role: 'user', content: 'hi' }] });
  document.getElementById('s').textContent = '已发出全部模拟请求';
})();
</script></body>`);
    return;
  }

  if (url.pathname === '/api/user/quota') {
    return json({ code: 0, data: { quota: { total: 5000, used: 1200, remaining: 3800 }, plan: 'pro' } });
  }
  if (url.pathname === '/api/models') {
    return json({ data: [{ id: 'workbuddy-pro' }, { id: 'workbuddy-lite' }] });
  }
  if (url.pathname === '/api/checkin') {
    state.checkin += 1;
    return json({ code: 0, success: true, data: { reward: 120 } });
  }
  if (url.pathname === '/api/tasks') {
    return json({ data: { list: [{ id: 12, title: '每日对话', done: false }] } });
  }
  if (url.pathname.startsWith('/api/tasks/')) {
    return json({ code: 0, success: true });
  }
  if (url.pathname === '/api/reward/claim') {
    state.claim += 1;
    return json({ code: 0, success: true, data: { amount: 100 } });
  }
  if (url.pathname === '/v1/chat/completions') {
    return json({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: '[mock upstream] pong' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
    });
  }
  if (url.pathname === '/stats') {
    return json(state);
  }
  return json({ error: 'not_found', path: url.pathname }, 404);
});

server.listen(8900, '127.0.0.1', () => console.log('mock upstream on 8900'));
