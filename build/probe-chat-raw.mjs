// 看 /v2/chat/completions 的原始 SSE 帧，确认正文落在哪个字段
// 用法：node build/probe-chat-raw.mjs [accountId] [model]
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { parseCredential, buildHeaders, realmOf, WB_PATHS } from '../src/workbuddy.mjs';

const dataDir = join(import.meta.dirname, '..', 'release', 'WorkBuddy Gateway-win32-x64', 'data');
const store = new Store({ stateFile: join(dataDir, 'state.json'), secretsFile: join(dataDir, 'secrets.json') });
await store.load();

const id = process.argv[2] || store.listAccounts().at(-1)?.id;
const model = process.argv[3] || 'glm-5.3';
const cred = parseCredential((await store.getSecret(id)).value);
const cfg = realmOf(cred.realm);

const body = {
  model,
  messages: [{ role: 'user', content: '用一句话说明你是谁' }],
  max_tokens: 256,
  reasoning_effort: 'low',
  stream: true
};
const res = await fetch(`${cfg.base}${WB_PATHS.chat}`, {
  method: 'POST',
  headers: { ...buildHeaders(cred, 'chat'), accept: 'text/event-stream' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(180000)
});
console.log('status', res.status, res.headers.get('content-type'));
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let frames = 0;
const samples = [];
const keys = new Set();
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let index;
  while ((index = buf.indexOf('\n\n')) >= 0) {
    const frame = buf.slice(0, index).trim();
    buf = buf.slice(index + 2);
    if (!frame) continue;
    frames += 1;
    if (samples.length < 6) samples.push(frame.slice(0, 500));
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        for (const key of Object.keys(json)) keys.add(key);
        const choice = json.choices?.[0];
        if (choice) {
          for (const key of Object.keys(choice)) keys.add(`choices[0].${key}`);
          if (choice.delta) for (const key of Object.keys(choice.delta)) keys.add(`delta.${key}`);
          if (choice.message) for (const key of Object.keys(choice.message)) keys.add(`message.${key}`);
        }
      } catch { /* 忽略 */ }
    }
  }
}
console.log('frames', frames);
console.log('fields:', [...keys].sort().join(', '));
console.log('--- 前几帧 ---');
for (const sample of samples) console.log(sample.replace(/\n/g, ' | '));
