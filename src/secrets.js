import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const FORMAT = 1;

function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, 32);
}

// Encrypted file for the credentials saved in the admin view (AES-256-GCM, key derived from
// SECRETS_KEY with scrypt). The key is never stored; without it the file cannot be read.
// Pass file: null for an in-memory store (tests).
export async function createSecretStore({ file = null, key }) {
  if (!key) throw new Error('SECRETS_KEY puuttuu.');
  let salt = randomBytes(16);
  let entries = {};

  if (file) {
    let raw = null;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (raw) {
      salt = Buffer.from(raw.salt, 'base64');
      try {
        const decipher = createDecipheriv('aes-256-gcm', deriveKey(key, salt), Buffer.from(raw.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(raw.tag, 'base64'));
        const plain = Buffer.concat([decipher.update(Buffer.from(raw.data, 'base64')), decipher.final()]);
        entries = JSON.parse(plain.toString('utf8'));
      } catch {
        throw new Error('Tunnusten tiedostoa ei voi avata: SECRETS_KEY on väärä tai tiedosto on vioittunut.');
      }
    }
  }

  let queue = Promise.resolve();

  function save() {
    if (!file) return Promise.resolve();
    // A fresh IV for every write; the key and salt stay the same.
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', deriveKey(key, salt), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(entries), 'utf8'), cipher.final()]);
    const body = JSON.stringify({
      v: FORMAT,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    });
    const write = queue.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, body, { mode: 0o600 });
      await rename(tmp, file);
      await chmod(file, 0o600);
    });
    queue = write.catch(() => {});
    return write;
  }

  // An entry is { fields, note, savedAt, meta }: fields are secret, the rest is display data.
  return {
    get: (name) => entries[name] ?? null,
    async set(name, { fields, note = '', meta = {} }, savedAt = new Date().toISOString()) {
      entries[name] = { fields, note, meta, savedAt };
      await save();
    },
    async remove(name) {
      delete entries[name];
      await save();
    },
  };
}
