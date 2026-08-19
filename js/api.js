/* Курсы валют и Monobank API. Все запросы идут напрямую с устройства. */

const RATE_TTL = 60 * 60 * 1000; // курс считаем свежим 1 час

async function fetchRateOnline(force) {
  // Запрос курса ТОЛЬКО из Monobank (публичный API)
  try {
    const res = await fetch('https://api.monobank.ua/bank/currency');
    if (res.ok) {
      const list = await res.json();
      const usd = list.find((r) => r.currencyCodeA === 840 && r.currencyCodeB === 980);
      if (usd) {
        // Курс Monobank: rateSell (курс продажи доллара клиенту) или rateCross / средний
        const rate = usd.rateSell || usd.rateCross || (usd.rateBuy && usd.rateSell ? (usd.rateBuy + usd.rateSell) / 2 : usd.rateBuy);
        if (rate > 0) return { usdUah: rate, source: 'Monobank' };
      }
    }
  } catch (e) { /* сеть или лимит 1 запрос в минуту */ }

  // Если запрос не прошел или Monobank вернул 429 (лимит запросов) — берем сохраненный курс Monobank
  if (state.rate && state.rate.usdUah > 0) {
    return { usdUah: state.rate.usdUah, source: 'Monobank' };
  }

  return { usdUah: 44.85, source: 'Monobank' };
}

