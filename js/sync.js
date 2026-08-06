/* Связь с личным сервером: автосинхронизация операций через вебхук
   Monobank и push-уведомления. Сервер видит только операции — токен
   Monobank и остальные данные трекера остаются на устройстве. */

function serverConfigured() {
  return Boolean(state.settings.serverUrl && state.settings.deviceToken);
}

/* Браузер сообщает об отказе CORS так же, как о недоступности сети, —
   обычным сбоем fetch. Отличаем одно от другого запросом в режиме no-cors:
   он не требует разрешения сервера, поэтому проходит, если сервер вообще
   отвечает. Значит, сбой основного запроса — именно из-за CORS. */
async function probeServerReachable(baseUrl) {
  try {
    await fetch(baseUrl.replace(/\/+$/, '') + '/health', { mode: 'no-cors', cache: 'no-store' });
    return true;
  } catch (e) {
    return false;
  }
}

async function serverFetch(path, options = {}) {
  if (!serverConfigured()) throw new Error('Сервер не настроен');
  const base = state.settings.serverUrl.replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(base + path, {
      method: options.method || 'GET',
      headers: {
        'X-Device-Token': state.settings.deviceToken,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: requestTimeout(),
    });
  } catch (e) {
    if (e && e.name === 'TimeoutError') throw new Error('Сервер не ответил за 15 секунд');
    throw new Error('Сервер недоступен. Проверьте адрес и интернет.');
  }
  if (res.status === 401) throw new Error('Сервер не принял токен устройства');
  if (!res.ok) throw new Error('Ошибка сервера (HTTP ' + res.status + ')');
  return res.json();
}

/* ---------- операции ---------- */

const CODE_TO_CURRENCY = { 980: 'UAH', 840: 'USD' };

/**
 * Забирает с сервера операции, пришедшие по вебхуку после прошлой синхронизации.
 * Дубли и вручную удалённые операции не возвращаются.
 */
async function syncOps() {
  const since = state.sync.cursor || 0;
  const data = await serverFetch('/api/ops?since=' + since);
  const known = new Set(state.transactions.map((t) => t.sourceId).filter(Boolean));
  const deleted = new Set(state.monoDeleted || []);

  let added = 0;
  for (const op of data.items || []) {
    if (!op.amount) continue;
    if (known.has(op.monoId) || deleted.has(op.monoId)) continue;
    const currency = CODE_TO_CURRENCY[op.currencyCode];
    if (!currency) continue; // счета в других валютах трекер не ведёт
    state.transactions.push(mapMonoItem({
      id: op.monoId,
      time: Math.floor(op.ts / 1000),
      amount: op.amount,
      mcc: op.mcc,
      description: op.description,
    }, currency));
    known.add(op.monoId);
    added++;
  }

  state.sync.cursor = data.cursor || since;
  state.sync.lastAt = Date.now();
  save();
  return added;
}

/* ---------- напоминания о платежах ---------- */

/**
 * Момент отправки считаем здесь, в часовом поясе телефона, и отдаём серверу
 * готовый timestamp — серверу не нужно ничего знать про часовые пояса.
 * Ключ включает дату платежа: после оплаты появится новый ключ и напоминание
 * сработает снова уже для следующего списания.
 */
function buildReminders() {
  const days = Number(state.settings.remindDays);
  const hour = Number(state.settings.remindHour);
  const horizon = Date.now() + 400 * 86400000; // на год вперёд достаточно

  return activeSubs().map((s) => {
    const fire = parseISO(s.nextDate);
    fire.setDate(fire.getDate() - days);
    fire.setHours(hour, 0, 0, 0);

    const when = days === 0 ? 'сегодня' : (days === 1 ? 'завтра' : `через ${days} дн.`);
    const amount = fmtMoney(s.amount, s.currency);
    const body = isCredit(s)
      ? `${amount} · платёж ${Math.min(s.plan.paid + 1, s.plan.total)} из ${s.plan.total} · ${when}`
      : `${amount} · ${when}`;

    return {
      key: s.id + '@' + s.nextDate,
      title: (isCredit(s) ? 'Платёж по рассрочке: ' : 'Списание: ') + s.name,
      body,
      fireAt: fire.getTime(),
    };
  }).filter((r) => r.fireAt < horizon);
}

async function syncReminders() {
  const reminders = buildReminders();
  await serverFetch('/api/reminders', { method: 'PUT', body: { reminders } });
  return reminders.length;
}

/* ---------- push-уведомления ---------- */

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - base64.length % 4) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function enablePush() {
  if (!pushSupported()) {
    throw new Error('Уведомления доступны только в приложении, добавленном на экран «Домой»');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Разрешение на уведомления не выдано. Включите его в Настройках iOS для этого приложения.');
  }

  const info = await serverFetch('/api/state');
  if (!info.vapidPublicKey) throw new Error('На сервере не заданы VAPID-ключи');

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(info.vapidPublicKey),
    });
  }
  await serverFetch('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  return true;
}

async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await serverFetch('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
    await sub.unsubscribe();
  }
}

async function sendTestPush() {
  return serverFetch('/api/push/test', { method: 'POST', body: {} });
}

async function saveNotifySettings(patch) {
  const data = await serverFetch('/api/settings', { method: 'PUT', body: patch });
  state.sync.notify = data.settings;
  save();
  return data.settings;
}

/* Пошаговая проверка связи: отвечает ли сервер вообще, пускает ли он
   запросы с адреса приложения и принимает ли токен. Возвращает текст,
   по которому сразу видно, что чинить. */
async function diagnoseServer() {
  const base = (state.settings.serverUrl || '').replace(/\/+$/, '');
  const out = ['Адрес приложения:', location.origin, '', 'Сервер:', base || '(не задан)', ''];
  if (!base) return out.join('\n') + 'Сервер не настроен.';

  const reachable = await probeServerReachable(base);
  out.push(reachable ? '✓ Сервер отвечает' : '✗ Сервер не отвечает');
  if (!reachable) {
    out.push('', 'Откройте ' + base + '/health в Safari.',
      'Если и там ошибка — дело в домене, сертификате или контейнере.');
    return out.join('\n');
  }

  try {
    const info = await serverFetch('/api/state');
    out.push('✓ Доступ из приложения есть', '✓ Токен принят');
    out.push('', 'Операций на сервере: ' + info.cursor,
      'Подписок на уведомления: ' + info.subscriptions);
  } catch (e) {
    out.push('✗ ' + e.message);
    if (/недоступен/.test(e.message)) {
      out.push('', 'Сервер отвечает, но не разрешает запросы с адреса приложения.',
        'Впишите в ALLOWED_ORIGINS на сервере:', location.origin,
        'и перезапустите контейнер.');
    } else if (/токен/i.test(e.message)) {
      out.push('', 'Введите заново токен из .env сервера.');
    }
  }
  return out.join('\n');
}

/* Полная синхронизация при открытии приложения: забрать операции,
   обновить расписание напоминаний, освежить состояние сервера. */
async function syncAll() {
  const added = await syncOps();
  const info = await serverFetch('/api/state');
  state.sync.notify = info.settings;
  state.sync.serverInfo = {
    webhookUrl: info.webhookUrl,
    pushConfigured: info.pushConfigured,
    subscriptions: info.subscriptions,
    lastHookAt: info.stats && info.stats.lastHookAt,
    lastPushError: info.stats && info.stats.lastPushError,
  };
  save();
  await syncReminders();
  return added;
}
