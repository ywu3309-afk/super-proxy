// 摸清 /v2/chat/completions 接受哪种 body：模型 × 思考档位 × max_tokens
// 用法：node build/probe-chat-matrix.mjs [accountId]
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { parseCredential, chatCompletion, aggregateStream } from '../src/workbuddy.mjs';

const dataDir = join(import.meta.dirname, '..', 'release', 'WorkBuddy Gateway-win32-x64', 'data');
const store = new Store({ stateFile: join(dataDir, 'state.json'), secretsFile: join(dataDir, 'secrets.json') });
await store.load();

const id = process.argv[2] || store.listAccounts().at(-1)?.id;
const cred = parseCredential((await store.getSecret(id)).value);
console.log('account:', store.getAccount(id).label, '| uid', cred.uid);

const base = { messages: [{ role: 'user', content: '只说两个字：在的' }] };
const cases = [
  ['glm-5.1 + none', { ...base, model: 'glm-5.1', reasoning_effort: 'none', max_tokens: 32 }],
  ['glm-5.1 + low', { ...base, model: 'glm-5.1', reasoning_effort: 'low', max_tokens: 32 }],
  ['glm-5.1 无 effort 无 max_tokens', { ...base, model: 'glm-5.1' }],
  ['glm-5.3 + none', { ...base, model: 'glm-5.3', reasoning_effort: 'none', max_tokens: 32 }],
  ['auto + none', { ...base, model: 'auto', reasoning_effort: 'none', max_tokens: 32 }],
  ['hunyuan-chat + none', { ...base, model: 'hunyuan-chat', reasoning_effort: 'none', max_tokens: 32 }],
  ['deepseek-v4.1-flash + none', { ...base, model: 'deepseek-v4.1-flash', reasoning_effort: 'none', max_tokens: 32 }],
  ['kimi-k3-1 + none', { ...base, model: 'kimi-k3-1', reasoning_effort: 'none', max_tokens: 32 }]
];

for (const [label, body] of cases) {
  const started = Date.now();
  const result = await chatCompletion(cred, body);
  if (!result.ok) {
    let msg = String(result.body || '');
    try { const j = JSON.parse(msg); msg = `${j.code} ${j.msg || j.displayMsg?.zh || ''}`; } catch { /* 原样 */ }
    console.log(`${label.padEnd(28)} → ${result.status} ${msg.slice(0, 110)} · ${Date.now() - started}ms`);
    continue;
  }
  const agg = await aggregateStream(result.stream, { model: body.model });
  console.log(`${label.padEnd(28)} → 200 ${JSON.stringify((agg.content || '').slice(0, 40))} · ${Date.now() - started}ms`);
}
