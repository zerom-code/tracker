/* Формирование текста уведомлений и правила «слать или не слать».
   Чистые функции — их удобно тестировать отдельно от отправки. */

const SYMBOL = { 980: '₴', 840: '$', 978: '€' };

/* Переводы и снятие наличных: card-to-card, финансовые операции, банкоматы.
   Список синхронизирован с TRANSFER_MCC в js/api.js приложения. */
const TRANSFER_MCC = [4829, 6012, 6011, 6538];

export function fmtAmount(minor, currencyCode) {
  const sign = minor > 0 ? '+' : '−';
  const value = Math.abs(minor) / 100;
  const symbol = SYMBOL[currencyCode] || '';
  const text = new Intl.NumberFormat('uk-UA', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(value);
  return `${sign}${text}${symbol ? ' ' + symbol : ''}`;
}

export function opKind(op) {
  if (op.amount > 0) return 'income';
  return TRANSFER_MCC.includes(op.mcc) ? 'transfer' : 'expense';
}

export function shouldNotify(op, settings) {
  const kind = opKind(op);
  if (kind === 'income' && !settings.onIncome) return false;
  if (kind === 'expense' && !settings.onExpense) return false;
  if (kind === 'transfer' && !settings.onTransfer) return false;
  const minor = Math.abs(op.amount);
  if (settings.minAmount > 0 && minor < settings.minAmount * 100) return false;
  return true;
}

export function buildOpNotification(op, accounts = {}) {
  const kind = opKind(op);
  const label = { income: 'Поступление', transfer: 'Перевод', expense: 'Трата' }[kind];
  const title = (op.description || '').trim() || label;
  // сумма и баланс всегда в валюте счёта; currencyCode операции может отличаться
  const code = accounts[op.account] || op.currencyCode;
  const parts = [fmtAmount(op.amount, code)];
  if (Number.isFinite(op.balance)) {
    const bal = new Intl.NumberFormat('uk-UA', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(op.balance / 100);
    parts.push(`остаток ${bal} ${SYMBOL[code] || ''}`.trim());
  }
  return {
    title,
    body: parts.join(' · '),
    tag: 'op-' + op.monoId,
    kind,
    url: '#ops',
  };
}
