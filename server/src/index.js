/* Приёмник вебхуков Monobank + выдача операций приложению + push-уведомления.
   Слушает только внутри контейнера, наружу его выставляет Caddy по HTTPS. */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, webhookPath, webhookUrl } from './config.js';
import { Store } from './store.js';
import { buildOpNotification, shouldNotify } from './notify.js';
import { sendPush, pushConfigured } from './push.js';

const store = new Store(config.dataDir);

/* ---------- вспомогательное ---------- */

const MAX_BODY = 256 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('слишком большое тело запроса')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, data, origin) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...corsHeaders(origin),
  });
  res.end(body);
}

function corsHeaders(origin) {
  if (!origin || !config.allowedOrigins.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, X-Device-Token',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

/* Сравнение токенов постоянное по времени, чтобы его нельзя было подобрать по таймингу */
function tokenOk(given) {
  if (!given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(config.deviceToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* Простое ограничение частоты: защита от перебора токена */
const hits = new Map();
function rateLimited(ip, limit = 120, windowMs = 60_000) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > windowMs) { hits.set(ip, { start: now, n: 1 }); return false; }
  rec.n++;
  return rec.n > limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of hits) if (now - rec.start > 300_000) hits.delete(ip);
}, 300_000).unref();

/* ---------- обработка вебхука Monobank ---------- */

/**
 * Monobank шлёт {type:"StatementItem", data:{account, statementItem}}.
 * Ответить нужно строго 200 и быстро (таймаут 5 секунд), иначе банк
 * повторит через 60 и 600 секунд, а после третьей неудачи отключит вебхук.
 * Поэтому push отправляем уже после ответа.
 */
function handleWebhookPayload(raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch { return null; }
  if (!payload || payload.type !== 'StatementItem') return null;
  const data = payload.data || {};
  const item = data.statementItem || {};
  if (!item.id || typeof item.amount !== 'number') return null;

  return store.addOp({
    monoId: item.id,
    account: data.account || '',
    ts: (item.time || Math.floor(Date.now() / 1000)) * 1000,
    amount: item.amount,
    // сумма в валюте операции по курсу банка — нужна для показа эквивалента
    // и сверки с долгами; amount всегда в валюте счёта
    operationAmount: typeof item.operationAmount === 'number' ? item.operationAmount : null,
    currencyCode: item.currencyCode || 980,
    mcc: item.mcc || 0,
    description: (item.description || '').replace(/\s*\n\s*/g, ' · ').slice(0, 200),
    balance: typeof item.balance === 'number' ? item.balance : null,
    receivedAt: Date.now(),
  });
}

/* ---------- маршруты ---------- */

async function route(req, res, url, origin) {
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }

  if (path === '/health') return json(res, 200, { ok: true }, origin);

  // Проверочный GET от Monobank при регистрации вебхука
  if (path === webhookPath && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (path === webhookPath && req.method === 'POST') {
    const raw = await readBody(req);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok'); // отвечаем сразу, дальше работаем в фоне

    const op = handleWebhookPayload(raw);
    if (!op) return;
    console.log(`[hook] ${op.description} ${op.amount / 100}`);
    if (pushConfigured() && shouldNotify(op, store.settings)) {
      sendPush(store, buildOpNotification(op, store.accounts))
        .catch((e) => console.error('[push]', e.message));
    }
    return;
  }

  /* ---- дальше только для приложения, по токену устройства ---- */
  if (!path.startsWith('/api/')) return json(res, 404, { error: 'not found' }, origin);
  if (!tokenOk(req.headers['x-device-token'])) return json(res, 401, { error: 'неверный токен устройства' }, origin);

  if (path === '/api/state' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      webhookUrl,
      vapidPublicKey: config.vapidPublic,
      pushConfigured: pushConfigured(),
      subscriptions: store.subscriptions.length,
      settings: store.settings,
      cursor: store.data.seq,
      reminders: store.data.reminders.length,
      stats: store.stats,
    }, origin);
  }

  if (path === '/api/ops' && req.method === 'GET') {
    const since = Number(url.searchParams.get('since') || 0);
    const items = store.opsSince(since);
    return json(res, 200, { items, cursor: store.data.seq }, origin);
  }

  if (path === '/api/settings' && req.method === 'PUT') {
    const patch = JSON.parse(await readBody(req) || '{}');
    return json(res, 200, { settings: store.updateSettings(patch) }, origin);
  }

  if (path === '/api/push/subscribe' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    try {
      const count = store.addSubscription(body.subscription);
      return json(res, 200, { ok: true, subscriptions: count }, origin);
    } catch (e) {
      return json(res, 400, { error: e.message }, origin);
    }
  }

  if (path === '/api/push/unsubscribe' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    store.removeSubscription(body.endpoint);
    return json(res, 200, { ok: true, subscriptions: store.subscriptions.length }, origin);
  }

  if (path === '/api/push/test' && req.method === 'POST') {
    const result = await sendPush(store, {
      title: 'Трекер трат',
      body: 'Уведомления работают 🎉',
      tag: 'test',
      url: '',
    });
    return json(res, result.error && !result.sent ? 502 : 200, result, origin);
  }

  if (path === '/api/reminders' && req.method === 'PUT') {
    const body = JSON.parse(await readBody(req) || '{}');
    const count = store.replaceReminders(Array.isArray(body.reminders) ? body.reminders : []);
    store.setAccounts(body.accounts); // заодно освежаем карту «счёт → валюта»
    return json(res, 200, { ok: true, reminders: count }, origin);
  }

  if (path === '/api/receipt' && req.method === 'GET') {
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) return json(res, 400, { error: 'url required' }, origin);
    try {
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
          'Accept': 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(8000),
      });
      const text = await response.text();
      return json(res, 200, { success: true, text }, origin);
    } catch (e) {
      return json(res, 200, { success: false, error: e.message }, origin);
    }
  }

  return json(res, 404, { error: 'not found' }, origin);
}

