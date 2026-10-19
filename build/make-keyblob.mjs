import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as at from 'file:///D:/Codex/workbuddy-credit-simulator/src/atrest.mjs';

const dir = mkdtempSync(join(tmpdir(), 'wb-keyblob-'));
mkdirSync(join(dir, '.workbuddy'), { recursive: true });

const secret = Buffer.from('interop-test-secret-32-bytes!!!!').toString('base64');
const key = createHash('sha256').update(secret, 'ascii').digest();
const master = randomBytes(32);

const blob = {
  version: 1,
  keyId: at.deriveKeyId(master),
  slots: [{
    type: 'static-v1',
    protectorKeyId: at.deriveKeyId(key),
    wrapped: at.seal(key, master, 'file')
  }]
};
writeFileSync(join(dir, '.workbuddy', 'keyblob'), JSON.stringify(blob));

console.log(JSON.stringify({ dir, secret, base64len: secret.length }, null, 1));

// 本机 JS 侧自洽
process.env.WORKBUDDY_CONFIG_DIR = join(dir, '.workbuddy');
const status = at.status();
console.log('js status', JSON.stringify(status));
at.adoptKey(secret);
console.log('js adopt ok', JSON.stringify(at.status()));
