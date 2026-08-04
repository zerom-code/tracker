/* Хранилище: один JSON-файл с атомарной записью.
   Данных мало (один пользователь), поэтому база не нужна — зато нет
   ни зависимостей, ни экспериментальных API. */

import fs from 'node:fs';
import path from 'node:path';

const MAX_OPS = 5000;      // столько последних операций держим в очереди
const MAX_SEEN = 20000;    // столько id помним, чтобы не принять дубль дважды

function emptyData() {
  return {
    seq: 0,
    ops: [],            // {cursor, monoId, account, ts, amount, currencyCode, mcc, description, balance}
    seen: [],           // id операций Monobank, уже принятых
    subscriptions: [],  // подписки Web Push
    settings: {
      onExpense: true,      // пуш на новые траты
      onIncome: true,       // пуш на поступления
      onTransfer: false,    // пуш на переводы и снятие наличных
      minAmount: 0,         // порог в единицах валюты счёта (0 — без порога)
      reminders: true,      // напоминания о подписках и рассрочках
    },
    reminders: [],      // {key, title, body, fireAt, sentAt}
    stats: { lastHookAt: 0, hookCount: 0, lastPushAt: 0, lastPushError: '' },
  };
}

export class Store {
  constructor(dir) {
    this.file = path.join(dir, 'data.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = this.#read();
    this.#seen = new Set(this.data.seen);
  }

  #seen;

  #read() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      return { ...emptyData(), ...JSON.parse(raw) };
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('[store] файл повреждён, начинаем заново:', e.message);
      return emptyData();
    }
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file); // атомарная замена — файл не побьётся при сбое
  }

  /* Возвращает добавленную операцию либо null, если это дубль */
  addOp(op) {
    if (this.#seen.has(op.monoId)) return null;
    this.#seen.add(op.monoId);
    this.data.seen.push(op.monoId);
    if (this.data.seen.length > MAX_SEEN) {
      this.data.seen = this.data.seen.slice(-MAX_SEEN);
      this.#seen = new Set(this.data.seen);
    }

    const stored = { ...op, cursor: ++this.data.seq };
    this.data.ops.push(stored);
    if (this.data.ops.length > MAX_OPS) this.data.ops = this.data.ops.slice(-MAX_OPS);

    this.data.stats.lastHookAt = Date.now();
    this.data.stats.hookCount++;
    this.save();
    return stored;
  }

  opsSince(cursor, limit = 500) {
    const from = Number(cursor) || 0;
    return this.data.ops.filter((o) => o.cursor > from).slice(0, limit);
  }

  get settings() { return this.data.settings; }

  updateSettings(patch) {
    const s = this.data.settings;
    if (typeof patch.onExpense === 'boolean') s.onExpense = patch.onExpense;
    if (typeof patch.onIncome === 'boolean') s.onIncome = patch.onIncome;
    if (typeof patch.onTransfer === 'boolean') s.onTransfer = patch.onTransfer;
    if (typeof patch.reminders === 'boolean') s.reminders = patch.reminders;
    if (Number.isFinite(patch.minAmount) && patch.minAmount >= 0) s.minAmount = patch.minAmount;
    this.save();
    return s;
  }

  addSubscription(sub) {
    if (!sub || !sub.endpoint) throw new Error('подписка без endpoint');
    const list = this.data.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
    list.push(sub);
    this.data.subscriptions = list;
    this.save();
    return list.length;
  }

  removeSubscription(endpoint) {
    const before = this.data.subscriptions.length;
    this.data.subscriptions = this.data.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (this.data.subscriptions.length !== before) this.save();
  }

  get subscriptions() { return this.data.subscriptions; }

  /* Напоминания приходят из приложения уже с точным моментом отправки (UTC),
     поэтому серверу не нужно ничего знать про часовой пояс. */
  replaceReminders(list) {
    const sentByKey = new Map(this.data.reminders.map((r) => [r.key, r.sentAt]));
    this.data.reminders = list
      .filter((r) => r && r.key && Number.isFinite(r.fireAt))
      .map((r) => ({
        key: String(r.key),
        title: String(r.title || 'Напоминание'),
        body: String(r.body || ''),
        fireAt: r.fireAt,
        // если этот же платёж уже напоминали — не повторяем
        sentAt: sentByKey.get(String(r.key)) || 0,
      }));
    this.save();
    return this.data.reminders.length;
  }

  dueReminders(now = Date.now()) {
    return this.data.reminders.filter((r) => !r.sentAt && r.fireAt <= now);
  }

  markReminderSent(key, when = Date.now()) {
    const r = this.data.reminders.find((x) => x.key === key);
    if (r) { r.sentAt = when; this.save(); }
  }

  notePush(error) {
    this.data.stats.lastPushAt = Date.now();
    this.data.stats.lastPushError = error ? String(error).slice(0, 300) : '';
    this.save();
  }

  get stats() { return this.data.stats; }
}
