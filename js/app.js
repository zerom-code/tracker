/* Интерфейс: отрисовка экранов, формы, обработка действий. */

const now = new Date();
const ui = {
  screen: 'home',
  opsFilter: 'all',            // all | expense | transfer
  opsY: now.getFullYear(),
  opsM: now.getMonth(),
  debtsTab: 'owe-me',          // owe-me | i-owe
  showDiag: false,
};

const MONTHS_RU_PREP = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне',
  'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];

/* Псевдокатегория для строки «Переводы» в разбивке за месяц */
const TRANSFERS_ROW = '__transfers';

const screenEl = document.getElementById('screen');
const fabEl = document.getElementById('fab');
const modalRoot = document.getElementById('modal-root');
const toastEl = document.getElementById('toast');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  // длинные подсказки держим на экране дольше, чтобы успеть прочитать
  toastTimer = setTimeout(() => { toastEl.hidden = true; },
    Math.min(9000, 2800 + msg.length * 45));
}

function moneyBoth(amountBase) {
  const base = state.settings.baseCurrency;
  const other = otherCurrency(base);
  return {
    main: fmtMoney(amountBase, base),
    other: fmtMoney(convert(amountBase, base, other), other),
  };
}

/* ================= отрисовка экранов ================= */

function render() {
  document.querySelectorAll('.tabbar button').forEach((b) => {
    b.classList.toggle('active', b.dataset.nav === ui.screen);
  });
  const renderers = {
    home: renderHome, ops: renderOps, subs: renderSubs,
    debts: renderDebts, settings: renderSettings,
  };
  screenEl.innerHTML = renderers[ui.screen]();
  fabEl.hidden = ui.screen === 'settings';
}

/* ---------- главная ---------- */

function renderHome() {
  const y = now.getFullYear(), m = now.getMonth();
  const spentBase = sumBase(outflowOfMonth(y, m)); // траты вместе с переводами
  const transfersBase = sumBase(txOfMonth(y, m, 'transfer'));
  const incomeBase = sumBase(txOfMonth(y, m, 'income'));
  const spent = moneyBoth(spentBase);

  const subsMonthly = activeSubs().reduce((acc, s) => acc + subMonthlyBase(s), 0);
  const subs = moneyBoth(subsMonthly);
  const creditsLeft = creditsRemainingBase();

  const oweMe = moneyBoth(activeDebts('owe-me').reduce((a, d) => a + toBase(debtRemaining(d), d.currency), 0));
  const iOwe = moneyBoth(activeDebts('i-owe').reduce((a, d) => a + toBase(debtRemaining(d), d.currency), 0));

  // топ категорий месяца; переводы идут отдельной строкой, чтобы сумма
  // столбиков сходилась с итогом расходов
  const byCat = {};
  for (const t of txOfMonth(y, m, 'expense')) {
    const id = t.categoryId || FALLBACK_CATEGORY;
    byCat[id] = (byCat[id] || 0) + toBase(t.amount, t.currency);
  }
  if (transfersBase > 0) byCat[TRANSFERS_ROW] = transfersBase;
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 7);
  const maxCat = cats.length ? cats[0][1] : 1;

  const upcoming = activeSubs()
    .slice().sort((a, b) => (a.nextDate < b.nextDate ? -1 : 1)).slice(0, 3);

  return `
    <h1 class="screen-title">Обзор</h1>

    <div class="card">
      <h3>Расходы в ${MONTHS_RU_PREP[m]}</h3>
      <div class="big-amount">${spent.main}</div>
      <div class="sub-amount">≈ ${spent.other}</div>
      <div class="divider"></div>
      <div class="rate-line">
        <span style="color:var(--muted);font-size:14px">Доходы за месяц</span>
        <span style="font-weight:700;color:var(--green)">+${fmtMoney(incomeBase, state.settings.baseCurrency)}</span>
      </div>
      <div class="rate-line" style="margin-top:6px">
        <span style="color:var(--muted);font-size:14px">Из них переводы</span>
        <span style="font-weight:700;color:var(--accent)">${fmtMoney(transfersBase, state.settings.baseCurrency)}</span>
      </div>
    </div>

    <div class="stat-grid" style="margin-bottom:12px">
      <div class="card">
        <div class="stat-label">Платежи в месяц</div>
        <div class="stat-value">${subs.main}</div>
        <div class="row-sub">${creditsLeft > 0 ? 'выплатить ещё ' + fmtMoney(creditsLeft, state.settings.baseCurrency) : '≈ ' + subs.other}</div>
      </div>
      <div class="card">
        <div class="stat-label">Курс доллара</div>
        <div class="stat-value">${effectiveRate() ? effectiveRate().toFixed(2) + ' ₴' : '—'}</div>
        <div class="row-sub">${state.settings.manualRate ? 'ручной курс' : esc(state.rate.source)}</div>
      </div>
      <div class="card">
        <div class="stat-label">Мне должны</div>
        <div class="stat-value green">${oweMe.main}</div>
      </div>
      <div class="card">
        <div class="stat-label">Я должен</div>
        <div class="stat-value red">${iOwe.main}</div>
      </div>
    </div>

    ${cats.length ? `
    <div class="card">
      <h3>Категории за месяц</h3>
      ${cats.map(([id, sum]) => {
        const c = id === TRANSFERS_ROW ? { emoji: '🔁', name: 'Переводы' } : categoryById(id);
        return `
        <div class="cat-bar">
          <div class="cat-bar-top">
            <span class="name">${c.emoji} ${esc(c.name)}</span>
            <span class="val">${fmtMoney(sum, state.settings.baseCurrency)}</span>
          </div>
          <div class="cat-bar-track"><div class="cat-bar-fill" style="width:${Math.max(3, Math.round(sum / maxCat * 100))}%"></div></div>
        </div>`;
      }).join('')}
    </div>` : ''}

    ${upcoming.length ? `
    <div class="card">
      <h3>Ближайшие платежи</h3>
      ${upcoming.map(subRow).join('')}
    </div>` : ''}

    ${!state.transactions.length && !upcoming.length ? `
    <div class="empty">
      <div class="empty-icon">👋</div>
      Начните с кнопки «+» — добавьте первую трату,<br>
      подписку или подключите Monobank в «Ещё».
    </div>` : ''}
  `;
}

/* ---------- операции ---------- */

function renderOps() {
  const { opsY: y, opsM: m } = ui;
  // «Расходы» показывают и переводы — они тоже расход, просто отдельного вида
  const matchesFilter = (t) => ui.opsFilter === 'all' ||
    (ui.opsFilter === 'expense' ? isOutflow(t) : t.type === ui.opsFilter);
  const monthTx = txOfMonth(y, m).filter(matchesFilter);
  const sorted = monthTx.sort((a, b) =>
    a.date === b.date ? (b.ts || 0) - (a.ts || 0) : (a.date < b.date ? 1 : -1));

  const expSum = sumBase(outflowOfMonth(y, m)); // вместе с переводами
  const trSum = sumBase(txOfMonth(y, m, 'transfer'));
  const inSum = sumBase(txOfMonth(y, m, 'income'));

  const groups = [];
  for (const t of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.date === t.date) last.items.push(t);
    else groups.push({ date: t.date, items: [t] });
  }

  return `
    <h1 class="screen-title">Операции</h1>

    <div class="month-nav">
      <button data-action="month-prev">‹</button>
      <span class="month-label">${MONTHS_RU[m]} ${y}</span>
      <button data-action="month-next">›</button>
    </div>

    <div class="segmented seg-tight" style="margin-bottom:12px">
      <button data-action="ops-filter" data-val="all" class="${ui.opsFilter === 'all' ? 'active' : ''}">Все</button>
      <button data-action="ops-filter" data-val="expense" class="${ui.opsFilter === 'expense' ? 'active' : ''}">Расходы</button>
      <button data-action="ops-filter" data-val="transfer" class="${ui.opsFilter === 'transfer' ? 'active' : ''}">Переводы</button>
      <button data-action="ops-filter" data-val="income" class="${ui.opsFilter === 'income' ? 'active' : ''}">Доходы</button>
    </div>

    <div class="card">
      <div class="sums-line">
        <span>Расходы<b>${fmtMoney(expSum, state.settings.baseCurrency)}</b></span>
        <span>из них переводы<b style="color:var(--accent)">${fmtMoney(trSum, state.settings.baseCurrency)}</b></span>
        <span>Доходы<b style="color:var(--green)">+${fmtMoney(inSum, state.settings.baseCurrency)}</b></span>
      </div>
    </div>

    ${groups.length ? groups.map((g) => `
      <div class="group-label">${fmtDay(g.date)}</div>
      <div class="card" style="padding:4px 16px">
        ${g.items.map(txRow).join('')}
      </div>
    `).join('') : `
    <div class="empty">
      <div class="empty-icon">🧾</div>
      За этот месяц операций нет.<br>Добавьте трату кнопкой «+».
    </div>`}
  `;
}

