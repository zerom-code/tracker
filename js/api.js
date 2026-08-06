/* Курсы валют и Monobank API. Все запросы идут напрямую с устройства. */

const RATE_TTL = 60 * 60 * 1000; // курс считаем свежим 1 час

async function fetchRateOnline() {
  // 1) публичный курс Монобанка (без токена)
  try {
    const res = await fetch('https://api.monobank.ua/bank/currency');
    if (res.ok) {
      const list = await res.json();
      const usd = list.find((r) => r.currencyCodeA === 840 && r.currencyCodeB === 980);
      if (usd) {
        const rate = usd.rateCross || (usd.rateBuy + usd.rateSell) / 2;
        if (rate > 0) return { usdUah: rate, source: 'Monobank' };
      }
    }
  } catch (e) { /* пробуем НБУ */ }

  // 2) официальный курс НБУ
  const res = await fetch('https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&json');
  if (!res.ok) throw new Error('НБУ недоступен');
  const data = await res.json();
  if (!data[0] || !data[0].rate) throw new Error('НБУ вернул пустой ответ');
  return { usdUah: data[0].rate, source: 'НБУ' };
}

async function refreshRate(force) {
  const fresh = Date.now() - state.rate.updatedAt < RATE_TTL;
  if (fresh && !force) return false;
  const { usdUah, source } = await fetchRateOnline();
  state.rate = { usdUah: Math.round(usdUah * 10000) / 10000, updatedAt: Date.now(), source };
  save();
  return true;
}

/* ---------- Monobank personal API ---------- */

const CURRENCY_BY_CODE = { 980: 'UAH', 840: 'USD' };

