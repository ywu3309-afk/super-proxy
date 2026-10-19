const base = process.argv[2] || 'http://127.0.0.1:8787';

// 演示数据：分两个批次，覆盖正常 / 限流 / 过期等卡片状态
const accounts = [
  { label: 'luke·主号', role: 'admin', batch: '第一批', total: 4545, used: 1280, secret: 'sid=demo-1', health: 'healthy' },
  { label: 'Joey', role: 'team', batch: '第一批', total: 1192, used: 640, secret: 'sid=demo-2', health: 'healthy' },
  { label: 'ChmcZry', role: 'team', batch: '第一批', total: 4331, used: 1520, secret: 'sid=demo-3', health: 'limited' },
  { label: '杨lb', role: 'team', batch: '第二批', total: 3448, used: 1870, secret: 'sid=demo-4', health: 'healthy' },
  { label: 'China Zxy', role: 'team', batch: '第二批', total: 3879, used: 2100, secret: 'sid=demo-5', health: 'healthy' },
  { label: '喻元庆-个人', role: 'team', batch: '第二批', total: 3375, used: 3010, secret: 'sid=demo-6', health: 'expired' }
];

async function send(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json();
}

const post = (path, body) => send('POST', path, body);
const patch = (path, body) => send('PATCH', path, body);

const created = [];
for (const account of accounts) {
  const result = await post('/api/accounts', account);
  created.push(result.account);
  await patch(`/api/accounts/${encodeURIComponent(result.account.id)}`, {
    batch: account.batch,
    role: account.role,
    health: account.health
  });
}

for (let index = 0; index < 8; index += 1) {
  await post('/v1/chat/completions', {
    model: 'workbuddy-gateway-v1',
    messages: [{ role: 'user', content: `demo request ${index + 1}` }],
    estimatedTokens: 700 + index * 60
  });
}

await post('/api/bulk', { action: 'inspect' });
await post('/api/bulk', { action: 'keepalive' });
await post('/api/automation/run', {});
console.log(`已写入 ${created.length} 个演示账号（2 个批次）并生成 8 次网关请求：${base}`);
