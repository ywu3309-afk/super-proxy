// 在运行中的便携版上实测 POST /api/atrest/recover（打包后脚本物化路径是否真的能跑）
// 用法：node build/probe-recover.mjs [baseUrl]
const base = process.argv[2] || 'http://127.0.0.1:8787';
const started = Date.now();
const res = await fetch(`${base}/api/atrest/recover`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}'
});
const text = await res.text();
console.log(`status ${res.status} · ${Math.round((Date.now() - started) / 1000)}s`);
console.log(text);