/* Запрос без таймаута может висеть бесконечно, и кнопка остаётся в «…» */
function requestTimeout(ms = 15000) {
  return (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
    ? AbortSignal.timeout(ms) : undefined;
}

async function monoFetch(path, body) {
  const token = state.settings.monoToken;
  if (!token) throw new Error('Токен Monobank не задан');
  let res;
  try {
    res = await fetch('https://api.monobank.ua' + path, body
      ? {
        method: 'POST',
        headers: { 'X-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: requestTimeout(),
      }
      : { headers: { 'X-Token': token }, signal: requestTimeout() });
  } catch (e) {
    if (e && e.name === 'TimeoutError') throw new Error('Monobank не ответил за 15 секунд, попробуйте ещё раз');
    throw new Error('Не удалось связаться с Monobank. Проверьте интернет и попробуйте ещё раз.');
  }
  if (res.status === 429) throw new Error('Monobank ограничивает частоту запросов: подождите минуту и повторите.');
  if (res.status === 401 || res.status === 403) throw new Error('Monobank не принял токен. Проверьте его на api.monobank.ua и введите заново.');
  if (!res.ok) throw new Error('Ошибка Monobank (HTTP ' + res.status + ')');
  return res.json();
}

async function monoConnect(token) {
  state.settings.monoToken = token.trim();
  const info = await monoFetch('/personal/client-info');
  state.mono = {
    clientName: info.name || '',
    accounts: (info.accounts || []).map((a) => ({
      id: a.id,
      type: a.type || '',
      currency: CURRENCY_BY_CODE[a.currencyCode] || String(a.currencyCode),
      supported: Boolean(CURRENCY_BY_CODE[a.currencyCode]),
      maskedPan: (a.maskedPan && a.maskedPan[0]) || a.iban || a.id,
      balance: typeof a.balance === 'number' ? a.balance / 100 : null,
    })),
  };
  save();
  return state.mono;
}

function monoDisconnect() {
  state.settings.monoToken = '';
  state.mono = { clientName: '', accounts: [] };
  save();
}

/* MCC-коды → категории трекера */
const MCC_CATEGORY = [
  [[5411, 5422, 5441, 5451, 5462, 5499, 5921], 'groceries'],
  [[5811, 5812, 5813, 5814], 'cafe'],
  [[4111, 4112, 4121, 4131, 4789, 5541, 5542, 7511, 7523], 'transport'],
  [[4900, 6513, 5722, 5211, 5251, 5712, 5719], 'home'],
  [[5912, 5122, 8011, 8021, 8041, 8043, 8049, 8062, 8071, 8099], 'health'],
  [[5816, 7832, 7841, 7922, 7929, 7941, 7991, 7994, 7996, 7997, 7999], 'fun'],
  [[5611, 5621, 5631, 5641, 5651, 5661, 5691, 5699, 5941, 5948], 'clothes'],
  [[4814, 4899], 'connection'],
  [[5192, 5942, 8211, 8220, 8241, 8244, 8249, 8299], 'education'],
];

/* Переводы: card-to-card, финансовые операции, снятие наличных */
const TRANSFER_MCC = [4829, 6012, 6011, 6538];

function categoryForMcc(mcc) {
  for (const [codes, cat] of MCC_CATEGORY) {
    if (codes.includes(mcc)) return cat;
  }
  return FALLBACK_CATEGORY;
}

/* Операция Monobank → операция трекера. Одна и та же логика нужна и при
   ручном импорте выписки, и при автосинхронизации через вебхук. */
function mapMonoItem(item, currency) {
  const isIncome = item.amount > 0;
  const isTransfer = !isIncome && TRANSFER_MCC.includes(item.mcc);
  const type = isIncome ? 'income' : (isTransfer ? 'transfer' : 'expense');
  const when = new Date((item.time || Math.floor(Date.now() / 1000)) * 1000);
  return {
    id: uid(),
    ts: when.getTime(),
    type,
    amount: Math.abs(item.amount) / 100,
    currency,
    categoryId: type === 'transfer' ? null : (isIncome ? FALLBACK_CATEGORY : categoryForMcc(item.mcc)),
    description: (item.description || '').replace(/\n/g, ' · '),
    date: toISO(when),
    source: 'mono',
    sourceId: item.id,
  };
}

/* Регистрирует адрес вебхука в Monobank. Запрос уходит с телефона —
   токен остаётся на устройстве и на сервер не попадает. */
async function monoSetWebhook(url) {
  try {
    await monoFetch('/personal/webhook', { webHookUrl: url });
  } catch (e) {
    // банк проверяет адрес запросом и, не получив 200, отвечает 400
    if (url && /HTTP 400/.test(e.message)) {
      throw new Error('Monobank не принял адрес: банк должен получить ответ 200 по ' +
        url + ' — проверьте, что сервер доступен извне и адрес актуален.');
    }
    throw e;
  }
  return true;
}

/**
 * Импорт выписки за период [fromSec, toSec] (unix-секунды).
 * Monobank отдаёт максимум 31 день + 1 час за один запрос.
 * Списания становятся расходами/переводами, поступления — доходами.
 * Дубликаты отсекаем по id операции.
 */
async function monoImport(accountId, fromSec, toSec) {
  const account = state.mono.accounts.find((a) => a.id === accountId);
  if (!account) throw new Error('Счёт не найден — переподключите Monobank');
  if (!account.supported) throw new Error('Поддерживаются только счета в гривне и долларах');

  const items = await monoFetch('/personal/statement/' + accountId + '/' + fromSec + '/' + toSec);

  const known = new Set(state.transactions.map((t) => t.sourceId).filter(Boolean));
  const deleted = new Set(state.monoDeleted || []);
  const addedDates = [];
  let added = 0, incomes = 0, duplicates = 0;

  for (const it of items) {
    if (!it.amount) continue;
    if (known.has(it.id) || deleted.has(it.id)) { duplicates++; continue; }
    const tx = mapMonoItem(it, account.currency);
    addedDates.push(tx.date);
    state.transactions.push(tx);
    added++;
    if (tx.type === 'income') incomes++;
  }

  if (added) save();
  return { added, incomes, duplicates, addedDates };
}
