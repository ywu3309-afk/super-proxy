/**
 * 桌面客户端 at-rest 加密凭据解密
 *
 * 移植自 workbuddy2api-hub（AGPL-3.0）的 wb_atrest.py。客户端自 2026-09-24 起
 * 把 accessToken / refreshToken 存成 `{"$wbEncrypted": 1, "envelope": "base64"}`，
 * 直接拿出来用会 401。这里按客户端 packages/at-rest-crypto 的同一套方案解开：
 *
 *   保护密钥  = 64 位 hex（sha256 之后的结果），或 sha256(44 字符 base64 字符串)
 *   keyId     = sha256(保护密钥).hex[0:16]
 *   AAD       = "WB-AAD\0" | 0x01 | LP("WBEF1"/"WBEV1") | LP("sym-v1")
 *               | u32(suite) | LP(keyId) | framingCode | 0x00 | 0x00
 *   envelope  = base64(JSON{suite,keyId,nonce,authTag,ciphertext})  AES-256-GCM
 *
 * 保护密钥编在客户端原生模块里，磁盘上没有明文：要么从客户端进程内存里回收
 * （Windows，另做），要么手动粘贴一次。这里只保留内存缓存，不落盘、不进日志。
 */
import { createHash, createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';

export const ENVELOPE_KEY = '$wbEncrypted';
export const FRAMING_MAGIC = { file: 'WBEF1', field: 'WBEV1', record: 'WBER1', stream: 'WBES1' };
export const FRAMING_CODE = { file: 1, field: 2, record: 3, stream: 4 };
export const SCHEME = 'sym-v1';
export const SUITE = 1;
export const KEYBLOB_NAME = 'keyblob';
const CONFIG_DIR_CANDIDATES = ['.workbuddy-ai', '.workbuddy'];

export class AtRestError extends Error {}

// ----------------------------------------------------------------- 基础编码
function lp(text) {
  const raw = Buffer.from(String(text), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(raw.length, 0);
  return Buffer.concat([head, raw]);
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(Number(value) >>> 0, 0);
  return buf;
}

/** AAD 必须逐字节对齐客户端，否则 GCM 校验必然失败。 */
export function aad(keyId, suite, framing) {
  const magic = FRAMING_MAGIC[framing];
  if (!magic) throw new AtRestError(`unknown framing ${framing}`);
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'binary'),
    Buffer.from([0x01]),
    lp(magic),
    lp(SCHEME),
    u32(suite),
    lp(keyId),
    Buffer.from([FRAMING_CODE[framing], 0x00, 0x00])
  ]);
}

/** protectorKeyId / envelope.keyId：sha256(保护密钥) 的前 16 个 hex。 */
export function deriveKeyId(key) {
  return createHash('sha256').update(toKey(key)).digest('hex').slice(0, 16);
}

function toKey(key) {
  if (Buffer.isBuffer(key)) return key;
  if (key instanceof Uint8Array) return Buffer.from(key);
  throw new AtRestError('保护密钥必须是 32 字节 Buffer（先用 parseKeyText 归一）');
}

/**
 * 把用户粘贴的密钥文本规整成 32 字节保护密钥。
 * 认两种写法：64 位 hex（已派生的保护密钥）、44 字符规范 base64（atRestSecretKey）。
 */
export function parseKeyText(text) {
  let raw = String(text || '').trim();
  if (raw.slice(0, 2).toLowerCase() === '0x') raw = raw.slice(2).trim();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  if (/^[A-Za-z0-9+/]{43}=$/.test(raw)) {
    // 与客户端载荷档一致：sha256 的是 base64 字符串本身，不是它解出来的 32 字节
    return createHash('sha256').update(raw, 'ascii').digest();
  }
  throw new AtRestError('认不出密钥格式：需要 64 位 hex 保护密钥，或 44 字符 base64 的 atRestSecretKey');
}

/** 是不是一个 $wbEncrypted 信封（而不是明文 token）。 */
export function isEnvelope(value) {
  if (value && typeof value === 'object') {
    return typeof value.envelope === 'string' && ENVELOPE_KEY in value;
  }
  if (typeof value === 'string') {
    const stripped = value.replace(/^\s+/, '');
    return stripped.startsWith('{') && stripped.slice(0, 64).includes(ENVELOPE_KEY);
  }
  return false;
}

export function parseEnvelope(value) {
  const raw = value && typeof value === 'object' ? value.envelope || '' : value;
  let env;
  try {
    env = JSON.parse(Buffer.from(String(raw), 'base64').toString('utf8'));
  } catch (error) {
    throw new AtRestError(`envelope 不是 base64(JSON)：${error.message}`);
  }
  try {
    return {
      suite: Number(env.suite || SUITE),
      keyId: String(env.keyId || ''),
      nonce: Buffer.from(env.nonce, 'base64'),
      authTag: Buffer.from(env.authTag, 'base64'),
      ciphertext: Buffer.from(env.ciphertext, 'base64')
    };
  } catch (error) {
    throw new AtRestError(`envelope 缺字段：${error.message}`);
  }
}

