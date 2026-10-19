// 直连上游复现对话失败：读便携版 data/ → 解出凭据 → 打 /v2/chat/completions
// 用法：node build/probe-chat.mjs [accountId] [model]
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { parseCredential, chatCompletion, aggregateStream } from '../src/workbuddy.mjs';

const dataDir = join(import.meta.dirname, '..', 'release', 'WorkBuddy Gateway-win32-x64', 'data');
const store = new Store({ stateFile: join(dataDir, 'state.json'), secretsFile: join(dataDir, 'secrets.json') });
await store.load();

console.log('accounts:', store.listAccounts().map((a) => `${a.id}(${a.label})`).join(', '));

const id = process.argv[2] || store.listAccounts().at(-1)?.id;
const model = process.argv[3] || 'glm-5.1';
const account = store.getAccount(id);
if (!account) throw new Error(`没有这个账号：${id}`);
const secret = await store.getSecret(id);
console.log('account:', account.label, '| authType', secret?.authType);

const cred = parseCredential(secret?.value);
console.log('cred:', JSON.stringify({
  uid: cred?.uid || null,
  domain: cred?.domain || null,
  realm: cred?.realm || null,
  tokenLength: cred?.token?.length || 0,
  refreshLength: cred?.refreshToken?.length || 0
}));

const result = await chatCompletion(cred, {
  model,
  messages: [{ role: 'user', content: '只回答两个字：在的' }],
  max_tokens: 32
});
if (!result.ok) {
  console.log(`chat ${model} → 失败 ${result.status}:`, String(result.body || '').slice(0, 900));
  process.exit(1);
}
console.log(`chat ${model} → 200，开始聚合流`);
const agg = await aggregateStream(result.stream, { model });
console.log('content:', JSON.stringify((agg.content || '').slice(0, 120)));
console.log('usage:', JSON.stringify(agg.usage || null), '| finish:', agg.finishReason || null);
