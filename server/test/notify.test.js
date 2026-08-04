import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtAmount, opKind, shouldNotify, buildOpNotification } from '../src/notify.js';

const ALL_ON = { onExpense: true, onIncome: true, onTransfer: true, minAmount: 0, reminders: true };

/* Intl разделяет разряды неразрывным пробелом — для сравнения приводим к обычному */
const norm = (s) => s.replace(/[  ]/g, ' ');

test('суммы форматируются со знаком и валютой', () => {
  assert.equal(fmtAmount(-36030, 980), '−360,30 ₴');
  assert.equal(fmtAmount(16000, 980), '+160,00 ₴');
  assert.equal(fmtAmount(-1299, 840), '−12,99 $');
});

test('тип операции определяется по знаку и MCC', () => {
  assert.equal(opKind({ amount: 16000, mcc: 4829 }), 'income');
  assert.equal(opKind({ amount: -20000, mcc: 4829 }), 'transfer'); // card-to-card
  assert.equal(opKind({ amount: -20000, mcc: 6011 }), 'transfer'); // банкомат
  assert.equal(opKind({ amount: -36030, mcc: 5411 }), 'expense');
});

test('переключатели уведомлений учитываются по типу', () => {
  const expense = { amount: -36030, mcc: 5411 };
  assert.equal(shouldNotify(expense, ALL_ON), true);
  assert.equal(shouldNotify(expense, { ...ALL_ON, onExpense: false }), false);

  const income = { amount: 16000, mcc: 4829 };
  assert.equal(shouldNotify(income, { ...ALL_ON, onIncome: false }), false);

  const transfer = { amount: -20000, mcc: 4829 };
  assert.equal(shouldNotify(transfer, { ...ALL_ON, onTransfer: false }), false);
});

test('порог суммы отсекает мелочь', () => {
  const settings = { ...ALL_ON, minAmount: 500 };
  assert.equal(shouldNotify({ amount: -39900, mcc: 5411 }, settings), false); // 399 ₴
  assert.equal(shouldNotify({ amount: -60000, mcc: 5411 }, settings), true);  // 600 ₴
});

test('текст уведомления: продавец в заголовке, сумма и остаток в теле', () => {
  const n = buildOpNotification({
    monoId: 'abc', amount: -36030, currencyCode: 980, mcc: 5411,
    description: 'АТБ', balance: 445873,
  });
  assert.equal(n.title, 'АТБ');
  assert.equal(norm(n.body), '−360,30 ₴ · остаток 4 458,73 ₴');
  assert.equal(n.kind, 'expense');
  assert.equal(n.tag, 'op-abc');
});

test('без описания подставляется тип операции, без баланса — только сумма', () => {
  const n = buildOpNotification({
    monoId: 'x', amount: 16000, currencyCode: 980, mcc: 4829, description: '', balance: null,
  });
  assert.equal(n.title, 'Поступление');
  assert.equal(n.body, '+160,00 ₴');
});