async function refreshRate(force) {
  const fresh = Date.now() - (state.rate.updatedAt || 0) < RATE_TTL;
  if (fresh && !force) return false;
  const { usdUah, source } = await fetchRateOnline(force);
  state.rate = { usdUah: Math.round(usdUah * 10000) / 10000, updatedAt: Date.now(), source: 'Monobank' };
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
/* operationAmount — сумма в валюте операции по курсу банка на момент
   перевода: для «−$39.22 с долларовой» это ровно 1 750,00 ₴ */
function monoAltOf(item, accountCurrency) {
  const altCurrency = CURRENCY_BY_CODE[item.currencyCode];
  if (!item.operationAmount || !altCurrency || altCurrency === accountCurrency) return null;
  return { amount: Math.abs(item.operationAmount) / 100, currency: altCurrency };
}

function isCreditPayment(desc) {
  return /погашен|розстрочк|рассрочк|частинами|кредит/i.test(String(desc || ''));
}

function mapMonoItem(item, currency, accountId) {
  const isIncome = item.amount > 0;
  const desc = (item.description || '').replace(/\n/g, ' · ');
  const isCredit = !isIncome && isCreditPayment(desc);
  const isTransfer = !isIncome && !isCredit && TRANSFER_MCC.includes(item.mcc);
  const type = isIncome ? 'income' : (isTransfer ? 'transfer' : 'expense');
  const when = new Date((item.time || Math.floor(Date.now() / 1000)) * 1000);
  let txCurrency = currency || 'UAH';
  let txAmount = Math.abs(item.amount) / 100;
  let alt = monoAltOf(item, txCurrency);

  // Если операция совершена в гривнах (currencyCode 980), но валюта карты ошибочно передана как USD
  if (item.currencyCode === 980 && txCurrency === 'USD' && item.operationAmount && Math.abs(item.operationAmount) === Math.abs(item.amount)) {
    txCurrency = 'UAH';
    alt = null;
  }

  return {
    altAmount: alt ? alt.amount : null,
    altCurrency: alt ? alt.currency : null,
    id: uid(),
    ts: when.getTime(),
    type,
    amount: txAmount,
    currency: txCurrency,
    categoryId: isCredit ? 'credit' : (type === 'transfer' ? null : (isIncome ? FALLBACK_CATEGORY : categoryForMcc(item.mcc))),
    description: desc,
    date: toISO(when),
    source: 'mono',
    sourceId: item.id,
    accountId: accountId || null,
    internal: false,
  };
}

/**
 * Ищет пары «перевод между своими картами»: списание и зачисление, близкие
 * по времени, на одинаковую сумму (для разных валют — эквивалентную по курсу).
 * Помеченные пары остаются в списке, но не попадают в итоги — иначе перевод
 * себе раздувает и расходы, и доходы, хотя в сумме это ноль.
 */
function pairInternalTransfers() {
  const WINDOW = 3 * 60 * 1000;
  const TOLERANCE = 0.08;
  const candidates = state.transactions.filter((t) => t.source === 'mono' && !t.internal);
  const outs = candidates.filter((t) => t.type === 'transfer');
  const ins = candidates.filter((t) => t.type === 'income');
  let linked = 0;

  for (const out of outs) {
    for (const inn of ins) {
      if (inn.internal) continue;
      if (out.accountId && inn.accountId && out.accountId === inn.accountId) continue;
      if (Math.abs((out.ts || 0) - (inn.ts || 0)) > WINDOW) continue;

      let match = false;
      if (out.currency === inn.currency) {
        match = Math.abs(out.amount - inn.amount) < 0.01;
      } else if (effectiveRate()) {
        const converted = convert(out.amount, out.currency, inn.currency);
        match = Math.abs(converted - inn.amount) / inn.amount < TOLERANCE;
      }
      if (match) {
        out.internal = true;
        inn.internal = true;
        linked++;
        break;
      }
    }
  }

  if (linked) save();
  return linked;
}

/* ---------- автопогашение долгов ---------- */

/**
 * Ищет свежие операции Monobank, совпадающие по сумме с остатком открытого
 * долга: исходящий перевод — с «я должен», поступление — с «мне должны».
 * Сравнение идёт в валюте долга: напрямую, через сумму конвертации банка
 * (altAmount) или по текущему курсу с допуском 3%.
 */
function collectDebtSuggestions() {
  const seen = new Set(state.debtSuggestSeen || []);
  const cutoff = Date.now() - 14 * 86400000;
  const matches = [];

  for (const t of state.transactions) {
    if (t.source !== 'mono' || t.internal || !t.sourceId || seen.has(t.sourceId)) continue;
    if ((t.ts || 0) < cutoff) continue;
    const direction = t.type === 'transfer' ? 'i-owe' : (t.type === 'income' ? 'owe-me' : null);
    if (!direction) continue;

    for (const debt of activeDebts(direction)) {
      const remaining = debtRemaining(debt);
      if (remaining > 0 && txMatchesDebtAmount(t, debt, remaining)) {
        matches.push({ tx: t, debt, amount: remaining });
        break;
      }
    }
  }
  return matches;
}

function txMatchesDebtAmount(t, debt, remaining) {
  const close = (a, b) => Math.abs(a - b) < 0.005;
  if (t.currency === debt.currency) return close(t.amount, remaining);
  if (t.altCurrency === debt.currency && t.altAmount != null) return close(t.altAmount, remaining);
  if (!effectiveRate()) return false;
  const converted = convert(t.amount, t.currency, debt.currency);
  return Math.abs(converted - remaining) / remaining < 0.03;
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
  const tombstoned = []; // удалены вручную — вернём только с согласия
  let added = 0, incomes = 0, duplicates = 0, backfilled = 0;

  for (const it of items) {
    if (!it.amount) continue;
    if (deleted.has(it.id)) { tombstoned.push(it); continue; }
    if (known.has(it.id)) {
      duplicates++;
      // операции, загруженные до появления эквивалента, дозаполняем
      const existing = state.transactions.find((t) => t.sourceId === it.id);
      const alt = existing && existing.altAmount == null && monoAltOf(it, account.currency);
      if (alt) {
        existing.altAmount = alt.amount;
        existing.altCurrency = alt.currency;
        backfilled++;
      }
      continue;
    }
    const tx = mapMonoItem(it, account.currency, accountId);
    addedDates.push(tx.date);
    state.transactions.push(tx);
    added++;
    if (tx.type === 'income') incomes++;
  }

  if (added || backfilled) {
    save();
    if (added) pairInternalTransfers();
  }
  return { added, incomes, duplicates, addedDates, tombstoned, backfilled };
}

/** Возвращает вручную удалённые операции: убирает их из чёрного списка и добавляет заново */
function monoRestoreItems(items, accountId) {
  const account = state.mono.accounts.find((a) => a.id === accountId);
  if (!account || !items.length) return 0;
  const ids = new Set(items.map((i) => i.id));
  state.monoDeleted = (state.monoDeleted || []).filter((id) => !ids.has(id));
  for (const it of items) {
    state.transactions.push(mapMonoItem(it, account.currency, accountId));
  }
  save();
  pairInternalTransfers();
  return items.length;
}