/* ---------- напоминания о платежах ---------- */

/* Приложение присылает уже вычисленный момент отправки в UTC,
   поэтому здесь достаточно раз в минуту проверять, кому пора. */
async function tickReminders() {
  if (!store.settings.reminders || !pushConfigured()) return;
  for (const r of store.dueReminders()) {
    const result = await sendPush(store, {
      title: r.title, body: r.body, tag: 'rem-' + r.key, url: '#subs',
    });
    if (result.sent) {
      store.markReminderSent(r.key);
      console.log(`[reminder] отправлено: ${r.title}`);
    } else {
      break; // нет подписок или push не настроен — попробуем в следующий раз
    }
  }
}
setInterval(() => { tickReminders().catch((e) => console.error('[reminder]', e.message)); }, 60_000).unref();

/* ---------- запуск ---------- */

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  const ip = req.socket.remoteAddress || '?';
  if (rateLimited(ip)) return json(res, 429, { error: 'слишком много запросов' }, origin);

  const url = new URL(req.url, 'http://localhost');
  route(req, res, url, origin).catch((e) => {
    console.error('[error]', req.method, url.pathname, e.message);
    // сервис личный и за токеном — показываем причину, иначе такую ошибку
    // не отладить, глядя только на телефон
    if (!res.headersSent) json(res, 500, { error: e.message }, origin);
  });
});

/* Каталог данных проверяем на запись сразу: иначе первая же запись падает
   с невнятной 500 уже после того, как чтение отработало нормально. */
function checkDataWritable() {
  try {
    const probe = path.join(config.dataDir, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    console.error(`[start] ВНИМАНИЕ: в ${config.dataDir} нельзя писать (${e.code || e.message}).`);
    console.error('[start] Чтение будет работать, но настройки и напоминания не сохранятся.');
    console.error('[start] Обычно это права на каталог: используйте именованный том');
    console.error('[start] (см. docker-compose.yml) или выполните на хосте: chown -R 1000:1000 <каталог>');
    return false;
  }
}

server.listen(config.port, config.host, () => {
  console.log(`[start] трекер-сервис слушает ${config.host}:${config.port}`);
  console.log(`[start] адрес вебхука: ${webhookUrl}`);
  console.log(`[start] push ${pushConfigured() ? 'настроен' : 'НЕ настроен (нет VAPID-ключей)'}`);
  console.log(`[start] каталог данных ${config.dataDir}: ${checkDataWritable() ? 'доступен для записи' : 'ТОЛЬКО ЧТЕНИЕ'}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { console.log('[stop] завершаемся'); server.close(() => process.exit(0)); });
}
