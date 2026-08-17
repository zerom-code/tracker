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

  if (path === '/api/receipt' && req.method === 'GET') {
    const rawUrl = url.searchParams.get('url') || '';
    const fn = url.searchParams.get('fn') || '';
    const id = url.searchParams.get('id') || '';
    const date = url.searchParams.get('date') || '';
    const time = url.searchParams.get('time') || '';
    const sm = url.searchParams.get('sm') || '';

    try {
      let targetFn = fn;
      let targetId = id;
      let targetDate = date;
      let targetTime = time;
      let targetSm = sm;

      if (rawUrl && (!targetFn || !targetId)) {
        try {
          const parsedUrl = new URL(rawUrl);
          targetFn = targetFn || parsedUrl.searchParams.get('fn') || '';
          targetId = targetId || parsedUrl.searchParams.get('id') || '';
          const d = parsedUrl.searchParams.get('date') || '';
          if (d.length === 8) {
            targetDate = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
          }
          const t = parsedUrl.searchParams.get('time') || '';
          if (t.length === 6) {
            targetTime = `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
          }
          targetSm = targetSm || parsedUrl.searchParams.get('sm') || '';
        } catch (e) {}
      }

      if (targetFn && targetId) {
        let cleanId = String(targetId).trim();
        let cleanTime = String(targetTime || '').trim();
        if (cleanTime.length === 4) {
          cleanTime = `${cleanTime.slice(0, 2)}:${cleanTime.slice(2, 4)}:00`;
        } else if (cleanTime.length === 5) {
          cleanTime = `${cleanTime}:00`;
        } else if (cleanTime.length === 6 && !cleanTime.includes(':')) {
          cleanTime = `${cleanTime.slice(0, 2)}:${cleanTime.slice(2, 4)}:${cleanTime.slice(4, 6)}`;
        }

        const idNoZeros = cleanId.replace(/^0+/, '');
        const idPadded = cleanId.padStart(7, '0');
        const idList = [...new Set([cleanId, idNoZeros, idPadded].filter(Boolean))];

        const dateWithTime = targetDate ? `${targetDate} ${cleanTime || '00:00:00'}`.trim() : '';
        const dateOnly = targetDate;
        const dateList = [...new Set([dateWithTime, dateOnly].filter(Boolean))];

        let decoded = null;
        for (const currentId of idList) {
          if (decoded) break;
          for (const currentDate of dateList) {
            const dpsApiUrl = `https://cabinet.tax.gov.ua/ws/api_public/rro/chkAllWeb?id=${encodeURIComponent(currentId)}&date=${encodeURIComponent(currentDate)}&type=1&captcha=&fn=${encodeURIComponent(targetFn)}&sm=${encodeURIComponent(targetSm || '')}`;
            try {
              const dpsRes = await fetch(dpsApiUrl, {
                headers: { 'Accept': 'application/json, text/plain, */*' }
              });
              if (dpsRes.ok) {
                const data = await dpsRes.json();
                if (data && data.check) {
                  decoded = Buffer.from(data.check, 'base64').toString('utf8');
                  break;
                }
              }
            } catch (e) {}
          }
        }
        
        if (decoded) {
            function cleanProductName(name) {
              if (!name || typeof name !== 'string') return '';
              let cleaned = name.trim().replace(/\s+/g, ' ');
              cleaned = cleaned.replace(/([A-ZА-ЯІЇЄҐ])([A-ZА-ЯІЇЄҐ][a-zа-яіїєґ])/g, '$1 $2');
              cleaned = cleaned.replace(/([a-zа-яіїєґ0-9])([A-ZА-ЯІЇЄҐ])/g, '$1 $2');
              return cleaned.replace(/\s+/g, ' ').trim();
            }

            function normalizeBrandName(storeName, companyName = '') {
              const combined = (storeName + ' ' + companyName).trim();
              if (/varus|варус/i.test(combined)) return 'VARUS';
              if (/атб|atb/i.test(combined)) return 'АТБ';
              if (/сільпо|сильпо|silpo/i.test(combined)) return 'Сільпо';
              if (/novus|новус/i.test(combined)) return 'Novus';
              if (/фора|fora/i.test(combined)) return 'Фора';
              if (/sinsay|синсей/i.test(combined)) return 'SINSAY';
              if (/епіцентр|эпицентр|epicentr/i.test(combined)) return 'Епіцентр';
              if (/eva|єва|prostor|простор/i.test(combined)) return 'EVA';
              if (/ашан|auchan/i.test(combined)) return 'Ашан';
              if (/metro|метро/i.test(combined)) return 'METRO';
              if (/вигідна покупка|аврора|avrora/i.test(combined)) return 'Аврора';
              if (/jysk|юск/i.test(combined)) return 'JYSK';
              if (/mcdonald|макдоналд/i.test(combined)) return 'McDonald’s';
              if (/kfc|кфс/i.test(combined)) return 'KFC';
              if (/wog|вого/i.test(combined)) return 'WOG';
              if (/okko|окко/i.test(combined)) return 'OKKO';
              if (/upg|упг/i.test(combined)) return 'UPG';
              if (/socar|сокар/i.test(combined)) return 'SOCAR';

              if (/^продукти(?:-\d+)?$/i.test(storeName) && /атб/i.test(companyName)) {
                return 'АТБ';
              }

              let clean = storeName || companyName || '';
              clean = clean.replace(/(?:-\d+|\s+№\s*\d+|\s+\d+)$/, '').trim();
              return clean;
            }

            function extractUniversalStoreName(rawLines) {
              let company = '';
              let shop = '';

              for (let i = 0; i < Math.min(rawLines.length, 12); i++) {
                const line = rawLines[i].trim();
                if (!line || line.startsWith('-') || line.startsWith('=')) break;
                if (line.includes('Касовий чек') || line.includes('РРО ФН') || line.includes('ПРРО ФН')) break;

                const shopMatch = line.match(/(?:МАГАЗИН|СУПЕРМАРКЕТ|МАРКЕТ|ТОРГОВА ТОЧКА|АПТЕКА|АЗС|КАФЕ|РЕСТОРАН|ВІДДІЛЕННЯ)\s*(.+)?/i);
                if (shopMatch && !shop) {
                  let raw = (shopMatch[1] || '').trim();
                  if (raw) {
                    raw = raw.replace(/(?:\s+|^)(?:ТЦ|ТРЦ|ТОЦ|ТРК|ТК|№|\d+)[^а-яa-z].*$/i, '').trim();
                    raw = raw.replace(/["'«»]/g, '').trim();
                    if (raw) shop = raw;
                  }
                }

                const compMatch = line.match(/(?:ТОВ|ДП|ПП|АТ|ПРАТ|ПАТ|ВАТ|ФОП)\s+["'«]?([^"'»\n]+)["'»]?/i);
                if (compMatch && !company) {
                  company = compMatch[1].trim().replace(/["'«»]/g, '').trim();
                }
              }

              return normalizeBrandName(shop, company);
            }

            const items = [];
            const lines = decoded.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            const storeName = extractUniversalStoreName(lines);
            let currentItem = null;

            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];

              // Конец товарной части чека (итоги)
              if (line.match(/^(?:СУМА ДО СПЛАТИ|СУМА|ВСЬОГО|ИТОГО|РАЗОМ|ГОТІВКА|БЕЗГОТІВКА|КАРТКА|ПДВ|ДИСКОНТ|Скидка|ЧЕК:|Контрольне число|ФІСКАЛЬНИЙ ЧЕК)/i)) {
                if (currentItem) {
                  items.push(currentItem);
                  currentItem = null;
                }
                if (line.match(/^(?:СУМА ДО СПЛАТИ|СУМА|ВСЬОГО|ИТОГО|РАЗОМ|ГОТІВКА)/i)) {
                  break;
                }
              }

              // 1. Поиск строки расчёта с любыми единицами измерения: "1.000 шт x 12.00 = 12.00 А"
              const calcMatch = line.match(/^(\d+[.,]?\d*)\s*(?:[а-яіїєґa-z./]+)?\s*[xх*×]\s*(\d+[.,]?\d*)\s*=\s*(\d+[.,]?\d*)/i)
                || line.match(/^(\d+[.,]?\d*)\s*(?:[а-яіїєґa-z./]+)?\s*[xх*×]\s*(\d+[.,]?\d*)/i);

              if (calcMatch && currentItem) {
                currentItem.quantity = parseFloat(calcMatch[1].replace(',', '.'));
                currentItem.price = parseFloat(calcMatch[2].replace(',', '.'));
                currentItem.total = calcMatch[3] ? parseFloat(calcMatch[3].replace(',', '.')) : (currentItem.quantity * currentItem.price);
                items.push(currentItem);
                currentItem = null;
                continue;
              }

              // 2. Строка с ценой/суммой: "= 12.00" или "12.00 А"
              const singlePriceMatch = line.match(/=\s*(\d+[.,]\d{2})\s*[а-яa-z]?$/i) || line.match(/^(\d+[.,]\d{2})\s*[А-ЯA-Z]$/);
              if (singlePriceMatch && currentItem) {
                currentItem.total = parseFloat(singlePriceMatch[1].replace(',', '.'));
                if (!currentItem.price) currentItem.price = currentItem.total;
                items.push(currentItem);
                currentItem = null;
                continue;
              }

              // 3. Начало новой позиции
              const artMatch = line.match(/^АРТ\.?\s*№?\s*\d*\s+(.+)$/i) || line.match(/^\d+\.\s+(.+)$/i);
              if (artMatch) {
                if (currentItem) items.push(currentItem);
                currentItem = {
                  name: cleanProductName(artMatch[1]),
                  quantity: 1,
                  price: 0,
                  total: 0,
                };
                continue;
              }

              // 4. Дополнение многострочного названия товара
              if (currentItem && !line.match(/^(?:Дисконт|Знижка|Штрих|ПДВ|Код)/i) && !line.startsWith('-') && !line.startsWith('=')) {
                currentItem.name = cleanProductName(currentItem.name + ' ' + line);
              }
            }

            if (currentItem) items.push(currentItem);

            return json(res, 200, {
              success: true,
              storeName: storeName || '',
              items,
              rawText: decoded
            }, origin);
          }
        }
      }
      return json(res, 200, { success: false, error: 'Чек не найден в ДПС' }, origin);
    } catch (err) {
      console.error('[receipt] error:', err.message);
      return json(res, 500, { success: false, error: err.message }, origin);
    }
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
