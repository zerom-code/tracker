/* Отправка Web Push. Библиотека подключается лениво: без неё остальной
   сервис (вебхук, выдача операций) продолжает работать и его можно
   запустить и протестировать без npm install. */

import { config } from './config.js';

let webpush = null;
let loadError = '';

async function getWebPush() {
  if (webpush) return webpush;
  if (loadError) throw new Error(loadError);
  try {
    const mod = await import('web-push');
    webpush = mod.default || mod;
  } catch (e) {
    loadError = 'Модуль web-push не установлен — выполните npm install в каталоге server';
    throw new Error(loadError);
  }
  if (!config.vapidPublic || !config.vapidPrivate) {
    loadError = 'Не заданы VAPID_PUBLIC/VAPID_PRIVATE — сгенерируйте их командой npm run vapid';
    throw new Error(loadError);
  }
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublic, config.vapidPrivate);
  return webpush;
}

export function pushConfigured() {
  return Boolean(config.vapidPublic && config.vapidPrivate);
}

/**
 * Рассылает уведомление на все подписки устройства.
 * Подписки, которые push-сервис пометил мёртвыми (404/410), удаляются.
 */
export async function sendPush(store, payload) {
  const subs = store.subscriptions;
  if (!subs.length) return { sent: 0, removed: 0, error: 'нет подписок на уведомления' };

  let wp;
  try {
    wp = await getWebPush();
  } catch (e) {
    store.notePush(e.message);
    return { sent: 0, removed: 0, error: e.message };
  }

  const body = JSON.stringify(payload);
  let sent = 0, removed = 0, lastError = '';

  for (const sub of [...subs]) {
    try {
      await wp.sendNotification(sub, body, { TTL: 3600, urgency: 'high' });
      sent++;
    } catch (e) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410) {
        store.removeSubscription(sub.endpoint); // устройство отписалось
        removed++;
      } else {
        lastError = `HTTP ${code || '?'}: ${(e && e.message) || e}`;
      }
    }
  }

  store.notePush(lastError);
  return { sent, removed, error: lastError };
}
