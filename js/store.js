/* Хранилище: все данные живут в localStorage на устройстве пользователя. */

const STORAGE_KEY = 'tracker.v1';

const DEFAULT_CATEGORIES = [
  { id: 'groceries', name: 'Продукты', emoji: '🛒' },
  { id: 'cafe', name: 'Кафе и рестораны', emoji: '🍔' },
  { id: 'transport', name: 'Транспорт', emoji: '🚕' },
  { id: 'home', name: 'Жильё и коммуналка', emoji: '🏠' },
  { id: 'health', name: 'Здоровье', emoji: '💊' },
  { id: 'fun', name: 'Развлечения', emoji: '🎮' },
  { id: 'clothes', name: 'Одежда', emoji: '👕' },
  { id: 'subs', name: 'Подписки', emoji: '📺' },
  { id: 'credit', name: 'Кредиты и рассрочки', emoji: '💳' },
  { id: 'connection', name: 'Связь и интернет', emoji: '📱' },
  { id: 'education', name: 'Образование', emoji: '📚' },
  { id: 'other', name: 'Другое', emoji: '✨' },
];

const FALLBACK_CATEGORY = 'other';

function defaultState() {
  return {
    settings: {
      baseCurrency: 'UAH',   // 'UAH' | 'USD'
      manualRate: null,      // если задан — используется вместо курса из сети
      monoToken: '',
      monoLastAccount: '',   // карта, с которой импортировали в прошлый раз
      serverUrl: '',         // личный сервер уведомлений и автосинхронизации
      deviceToken: '',
      remindDays: 1,         // за сколько дней напоминать о платеже
      remindHour: 10,        // в котором часу (по времени телефона)
      openaiKey: '',         // персональный API-ключ OpenAI
      openaiModel: 'gpt-5.6-luna', // модель по умолчанию
      openaiBaseUrl: '',     // опциональный кастомный URL эндпоинта
    },
    sync: {
      cursor: 0,             // до какой операции сервера уже забрали
      lastAt: 0,
      notify: null,          // зеркало настроек уведомлений с сервера
      serverInfo: null,
      webhookAt: 0,          // когда включили автосинхронизацию Monobank
      lastError: '',         // почему не прошла последняя синхронизация
      lastErrorAt: 0,
    },
    rate: { usdUah: 42, updatedAt: 0, source: 'по умолчанию' },
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    // internal=true — перевод между своими картами: виден в списке, но не входит в итоги
    transactions: [],  // {id, ts, type:'expense'|'transfer'|'income', amount, currency, categoryId, description, date, source, sourceId, accountId, internal}
    // подписка с plan — это рассрочка/кредит: конечное число платежей
    subscriptions: [], // {id, name, amount, currency, period:'month'|'year', nextDate, active, plan:{total,paid,lender}|null}
    // долг — контейнер: entries (за что, сколько) + payments (погашения)
    debts: [],         // {id, direction:'i-owe'|'owe-me', person, currency, date, settled, entries:[{id,amount,description,date}], payments:[{id,amount,date,note}]}
    mono: { clientName: '', accounts: [] },
    monoDeleted: [],   // id операций Monobank, удалённых вручную — не возвращать при импорте
    debtSuggestSeen: [], // операции, по которым уже предлагали погасить долг
  };
}

function migrateTransactions(txs) {
  if (!Array.isArray(txs)) return [];
  return txs.map((t) => {
    let updated = { ...t };

    // 1. Исправление типа рассрочек/кредитов
    if (updated.type === 'transfer' && !updated.internal && /погашен|розстрочк|рассрочк|частинами|кредит/i.test(updated.description || '')) {
      updated.type = 'expense';
      updated.categoryId = 'credit';
    }

    return updated;
  });
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const data = JSON.parse(raw);
    const base = defaultState();
    const rateObj = { ...base.rate, ...(data.rate || {}) };
    if (rateObj.source === 'НБУ' || !rateObj.source) rateObj.source = 'Monobank';
    return {
      ...base,
      ...data,
      settings: { ...base.settings, ...(data.settings || {}) },
      rate: rateObj,
      mono: { ...base.mono, ...(data.mono || {}) },
      sync: { ...base.sync, ...(data.sync || {}) },
      categories: mergeCategories(data.categories, base.categories),
      transactions: migrateTransactions(data.transactions || []),
      subscriptions: (data.subscriptions || []).map(normalizeSub),
      debts: (data.debts || []).map(normalizeDebt),
      monoDeleted: data.monoDeleted || [],
      debtSuggestSeen: data.debtSuggestSeen || [],
    };
  } catch (e) {
    console.error('Не удалось прочитать данные', e);
    return defaultState();
  }
}

/* Сохраняем категории пользователя, но дополняем недостающими служебными
   (например «Кредиты и рассрочки», появившейся в новой версии). */
function mergeCategories(saved, base) {
  if (!Array.isArray(saved) || !saved.length) return base;
  const have = new Set(saved.map((c) => c.id));
  const missing = base.filter((c) => c.id === 'credit' && !have.has(c.id));
  return missing.length ? [...saved, ...missing] : saved;
}

let state = load();

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Ошибка сохранения данных в localStorage:', e);
  }
}

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/* ---------- даты ---------- */

