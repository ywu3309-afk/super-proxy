// 从 app.asar 中批量抽取接口路径与域名，去重输出
import { open } from 'node:fs/promises';

const archive = process.argv[2];
const handle = await open(archive, 'r');
const head = Buffer.alloc(16);
await handle.read(head, 0, 16, 0);
const headerPickleSize = head.readUInt32LE(4);
const headerBuf = Buffer.alloc(headerPickleSize);
await handle.read(headerBuf, 0, headerPickleSize, 8);
const jsonLen = headerBuf.readUInt32LE(4);
const header = JSON.parse(headerBuf.slice(8, 8 + jsonLen).toString('utf8'));
const baseOffset = 8 + headerPickleSize;

const files = [];
(function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const full = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, full);
    else files.push({ path: full, size: Number(entry.size || 0), offset: Number(entry.offset || 0), unpacked: Boolean(entry.unpacked) });
  }
})(header, '');

const want = /^(main\/|renderer\/assets\/|cli\/dist\/|resources\/extensions\/).*\.(js|mjs|cjs)$/;
const paths = new Map();

for (const entry of files) {
  if (!want.test(entry.path)) continue;
  if (entry.size > 30 * 1048576) continue;
  let buffer;
  if (entry.unpacked) {
    const { readFile } = await import('node:fs/promises');
    try { buffer = await readFile(`${archive}.unpacked/${entry.path}`); } catch { continue; }
  } else {
    buffer = Buffer.alloc(entry.size);
    await handle.read(buffer, 0, entry.size, baseOffset + entry.offset);
  }
  const text = buffer.toString('utf8');
  const re = /["'`]((?:\/v2|\/billing|\/activity|\/console|\/api|\/v1)\/[A-Za-z0-9_\-./{}$:]{2,80})["'`]/g;
  let match;
  while ((match = re.exec(text))) {
    const candidate = match[1];
    if (/\.(js|css|png|svg|json)$/i.test(candidate)) continue;
    if (!paths.has(candidate)) paths.set(candidate, entry.path);
  }
}

const rows = [...paths.entries()].sort((a, b) => a[0].localeCompare(b[0]));
for (const [path, from] of rows) console.log(`${path}\t${from}`);
console.log(`--- ${rows.length} unique endpoints`);
await handle.close();
