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
    },
    rate: { usdUah: 42, updatedAt: 0, source: 'по умолчанию' },
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    transactions: [],  // {id, ts, type:'expense'|'transfer', amount, currency, categoryId, description, date, source, sourceId}
    subscriptions: [], // {id, name, amount, currency, period:'month'|'year', nextDate, active}
    debts: [],         // {id, direction:'i-owe'|'owe-me', person, amount, currency, description, date, settled}
    mono: { clientName: '', accounts: [] },
    monoDeleted: [],   // id операций Monobank, удалённых вручную — не возвращать при импорте
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const data = JSON.parse(raw);
    const base = defaultState();
    return {
      ...base,
      ...data,
      settings: { ...base.settings, ...(data.settings || {}) },
      rate: { ...base.rate, ...(data.rate || {}) },
      mono: { ...base.mono, ...(data.mono || {}) },
      categories: Array.isArray(data.categories) && data.categories.length ? data.categories : base.categories,
      transactions: data.transactions || [],
      subscriptions: data.subscriptions || [],
      debts: data.debts || [],
      monoDeleted: data.monoDeleted || [],
    };
  } catch (e) {
    console.error('Не удалось прочитать данные', e);
    return defaultState();
  }
}

let state = load();

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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

function addPeriod(iso, period) {
  const d = parseISO(iso);
  if (period === 'year') {
    d.setFullYear(d.getFullYear() + 1);
    return toISO(d);
  }
  const day = d.getDate();
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
  return state.settings.manualRate || state.rate.usdUah || 0;
}

function convert(amount, from, to) {
  if (from === to) return amount;
  const rate = effectiveRate();
  if (!rate) return 0;
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
  return state.transactions.filter((t) =>
    t.date.startsWith(prefix) && (!type || t.type === type));
}

function sumBase(list) {
  return list.reduce((acc, t) => acc + toBase(t.amount, t.currency), 0);
}

function subMonthlyBase(sub) {
  const monthly = sub.period === 'year' ? sub.amount / 12 : sub.amount;
  return toBase(monthly, sub.currency);
}

function activeSubs() {
  return state.subscriptions.filter((s) => s.active !== false);
}

function activeDebts(direction) {
  return state.debts.filter((d) => d.direction === direction && !d.settled);
}
