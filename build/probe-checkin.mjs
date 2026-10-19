// 直连上游复现签到：读便携版 data/ → 解出凭据 → 打签到与签到状态接口
// 用法：node build/probe-checkin.mjs [accountId]
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { parseCredential, dailyCheckin, checkinStatus } from '../src/workbuddy.mjs';

const dataDir = join(import.meta.dirname, '..', 'release', 'WorkBuddy Gateway-win32-x64', 'data');
const store = new Store({ stateFile: join(dataDir, 'state.json'), secretsFile: join(dataDir, 'secrets.json') });
await store.load();

const id = process.argv[2] || 'acc-a391436b';
const account = store.getAccount(id);
if (!account) throw new Error(`没有这个账号：${id}`);
const secret = await store.getSecret(id);
const cred = parseCredential(secret?.value);
console.log('account:', account.label, '| realm', cred?.realm, '| uid', cred?.uid);

const st = await checkinStatus(cred);
console.log('checkinStatus →', JSON.stringify({ ok: st.ok, checkedIn: st.checkedIn, path: st.path, today: st.today, total: st.total, streak: st.streak, body: st.body }).slice(0, 500));

const r = await dailyCheckin(cred);
console.log('dailyCheckin →', JSON.stringify(r).slice(0, 700));