/** 解开一个信封，返回明文字节。key 是 32 字节保护密钥。 */
export function openEnvelope(key, value, framing) {
  const env = parseEnvelope(value);
  const expect = deriveKeyId(key);
  if (env.keyId && env.keyId !== expect) {
    throw new AtRestError(`envelope keyId ${env.keyId} 与当前密钥（${expect}）不匹配`);
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', toKey(key), env.nonce);
    decipher.setAAD(aad(env.keyId || expect, env.suite, framing));
    decipher.setAuthTag(env.authTag);
    return Buffer.concat([decipher.update(env.ciphertext), decipher.final()]);
  } catch (error) {
    throw new AtRestError(`GCM 解密失败（密钥不对或信封损坏）：${error.message}`);
  }
}

/** 加密一个字段（只在测试与自检里用，产品不需要写回客户端）。 */
export function seal(key, plaintext, framing = 'field', keyId = null) {
  const master = toKey(key);
  const kid = keyId || deriveKeyId(master);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', master, nonce);
  cipher.setAAD(aad(kid, SUITE, framing));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const envelope = Buffer.from(JSON.stringify({
    suite: SUITE,
    keyId: kid,
    nonce: nonce.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  }), 'utf8').toString('base64');
  return { [ENVELOPE_KEY]: SUITE, envelope };
}

/** 解密一个可能加密、也可能本来就是明文的字段。 */
export function decryptField(key, value, framing = 'field') {
  if (value === null || value === undefined || value === '') return '';
  if (!isEnvelope(value)) return typeof value === 'string' ? value : null;
  return openEnvelope(key, value, framing).toString('utf8');
}

// --------------------------------------------------------------- keyblob
export function configDir() {
  const env = process.env.WORKBUDDY_CONFIG_DIR || process.env.CODEBUDDY_CONFIG_DIR;
  if (env) return resolve(env.replace(/^~(?=$|[\\/])/, homedir()));
  for (const name of CONFIG_DIR_CANDIDATES) {
    const candidate = join(homedir(), name);
    if (existsSync(join(candidate, KEYBLOB_NAME))) return resolve(candidate);
  }
  return resolve(join(homedir(), CONFIG_DIR_CANDIDATES[0]));
}

/** 文件名写死，调用方无法指向别处（把路径钉在配置目录内）。 */
export function keyblobPath() {
  const root = configDir();
  const path = resolve(root, KEYBLOB_NAME);
  if (dirname(path) !== root || basename(path) !== KEYBLOB_NAME) {
    throw new AtRestError(`路径越界：${path} 不在 ${root} 内`);
  }
  return path;
}

export function loadKeyblob() {
  const path = keyblobPath();
  if (!existsSync(path)) {
    throw new AtRestError(`keyblob 不存在：${path}（桌面客户端没装或没登录过？）`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof AtRestError) throw error;
    throw new AtRestError(`keyblob 读取失败：${error.message}`);
  }
}

/** static-v1 槽的 protectorKeyId —— 内存里搜密钥时的判据。 */
export function readKeyId() {
  const blob = loadKeyblob();
  for (const slot of blob.slots || []) {
    if (slot && slot.type === 'static-v1' && slot.protectorKeyId) {
      return String(slot.protectorKeyId).toLowerCase();
    }
  }
  throw new AtRestError(`keyblob 里没有带 protectorKeyId 的 static-v1 槽（${keyblobPath()}）`);
}

/** 自检：密钥对得上 protectorKeyId，且能解出 32 字节主密钥。 */
export function unwrapKeyblob(key) {
  const blob = loadKeyblob();
  const master = toKey(key);
  for (const slot of blob.slots || []) {
    if (!slot || slot.type !== 'static-v1' || !slot.wrapped) continue;
    if (String(slot.protectorKeyId || '').toLowerCase() !== deriveKeyId(master)) {
      throw new AtRestError('密钥与 keyblob 的 protectorKeyId 不匹配');
    }
    const unwrapped = openEnvelope(master, slot.wrapped, 'file');
    if (unwrapped.length !== 32 || deriveKeyId(unwrapped) !== String(blob.keyId || '')) {
      throw new AtRestError('keyblob 解出的主密钥校验失败');
    }
    return unwrapped;
  }
  throw new AtRestError('keyblob 里没有可用的 static-v1 槽');
}

// ------------------------------------------------------- 进程内密钥缓存
let cached = null;

/** 登记一个密钥（先做 keyblob 自检，通过才留内存）。 */
export function adoptKey(text) {
  const key = parseKeyText(text);
  unwrapKeyblob(key);
  cached = key;
  return { ok: true, keyId: deriveKeyId(key) };
}

export function cachedKey() {
  return cached;
}

export function hasKey() {
  return Boolean(cached);
}

export function forgetKey() {
  cached = null;
}

export function status() {
  const dir = configDir();
  const path = join(dir, KEYBLOB_NAME);
  const out = {
    configDir: dir,
    keyblob: existsSync(path),
    key: hasKey(),
    keyId: null,
    prototype: false
  };
  if (out.keyblob) {
    try { out.keyId = readKeyId(); } catch { /* 结构异常时留空 */ }
  }
  return out;
}

/** 解开一个账号的 token 字段（没有密钥时原样返回，让调用方自己决定）。 */
export function decryptTokenField(value) {
  if (!isEnvelope(value)) return { ok: true, value, encrypted: false };
  if (!cached) return { ok: false, reason: 'key_required', value: null, encrypted: true };
  try {
    return { ok: true, value: decryptField(cached, value), encrypted: true };
  } catch (error) {
    return { ok: false, reason: error.message, value: null, encrypted: true };
  }
}
