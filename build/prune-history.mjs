import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// 清掉指向已删账号的执行/事件/请求记录：账号删了，历史里的卡片也不该再出现
const targets = process.argv.slice(2);
if (!targets.length) {
  console.error('usage: node build/prune-history.mjs <dataDir> [dataDir...]');
  process.exit(1);
}

for (const dir of targets) {
  const file = join(dir, 'state.json');
  if (!existsSync(file)) {
    console.log(`[skip] ${file} 不存在`);
    continue;
  }
  const state = JSON.parse(readFileSync(file, 'utf8'));
  const keep = new Set((state.accounts || []).map((item) => item.id));
  const before = { jobs: (state.jobs || []).length, events: (state.events || []).length, requests: (state.requests || []).length };

  const alive = (item) => !item || !item.accountId || keep.has(item.accountId);
  state.jobs = (state.jobs || []).filter(alive);
  state.events = (state.events || []).filter(alive);
  state.requests = (state.requests || []).filter(alive);

  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, file);

  console.log(
    `[${dir}] jobs ${before.jobs}→${state.jobs.length} · events ${before.events}→${state.events.length} · requests ${before.requests}→${state.requests.length}`
  );
}
