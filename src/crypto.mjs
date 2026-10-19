import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ALGORITHM = 'aes-256-gcm';

export class SecretBox {
  constructor(dataDir) {
    this.keyFile = join(dataDir, '.key');
    this.key = null;
  }

  async ensureKey() {
    if (this.key) return this.key;
    await mkdir(dirname(this.keyFile), { recursive: true });
    let raw = null;
    try {
      raw = await readFile(this.keyFile);
    } catch {
      raw = null;
    }
    if (!raw || raw.length !== 32) {
      raw = randomBytes(32);
      await writeFile(this.keyFile, raw, { mode: 0o600 });
      try {
        await chmod(this.keyFile, 0o600);
      } catch {
        /* Windows 上 chmod 语义有限，忽略 */
      }
    }
    this.key = raw;
    return this.key;
  }

  async encrypt(plaintext) {
    const key = await this.ensureKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return {
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64')
    };
  }

  async decrypt(payload) {
    if (!payload || payload.v !== 1) return null;
    const key = await this.ensureKey();
    try {
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
      const output = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]);
      return output.toString('utf8');
    } catch {
      return null;
    }
  }
}