function toISO(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function todayISO() {
  return toISO(new Date());
}

function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function daysBetween(fromISO, untilISO) {
  return Math.round((parseISO(untilISO) - parseISO(fromISO)) / 86400000);
}

const MONTHS_RU = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_RU_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function fmtDay(iso) {
  const today = todayISO();
  if (iso === today) return 'Сегодня';
  if (daysBetween(iso, today) === 1) return 'Вчера';
  const d = parseISO(iso);
  const year = d.getFullYear() === new Date().getFullYear() ? '' : ' ' + d.getFullYear();
  return d.getDate() + ' ' + MONTHS_RU_GEN[d.getMonth()] + year;
}

function addPeriod(iso, period, preferredDay) {
  const d = parseISO(iso);
  const origMonth = d.getMonth();
  const day = preferredDay || d.getDate();
  if (period === 'year') {
    d.setDate(1);
    d.setFullYear(d.getFullYear() + 1);
    d.setMonth(origMonth);
    const maxDay = new Date(d.getFullYear(), origMonth + 1, 0).getDate();
    d.setDate(Math.min(day, maxDay));
    return toISO(d);
  }
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  const maxDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, maxDay));
  return toISO(d);
}

/* ---------- валюта ---------- */

const fmtUAH = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtUSD = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmtMoney(n, currency) {
  const sign = n < 0 ? '−' : '';
  const abs = Math.abs(n);
  return currency === 'USD'
    ? sign + '$' + fmtUSD.format(abs)
    : sign + fmtUAH.format(abs) + ' ₴';
}

function effectiveRate() {
  return state.settings.manualRate || (state.rate && (state.rate.usd || state.rate.usdUah)) || null;
}

function convert(amount, from, to) {
  if (from === to) return amount;
  const rate = effectiveRate() || 44.0;
  return from === 'USD' ? amount * rate : amount / rate;
}

function toBase(amount, currency) {
  return convert(amount, currency, state.settings.baseCurrency);
}

function otherCurrency(cur) {
  return cur === 'UAH' ? 'USD' : 'UAH';
}

/* ---------- выборки ---------- */

function categoryById(id) {
  return state.categories.find((c) => c.id === id) ||
    state.categories.find((c) => c.id === FALLBACK_CATEGORY) ||
    { id: FALLBACK_CATEGORY, name: 'Другое', emoji: '✨' };
}

function txSorted() {
  return [...state.transactions].sort((a, b) =>
    a.date === b.date ? (b.ts || 0) - (a.ts || 0) : (a.date < b.date ? 1 : -1));
}

function txOfMonth(year, month, type) {
  const prefix = year + '-' + String(month + 1).padStart(2, '0');
  // выборка с типом идёт в итоги, поэтому переводы между своими исключаются
  return state.transactions.filter((t) =>
    t.date.startsWith(prefix) && (!type || (t.type === type && !t.internal)));
}

/* Расход — это исключительно траты (категория «Переводы» исключена) */
function outflowOfMonth(year, month) {
  return txOfMonth(year, month, 'expense');
}

function isOutflow(t) {
  return t.type === 'expense';
}

/* Сумма операции в валюте учёта. */
function txBase(t) {
  if (t.currency === state.settings.baseCurrency) return t.amount;
  if (t.altAmount && t.altCurrency === state.settings.baseCurrency && t.altAmount > 0) {
    return t.altAmount;
  }
  return toBase(t.amount, t.currency);
}

function sumBase(list) {
  return list.reduce((acc, t) => acc + txBase(t), 0);
}

function subMonthlyBase(sub) {
  const monthly = sub.period === 'year' ? sub.amount / 12 : sub.amount;
  return toBase(monthly, sub.currency);
}

function activeSubs() {
  return state.subscriptions.filter((s) => s.active !== false);
}

/* ---------- кредиты и рассрочки ---------- */

/* Миграция: у подписок, заведённых до появления рассрочек, плана платежей нет */
function normalizeSub(s) {
  const day = (s && typeof s.preferredDay === 'number') ? s.preferredDay : (s && s.nextDate ? parseISO(s.nextDate).getDate() : 1);
  return { ...s, plan: s && s.plan ? s.plan : null, preferredDay: day };
}

function isCredit(s) {
  return !!(s.plan && s.plan.total > 0);
}

/* Сколько ещё предстоит выплатить по рассрочке (в её валюте) */
function creditRemaining(s) {
  if (!isCredit(s)) return 0;
  return s.amount * Math.max(0, s.plan.total - s.plan.paid);
}

function activeCredits() {
  return activeSubs().filter(isCredit);
}

function activePlainSubs() {
  return activeSubs().filter((s) => !isCredit(s));
}

function creditsRemainingBase() {
  return activeCredits().reduce((acc, s) => acc + toBase(creditRemaining(s), s.currency), 0);
}

/* Миграция старого плоского формата долга в контейнер с записями */
function normalizeDebt(d) {
  if (Array.isArray(d.entries)) return { payments: [], ...d };
  return {
    id: d.id,
    direction: d.direction,
    person: d.person,
    currency: d.currency,
    date: d.date,
    settled: !!d.settled,
    entries: [{ id: uid(), amount: d.amount || 0, description: d.description || '', date: d.date }],
    payments: [],
  };
}

function debtTotal(d) {
  return d.entries.reduce((a, e) => a + e.amount, 0);
}

function debtPaid(d) {
  return d.payments.reduce((a, p) => a + p.amount, 0);
}

function debtRemaining(d) {
  return Math.max(0, debtTotal(d) - debtPaid(d));
}

function debtSettled(d) {
  return d.settled || debtTotal(d) - debtPaid(d) <= 0.005;
}

function activeDebts(direction) {
  return state.debts.filter((d) => d.direction === direction && !debtSettled(d));
}

function normPerson(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
