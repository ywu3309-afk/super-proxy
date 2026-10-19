// 账号池加密备份：用口令派生密钥（scrypt）+ AES-256-GCM 封装
// 与 SecretBox 的区别：那个绑本机 .key，换电脑解不开；这个是「口令即密钥」，可以拷到别的机器导入。
// 思路同 WorkDaddy 的账号导出（随机 salt + AES-256-GCM，口令不写进文件）。
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KDF = 'scrypt';
// scrypt 参数：N=2^15 在普通机器上约 100ms，足够挡住离线暴力
const PARAMS = { N: 32768, r: 8, p: 1, keyLen: 32 };
export const VAULT_VERSION = 1;
export const VAULT_MARKER = 'workbuddy-gateway-vault';

function derive(password, salt) {
  return scryptSync(String(password).normalize('NFKC'), salt, PARAMS.keyLen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: 128 * PARAMS.N * PARAMS.r * 2
  });
}

export function isVault(value) {
  if (!value || typeof value !== 'object') return false;
  return value.marker === VAULT_MARKER && typeof value.data === 'string' && value.kdf === KDF;
}

export function seal(payload, password) {
  if (!password || String(password).length < 6) throw new Error('password_too_short');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = derive(password, salt);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    marker: VAULT_MARKER,
    v: VAULT_VERSION,
    kdf: KDF,
    kdfParams: { N: PARAMS.N, r: PARAMS.r, p: PARAMS.p },
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
    createdAt: new Date().toISOString()
  };
}

export function open(blob, password) {
  if (!isVault(blob)) return null;
  try {
    const salt = Buffer.from(blob.salt, 'base64');
    const key = derive(password, salt);
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    const output = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]);
    return JSON.parse(output.toString('utf8'));
  } catch {
    // 口令错 / 文件被改都会落到这里（GCM 校验失败）
    return null;
  }
}