function txRow(t) {
  const isTr = t.type === 'transfer';
  const isIn = t.type === 'income';
  const cat = isTr ? null : categoryById(t.categoryId);
  const emoji = isTr ? '🔁' : (isIn && (!t.categoryId || t.categoryId === FALLBACK_CATEGORY) ? '💰' : cat.emoji);
  const title = t.description || (isTr ? 'Перевод' : (isIn ? 'Доход' : cat.name));
  const subParts = [];
  if (isTr) subParts.push('Перевод');
  else if (isIn) subParts.push(t.categoryId && t.categoryId !== FALLBACK_CATEGORY ? 'Доход · ' + cat.name : 'Доход');
  else subParts.push(cat.name);
  if (t.source === 'mono') subParts.push('Monobank');
  const amountCls = isIn ? 'positive' : (isTr ? 'transfer' : 'expense');
  return `
    <div class="row" data-action="edit-tx" data-id="${t.id}">
      <div class="row-emoji">${emoji}</div>
      <div class="row-main">
        <div class="row-title">${esc(title)}</div>
        <div class="row-sub">${esc(subParts.join(' · '))}</div>
      </div>
      <div class="row-right">
        <div class="row-amount ${amountCls}">${isIn ? '+' : '−'}${fmtMoney(t.amount, t.currency)}</div>
      </div>
    </div>`;
}

/* ---------- подписки ---------- */

function subRow(s) {
  const today = todayISO();
  const days = daysBetween(today, s.nextDate);
  let badge = '';
  if (days < 0) badge = `<span class="badge danger">просрочено ${-days} дн.</span>`;
  else if (days === 0) badge = '<span class="badge warn">сегодня</span>';
  else if (days <= 5) badge = `<span class="badge warn">через ${days} дн.</span>`;
  else badge = `<span class="badge">через ${days} дн.</span>`;

  const d = parseISO(s.nextDate);
  const dateStr = d.getDate() + ' ' + MONTHS_RU_GEN[d.getMonth()];
  const payBtn = days <= 0
    ? `<button class="icon-btn ok" data-action="pay-sub" data-id="${s.id}" title="Отметить оплаченным">✓</button>`
    : '';

  const credit = isCredit(s);
  const nextNo = Math.min(s.plan ? s.plan.paid + 1 : 0, s.plan ? s.plan.total : 0);
  const pct = credit ? Math.round(s.plan.paid / s.plan.total * 100) : 0;

  return `
    <div class="row" data-action="edit-sub" data-id="${s.id}">
      <div class="row-emoji">${credit ? '💳' : '🔁'}</div>
      <div class="row-main">
        <div class="row-title">${esc(s.name)}</div>
        <div class="row-sub${credit ? ' wrap' : ''}">${badge} ${dateStr}${credit ? ` · платёж ${nextNo} из ${s.plan.total}` : ` · ${s.period === 'year' ? 'ежегодно' : 'ежемесячно'}`}</div>
        ${credit ? `<div class="cat-bar-track" style="margin-top:6px"><div class="cat-bar-fill" style="width:${Math.max(2, pct)}%"></div></div>` : ''}
      </div>
      <div class="inline-actions">
        <div class="row-right">
          <div class="row-amount">${fmtMoney(s.amount, s.currency)}</div>
          <div class="row-sub">${credit ? 'ост. ' + fmtMoney(creditRemaining(s), s.currency) : (s.period === 'year' ? '/год' : '/мес')}</div>
        </div>
        ${payBtn}
      </div>
    </div>`;
}

function renderSubs() {
  const byDate = (a, b) => (a.nextDate < b.nextDate ? -1 : 1);
  const subs = activePlainSubs().slice().sort(byDate);
  const credits = activeCredits().slice().sort(byDate);
  const paused = state.subscriptions.filter((s) => s.active === false);

  const monthly = moneyBoth(activeSubs().reduce((acc, s) => acc + subMonthlyBase(s), 0));
  const remaining = moneyBoth(creditsRemainingBase());

  return `
    <h1 class="screen-title">Платежи</h1>

    <div class="card">
      <h3>В месяц</h3>
      <div class="big-amount">${monthly.main}</div>
      <div class="sub-amount">≈ ${monthly.other}</div>
      ${credits.length ? `
      <div class="divider"></div>
      <div class="rate-line">
        <span style="color:var(--muted);font-size:14px">Осталось выплатить</span>
        <span style="font-weight:700">${remaining.main}</span>
      </div>` : ''}
    </div>

    ${credits.length ? `
    <div class="group-label">Кредиты и рассрочки</div>
    <div class="card" style="padding:4px 16px">${credits.map(subRow).join('')}</div>` : ''}

    ${subs.length ? `
    ${credits.length ? '<div class="group-label">Подписки</div>' : ''}
    <div class="card" style="padding:4px 16px">${subs.map(subRow).join('')}</div>` : ''}

    ${!subs.length && !credits.length ? `
    <div class="empty">
      <div class="empty-icon">🔁</div>
      Добавьте кнопкой «+» подписки (Netflix, iCloud)<br>или рассрочку с фиксированным платежом.
    </div>` : ''}

    ${paused.length ? `
    <div class="group-label">Закрытые и приостановленные</div>
    <div class="card" style="padding:4px 16px">
      ${paused.map((s) => `
      <div class="row settled" data-action="edit-sub" data-id="${s.id}">
        <div class="row-emoji">${isCredit(s) ? '✅' : '⏸️'}</div>
        <div class="row-main">
          <div class="row-title">${esc(s.name)}</div>
          ${isCredit(s) ? `<div class="row-sub">выплачено ${s.plan.paid} из ${s.plan.total}</div>` : ''}
        </div>
        <div class="row-right"><div class="row-amount">${fmtMoney(s.amount, s.currency)}</div></div>
      </div>`).join('')}
    </div>` : ''}

    <p class="hint">Когда подходит дата — нажмите «✓»: платёж запишется в расходы, а дата сдвинется. У рассрочки счётчик платежей увеличится, и после последнего она закроется сама.</p>
  `;
}

/* ---------- долги ---------- */

function debtRow(d) {
  const settled = debtSettled(d);
  const remaining = debtRemaining(d);
  const total = debtTotal(d);
  const firstDesc = d.entries.length ? (d.entries[0].description || 'без описания') : 'без описания';
  const more = d.entries.length > 1 ? ` · ещё ${d.entries.length - 1}` : '';
  const settleBtn = settled ? '' :
    `<button class="icon-btn ok" data-action="settle-debt" data-id="${d.id}" title="Погасить полностью">✓</button>`;
  const partial = !settled && debtPaid(d) > 0
    ? `<div class="row-sub">из ${fmtMoney(total, d.currency)}</div>` : '';
  return `
    <div class="row ${settled ? 'settled' : ''}" data-action="edit-debt" data-id="${d.id}">
      <div class="row-emoji">${d.direction === 'owe-me' ? '📥' : '📤'}</div>
      <div class="row-main">
        <div class="row-title">${esc(d.person)}</div>
        <div class="row-sub">${esc(firstDesc)}${esc(more)}</div>
      </div>
      <div class="inline-actions">
        <div class="row-right">
          <div class="row-amount ${settled ? '' : (d.direction === 'owe-me' ? 'positive' : 'negative')}">${fmtMoney(settled ? total : remaining, d.currency)}</div>
          ${partial}
        </div>
        ${settleBtn}
      </div>
    </div>`;
}

function renderDebts() {
  const dir = ui.debtsTab;
  const active = activeDebts(dir);
  const settled = state.debts.filter((d) => d.direction === dir && debtSettled(d));
  const total = moneyBoth(active.reduce((a, d) => a + toBase(debtRemaining(d), d.currency), 0));

  return `
    <h1 class="screen-title">Долги</h1>

    <div class="segmented" style="margin-bottom:12px">
      <button data-action="debts-tab" data-val="owe-me" class="${dir === 'owe-me' ? 'active' : ''}">Мне должны</button>
      <button data-action="debts-tab" data-val="i-owe" class="${dir === 'i-owe' ? 'active' : ''}">Я должен</button>
    </div>

    <div class="card">
      <h3>${dir === 'owe-me' ? 'Всего мне должны' : 'Всего я должен'}</h3>
      <div class="big-amount ${dir === 'owe-me' ? 'stat-value green' : 'stat-value red'}" style="font-size:30px">${total.main}</div>
      <div class="sub-amount">≈ ${total.other}</div>
    </div>

    ${dir === 'i-owe' && creditsRemainingBase() > 0 ? `
    <button class="card row" data-nav="subs" style="width:100%;padding:12px 16px">
      <div class="row-emoji">💳</div>
      <div class="row-main">
        <div class="row-title">Кредиты и рассрочки</div>
        <div class="row-sub">${activeCredits().length} ${activeCredits().length === 1 ? 'платёж' : 'платежа(ей)'} · открыть</div>
      </div>
      <div class="row-right">
        <div class="row-amount negative">${fmtMoney(creditsRemainingBase(), state.settings.baseCurrency)}</div>
        <div class="row-sub">осталось</div>
      </div>
    </button>` : ''}

    ${active.length ? `<div class="card" style="padding:4px 16px">${active.map(debtRow).join('')}</div>` : `
    <div class="empty">
      <div class="empty-icon">🤝</div>
      ${dir === 'owe-me' ? 'Никто не должен — красота.' : 'Долгов нет — свобода!'}<br>
      Добавить можно кнопкой «+».
    </div>`}

    ${settled.length ? `
    <div class="group-label">Погашенные</div>
    <div class="card" style="padding:4px 16px">${settled.map(debtRow).join('')}</div>` : ''}
  `;
}

