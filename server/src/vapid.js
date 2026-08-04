/* Генерация ключей и секретов — на встроенном crypto, без зависимостей.
   Запуск:  npm run vapid     — ключи Web Push
            npm run secrets   — токен устройства и секрет вебхука   */

import crypto from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** Пара ключей VAPID: публичный — несжатая точка P-256 (65 байт), приватный — скаляр (32 байта) */
export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-65);
  const jwk = privateKey.export({ format: 'jwk' });
  return {
    publicKey: b64url(pubRaw),
    privateKey: jwk.d, // уже в base64url
  };
}

export function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

if (process.argv[1] && process.argv[1].endsWith('vapid.js')) {
  if (process.argv.includes('--secrets')) {
    console.log('DEVICE_TOKEN=' + randomSecret(32));
    console.log('WEBHOOK_SECRET=' + randomSecret(24));
  } else {
    const { publicKey, privateKey } = generateVapidKeys();
    console.log('VAPID_PUBLIC=' + publicKey);
    console.log('VAPID_PRIVATE=' + privateKey);
  }
}
