import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

function tmpStore() {
  return new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-test-')));
}

const op = (id, amount = -1000) => ({
  monoId: id, account: 'acc', ts: Date.now(), amount,
  currencyCode: 980, mcc: 5411, description: 'тест', balance: 1000,
});

test('операции получают возрастающий курсор и выдаются по нему', () => {
  const s = tmpStore();
  s.addOp(op('a'));
  s.addOp(op('b'));
  s.addOp(op('c'));
  assert.deepEqual(s.opsSince(0).map((o) => o.monoId), ['a', 'b', 'c']);
  assert.deepEqual(s.opsSince(1).map((o) => o.monoId), ['b', 'c']);
  assert.deepEqual(s.opsSince(3), []);
});

test('повторный вебхук с тем же id не создаёт дубль', () => {
  const s = tmpStore();
  assert.ok(s.addOp(op('dup')));
  assert.equal(s.addOp(op('dup')), null);
  assert.equal(s.opsSince(0).length, 1);
});

test('данные переживают перезапуск', () => {
  const s = tmpStore();
  s.addOp(op('persist'));
  s.updateSettings({ onExpense: false, minAmount: 250 });

  const again = new Store(path.dirname(s.file));
  assert.equal(again.opsSince(0).length, 1);
  assert.equal(again.settings.onExpense, false);
  assert.equal(again.settings.minAmount, 250);
  assert.equal(again.addOp(op('persist')), null); // дубли помнятся и после перезапуска
});

test('подписки не задваиваются и удаляются', () => {
  const s = tmpStore();
  s.addSubscription({ endpoint: 'https://push/1' });
  s.addSubscription({ endpoint: 'https://push/1' });
  assert.equal(s.subscriptions.length, 1);
  s.addSubscription({ endpoint: 'https://push/2' });
  assert.equal(s.subscriptions.length, 2);
  s.removeSubscription('https://push/1');
  assert.deepEqual(s.subscriptions.map((x) => x.endpoint), ['https://push/2']);
});

test('напоминание срабатывает по времени и только один раз', () => {
  const s = tmpStore();
  const past = Date.now() - 1000;
  const future = Date.now() + 3_600_000;
  s.replaceReminders([
    { key: 'netflix', title: 'Netflix', body: 'завтра', fireAt: past },
    { key: 'icloud', title: 'iCloud', body: 'позже', fireAt: future },
  ]);
  assert.deepEqual(s.dueReminders().map((r) => r.key), ['netflix']);

  s.markReminderSent('netflix');
  assert.deepEqual(s.dueReminders(), []);

  // приложение прислало список заново — отправленное не должно повториться
  s.replaceReminders([
    { key: 'netflix', title: 'Netflix', body: 'завтра', fireAt: past },
    { key: 'icloud', title: 'iCloud', body: 'позже', fireAt: future },
  ]);
  assert.deepEqual(s.dueReminders(), []);
});

test('карта счетов сохраняется, мусор отбрасывается', () => {
  const s = tmpStore();
  s.setAccounts({ 'uah-1': 980, 'usd-1': 840, bad: 'oops' });
  assert.deepEqual(s.accounts, { 'uah-1': 980, 'usd-1': 840 });
  const again = new Store(path.dirname(s.file));
  assert.deepEqual(again.accounts, { 'uah-1': 980, 'usd-1': 840 });
  s.setAccounts(null); // не должно упасть и не должно затереть
  assert.deepEqual(s.accounts, { 'uah-1': 980, 'usd-1': 840 });
});

test('битый файл данных не роняет сервис', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-broken-'));
  fs.writeFileSync(path.join(dir, 'data.json'), '{ это не json');
  const s = new Store(dir);
  assert.deepEqual(s.opsSince(0), []);
  assert.equal(s.settings.onExpense, true);
});