/* ---------- настройки ---------- */

function renderSettings() {
  const s = state.settings;
  const rateTime = state.rate.updatedAt
    ? new Date(state.rate.updatedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—';

  const firstSupported = state.mono.accounts.findIndex((a) => a.supported);
  const monoBlock = s.monoToken && state.mono.accounts.length ? `
    <div class="row-sub" style="margin-bottom:8px">Подключено: <b style="color:var(--text)">${esc(state.mono.clientName || 'клиент Monobank')}</b></div>
    <div class="field">
      <label>Счёт для импорта</label>
      ${state.mono.accounts.map((a, i) => `
        <label style="display:flex;align-items:center;gap:10px;padding:8px 2px;font-size:15px;color:${a.supported ? 'var(--text)' : 'var(--muted)'}">
          <input type="radio" name="mono-acc" value="${esc(a.id)}" ${i === firstSupported ? 'checked' : ''} ${a.supported ? '' : 'disabled'}>
          ${esc(a.maskedPan)} · ${esc(a.currency)}${a.type ? ' · ' + esc(a.type) : ''}${a.supported ? '' : ' (не поддерживается)'}
        </label>`).join('')}
    </div>
    <div class="field">
      <label>Период</label>
      <select id="mono-days">
        <option value="7">последние 7 дней</option>
        <option value="31" selected>последние 31 день</option>
        <option value="custom">выбрать даты…</option>
      </select>
    </div>
    <div id="mono-custom" hidden>
      <div class="field-split">
        <div class="field">
          <label>С даты</label>
          <input id="mono-from" type="date" value="${todayISO()}">
        </div>
        <div class="field">
          <label>По дату</label>
          <input id="mono-to" type="date" value="${todayISO()}">
        </div>
      </div>
      <p class="hint" style="margin:0 0 10px">Для одного дня укажите одинаковые даты. Monobank отдаёт максимум 31 день за один запрос.</p>
    </div>
    <button class="btn" data-action="mono-import">Импортировать операции</button>
    <button class="btn danger-ghost" data-action="mono-disconnect">Отключить Monobank</button>
    <p class="hint">Списания станут расходами (категория — по типу магазина), переводы и снятие наличных попадут в «Переводы», поступления — в «Доходы». Уже импортированные операции не дублируются.</p>
  ` : `
    <div class="field">
      <label>Токен персонального API</label>
      <input id="mono-token" type="text" autocomplete="off" autocapitalize="off" placeholder="uXXXXXXXXXXXXXXXXXXX" value="${esc(s.monoToken)}">
    </div>
    <button class="btn" data-action="mono-connect">Подключить</button>
    <p class="hint">Токен выдаётся бесплатно на <a href="https://api.monobank.ua" target="_blank" rel="noopener">api.monobank.ua</a> — зайдите с телефона и подтвердите в приложении mono. Токен хранится только на этом устройстве.</p>
  `;

  return `
    <h1 class="screen-title">Настройки</h1>

    <div class="card">
      <h3>Валюта учёта</h3>
      <div class="segmented">
        <button data-action="set-base" data-val="UAH" class="${s.baseCurrency === 'UAH' ? 'active' : ''}">Гривна ₴</button>
        <button data-action="set-base" data-val="USD" class="${s.baseCurrency === 'USD' ? 'active' : ''}">Доллар $</button>
      </div>
      <p class="hint">Итоги считаются в этой валюте, суммы в другой валюте конвертируются по курсу.</p>
    </div>

    <div class="card">
      <h3>Курс доллара</h3>
      <div class="rate-line">
        <div>
          <div class="rate-value">1 $ = ${effectiveRate() ? effectiveRate().toFixed(2) : '—'} ₴</div>
          <div class="rate-src">${s.manualRate ? 'задан вручную' : esc(state.rate.source) + ' · обновлён ' + rateTime}</div>
        </div>
        <button class="icon-btn" data-action="rate-refresh" title="Обновить курс">🔄</button>
      </div>
      <div class="divider"></div>
      <div class="field" style="margin-bottom:8px">
        <label>Свой курс (пусто — автоматически)</label>
        <div class="field-split">
          <input id="manual-rate" type="text" inputmode="decimal" placeholder="напр. 42.50" value="${s.manualRate || ''}">
          <button class="btn small secondary" data-action="save-manual-rate" style="flex:0 0 auto">Сохранить</button>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>Monobank</h3>
      ${monoBlock}
    </div>

    <div class="card">
      <h3>Сервер и уведомления</h3>
      ${renderServerBlock()}
    </div>

    <div class="card">
      <h3>Категории</h3>
      <div style="padding:0">
        ${state.categories.map((c) => `
        <div class="row" data-action="edit-category" data-id="${esc(c.id)}">
          <div class="row-emoji">${esc(c.emoji)}</div>
          <div class="row-main"><div class="row-title">${esc(c.name)}</div></div>
          <div class="row-right" style="color:var(--muted)">›</div>
        </div>`).join('')}
      </div>
      <button class="btn secondary" data-action="add-category" style="margin-top:10px">Добавить категорию</button>
    </div>

    <div class="card">
      <h3>Данные</h3>
      <button class="btn secondary" data-action="export-data">Скачать резервную копию</button>
      <label class="btn secondary" style="margin-top:8px">
        Восстановить из копии
        <input id="import-file" type="file" accept="application/json,.json" style="display:none">
      </label>
      <button class="btn danger-ghost" data-action="wipe-data">Удалить все данные</button>
      <p class="hint">Все данные хранятся только в этом браузере на вашем устройстве и никуда не отправляются. Делайте копию время от времени.</p>
    </div>

    <p class="hint" style="text-align:center" data-action="diag-toggle">Трекер трат · версия 13</p>
    ${ui.showDiag ? `
    <div class="card">
      <h3>Диагностика экрана</h3>
      <div class="diag">${diagLines().map((l) => `<div>${esc(l)}</div>`).join('')}</div>
      <button class="btn secondary" data-action="tap-test" style="margin-top:10px">Тест тапа</button>
      <p class="hint">Если тап «промахивается», разница между координатами нажатия и клика покажет сдвиг.</p>
    </div>` : ''}
  `;
}

/* Блок настройки личного сервера: автосинхронизация и push-уведомления */
function renderServerBlock() {
  const s = state.settings;
  if (!serverConfigured()) {
    return `
      <div class="field">
        <label>Адрес сервера</label>
        <input id="srv-url" type="url" autocapitalize="off" autocorrect="off"
               placeholder="https://tracker.example.com" value="${esc(s.serverUrl)}">
      </div>
      <div class="field">
        <label>Токен устройства</label>
        <input id="srv-token" type="text" autocomplete="off" autocapitalize="off"
               placeholder="из .env сервера" value="${esc(s.deviceToken)}">
      </div>
      <button class="btn" data-action="srv-connect">Подключить</button>
      <p class="hint">Сервер принимает вебхуки Monobank, чтобы операции подтягивались сами, и шлёт уведомления. Он видит только операции — токен Monobank остаётся на телефоне.</p>
    `;
  }

  const n = state.sync.notify || {};
  const info = state.sync.serverInfo || {};
  const fmtTime = (ts) => new Date(ts).toLocaleString('ru-RU',
    { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const lastSync = state.sync.lastAt ? fmtTime(state.sync.lastAt) : 'ещё не было';
  const pushOn = info.subscriptions > 0;
  const hookOn = Boolean(state.sync.webhookAt);

  const toggle = (key, label, on) => `
    <label class="switch-row">
      <span>${label}</span>
      <input type="checkbox" data-action="notify-toggle" data-key="${key}" ${on ? 'checked' : ''}>
    </label>`;

  return `
    <div class="rate-line" style="margin-bottom:10px">
      <div>
        <div class="rate-value" style="font-size:15px">${esc(s.serverUrl.replace(/^https?:\/\//, ''))}</div>
        <div class="rate-src">синхронизация: ${lastSync}</div>
      </div>
      <button class="icon-btn" data-action="srv-sync" title="Синхронизировать">🔄</button>
    </div>

    ${hookOn ? `
      <div class="status-row ok">
        <span>✓ Автосинхронизация Monobank включена</span>
        <button class="btn small secondary" data-action="mono-webhook-off">Отключить</button>
      </div>
      <p class="hint" style="margin-bottom:12px">${info.lastHookAt
        ? 'Последняя операция от банка: ' + fmtTime(info.lastHookAt)
        : 'Ждём первую операцию — она придёт сразу после ближайшей оплаты картой.'}</p>
    ` : `
      <button class="btn secondary" data-action="mono-webhook">Включить автосинхронизацию Monobank</button>
      <p class="hint" style="margin-bottom:12px">Нажмите один раз — Monobank начнёт присылать операции на сервер сразу после оплаты.</p>
    `}

    <div class="divider"></div>

    <h3 style="margin-bottom:10px">Уведомления</h3>
    ${pushOn ? `
      <div class="status-row ok">
        <span>✓ Уведомления включены</span>
        <button class="btn small secondary" data-action="push-test">Проверить</button>
      </div>
    ` : `
      <button class="btn" data-action="push-enable">Включить уведомления на этом айфоне</button>
      <p class="hint">Работает только в приложении, добавленном на экран «Домой». ${info.pushConfigured === false ? '<b>На сервере не заданы VAPID-ключи.</b>' : ''}</p>
    `}

    <div class="switch-list" style="margin-top:12px">
      ${toggle('onExpense', 'Новые траты', n.onExpense)}
      ${toggle('onIncome', 'Поступления', n.onIncome)}
      ${toggle('onTransfer', 'Переводы и снятие наличных', n.onTransfer)}
      ${toggle('reminders', 'Напоминания о подписках и рассрочках', n.reminders)}
    </div>

    <div class="field" style="margin-top:12px">
      <label>Уведомлять только от суммы (0 — обо всех)</label>
      <div class="field-split">
        <input id="notify-min" type="text" inputmode="decimal" placeholder="0" value="${n.minAmount || ''}">
        <button class="btn small secondary" data-action="notify-min-save" style="flex:0 0 auto">Сохранить</button>
      </div>
    </div>
    <div class="field-split">
      <div class="field">
        <label>Напоминать за (дней)</label>
        <input id="remind-days" type="text" inputmode="numeric" value="${s.remindDays}">
      </div>
      <div class="field">
        <label>В котором часу</label>
        <input id="remind-hour" type="text" inputmode="numeric" value="${s.remindHour}">
      </div>
    </div>
    <button class="btn small secondary" data-action="remind-save">Сохранить расписание</button>
    ${pushOn ? '<button class="btn danger-ghost" data-action="push-disable">Отключить уведомления</button>' : ''}

    ${info.lastPushError ? `<p class="hint" style="color:var(--yellow)">Последняя ошибка отправки: ${esc(info.lastPushError)}</p>` : ''}
    <div class="divider"></div>
    <button class="btn danger-ghost" data-action="srv-disconnect">Отключить сервер</button>
  `;
}

function diagLines() {
  const vv = window.visualViewport;
  const cs = getComputedStyle(document.documentElement);
  return [
    'innerHeight: ' + window.innerHeight,
    'screen.height: ' + screen.height,
    'visualViewport: ' + (vv ? Math.round(vv.height) + ' (offsetTop ' + Math.round(vv.offsetTop) + ')' : 'нет'),
    '--app-h: ' + cs.getPropertyValue('--app-h').trim(),
    'body height: ' + Math.round(document.body.getBoundingClientRect().height),
    'standalone: ' + (navigator.standalone === true ? 'да' : 'нет'),
    'safe-area top/bottom: ' + safeArea('top') + ' / ' + safeArea('bottom'),
  ];
}

function safeArea(side) {
  const probe = document.createElement('div');
  probe.style.cssText = `position:fixed;height:env(safe-area-inset-${side});visibility:hidden`;
  document.body.appendChild(probe);
  const v = Math.round(probe.getBoundingClientRect().height);
  probe.remove();
  return v + 'px';
}

/* Показывает, куда пришлось нажатие и куда — клик. Расхождение = тот самый сдвиг. */
function runTapTest(btn) {
  let down = null;
  btn.textContent = 'Нажмите сюда ещё раз';
  const onDown = (e) => { down = { x: Math.round(e.clientX), y: Math.round(e.clientY) }; };
  const onClick = (e) => {
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    btn.removeEventListener('pointerdown', onDown);
    btn.removeEventListener('click', onClick);
    btn.textContent = 'Тест тапа';
    toast(`press: ${down ? down.x + ',' + down.y : '—'}\nclick: ${Math.round(e.clientX)},${Math.round(e.clientY)}\nпопал в: ${hit ? hit.tagName.toLowerCase() : '?'}`);
  };
  btn.addEventListener('pointerdown', onDown);
  btn.addEventListener('click', onClick);
}

/* ================= модальные формы ================= */

function openSheet(html) {
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-action="modal-close">
      <div class="sheet" data-stop-close>
        <div class="sheet-grip"></div>
        ${html}
      </div>
    </div>`;
}

function closeSheet() {
  modalRoot.innerHTML = '';
}

function sheetHead(title) {
  return `
    <div class="sheet-head">
      <h2>${esc(title)}</h2>
      <button type="button" class="sheet-close" data-action="modal-close">✕</button>
    </div>`;
}

function segButtons(options, current) {
  return options.map(([val, label]) =>
    `<button type="button" class="seg-opt ${val === current ? 'active' : ''}" data-val="${val}">${label}</button>`
  ).join('');
}

function segValue(sel) {
  const el = document.querySelector(sel + ' .seg-opt.active');
  return el ? el.dataset.val : null;
}

function parseAmount(str) {
  const n = parseFloat(String(str).replace(/\s/g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/* --- операция (расход / перевод) --- */

function openTxForm(tx) {
  const isNew = !tx;
  const defaultType = { transfer: 'transfer', income: 'income' }[ui.opsFilter] || 'expense';
  const t = tx || {
    type: ui.screen === 'ops' ? defaultType : 'expense',
    amount: '', currency: state.settings.baseCurrency,
    categoryId: null, description: '', date: todayISO(),
  };

  openSheet(`
    ${sheetHead(isNew ? 'Новая операция' : 'Изменить операцию')}
    <form id="sheet-form" data-form="tx" data-id="${tx ? tx.id : ''}">
      <div class="field">
        <div class="segmented" id="tx-type-seg">
          ${segButtons([['expense', 'Расход'], ['transfer', 'Перевод'], ['income', 'Доход']], t.type)}
        </div>
      </div>
      <div class="field">
        <label>Сумма</label>
        <div class="amount-row">
          <input id="tx-amount" type="text" inputmode="decimal" placeholder="0" value="${t.amount || ''}" required>
          <div class="segmented" id="tx-cur-seg">
            ${segButtons([['UAH', '₴'], ['USD', '$']], t.currency)}
          </div>
        </div>
      </div>
      <div class="field" id="tx-cat-field" ${t.type === 'transfer' ? 'hidden' : ''}>
        <label>Категория</label>
        <div class="chips" id="tx-cats">
          ${state.categories.map((c) => `
            <button type="button" class="chip tx-cat ${(t.categoryId || FALLBACK_CATEGORY) === c.id ? 'active' : ''}" data-cat="${esc(c.id)}">${esc(c.emoji)} ${esc(c.name)}</button>
          `).join('')}
        </div>
      </div>
      <div class="field">
        <label>${t.type === 'transfer' ? 'Кому / описание' : 'Описание'}</label>
        <input id="tx-desc" type="text" placeholder="${t.type === 'transfer' ? 'например: маме на карту' : (t.type === 'income' ? 'например: зарплата' : 'например: кофе с собой')}" value="${esc(t.description)}">
      </div>
      <div class="field">
        <label>Дата</label>
        <input id="tx-date" type="date" value="${t.date}" required>
      </div>
      <button type="submit" class="btn">${isNew ? 'Добавить' : 'Сохранить'}</button>
      ${isNew ? '' : `<button type="button" class="btn danger-ghost" data-action="del-tx" data-id="${tx.id}">Удалить операцию</button>`}
      ${t.source === 'mono' ? '<p class="hint" style="text-align:center">Импортировано из Monobank — правки не затирают её при повторном импорте</p>' : ''}
    </form>
  `);
}

function submitTxForm(form) {
  const amount = parseAmount(document.getElementById('tx-amount').value);
  if (!amount) { toast('Введите сумму больше нуля'); return; }
  const type = segValue('#tx-type-seg') || 'expense';
  const currency = segValue('#tx-cur-seg') || 'UAH';
  const catBtn = document.querySelector('#tx-cats .chip.active');
  const date = document.getElementById('tx-date').value || todayISO();
  const description = document.getElementById('tx-desc').value.trim();

  const categoryId = type !== 'transfer' ? (catBtn ? catBtn.dataset.cat : FALLBACK_CATEGORY) : null;
  const id = form.dataset.id;
  if (id) {
    const t = state.transactions.find((x) => x.id === id);
    if (!t) return;
    Object.assign(t, { type, amount, currency, date, description, categoryId });
  } else {
    state.transactions.push({
      id: uid(), ts: Date.now(), type, amount, currency, date, description, categoryId,
      source: 'manual', sourceId: null,
    });
  }
  save(); closeSheet(); render();
}

/* --- подписка --- */

function openSubForm(sub) {
  const isNew = !sub;
  const s = sub || {
    name: '', amount: '', currency: 'USD', period: 'month',
    nextDate: todayISO(), active: true, plan: null,
  };
  const credit = isCredit(s);
  const title = isNew ? 'Новый платёж' : (credit ? 'Изменить рассрочку' : 'Изменить подписку');

  openSheet(`
    ${sheetHead(title)}
    <form id="sheet-form" data-form="sub" data-id="${sub ? sub.id : ''}">
      <div class="field">
        <label>Название</label>
        <input id="sub-name" type="text" placeholder="${credit ? 'iPhone в рассрочку…' : 'Netflix, iCloud…'}" value="${esc(s.name)}" required>
      </div>
      <div class="field">
        <label>Сумма</label>
        <div class="amount-row">
          <input id="sub-amount" type="text" inputmode="decimal" placeholder="0" value="${s.amount || ''}" required>
          <div class="segmented" id="sub-cur-seg">
            ${segButtons([['UAH', '₴'], ['USD', '$']], s.currency)}
          </div>
        </div>
      </div>
      <div class="field">
        <label>Период</label>
        <div class="segmented" id="sub-period-seg">
          ${segButtons([['month', 'Ежемесячно'], ['year', 'Ежегодно']], s.period)}
        </div>
      </div>
      <div class="field">
        <label>Дата следующего списания</label>
        <input id="sub-date" type="date" value="${s.nextDate}" required>
      </div>

      <div class="field">
        <label style="display:flex;align-items:center;gap:10px;font-size:15px;color:var(--text)">
          <input id="sub-is-credit" type="checkbox" ${credit ? 'checked' : ''}>
          Это рассрочка или кредит
        </label>
      </div>
      <div id="sub-plan" ${credit ? '' : 'hidden'}>
        <div class="field">
          <label>Кому платим</label>
          <input id="sub-lender" type="text" placeholder="например: Monobank" value="${credit ? esc(s.plan.lender || '') : ''}">
        </div>
        <div class="field-split">
          <div class="field">
            <label>Всего платежей</label>
            <input id="sub-total" type="text" inputmode="numeric" placeholder="12" value="${credit ? s.plan.total : ''}">
          </div>
          <div class="field">
            <label>Уже оплачено</label>
            <input id="sub-paid" type="text" inputmode="numeric" placeholder="0" value="${credit ? s.plan.paid : ''}">
          </div>
        </div>
      </div>

      ${isNew ? '' : `
      <div class="field">
        <label style="display:flex;align-items:center;gap:10px;font-size:15px;color:var(--text)">
          <input id="sub-active" type="checkbox" ${s.active !== false ? 'checked' : ''}>
          Активен
        </label>
      </div>`}
      <button type="submit" class="btn">${isNew ? 'Добавить' : 'Сохранить'}</button>
      ${isNew ? '' : `<button type="button" class="btn danger-ghost" data-action="del-sub" data-id="${sub.id}">Удалить</button>`}
    </form>
  `);
}

function submitSubForm(form) {
  const name = document.getElementById('sub-name').value.trim();
  const amount = parseAmount(document.getElementById('sub-amount').value);
  if (!name) { toast('Укажите название'); return; }
  if (!amount) { toast('Введите сумму больше нуля'); return; }

  let plan = null;
  if (document.getElementById('sub-is-credit').checked) {
    const total = parseInt(document.getElementById('sub-total').value, 10);
    const paid = parseInt(document.getElementById('sub-paid').value, 10) || 0;
    if (!(total >= 1)) { toast('Укажите, сколько всего платежей'); return; }
    if (paid < 0 || paid > total) { toast('Оплачено не может быть больше, чем всего платежей'); return; }
    plan = { total, paid, lender: document.getElementById('sub-lender').value.trim() };
  }

  const data = {
    name, amount, plan,
    currency: segValue('#sub-cur-seg') || 'USD',
    period: segValue('#sub-period-seg') || 'month',
    nextDate: document.getElementById('sub-date').value || todayISO(),
  };
  const activeEl = document.getElementById('sub-active');
  const id = form.dataset.id;
  if (id) {
    const s = state.subscriptions.find((x) => x.id === id);
    if (!s) return;
    Object.assign(s, data, { active: activeEl ? activeEl.checked : s.active });
  } else {
    state.subscriptions.push({ id: uid(), ...data, active: true });
  }
  save(); closeSheet(); render();
}

/* --- долг --- */

function openDebtForm(debt) {
  if (!debt) { openNewDebtForm(); return; }

  const remaining = debtRemaining(debt);
  const entriesHtml = debt.entries.map((e) => `
    <div class="row compact" data-action="edit-debt-entry" data-debt="${debt.id}" data-id="${e.id}">
      <div class="row-main">
        <div class="row-title" style="font-weight:500">${esc(e.description || 'без описания')}</div>
        <div class="row-sub">${fmtDay(e.date)}</div>
      </div>
      <div class="row-right"><div class="row-amount">${fmtMoney(e.amount, debt.currency)}</div></div>
    </div>`).join('');

  const paymentsHtml = debt.payments.map((p) => `
    <div class="row compact" data-action="edit-debt-payment" data-debt="${debt.id}" data-id="${p.id}">
      <div class="row-main">
        <div class="row-title" style="font-weight:500">${esc(p.note || 'Погашение')}</div>
        <div class="row-sub">${fmtDay(p.date)}</div>
      </div>
      <div class="row-right"><div class="row-amount positive">−${fmtMoney(p.amount, debt.currency)}</div></div>
    </div>`).join('');

  openSheet(`
    ${sheetHead('Долг · ' + debt.person)}
    <form id="sheet-form" data-form="debt" data-id="${debt.id}">
      <div class="field">
        <div class="segmented" id="debt-dir-seg">
          ${segButtons([['owe-me', 'Мне должны'], ['i-owe', 'Я должен']], debt.direction)}
        </div>
      </div>
      <div class="field-split">
        <div class="field">
          <label>Кто</label>
          <input id="debt-person" type="text" placeholder="Имя" value="${esc(debt.person)}" required>
        </div>
        <div class="field" style="flex:0 0 120px">
          <label>Валюта</label>
          <div class="segmented" id="debt-cur-seg">
            ${segButtons([['UAH', '₴'], ['USD', '$']], debt.currency)}
          </div>
        </div>
      </div>

      <div class="field">
        <label>За что (${debt.entries.length})</label>
        <div class="card" style="padding:2px 12px;margin:0">${entriesHtml}</div>
        <button type="button" class="btn secondary" data-action="add-debt-entry" data-debt="${debt.id}" style="margin-top:8px">＋ Добавить запись</button>
      </div>

      <div class="field">
        <label>Погашения</label>
        ${debt.payments.length ? `<div class="card" style="padding:2px 12px;margin:0">${paymentsHtml}</div>` : ''}
        <button type="button" class="btn secondary" data-action="add-debt-payment" data-debt="${debt.id}" style="margin-top:8px">Частичное погашение</button>
      </div>

      <div class="rate-line" style="margin:4px 2px 12px">
        <span style="color:var(--muted);font-size:14px">Осталось</span>
        <span style="font-weight:800;font-size:17px">${fmtMoney(remaining, debt.currency)} <span style="color:var(--muted);font-weight:400;font-size:13px">из ${fmtMoney(debtTotal(debt), debt.currency)}</span></span>
      </div>

      <div class="field">
        <label style="display:flex;align-items:center;gap:10px;font-size:15px;color:var(--text)">
          <input id="debt-settled" type="checkbox" ${debtSettled(debt) ? 'checked' : ''}>
          Долг закрыт
        </label>
      </div>
      <button type="submit" class="btn">Сохранить</button>
      <button type="button" class="btn danger-ghost" data-action="del-debt" data-id="${debt.id}">Удалить долг</button>
    </form>
  `);
}

function openNewDebtForm() {
  openSheet(`
    ${sheetHead('Новый долг')}
    <form id="sheet-form" data-form="debt" data-id="">
      <div class="field">
        <div class="segmented" id="debt-dir-seg">
          ${segButtons([['owe-me', 'Мне должны'], ['i-owe', 'Я должен']], ui.debtsTab)}
        </div>
      </div>
      <div class="field">
        <label>Кто</label>
        <input id="debt-person" type="text" placeholder="Имя" required>
      </div>
      <div class="field">
        <label>Сумма</label>
        <div class="amount-row">
          <input id="debt-amount" type="text" inputmode="decimal" placeholder="0" required>
          <div class="segmented" id="debt-cur-seg">
            ${segButtons([['UAH', '₴'], ['USD', '$']], 'UAH')}
          </div>
        </div>
      </div>
      <div class="field">
        <label>За что</label>
        <input id="debt-desc" type="text" placeholder="например: за билеты на концерт">
      </div>
      <div class="field">
        <label>Дата</label>
        <input id="debt-date" type="date" value="${todayISO()}">
      </div>
      <button type="submit" class="btn">Добавить</button>
      <p class="hint">Если у этого человека уже есть незакрытый долг, приложение предложит объединить записи или зачесть встречный долг.</p>
    </form>
  `);
}

function submitDebtForm(form) {
  const person = document.getElementById('debt-person').value.trim();
  if (!person) { toast('Укажите имя'); return; }
  const direction = segValue('#debt-dir-seg') || 'owe-me';
  const currency = segValue('#debt-cur-seg') || 'UAH';
  const id = form.dataset.id;

  if (id) {
    const d = state.debts.find((x) => x.id === id);
    if (!d) return;
    const settledEl = document.getElementById('debt-settled');
    d.direction = direction;
    d.person = person;
    d.currency = currency;
    d.settled = settledEl.checked;
    save(); closeSheet(); render();
    return;
  }

  const amount = parseAmount(document.getElementById('debt-amount').value);
  if (!amount) { toast('Введите сумму больше нуля'); return; }
  const description = document.getElementById('debt-desc').value.trim();
  const date = document.getElementById('debt-date').value || todayISO();
  const norm = normPerson(person);

  // тот же человек, то же направление → предложить объединить
  const sameDir = state.debts.find((d) =>
    !debtSettled(d) && d.direction === direction && d.currency === currency && normPerson(d.person) === norm);
  if (sameDir && confirm(`У «${sameDir.person}» уже есть незакрытый долг на ${fmtMoney(debtRemaining(sameDir), currency)}.\n\nОбъединить с ним? («Отмена» — записать отдельным долгом)`)) {
    sameDir.entries.push({ id: uid(), amount, description, date });
    sameDir.settled = false;
    save(); closeSheet(); render();
    toast(`Добавлено к долгу «${sameDir.person}»: теперь ${fmtMoney(debtRemaining(sameDir), currency)}`);
    return;
  }

  // тот же человек, встречное направление → предложить взаимозачёт
  const opposite = state.debts.find((d) =>
    !debtSettled(d) && d.direction !== direction && d.currency === currency && normPerson(d.person) === norm);
  if (opposite) {
    const rem = debtRemaining(opposite);
    const offset = Math.min(amount, rem);
    const msg = direction === 'owe-me'
      ? `Вы должны «${opposite.person}» ${fmtMoney(rem, currency)}.\n\nЗачесть ${fmtMoney(offset, currency)} в счёт вашего долга? Запись о встречном долге сохранится.`
      : `«${opposite.person}» должен вам ${fmtMoney(rem, currency)}.\n\nЗачесть ${fmtMoney(offset, currency)} в счёт его долга? Запись о вашем долге сохранится.`;
    if (confirm(msg)) {
      opposite.payments.push({ id: uid(), amount: offset, date, note: 'Взаимозачёт' });
      opposite.settled = debtRemaining(opposite) <= 0.005;
      const newDebt = {
        id: uid(), direction, person, currency, date, settled: false,
        entries: [{ id: uid(), amount, description, date }],
        payments: [{ id: uid(), amount: offset, date, note: 'Взаимозачёт' }],
      };
      newDebt.settled = debtRemaining(newDebt) <= 0.005;
      state.debts.push(newDebt);
      save(); closeSheet(); render();
      toast(opposite.settled && newDebt.settled
        ? 'Долги взаимно погашены 🎉'
        : `Зачтено ${fmtMoney(offset, currency)}`);
      return;
    }
  }

  state.debts.push({
    id: uid(), direction, person, currency, date, settled: false,
    entries: [{ id: uid(), amount, description, date }],
    payments: [],
  });
  save(); closeSheet(); render();
}

/* --- запись и погашение внутри долга --- */

function openDebtEntryForm(debtId, entryId) {
  const debt = state.debts.find((d) => d.id === debtId);
  if (!debt) return;
  const entry = entryId ? debt.entries.find((e) => e.id === entryId) : null;
  openSheet(`
    ${sheetHead(entry ? 'Изменить запись' : 'Новая запись')}
    <form id="sheet-form" data-form="debt-entry" data-debt="${debt.id}" data-id="${entry ? entry.id : ''}">
      <div class="field">
        <label>Сумма (${debt.currency === 'USD' ? '$' : '₴'})</label>
        <input id="de-amount" type="text" inputmode="decimal" placeholder="0" value="${entry ? entry.amount : ''}" required>
      </div>
      <div class="field">
        <label>За что</label>
        <input id="de-desc" type="text" placeholder="например: за обед" value="${entry ? esc(entry.description) : ''}">
      </div>
      <div class="field">
        <label>Дата</label>
        <input id="de-date" type="date" value="${entry ? entry.date : todayISO()}">
      </div>
      <button type="submit" class="btn">Сохранить</button>
      ${entry ? `<button type="button" class="btn danger-ghost" data-action="del-debt-entry" data-debt="${debt.id}" data-id="${entry.id}">Удалить запись</button>` : ''}
    </form>
  `);
}

function openDebtPaymentForm(debtId, paymentId) {
  const debt = state.debts.find((d) => d.id === debtId);
  if (!debt) return;
  const payment = paymentId ? debt.payments.find((p) => p.id === paymentId) : null;
  openSheet(`
    ${sheetHead(payment ? 'Изменить погашение' : 'Частичное погашение')}
    <form id="sheet-form" data-form="debt-payment" data-debt="${debt.id}" data-id="${payment ? payment.id : ''}">
      <div class="field">
        <label>Сумма (${debt.currency === 'USD' ? '$' : '₴'}) — осталось ${fmtMoney(debtRemaining(debt), debt.currency)}</label>
        <input id="dp-amount" type="text" inputmode="decimal" placeholder="0" value="${payment ? payment.amount : debtRemaining(debt) || ''}" required>
      </div>
      <div class="field">
        <label>Дата</label>
        <input id="dp-date" type="date" value="${payment ? payment.date : todayISO()}">
      </div>
      <button type="submit" class="btn">Сохранить</button>
      ${payment ? `<button type="button" class="btn danger-ghost" data-action="del-debt-payment" data-debt="${debt.id}" data-id="${payment.id}">Удалить погашение</button>` : ''}
    </form>
  `);
}

function recalcDebtSettled(d) {
  d.settled = debtTotal(d) - debtPaid(d) <= 0.005;
}

function submitDebtEntryForm(form) {
  const debt = state.debts.find((d) => d.id === form.dataset.debt);
  if (!debt) return;
  const amount = parseAmount(document.getElementById('de-amount').value);
  if (!amount) { toast('Введите сумму больше нуля'); return; }
  const description = document.getElementById('de-desc').value.trim();
  const date = document.getElementById('de-date').value || todayISO();
  const id = form.dataset.id;
  if (id) {
    const e = debt.entries.find((x) => x.id === id);
    if (e) Object.assign(e, { amount, description, date });
  } else {
    debt.entries.push({ id: uid(), amount, description, date });
  }
  recalcDebtSettled(debt);
  save(); render();
  openDebtForm(debt);
}

function submitDebtPaymentForm(form) {
  const debt = state.debts.find((d) => d.id === form.dataset.debt);
  if (!debt) return;
  const amount = parseAmount(document.getElementById('dp-amount').value);
  if (!amount) { toast('Введите сумму больше нуля'); return; }
  const date = document.getElementById('dp-date').value || todayISO();
  const id = form.dataset.id;
  if (id) {
    const p = debt.payments.find((x) => x.id === id);
    if (p) Object.assign(p, { amount, date });
  } else {
    debt.payments.push({ id: uid(), amount, date, note: '' });
  }
  recalcDebtSettled(debt);
  save(); render();
  if (debt.settled) { closeSheet(); toast('Долг погашен полностью 🎉'); }
  else openDebtForm(debt);
}

/* --- категория --- */

function openCategoryForm(cat) {
  const isNew = !cat;
  const c = cat || { emoji: '🏷️', name: '' };
  openSheet(`
    ${sheetHead(isNew ? 'Новая категория' : 'Изменить категорию')}
    <form id="sheet-form" data-form="category" data-id="${cat ? esc(cat.id) : ''}">
      <div class="field-split">
        <div class="field" style="flex:0 0 84px">
          <label>Эмодзи</label>
          <input id="cat-emoji" type="text" maxlength="4" value="${esc(c.emoji)}" style="text-align:center;font-size:22px">
        </div>
        <div class="field">
          <label>Название</label>
          <input id="cat-name" type="text" placeholder="Например: Питомцы" value="${esc(c.name)}" required>
        </div>
      </div>
      <button type="submit" class="btn">${isNew ? 'Добавить' : 'Сохранить'}</button>
      ${isNew || cat.id === FALLBACK_CATEGORY ? '' :
        `<button type="button" class="btn danger-ghost" data-action="del-category" data-id="${esc(cat.id)}">Удалить категорию</button>`}
    </form>
  `);
}

function submitCategoryForm(form) {
  const name = document.getElementById('cat-name').value.trim();
  const emoji = document.getElementById('cat-emoji').value.trim() || '🏷️';
  if (!name) { toast('Укажите название'); return; }
  const id = form.dataset.id;
  if (id) {
    const c = state.categories.find((x) => x.id === id);
    if (c) Object.assign(c, { name, emoji });
  } else {
    state.categories.push({ id: uid(), name, emoji });
  }
  save(); closeSheet(); render();
}

/* ================= действия ================= */

function paySubscription(id) {
  const s = state.subscriptions.find((x) => x.id === id);
  if (!s) return;
  const credit = isCredit(s);
  state.transactions.push({
    id: uid(), ts: Date.now(), type: 'expense',
    amount: s.amount, currency: s.currency,
    categoryId: credit ? 'credit' : 'subs', description: s.name,
    date: todayISO(), source: 'manual', sourceId: null,
  });

  if (credit) {
    s.plan.paid = Math.min(s.plan.paid + 1, s.plan.total);
    if (s.plan.paid >= s.plan.total) {
      s.active = false;
      save(); render();
      toast(`«${s.name}» выплачено полностью 🎉`);
      return;
    }
  }

  s.nextDate = addPeriod(s.nextDate, s.period);
  save(); render();
  toast(credit
    ? `Платёж ${s.plan.paid} из ${s.plan.total} записан`
    : 'Записано в расходы, дата сдвинута');
}

async function handleRateRefresh(btn) {
  btn.disabled = true;
  try {
    await refreshRate(true);
    render();
    toast('Курс обновлён: 1 $ = ' + state.rate.usdUah.toFixed(2) + ' ₴');
  } catch (e) {
    toast('Не удалось получить курс: ' + e.message);
  } finally {
    btn.disabled = false;
  }
}

async function handleMonoConnect(btn) {
  const token = document.getElementById('mono-token').value.trim();
  if (!token) { toast('Вставьте токен из api.monobank.ua'); return; }
  btn.disabled = true; btn.textContent = 'Подключаем…';
  try {
    const info = await monoConnect(token);
    render();
    toast('Monobank подключён: счетов — ' + info.accounts.length);
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Подключить';
    toast(e.message);
  }
}

function monoImportRange() {
  const nowSec = Math.floor(Date.now() / 1000);
  const sel = document.getElementById('mono-days').value;
  if (sel !== 'custom') {
    const days = Number(sel) || 31;
    return { fromSec: nowSec - days * 86400, toSec: nowSec };
  }
  const fromISO = document.getElementById('mono-from').value;
  const toISO = document.getElementById('mono-to').value;
  if (!fromISO || !toISO) throw new Error('Укажите обе даты периода');
  if (fromISO > toISO) throw new Error('Дата «с» позже даты «по»');
  if (daysBetween(fromISO, toISO) > 30) throw new Error('Monobank отдаёт максимум 31 день за один запрос — выберите период короче');
  const fromSec = Math.floor(parseISO(fromISO).getTime() / 1000);
  if (fromSec > nowSec) throw new Error('Период ещё не наступил');
  // конец дня «по дату», но не позже текущего момента
  const toSec = Math.min(Math.floor(parseISO(toISO).getTime() / 1000) + 86399, nowSec);
  return { fromSec, toSec };
}

async function handleMonoImport(btn) {
  const acc = document.querySelector('input[name="mono-acc"]:checked');
  if (!acc) { toast('Выберите счёт'); return; }
  let range;
  try {
    range = monoImportRange();
  } catch (e) {
    toast(e.message);
    return;
  }
  btn.disabled = true; btn.textContent = 'Импортируем…';
  try {
    const r = await monoImport(acc.value, range.fromSec, range.toSec);
    // если операции легли в разные месяцы — подсказать, где искать:
    // экран «Операции» показывает один месяц за раз
    const byMonth = {};
    r.addedDates.forEach((d) => { byMonth[d.slice(0, 7)] = (byMonth[d.slice(0, 7)] || 0) + 1; });
    const months = Object.keys(byMonth).sort()
      .map((k) => `${MONTHS_RU[Number(k.slice(5, 7)) - 1]} — ${byMonth[k]}`);
    render();
    toast(r.added
      ? `Добавлено операций: ${r.added}` + (r.incomes ? ` (доходов: ${r.incomes})` : '') +
        (months.length > 1 ? `\n${months.join(', ')}` : '')
      : 'Новых операций нет' + (r.duplicates ? ` (дублей: ${r.duplicates})` : ''));
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Импортировать операции';
    toast(e.message);
  }
}

/* ---------- личный сервер: подключение, синхронизация, уведомления ---------- */

async function withBusy(btn, label, fn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    await fn();
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
    render();
  }
}

function handleServerConnect(btn) {
  const url = document.getElementById('srv-url').value.trim();
  const token = document.getElementById('srv-token').value.trim();
  if (!url || !token) { toast('Заполните адрес и токен'); return; }
  if (!/^https:\/\//i.test(url)) { toast('Адрес должен начинаться с https://'); return; }

  const prev = { url: state.settings.serverUrl, token: state.settings.deviceToken };
  state.settings.serverUrl = url.replace(/\/+$/, '');
  state.settings.deviceToken = token;

  withBusy(btn, 'Проверяем…', async () => {
    try {
      await syncAll();
      save();
      toast('Сервер подключён');
    } catch (e) {
      state.settings.serverUrl = prev.url;   // не сохраняем нерабочие данные
      state.settings.deviceToken = prev.token;
      save();
      // сервер отвечает, но запрос не прошёл — значит дело в CORS
      if (/недоступен/.test(e.message) && await probeServerReachable(url)) {
        throw new Error('Сервер отвечает, но не разрешает запросы с адреса ' +
          location.origin + '. Впишите его в ALLOWED_ORIGINS в .env и перезапустите контейнер.');
      }
      throw e;
    }
  });
}

function handleServerSync(btn) {
  withBusy(btn, '…', async () => {
    const added = await syncAll();
    toast(added ? `Новых операций: ${added}` : 'Новых операций нет');
  });
}

function handleMonoWebhook(btn) {
  if (!state.settings.monoToken) { toast('Сначала подключите Monobank выше'); return; }
  const url = (state.sync.serverInfo && state.sync.serverInfo.webhookUrl);
  if (!url) { toast('Сначала синхронизируйтесь с сервером'); return; }
  withBusy(btn, 'Включаем…', async () => {
    await monoSetWebhook(url);
    state.sync.webhookAt = Date.now();
    save();
    toast('Готово: операции будут приходить автоматически');
  });
}

function handleMonoWebhookOff(btn) {
  if (!confirm('Отключить автосинхронизацию? Операции можно будет загружать вручную через импорт.')) return;
  withBusy(btn, 'Отключаем…', async () => {
    await monoSetWebhook(''); // пустой адрес отменяет вебхук на стороне банка
    state.sync.webhookAt = 0;
    save();
    toast('Автосинхронизация отключена');
  });
}

function handlePushEnable(btn) {
  withBusy(btn, 'Включаем…', async () => {
    await enablePush();
    await syncAll();
    toast('Уведомления включены');
  });
}

function handlePushDisable(btn) {
  withBusy(btn, 'Отключаем…', async () => {
    await disablePush();
    await syncAll();
    toast('Уведомления отключены');
  });
}

function handlePushTest(btn) {
  withBusy(btn, 'Отправляем…', async () => {
    const r = await sendTestPush();
    toast(r.sent ? 'Отправлено — проверьте экран блокировки' : ('Не отправлено: ' + (r.error || 'нет подписок')));
  });
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tracker-backup-' + todayISO() + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function importDataFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.transactions)) {
        throw new Error('это не файл резервной копии трекера');
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
      state = load();
      save(); render();
      toast('Данные восстановлены');
    } catch (e) {
      toast('Не удалось восстановить: ' + e.message);
    }
  };
  reader.readAsText(file);
}

/* ================= обработчики событий ================= */

/* Защита от «фантомного» тапа: если между нажатием и отпусканием вёрстка
   сдвинулась (закрылась клавиатура, ужался лист), click прилетает в другой
   элемент — например в поле даты над кнопкой. Такой клик гасим в capture-фазе,
   иначе системный пикер даты успеет открыться. */
let pressTarget = null;
document.addEventListener('pointerdown', (e) => { pressTarget = e.target; }, true);
document.addEventListener('click', (e) => {
  const pressed = pressTarget;
  pressTarget = null;
  if (e.detail === 0 || !pressed) return; // submit с клавиатуры — не трогаем
  const related = pressed === e.target ||
    pressed.contains(e.target) || e.target.contains(pressed);
  if (!related) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

document.addEventListener('click', (e) => {
  const navBtn = e.target.closest('[data-nav]');
  if (navBtn) {
    ui.screen = navBtn.dataset.nav;
    history.replaceState(null, '', '#' + ui.screen);
    render();
    screenEl.scrollTop = 0;
    return;
  }

  // сегменты внутри форм
  const seg = e.target.closest('.seg-opt');
  if (seg) {
    seg.parentElement.querySelectorAll('.seg-opt').forEach((b) => b.classList.toggle('active', b === seg));
    if (seg.parentElement.id === 'tx-type-seg') {
      const catField = document.getElementById('tx-cat-field');
      if (catField) catField.hidden = seg.dataset.val === 'transfer';
    }
    return;
  }

  // чипсы категорий в форме операции
  const chip = e.target.closest('.tx-cat');
  if (chip) {
    document.querySelectorAll('#tx-cats .chip').forEach((b) => b.classList.toggle('active', b === chip));
    return;
  }

  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id, val, debt } = el.dataset;

  switch (action) {
    case 'modal-close':
      if (!e.target.closest('[data-stop-close]') || e.target.closest('.sheet-close')) closeSheet();
      break;

    case 'ops-filter': ui.opsFilter = val; render(); break;
    case 'debts-tab': ui.debtsTab = val; render(); break;
    case 'month-prev':
      ui.opsM--; if (ui.opsM < 0) { ui.opsM = 11; ui.opsY--; }
      render(); break;
    case 'month-next':
      ui.opsM++; if (ui.opsM > 11) { ui.opsM = 0; ui.opsY++; }
      render(); break;

    case 'edit-tx': openTxForm(state.transactions.find((t) => t.id === id)); break;
    case 'edit-sub': openSubForm(state.subscriptions.find((s) => s.id === id)); break;
    case 'edit-debt': openDebtForm(state.debts.find((d) => d.id === id)); break;
    case 'edit-category': openCategoryForm(state.categories.find((c) => c.id === id)); break;
    case 'add-category': openCategoryForm(null); break;

    case 'pay-sub': paySubscription(id); break;
    case 'settle-debt': {
      const d = state.debts.find((x) => x.id === id);
      if (d) {
        const rem = debtRemaining(d);
        if (rem > 0) d.payments.push({ id: uid(), amount: rem, date: todayISO(), note: '' });
        d.settled = true;
        save(); render(); toast('Долг погашен 🎉');
      }
      break;
    }

    case 'add-debt-entry': openDebtEntryForm(debt, null); break;
    case 'edit-debt-entry': openDebtEntryForm(debt, id); break;
    case 'del-debt-entry': {
      const d = state.debts.find((x) => x.id === debt);
      if (!d) break;
      if (d.entries.length <= 1) { toast('Это единственная запись — удалите весь долг'); break; }
      if (confirm('Удалить запись?')) {
        d.entries = d.entries.filter((x) => x.id !== id);
        recalcDebtSettled(d);
        save(); render(); openDebtForm(d);
      }
      break;
    }
    case 'add-debt-payment': openDebtPaymentForm(debt, null); break;
    case 'edit-debt-payment': openDebtPaymentForm(debt, id); break;
    case 'del-debt-payment': {
      const d = state.debts.find((x) => x.id === debt);
      if (!d) break;
      if (confirm('Удалить погашение?')) {
        d.payments = d.payments.filter((x) => x.id !== id);
        recalcDebtSettled(d);
        save(); render(); openDebtForm(d);
      }
      break;
    }

    case 'del-tx':
      if (confirm('Удалить операцию?')) {
        const tx = state.transactions.find((t) => t.id === id);
        if (tx && tx.sourceId) state.monoDeleted.push(tx.sourceId);
        state.transactions = state.transactions.filter((t) => t.id !== id);
        save(); closeSheet(); render();
      }
      break;
    case 'del-sub':
      if (confirm('Удалить подписку?')) {
        state.subscriptions = state.subscriptions.filter((s) => s.id !== id);
        save(); closeSheet(); render();
      }
      break;
    case 'del-debt':
      if (confirm('Удалить долг?')) {
        state.debts = state.debts.filter((d) => d.id !== id);
        save(); closeSheet(); render();
      }
      break;
    case 'del-category':
      if (confirm('Удалить категорию? Её траты перейдут в «Другое».')) {
        state.transactions.forEach((t) => { if (t.categoryId === id) t.categoryId = FALLBACK_CATEGORY; });
        state.categories = state.categories.filter((c) => c.id !== id);
        save(); closeSheet(); render();
      }
      break;

    case 'set-base':
      state.settings.baseCurrency = val;
      save(); render();
      break;
    case 'save-manual-rate': {
      const raw = document.getElementById('manual-rate').value.trim();
      if (!raw) {
        state.settings.manualRate = null;
        toast('Курс снова автоматический');
      } else {
        const r = parseAmount(raw);
        if (!r) { toast('Некорректный курс'); return; }
        state.settings.manualRate = r;
        toast('Установлен курс 1 $ = ' + r.toFixed(2) + ' ₴');
      }
      save(); render();
      break;
    }

    case 'rate-refresh': handleRateRefresh(el); break;
    case 'mono-connect': handleMonoConnect(el); break;
    case 'mono-import': handleMonoImport(el); break;
    case 'mono-disconnect':
      if (confirm('Отключить Monobank? Импортированные операции останутся.')) {
        monoDisconnect(); render();
      }
      break;

    case 'srv-connect': handleServerConnect(el); break;
    case 'srv-sync': handleServerSync(el); break;
    case 'srv-disconnect':
      if (confirm('Отключить сервер? Уже загруженные операции останутся.')) {
        state.settings.serverUrl = '';
        state.settings.deviceToken = '';
        state.sync = { cursor: 0, lastAt: 0, notify: null, serverInfo: null };
        save(); render();
      }
      break;
    case 'mono-webhook': handleMonoWebhook(el); break;
    case 'mono-webhook-off': handleMonoWebhookOff(el); break;
    case 'push-enable': handlePushEnable(el); break;
    case 'push-disable': handlePushDisable(el); break;
    case 'push-test': handlePushTest(el); break;
    case 'notify-min-save': {
      const v = parseFloat(String(document.getElementById('notify-min').value).replace(',', '.')) || 0;
      if (v < 0) { toast('Сумма не может быть отрицательной'); return; }
      saveNotifySettings({ minAmount: v })
        .then(() => { render(); toast(v ? `Уведомления от ${fmtMoney(v, 'UAH')}` : 'Уведомления обо всех операциях'); })
        .catch((e) => toast(e.message));
      break;
    }
    case 'remind-save': {
      const days = parseInt(document.getElementById('remind-days').value, 10);
      const hour = parseInt(document.getElementById('remind-hour').value, 10);
      if (!(days >= 0 && days <= 30)) { toast('Дней должно быть от 0 до 30'); return; }
      if (!(hour >= 0 && hour <= 23)) { toast('Час должен быть от 0 до 23'); return; }
      state.settings.remindDays = days;
      state.settings.remindHour = hour;
      save();
      syncReminders()
        .then((n) => { render(); toast(`Расписание обновлено: ${n} напоминаний`); })
        .catch((e) => toast(e.message));
      break;
    }

    case 'diag-toggle': ui.showDiag = !ui.showDiag; render(); break;
    case 'tap-test': runTapTest(el); break;

    case 'export-data': exportData(); break;
    case 'wipe-data':
      if (confirm('Удалить ВСЕ данные без возможности восстановления?')) {
        state = defaultState();
        save(); render();
      }
      break;
  }
});

// клик по фону модалки закрывает её, по самому листу — нет
modalRoot.addEventListener('click', (e) => {
  if (e.target.classList && e.target.classList.contains('modal-backdrop')) closeSheet();
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('#sheet-form');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  if (kind === 'tx') submitTxForm(form);
  else if (kind === 'sub') submitSubForm(form);
  else if (kind === 'debt') submitDebtForm(form);
  else if (kind === 'debt-entry') submitDebtEntryForm(form);
  else if (kind === 'debt-payment') submitDebtPaymentForm(form);
  else if (kind === 'category') submitCategoryForm(form);
});

document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'import-file' && e.target.files[0]) {
    importDataFile(e.target.files[0]);
    e.target.value = '';
  }
  if (e.target && e.target.id === 'mono-days') {
    const custom = document.getElementById('mono-custom');
    if (custom) custom.hidden = e.target.value !== 'custom';
  }
  if (e.target && e.target.id === 'sub-is-credit') {
    const plan = document.getElementById('sub-plan');
    if (plan) plan.hidden = !e.target.checked;
  }
  const notifyToggle = e.target && e.target.closest('[data-action="notify-toggle"]');
  if (notifyToggle) {
    saveNotifySettings({ [notifyToggle.dataset.key]: notifyToggle.checked })
      .catch((err) => { toast(err.message); render(); });
  }
});

fabEl.addEventListener('click', () => {
  if (ui.screen === 'subs') openSubForm(null);
  else if (ui.screen === 'debts') openDebtForm(null);
  else openTxForm(null);
});

/* ================= запуск ================= */

// Высота приложения. В standalone-режиме iOS вебвью занимает весь экран,
// но innerHeight и visualViewport занижены на высоту статус-бара — для
// установленной PWA единственный честный источник — физический размер экрана.
// В обычном браузере, наоборот, честен visualViewport.
function setAppHeight() {
  let h;
  if (navigator.standalone === true) {
    const portrait = matchMedia('(orientation: portrait)').matches;
    h = portrait
      ? Math.max(screen.height, screen.width)
      : Math.min(screen.height, screen.width);
  } else {
    h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  }
  document.documentElement.style.setProperty('--app-h', Math.round(h) + 'px');
}
window.addEventListener('resize', setAppHeight);
window.addEventListener('orientationchange', setAppHeight);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', setAppHeight);
}
setAppHeight();

const initialScreen = location.hash.replace('#', '');
if (['home', 'ops', 'subs', 'debts', 'settings'].includes(initialScreen)) {
  ui.screen = initialScreen;
}

render();

refreshRate(false)
  .then((changed) => { if (changed) render(); })
  .catch(() => { /* останемся на сохранённом курсе */ });

/* Тихая синхронизация при запуске и возврате в приложение */
function backgroundSync() {
  if (!serverConfigured()) return;
  syncAll()
    .then((added) => { if (added) render(); })
    .catch(() => { /* нет сети — попробуем в следующий раз */ });
}
backgroundSync();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) backgroundSync();
});

if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
