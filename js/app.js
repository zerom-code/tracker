/* Интерфейс: отрисовка экранов, формы, обработка действий. */

const now = new Date();
const ui = {
  screen: 'home',
  opsFilter: 'all',            // all | expense | transfer | income
  opsCategory: null,           // null | categoryId
  opsY: now.getFullYear(),
  opsM: now.getMonth(),
  debtsTab: 'owe-me',          // owe-me | i-owe
  showDiag: false,
};

function pluralOps(n) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs >= 11 && abs <= 19) return 'операций';
  if (last === 1) return 'операция';
  if (last >= 2 && last <= 4) return 'операции';
  return 'операций';
}

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
  const renderers = {
    home: renderHome, ops: renderOps, subs: renderSubs,
    debts: renderDebts, settings: renderSettings,
  };
  const renderer = renderers[ui.screen] || renderHome;
  if (!renderers[ui.screen]) ui.screen = 'home';

  document.querySelectorAll('.tabbar button').forEach((b) => {
    b.classList.toggle('active', b.dataset.nav === ui.screen);
  });

  try {
    screenEl.innerHTML = renderer();
  } catch (err) {
    console.error('Render error:', err);
    screenEl.innerHTML = `<div class="card" style="margin:20px;text-align:center"><h3>Ошибка отображения</h3><p class="hint">${esc(err.message)}</p><button class="btn secondary" onclick="ui.screen='home';render()">На главную</button></div>`;
  }
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

  // топ категорий месяца
  const byCat = {};
  for (const t of txOfMonth(y, m, 'expense')) {
    const id = t.categoryId || FALLBACK_CATEGORY;
    byCat[id] = (byCat[id] || 0) + txBase(t);
  }
  // Категория «Переводы» отключена
  // if (transfersBase > 0) byCat[TRANSFERS_ROW] = transfersBase;
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
      <div class="card stat-card-interactive" data-action="nav-subs" role="button" tabindex="0" title="Перейти к платежам и рассрочкам">
        <div class="stat-label">Платежи в месяц ›</div>
        <div class="stat-value">${subs.main}</div>
        <div class="row-sub">${creditsLeft > 0 ? 'выплатить ещё ' + fmtMoney(creditsLeft, state.settings.baseCurrency) : '≈ ' + subs.other}</div>
      </div>
      <div class="card stat-card-interactive" data-action="refresh-rate-home" role="button" tabindex="0" title="Нажмите для обновления курса">
        <div class="stat-label">Курс доллара 🔄</div>
        <div class="stat-value">${effectiveRate() ? effectiveRate().toFixed(2) + ' ₴' : '—'}</div>
        <div class="row-sub">${state.settings.manualRate ? 'ручной курс' : esc(state.rate.source)}</div>
      </div>
      <div class="card stat-card-interactive" data-action="nav-debts" role="button" tabindex="0" title="Перейти к долгам">
        <div class="stat-label">Мне должны ›</div>
        <div class="stat-value green">${oweMe.main}</div>
      </div>
      <div class="card stat-card-interactive" data-action="nav-debts" role="button" tabindex="0" title="Перейти к долгам">
        <div class="stat-label">Я должен ›</div>
        <div class="stat-value red">${iOwe.main}</div>
      </div>
    </div>

    <div class="ai-card">
      <div class="ai-card-top">
        <div class="ai-card-title">
          <span>✨</span>
          <span>ИИ-Аналитик</span>
        </div>
        <span class="ai-card-badge">${esc(state.settings.openaiModel || 'GPT 5.6 Luna')}</span>
      </div>
      <div class="ai-card-sub" style="margin-bottom:10px">
        Задайте вопрос по тратам, товарам из чеков и оптимизации бюджета.
      </div>
      <button type="button" class="btn secondary" data-action="open-ai-chat" style="padding:10px;font-size:14px;width:100%">💬 Спросить у ИИ</button>
    </div>

    ${cats.length ? `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h3 style="margin-bottom:0">Категории за месяц</h3>
        <span style="color:var(--muted);font-size:12px">нажмите для деталей</span>
      </div>
      ${cats.map(([id, sum]) => {
        const c = id === TRANSFERS_ROW ? { emoji: '🔁', name: 'Переводы' } : categoryById(id);
        return `
        <div class="cat-bar" data-action="home-cat-click" data-cat="${esc(id)}" role="button" tabindex="0">
          <div class="cat-bar-top">
            <span class="name">${c.emoji} ${esc(c.name)}</span>
            <span class="val">${fmtMoney(sum, state.settings.baseCurrency)} <span class="cat-arrow">›</span></span>
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
  const { opsY: y, opsM: m, opsCategory } = ui;
  // Переводы между своими картами полностью исключаются из логов операций
  const matchesFilter = (t) => {
    // Внутренние переводы между личными картами скрыты из списка
    if (t.internal) return false;

    let typeOk = true;
    if (ui.opsFilter === 'all') typeOk = true;
    else if (ui.opsFilter === 'expense') typeOk = isOutflow(t);
    else typeOk = t.type === ui.opsFilter;
    if (!typeOk) return false;

    if (opsCategory) {
      if (t.type === 'transfer') return false;
      const catId = t.categoryId || FALLBACK_CATEGORY;
      if (catId !== opsCategory) return false;
    }
    return true;
  };

  const monthTx = txOfMonth(y, m).filter(matchesFilter);
  const sorted = monthTx.sort((a, b) =>
    a.date === b.date ? (b.ts || 0) - (a.ts || 0) : (a.date < b.date ? 1 : -1));

  const expSum = sumBase(outflowOfMonth(y, m)); // вместе с переводами
  const trSum = sumBase(txOfMonth(y, m, 'transfer'));
  const inSum = sumBase(txOfMonth(y, m, 'income'));

  const activeCat = opsCategory ? categoryById(opsCategory) : null;
  const catSum = opsCategory ? sumBase(monthTx) : 0;
  const catPct = (opsCategory && expSum > 0) ? Math.round(catSum / expSum * 100) : 0;

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

    <div class="segmented seg-tight" style="margin-bottom:10px">
      <button data-action="ops-filter" data-val="all" class="${ui.opsFilter === 'all' ? 'active' : ''}">Все</button>
      <button data-action="ops-filter" data-val="expense" class="${ui.opsFilter === 'expense' ? 'active' : ''}">Расходы</button>
      <!-- Категория Переводы отключена -->
      <!-- <button data-action="ops-filter" data-val="transfer" class="${ui.opsFilter === 'transfer' ? 'active' : ''}">Переводы</button> -->
      <button data-action="ops-filter" data-val="income" class="${ui.opsFilter === 'income' ? 'active' : ''}">Доходы</button>
    </div>

    ${ui.opsFilter !== 'transfer' ? `
    <div class="ops-filter-row">
      <div class="cat-select-wrap">
        <select id="ops-cat-select" aria-label="Фильтр по категории">
          <option value="">Все категории</option>
          ${state.categories.map((c) => `
            <option value="${esc(c.id)}" ${opsCategory === c.id ? 'selected' : ''}>
              ${esc(c.emoji)} ${esc(c.name)}
            </option>
          `).join('')}
        </select>
        <span class="cat-select-arrow">▾</span>
      </div>
    </div>` : ''}

    ${opsCategory ? `
    <div class="active-filter-badge">
      <div class="filter-badge-left">
        <span class="filter-emoji">${activeCat.emoji}</span>
        <div class="filter-texts">
          <div class="filter-title">${esc(activeCat.name)}</div>
          <div class="filter-sub">${monthTx.length} ${pluralOps(monthTx.length)}${catPct ? ' · ' + catPct + '% от расходов' : ''}</div>
        </div>
      </div>
      <button class="filter-clear-btn" data-action="ops-cat-clear" title="Сбросить фильтр">✕ Сбросить</button>
    </div>` : ''}

    <div class="card">
      ${opsCategory ? `
      <div class="cat-summary-line">
        <div>
          <div class="stat-label">По категории «${esc(activeCat.name)}»</div>
          <div class="big-amount" style="font-size:24px;margin-top:2px">${fmtMoney(catSum, state.settings.baseCurrency)}</div>
        </div>
        <div style="text-align:right">
          <div class="stat-label">Всего расходов</div>
          <div style="font-size:16px;font-weight:700;color:var(--muted);margin-top:4px">${fmtMoney(expSum, state.settings.baseCurrency)}</div>
        </div>
      </div>` : `
      <div class="sums-line">
        <span>Расходы<b>${fmtMoney(expSum, state.settings.baseCurrency)}</b></span>
        <span>Доходы<b style="color:var(--green)">+${fmtMoney(inSum, state.settings.baseCurrency)}</b></span>
      </div>`}
    </div>

    ${groups.length ? groups.map((g) => `
      <div class="group-label">${fmtDay(g.date)}</div>
      <div class="card" style="padding:4px 16px">
        ${g.items.map(txRow).join('')}
      </div>
    `).join('') : `
    <div class="empty">
      <div class="empty-icon">${opsCategory ? activeCat.emoji : '🧾'}</div>
      ${opsCategory
        ? `В категории «${esc(activeCat.name)}» за ${MONTHS_RU_PREP[m]} ${y} операций нет.`
        : `За ${MONTHS_RU_PREP[m]} ${y} операций нет.<br>Добавьте трату кнопкой «+».`}
    </div>`}
  `;
}

function txRow(t) {
  const isTr = t.type === 'transfer';
  const isIn = t.type === 'income';
  const cat = isTr ? null : categoryById(t.categoryId);
  const emoji = t.internal ? '🔄'
    : (isTr ? '🔁' : (isIn && (!t.categoryId || t.categoryId === FALLBACK_CATEGORY) ? '💰' : cat.emoji));
  const title = t.description || (isTr ? 'Перевод' : (isIn ? 'Доход' : cat.name));
  const subParts = [];
  if (t.internal) subParts.push('Между своими');
  else if (isTr) subParts.push('Перевод');
  else if (isIn) subParts.push(t.categoryId && t.categoryId !== FALLBACK_CATEGORY ? 'Доход · ' + cat.name : 'Доход');
  else subParts.push(cat.name);
  if (t.source === 'mono') subParts.push('Monobank');
  if (t.receiptUrl) subParts.push('🧾 Чек');
  const amountCls = t.internal ? 'internal' : (isIn ? 'positive' : (isTr ? 'transfer' : 'expense'));
  return `
    <div class="row" data-action="edit-tx" data-id="${t.id}">
      <div class="row-emoji">${emoji}</div>
      <div class="row-main">
        <div class="row-title">${esc(title)}</div>
        <div class="row-sub">${esc(subParts.join(' · '))}</div>
      </div>
      <div class="row-right">
        <div class="row-amount ${amountCls}">${isIn ? '+' : '−'}${fmtMoney(t.amount, t.currency)}</div>
        ${t.altAmount ? `<div class="row-sub">≈ ${fmtMoney(t.altAmount, t.altCurrency)}</div>` : ''}
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
  const earlyBtn = credit && s.plan && s.plan.paid < s.plan.total
    ? `<button type="button" class="btn-xs-early" data-action="pay-sub-early" data-id="${s.id}" title="Внести досрочный платёж (дата следующего списания не изменится)">⚡ Досрочно</button>`
    : '';

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
        ${earlyBtn}
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

  const cards = state.mono.accounts.filter((a) => a.supported);
  const lastCard = cards.some((a) => a.id === s.monoLastAccount)
    ? s.monoLastAccount : (cards[0] && cards[0].id);

  const monoBlock = s.monoToken && state.mono.accounts.length ? `
    <div class="row-sub" style="margin-bottom:8px">Подключено: <b style="color:var(--text)">${esc(state.mono.clientName || 'клиент Monobank')}</b></div>
    <div class="field">
      <label>Карта</label>
      <select id="mono-acc">
        ${cards.map((a) => `
          <option value="${esc(a.id)}" ${a.id === lastCard ? 'selected' : ''}>
            ${esc(a.maskedPan)} · ${esc(a.currency)}${a.type ? ' · ' + esc(a.type) : ''}
          </option>`).join('')}
      </select>
    </div>
    <div class="field">
      <label>Период</label>
      <select id="mono-days">
        <option value="today" selected>сегодня</option>
        <option value="7">последние 7 дней</option>
        <option value="31">последние 31 день</option>
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
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h3 style="margin-bottom:0">Искусственный интеллект (OpenAI)</h3>
        <span class="ai-card-badge">${esc(s.openaiModel || 'GPT 5.6 Luna')}</span>
      </div>
      <div class="field">
        <label>API-ключ OpenAI</label>
        <div class="field-split">
          <input id="openai-key" type="password" autocomplete="off" autocapitalize="off" placeholder="sk-proj-..." value="${esc(s.openaiKey || '')}">
          <button class="btn small secondary" data-action="toggle-key-visibility" style="flex:0 0 auto">👁</button>
        </div>
      </div>
      <div class="field">
        <label>Модель</label>
        <input id="openai-model" type="text" placeholder="gpt-5.6-luna" value="${esc(s.openaiModel || 'gpt-5.6-luna')}">
        <div class="chips" id="openai-model-chips" style="margin-top:6px;gap:6px">
          ${['gpt-5.6-luna', 'gpt-4o-mini', 'gpt-4o', 'o1-mini'].map((m) => `
            <button type="button" class="chip ${s.openaiModel === m ? 'active' : ''}" data-action="set-ai-model" data-val="${m}">${m}</button>
          `).join('')}
        </div>
      </div>
      <div class="field">
        <label>Кастомный Base URL (необязательно)</label>
        <input id="openai-base-url" type="text" placeholder="https://api.openai.com/v1/chat/completions" value="${esc(s.openaiBaseUrl || '')}">
      </div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn" data-action="save-ai-settings" style="flex:1">Сохранить</button>
        <button class="btn secondary" data-action="test-ai-key" style="flex:1">Проверить связь</button>
      </div>
      <p class="hint">Ключ хранится локально на телефоне. Модель видит финансовую статистику и товары из чеков для ответа на ваши вопросы.</p>
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

    <p class="hint" style="text-align:center">
      <span data-action="diag-toggle" style="cursor:pointer">Трекер трат · версия 52</span> ·
      <span data-action="force-sw-update" style="cursor:pointer;color:var(--accent);font-weight:600">🔄 Обновить</span>
    </p>
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
  // банк уже что-то присылал — значит вебхук точно зарегистрирован,
  // даже если включали его до появления этой отметки
  const hookOn = Boolean(state.sync.webhookAt || info.lastHookAt);
  const err = state.sync.lastError;

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

    ${err ? `
    <div class="status-row bad" style="margin-bottom:8px">
      <span>Синхронизация не проходит: ${esc(err)}</span>
    </div>
    <button class="btn small secondary" data-action="srv-diagnose" style="margin-bottom:10px">Проверить связь</button>
    ${/токен/i.test(err) ? '<p class="hint">Похоже, токен на сервере изменился — отключите сервер ниже и подключите заново с новым токеном.</p>' : ''}
    ` : ''}

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
      <div class="status-row ok"><span>✓ Уведомления включены</span></div>
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
    'адрес приложения: ' + location.origin,
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

let activeScannerStream = null;
let scanAnimTimer = null;

function stopScannerCamera() {
  if (scanAnimTimer) {
    clearInterval(scanAnimTimer);
    scanAnimTimer = null;
  }
  if (activeScannerStream) {
    activeScannerStream.getTracks().forEach((tr) => tr.stop());
    activeScannerStream = null;
  }
}

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
  stopScannerCamera();
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

/* Эквивалент в другой валюте: банк присылает его не всегда (для прямого
   перевода с долларовой карты гривневая сумма в выписку не попадает),
   поэтому её можно вписать вручную — она видна в списке и участвует
   в сверке с долгами. */
function altFieldLabel(currency) {
  const other = otherCurrency(currency);
  return `Сумма в ${other === 'UAH' ? '₴' : '$'} по курсу банка (необязательно)`;
}

function altFieldPlaceholder(t) {
  const amount = parseAmount(t.amount) || 0;
  if (!amount || !effectiveRate()) return 'например 1750';
  const est = convert(amount, t.currency, otherCurrency(t.currency));
  return 'примерно ' + est.toFixed(2);
}

function captureCurrentTxForm() {
  const form = document.getElementById('sheet-form');
  if (!form || form.dataset.form !== 'tx') return null;
  const id = form.dataset.id || null;
  const original = id ? state.transactions.find((x) => x.id === id) : null;
  const catBtn = document.querySelector('#tx-cats .chip.active');
  const receiptUrlEl = document.getElementById('tx-receipt-url');

  // Сбор позиций товаров из формы
  const rows = document.querySelectorAll('.tx-item-row');
  const items = [];
  rows.forEach((row) => {
    const nameInput = row.querySelector('.tx-item-name');
    const priceInput = row.querySelector('.tx-item-price');
    const name = nameInput ? nameInput.value.trim() : '';
    const price = priceInput ? parseAmount(priceInput.value) : 0;
    if (name || price > 0) {
      items.push({ name: name || 'Товар', price, quantity: 1, total: price });
    }
  });

  return {
    id,
    type: segValue('#tx-type-seg') || 'expense',
    amount: document.getElementById('tx-amount') ? document.getElementById('tx-amount').value : '',
    currency: segValue('#tx-cur-seg') || 'UAH',
    altAmount: document.getElementById('tx-alt') ? document.getElementById('tx-alt').value : '',
    altCurrency: original ? original.altCurrency : null,
    categoryId: catBtn ? catBtn.dataset.cat : (original ? original.categoryId : null),
    description: document.getElementById('tx-desc') ? document.getElementById('tx-desc').value : '',
    date: document.getElementById('tx-date') ? document.getElementById('tx-date').value : todayISO(),
    internal: document.getElementById('tx-internal') ? document.getElementById('tx-internal').checked : false,
    receiptUrl: receiptUrlEl ? receiptUrlEl.value : (original ? original.receiptUrl : ''),
    receiptItems: items.length ? items : ((ui.tempTxForm && ui.tempTxForm.receiptItems) || (original ? original.receiptItems : null) || []),
    source: original ? original.source : 'manual',
    sourceId: original ? original.sourceId : null,
  };
}

function openTxForm(tx) {
  const isNew = !tx;
  const defaultType = { transfer: 'transfer', income: 'income' }[ui.opsFilter] || 'expense';
  const t = tx || {
    type: ui.screen === 'ops' ? defaultType : 'expense',
    amount: '', currency: state.settings.baseCurrency,
    categoryId: (ui.screen === 'ops' && ui.opsCategory) ? ui.opsCategory : null,
    description: '', date: todayISO(), receiptUrl: '', receiptItems: [],
  };

  openSheet(`
    ${sheetHead(isNew ? 'Новая операция' : 'Изменить операцию')}
    <form id="sheet-form" data-form="tx" data-id="${tx ? (tx.id || '') : ''}">
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
      <div class="field" id="tx-alt-field">
        <label id="tx-alt-label">${altFieldLabel(t.currency)}</label>
        <input id="tx-alt" type="text" inputmode="decimal"
               placeholder="${altFieldPlaceholder(t)}"
               value="${t.altAmount && t.altCurrency === otherCurrency(t.currency) ? t.altAmount : ''}">
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
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <label style="margin-bottom:0">${t.type === 'transfer' ? 'Кому / описание' : 'Описание'}</label>
          <button type="button" class="btn-link-action" data-action="scan-receipt-qr">📷 Чек по QR</button>
        </div>
        <input id="tx-desc" type="text" placeholder="${t.type === 'transfer' ? 'например: перевод' : (t.type === 'income' ? 'например: зарплата' : 'например: покупки')}" value="${esc(t.description)}">
        <input id="tx-receipt-url" type="hidden" value="${esc(t.receiptUrl || '')}">
        <div id="tx-receipt-preview" class="receipt-attached-row" style="${(t.receiptUrl || (t.receiptItems && t.receiptItems.length)) ? '' : 'display:none'}">
          <span>🧾 Чек прикреплён</span>
          <a href="${esc(t.receiptUrl || '')}" id="tx-receipt-link" target="_blank" rel="noopener" class="receipt-link-btn" ${t.receiptUrl ? '' : 'style="display:none"'}>Открыть оригинал ↗</a>
          <button type="button" class="receipt-del-btn" data-action="remove-tx-receipt" title="Открепить чек">✕</button>
        </div>
        ${t.receiptUrl && (!t.receiptItems || !t.receiptItems.length) ? `
          <div style="margin-top:6px;display:flex;justify-content:space-between;align-items:center;padding:7px 10px;border-radius:8px;background:rgba(255,255,255,0.03);border:1px dashed var(--border)">
            <span style="font-size:12px;color:var(--muted)">Товары не загружены</span>
            <button type="button" class="btn-link-action" data-action="reload-tx-receipt-items" style="color:var(--accent);font-size:12px;font-weight:600">🔄 Загрузить товары из ДПС</button>
          </div>
        ` : ''}
      </div>

      <div class="field" id="tx-receipt-items-container" style="margin-top:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <label style="margin-bottom:0">Товары и позиции</label>
          <button type="button" class="btn-link-action" data-action="add-tx-item" style="color:var(--accent);font-size:12px;font-weight:600">+ Добавить товар</button>
        </div>
        <div id="tx-items-list" style="display:flex;flex-direction:column;gap:6px">
          ${(t.receiptItems || []).map((it, i) => `
            <div class="tx-item-row" data-idx="${i}" style="display:flex;gap:6px;align-items:center">
              <input type="text" class="tx-item-name" placeholder="Название товара" value="${esc(it.name || '')}" style="flex:2;padding:7px 10px;font-size:13px">
              <input type="text" inputmode="decimal" class="tx-item-price" placeholder="Цена" value="${it.price || it.total || ''}" style="flex:1;padding:7px 8px;font-size:13px">
              <button type="button" class="receipt-del-btn" data-action="del-tx-item" data-idx="${i}" title="Удалить" style="color:var(--red);padding:2px 8px">✕</button>
            </div>
          `).join('')}
        </div>
        ${(t.receiptItems && t.receiptItems.length > 0) ? `
          <button type="button" class="btn-link-action" data-action="calc-tx-items-sum" style="margin-top:6px;font-size:12px;color:var(--accent);font-weight:600">
            ∑ Подставить сумму товаров (${fmtMoney(t.receiptItems.reduce((s, x) => s + (x.total || x.price || 0), 0), t.currency || 'UAH')}) в поле суммы
          </button>
        ` : ''}
      </div>

      <div class="field" id="tx-internal-field" ${t.type === 'expense' ? 'hidden' : ''}>
        <label style="display:flex;align-items:center;gap:10px;font-size:15px;color:var(--text)">
          <input id="tx-internal" type="checkbox" ${t.internal ? 'checked' : ''}>
          Между своими картами (не считать в итогах)
        </label>
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
  const current = captureCurrentTxForm();
  const amount = parseAmount(current.amount);
  if (!amount) { toast('Введите сумму больше нуля'); return; }
  const type = current.type;
  const currency = current.currency;
  const date = current.date;
  const description = current.description;
  const categoryId = type !== 'transfer' ? (current.categoryId || FALLBACK_CATEGORY) : null;
  const internal = type !== 'expense' && current.internal;
  const altValue = parseAmount(current.altAmount);
  const altAmount = altValue || null;
  const altCurrency = altValue ? otherCurrency(currency) : null;
  const receiptUrl = current.receiptUrl || null;
  const receiptItems = current.receiptItems || [];

  const id = form.dataset.id;
  if (id) {
    const t = state.transactions.find((x) => x.id === id);
    if (!t) return;
    Object.assign(t, { type, amount, currency, date, description, categoryId, internal, altAmount, altCurrency, receiptUrl, receiptItems });
  } else {
    state.transactions.push({
      id: uid(), ts: Date.now(), type, amount, currency, date, description, categoryId,
      internal, altAmount, altCurrency, receiptUrl, receiptItems, source: 'manual', sourceId: null,
    });
  }
  const [ty, tm] = date.split('-').map(Number);
  if (ty && tm) { ui.opsY = ty; ui.opsM = tm - 1; }
  save(); closeSheet(); render();
}

/* --- ИИ-финансовый аналитик (OpenAI) --- */

function formatAiMarkdown(raw) {
  if (!raw) return '';
  let text = esc(raw);
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  const lines = text.split('\n');
  let inList = false;
  let inOl = false;
  let out = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (/^[•\-*]\s+(.+)$/.test(line)) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${line.replace(/^[•\-*]\s+/, '')}</li>`);
    } else if (/^\d+\.\s+(.+)$/.test(line)) {
      if (inList) { out.push('</ul>'); inList = false; }
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push(`<li>${line.replace(/^\d+\.\s+/, '')}</li>`);
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (line) out.push(`<p>${line}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  if (inOl) out.push('</ol>');
  return out.join('');
}

function openAiChatModal(initialPrompt = '') {
  ui.aiChatHistory = ui.aiChatHistory || [];
  const modelName = state.settings.openaiModel || 'GPT 5.6 Luna';

  const historyHtml = ui.aiChatHistory.length ? ui.aiChatHistory.map((m) => `
    <div class="ai-msg ${m.role === 'user' ? 'user' : 'assistant'}">
      ${m.role === 'user' ? esc(m.content) : formatAiMarkdown(m.content)}
    </div>
  `).join('') : `
    <div class="ai-msg assistant">
      👋 Привет! Я ваш финансовый ИИ-аналитик на базе <strong>${esc(modelName)}</strong>.<br><br>
      Я знаю все ваши траты, категории, подписки и товары из фискальных чеков.<br>
      Спросите меня о чем угодно!
    </div>
  `;

  openSheet(`
    ${sheetHead('✨ ИИ-Аналитик (' + esc(modelName) + ')')}
    <div class="ai-chat-sheet">
      <div class="ai-quick-grid" style="margin-bottom:8px">
        <button type="button" class="ai-quick-chip" data-action="ai-chat-prompt" data-prompt="На какие продукты я потратил больше всего денег?">🛒 Топ продуктов</button>
        <button type="button" class="ai-quick-chip" data-action="ai-chat-prompt" data-prompt="Проанализируй мои расходы за этот месяц и найди аномалии">📊 Анализ за месяц</button>
        <button type="button" class="ai-quick-chip" data-action="ai-chat-prompt" data-prompt="Где я могу сэкономить и оптимизировать траты?">💡 Где сэкономить?</button>
        <button type="button" class="ai-quick-chip" data-action="ai-chat-prompt" data-prompt="Сколько я потратил на сладости, кофе и перекусы?">☕ Сладости и кофе</button>
      </div>

      <div class="ai-chat-messages" id="ai-chat-msgs">
        ${historyHtml}
      </div>

      <form id="ai-chat-form" class="ai-input-bar" onsubmit="return false;">
        <input id="ai-chat-input" type="text" placeholder="Задайте вопрос о финансах…" value="${esc(initialPrompt)}" autocomplete="off">
        <button type="submit" class="ai-send-btn" data-action="send-ai-msg" aria-label="Отправить">↑</button>
      </form>

      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px">
        <button type="button" class="btn-link-action" data-action="clear-ai-history" style="font-size:12px;color:var(--muted)">🗑️ Очистить диалог</button>
        <span style="font-size:11px;color:var(--muted)">Модель: ${esc(modelName)}</span>
      </div>
    </div>
  `);

  const msgsEl = document.getElementById('ai-chat-msgs');
  if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;

  if (initialPrompt) {
    setTimeout(() => {
      sendAiChatMessage(initialPrompt);
    }, 150);
  }
}

async function sendAiChatMessage(text) {
  const prompt = text || (document.getElementById('ai-chat-input') && document.getElementById('ai-chat-input').value.trim());
  if (!prompt) return;

  const inputEl = document.getElementById('ai-chat-input');
  if (inputEl) inputEl.value = '';

  const msgsEl = document.getElementById('ai-chat-msgs');
  if (!msgsEl) return;

  ui.aiChatHistory = ui.aiChatHistory || [];

  // Добавляем сообщение пользователя
  const userDiv = document.createElement('div');
  userDiv.className = 'ai-msg user';
  userDiv.textContent = prompt;
  msgsEl.appendChild(userDiv);

  // Добавляем индикатор печати
  const typingDiv = document.createElement('div');
  typingDiv.className = 'ai-msg assistant ai-typing';
  typingDiv.id = 'ai-typing-indicator';
  typingDiv.innerHTML = '<span></span><span></span><span></span>';
  msgsEl.appendChild(typingDiv);
  msgsEl.scrollTop = msgsEl.scrollHeight;

  try {
    const answer = await askAiAssistant(prompt, ui.aiChatHistory);
    ui.aiChatHistory.push({ role: 'user', content: prompt });
    ui.aiChatHistory.push({ role: 'assistant', content: answer });

    const typingEl = document.getElementById('ai-typing-indicator');
    if (typingEl) typingEl.remove();

    const ansDiv = document.createElement('div');
    ansDiv.className = 'ai-msg assistant';
    ansDiv.innerHTML = formatAiMarkdown(answer);
    msgsEl.appendChild(ansDiv);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  } catch (err) {
    const typingEl = document.getElementById('ai-typing-indicator');
    if (typingEl) typingEl.remove();

    const errDiv = document.createElement('div');
    errDiv.className = 'ai-msg assistant';
    errDiv.style.borderColor = 'var(--red)';
    errDiv.innerHTML = `⚠️ <strong>Ошибка:</strong> ${esc(err.message)}`;
    msgsEl.appendChild(errDiv);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }
}

/* --- Сканирование и обработка QR-кода чека --- */

function openQrScannerModal() {
  stopScannerCamera();
  const hasCamera = typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;

  openSheet(`
    ${sheetHead('Сканирование QR чека')}
    <div class="scanner-modal-body">
      <div class="scanner-container">
        <video id="scanner-video" playsinline muted autoplay></video>
        <div class="scanner-overlay">
          <div class="scanner-target">
            <div class="scanner-laser"></div>
          </div>
        </div>
      </div>

      <div class="scanner-actions" style="display:flex;flex-direction:column;gap:8px">
        <label class="btn secondary" style="cursor:pointer;margin-top:0;display:block;text-align:center">
          📁 Выбрать фото чека из галереи
          <input id="scanner-file" type="file" accept="image/*" style="display:none">
        </label>
        <button type="button" class="btn secondary" data-action="paste-receipt-data">📋 Вставить ссылку / текст чека</button>
        <div id="scanner-manual-paste-box" style="display:none;flex-direction:column;gap:6px;margin-top:4px">
          <textarea id="scanner-paste-input" rows="3" placeholder="Вставьте ссылку, XML или текст чека сюда…" style="width:100%;border-radius:10px;padding:8px 12px;background:rgba(255,255,255,0.06);border:1px solid var(--border);color:var(--text);font-size:13px;resize:none"></textarea>
          <button type="button" class="btn" data-action="process-manual-receipt" style="padding:9px;font-size:14px">Распознать чек ✨</button>
        </div>
      </div>
      <p class="hint" style="text-align:center;margin-top:10px">
        Наведите камеру на QR-код внизу фискального чека (ДПС, Checkbox, Вчасно и др.)
      </p>
    </div>
  `);

  const video = document.getElementById('scanner-video');
  const fileInput = document.getElementById('scanner-file');

  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      if (e.target.files && e.target.files[0]) {
        toast('Считываем фото чека…');
        try {
          const rawText = await qrEngine.decodeFile(e.target.files[0]);
          if (rawText) {
            stopScannerCamera();
            handleScannedReceipt(rawText);
          } else {
            toast('QR-код на фото не обнаружен. Сфотографируйте ближе и четче.');
          }
        } catch (err) {
          toast('Не удалось прочитать фото: ' + err.message);
        }
        e.target.value = '';
      }
    });
  }

  if (!hasCamera) {
    toast('Камера недоступна. Выберите фото чека из галереи.');
    return;
  }

  navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
  }).then((stream) => {
    activeScannerStream = stream;
    if (video) {
      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      video.setAttribute('webkit-playsinline', 'true');
      video.onloadedmetadata = () => {
        video.play().catch(() => {});
      };
      video.play().catch(() => {});
    }

    let isScanning = false;
    const checkFrame = async () => {
      if (isScanning || !activeScannerStream || !video || video.readyState < 2 || !video.videoWidth) return;
      isScanning = true;
      try {
        const rawText = await qrEngine.decodeSource(video);
        if (rawText) {
          stopScannerCamera();
          if (navigator.vibrate) navigator.vibrate(50);
          handleScannedReceipt(rawText);
          return;
        }
      } catch (e) {
        // продолжаем поиск
      } finally {
        isScanning = false;
      }
    };

    scanAnimTimer = setInterval(checkFrame, 180);
  }).catch((err) => {
    console.warn('Camera error:', err);
    toast('Нет доступа к камере. Разрешите доступ или выберите фото.');
  });
}

async function handleScannedReceipt(rawText) {
  const parsed = parseReceiptQr(rawText);
  if (!parsed) {
    toast('В этом тексте или QR-коде нет данных фискального чека');
    if (ui.tempTxForm) openTxForm(ui.tempTxForm);
    return;
  }

  toast('Загружаем данные чека…');
  try {
    const detailed = await fetchReceiptDetails(parsed);
    openReceiptPreviewModal(detailed);
  } catch (err) {
    openReceiptPreviewModal(parsed);
  }
}

function openReceiptPreviewModal(receipt) {
  ui.pendingReceipt = receipt;
  const storeHint = ui.tempTxForm ? (ui.tempTxForm.description || '') : '';
  const storeName = receipt.storeName || storeHint || receipt.typeName || 'Фіскальний чек';
  const categoryId = detectCategoryFromItems(receipt.items || [], storeName);
  const matchedCat = categoryId ? categoryById(categoryId) : null;
  const formattedDesc = formatReceiptDescription(receipt, storeHint);

  const itemsHtml = receipt.items && receipt.items.length ? `
    <div class="receipt-items-list" style="margin-top:6px;max-height:220px;overflow-y:auto;background:rgba(255,255,255,0.03);padding:6px 10px;border-radius:10px;border:1px solid var(--border)">
      ${receipt.items.map((it) => `
        <div class="receipt-item-row" style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;font-size:13px;border-bottom:1px solid rgba(255,255,255,0.04)">
          <span class="item-name" style="color:var(--text);font-weight:500">${esc(it.name)}</span>
          <span class="item-price" style="color:var(--muted);white-space:nowrap;margin-left:8px;font-variant-numeric:tabular-nums">${it.quantity > 1 ? it.quantity + ' × ' : ''}${fmtMoney(it.total, 'UAH')}</span>
        </div>
      `).join('')}
    </div>
  ` : '';

  openSheet(`
    ${sheetHead('Чек распознан 🎉')}
    <div class="receipt-preview-card">
      <div class="rate-line" style="margin-bottom:8px;align-items:flex-start">
        <div style="min-width:0;flex:1;margin-right:10px;word-break:break-word">
          <div style="font-weight:700;font-size:18px;color:var(--text);line-height:1.25">${esc(storeName)}</div>
          <div class="row-sub">${receipt.id ? 'Чек № ' + esc(receipt.id) : ''}${receipt.fn ? ' · ФН ' + esc(receipt.fn) : ''}</div>
        </div>
        ${receipt.amount ? `<div class="big-amount" style="font-size:22px;white-space:nowrap;flex-shrink:0;text-align:right">${fmtMoney(receipt.amount, 'UAH')}</div>` : ''}
      </div>

      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px">
        ${receipt.date ? `<span class="chip active" style="font-size:12px;padding:4px 8px">📅 ${receipt.date}${receipt.time ? ' ' + receipt.time : ''}</span>` : ''}
        ${matchedCat ? `<span class="chip" style="font-size:12px;padding:4px 8px">${matchedCat.emoji} ${esc(matchedCat.name)}</span>` : ''}
      </div>

      ${itemsHtml}

      <div class="field" style="margin-top:12px">
        <label>Описание для операции</label>
        <input id="preview-receipt-desc" type="text" value="${esc(formattedDesc)}">
        <p class="hint">Уточните описание при необходимости</p>
      </div>

      <button class="btn" data-action="apply-receipt-save">Сохранить операцию с чеком ✨</button>
      <button class="btn secondary" data-action="apply-receipt-full" style="margin-top:8px">Отредактировать в форме</button>
      <button class="btn secondary" data-action="apply-receipt-desc-only" style="margin-top:8px">Вставить только описание</button>
      ${receipt.rawUrl ? `<a href="${esc(receipt.rawUrl)}" target="_blank" rel="noopener" class="btn secondary" style="margin-top:8px;text-align:center;text-decoration:none;display:block">Открыть оригинал на сайте ДПС ↗</a>` : ''}
    </div>
  `);
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

/* ---------- автопогашение долгов по операциям ---------- */

function applyDebtRepayment(m) {
  // в заметке платежа остаётся, каким переводом погашен долг
  const noteParts = [m.tx.description || 'Перевод'];
  if (m.tx.currency !== m.debt.currency) {
    noteParts.push(fmtMoney(m.tx.amount, m.tx.currency));
  }
  m.debt.payments.push({
    id: uid(),
    amount: m.amount,
    date: m.tx.date,
    note: noteParts.join(' · '),
    txId: m.tx.id,
  });
  recalcDebtSettled(m.debt);
}

function offerDebtSuggestions() {
  const matches = collectDebtSuggestions();
  if (!matches.length) return;
  let applied = 0;

  for (const m of matches) {
    state.debtSuggestSeen.push(m.tx.sourceId); // повторно не спрашиваем
    const shown = m.tx.altAmount && m.tx.altCurrency === m.debt.currency
      ? `${fmtMoney(m.tx.amount, m.tx.currency)} (${fmtMoney(m.tx.altAmount, m.tx.altCurrency)})`
      : fmtMoney(m.tx.amount, m.tx.currency);
    const question = m.tx.type === 'transfer'
      ? `Перевод «${m.tx.description || 'без описания'}» на ${shown} совпадает с вашим долгом «${m.debt.person}» (осталось ${fmtMoney(m.amount, m.debt.currency)}).\n\nОтметить долг погашенным этим переводом?`
      : `Поступление «${m.tx.description || 'без описания'}» на ${shown} совпадает с долгом «${m.debt.person}» перед вами (осталось ${fmtMoney(m.amount, m.debt.currency)}).\n\nОтметить долг погашенным?`;
    if (confirm(question)) {
      applyDebtRepayment(m);
      applied++;
    }
  }

  if (state.debtSuggestSeen.length > 500) {
    state.debtSuggestSeen = state.debtSuggestSeen.slice(-500);
  }
  save();
  if (applied) {
    render();
    toast(applied === 1 ? 'Долг погашен 🎉' : `Погашено долгов: ${applied} 🎉`);
  }
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

function paySubscriptionEarly(id) {
  const s = state.subscriptions.find((x) => x.id === id);
  if (!s || !isCredit(s)) return;
  state.transactions.push({
    id: uid(), ts: Date.now(), type: 'expense',
    amount: s.amount, currency: s.currency,
    categoryId: 'credit', description: `${s.name} (досрочно)`,
    date: todayISO(), source: 'manual', sourceId: null,
  });

  s.plan.paid = Math.min(s.plan.paid + 1, s.plan.total);
  if (s.plan.paid >= s.plan.total) {
    s.active = false;
    save(); render();
    toast(`«${s.name}» выплачено полностью досрочно 🎉`);
    return;
  }

  // Дата следующего регулярного платежа сохраняется без изменений
  save(); render();
  toast(`Досрочный платёж ${s.plan.paid} из ${s.plan.total} записан (дата сохранена)`);
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
  if (sel === 'today') {
    return { fromSec: Math.floor(parseISO(todayISO()).getTime() / 1000), toSec: nowSec };
  }
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
  const acc = document.getElementById('mono-acc');
  if (!acc || !acc.value) { toast('Нет доступных карт — переподключите Monobank'); return; }
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
    state.settings.monoLastAccount = acc.value; // в следующий раз выберется сама
    save();
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

    // операции из чёрного списка возвращаем только с согласия
    if (r.tombstoned.length && confirm(
      `${r.tombstoned.length === 1 ? 'Одну операцию из этого периода вы раньше удалили' : `Операций из этого периода, удалённых вами раньше: ${r.tombstoned.length}`} из трекера.\n\nВернуть ${r.tombstoned.length === 1 ? 'её' : 'их'}?`)) {
      const restored = monoRestoreItems(r.tombstoned, acc.value);
      render();
      toast(`Возвращено операций: ${restored}`);
    }
    if (r.added || r.tombstoned.length) setTimeout(offerDebtSuggestions, 400);
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
    // страховка: что бы ни случилось, кнопка не останется в «…» навсегда
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('Операция не завершилась за 45 секунд')), 45000)),
    ]);
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
      if (/недоступен/.test(e.message) && await probeServerReachable(url) === true) {
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
  withBusy(btn, 'Включаем…', async () => {
    // адрес спрашиваем у сервера прямо сейчас: сохранённый мог устареть,
    // если на сервере меняли WEBHOOK_SECRET
    const info = await serverFetch('/api/state');
    const url = info.webhookUrl;
    if (!url) throw new Error('Сервер не сообщил адрес вебхука');
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
document.addEventListener('pointercancel', () => { pressTarget = null; }, true);
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

document.addEventListener('click', async (e) => {
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
      const internalField = document.getElementById('tx-internal-field');
      if (internalField) internalField.hidden = seg.dataset.val === 'expense';
    }
    if (seg.parentElement.id === 'tx-cur-seg') {
      const cur = seg.dataset.val;
      const label = document.getElementById('tx-alt-label');
      const input = document.getElementById('tx-alt');
      if (label) label.textContent = altFieldLabel(cur);
      if (input) {
        input.placeholder = altFieldPlaceholder({
          amount: document.getElementById('tx-amount').value, currency: cur,
        });
        input.value = ''; // прежний эквивалент относился к другой валюте
      }
      const totalLabel = document.querySelector('#tx-receipt-items-container label span:last-child');
      const form = document.getElementById('sheet-form');
      const txId = form ? form.dataset.id : null;
      const currentTx = txId ? state.transactions.find((x) => x.id === txId) : ui.tempTxForm;
      if (currentTx && currentTx.receiptItems && currentTx.receiptItems.length) {
        if (totalLabel) totalLabel.textContent = fmtMoney(currentTx.receiptItems.reduce((s, x) => s + (x.total || 0), 0), cur);
        const rows = document.querySelectorAll('#tx-receipt-items-container .receipt-item-row');
        currentTx.receiptItems.forEach((it, idx) => {
          if (rows[idx]) {
            const priceEl = rows[idx].querySelector('.item-price');
            if (priceEl) priceEl.textContent = (it.quantity > 1 ? it.quantity + ' × ' : '') + fmtMoney(it.total, cur);
          }
        });
      }
    }
    return;
  }

  // чипсы категорий в форме операции
  const chip = e.target.closest('.tx-cat');
  if (chip) {
    document.querySelectorAll('#tx-cats .chip').forEach((b) => b.classList.toggle('active', b === chip));
    return;
  }

  // чипсы выбора магазина в предпросмотре чека
  const storeChip = e.target.closest('.preview-store-chip');
  if (storeChip) {
    document.querySelectorAll('.preview-store-chip').forEach((b) => b.classList.toggle('active', b === storeChip));
    const newStore = storeChip.dataset.storeName;
    const descInput = document.getElementById('preview-receipt-desc');
    const r = ui.pendingReceipt;
    if (r) {
      r.storeName = newStore;
      const checkNum = String(r.id || '').replace(/^0+/, '') || r.id;
      if (descInput) {
        descInput.value = checkNum ? `${newStore} (Чек № ${checkNum})` : newStore;
      }
    }
    return;
  }

  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id, val, debt, cat } = el.dataset;

  switch (action) {
    case 'modal-close':
      if (!e.target.closest('[data-stop-close]') || e.target.closest('.sheet-close')) closeSheet();
      break;

    case 'force-sw-update': {
      toast('Проверяем обновления…');
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistration().then((reg) => {
          if (reg) {
            reg.update().then(() => {
              if (reg.waiting) {
                reg.waiting.postMessage({ type: 'SKIP_WAITING' });
              }
              setTimeout(() => { window.location.reload(); }, 400);
            }).catch(() => { window.location.reload(); });
          } else {
            window.location.reload();
          }
        }).catch(() => { window.location.reload(); });
      } else {
        window.location.reload();
      }
      break;
    }

    case 'nav-subs':
      ui.screen = 'subs';
      history.replaceState(null, '', '#subs');
      render();
      screenEl.scrollTop = 0;
      break;
    case 'nav-debts':
      ui.screen = 'debts';
      history.replaceState(null, '', '#debts');
      render();
      screenEl.scrollTop = 0;
      break;
    case 'refresh-rate-home': {
      const card = document.querySelector('[data-action="refresh-rate-home"]');
      if (card) card.style.opacity = '0.5';
      try {
        await refreshRate(true);
        render();
        toast('Курс обновлён: 1 $ = ' + state.rate.usdUah.toFixed(2) + ' ₴');
      } catch (e) {
        if (card) card.style.opacity = '1';
        toast('Не удалось обновить курс: ' + e.message);
      }
      break;
    }

    case 'ops-filter':
      ui.opsFilter = val;
      if (val === 'transfer') ui.opsCategory = null;
      render();
      break;
    case 'ops-cat-clear':
      ui.opsCategory = null;
      render();
      break;
    case 'home-cat-click': {
      if (cat === TRANSFERS_ROW) {
        ui.opsFilter = 'transfer';
        ui.opsCategory = null;
      } else {
        ui.opsFilter = 'expense';
        ui.opsCategory = cat;
      }
      ui.opsY = now.getFullYear();
      ui.opsM = now.getMonth();
      ui.screen = 'ops';
      history.replaceState(null, '', '#ops');
      render();
      screenEl.scrollTop = 0;
      break;
    }
    case 'debts-tab': ui.debtsTab = val; render(); break;
    case 'month-prev':
      ui.opsM--; if (ui.opsM < 0) { ui.opsM = 11; ui.opsY--; }
      render(); break;
    case 'month-next':
      ui.opsM++; if (ui.opsM > 11) { ui.opsM = 0; ui.opsY++; }
      render(); break;

    case 'scan-receipt-qr':
      ui.tempTxForm = captureCurrentTxForm();
      openQrScannerModal();
      break;
    case 'paste-receipt-data': {
      let text = '';
      if (navigator.clipboard && navigator.clipboard.readText) {
        try { text = await navigator.clipboard.readText(); } catch (e) {}
      }
      if (text && text.trim()) {
        stopScannerCamera();
        handleScannedReceipt(text.trim());
      } else {
        const box = document.getElementById('scanner-manual-paste-box');
        const input = document.getElementById('scanner-paste-input');
        if (box) {
          box.style.display = 'flex';
          if (input) input.focus();
        }
      }
      break;
    }
    case 'process-manual-receipt': {
      const input = document.getElementById('scanner-paste-input');
      const val = input ? input.value.trim() : '';
      if (val) {
        stopScannerCamera();
        handleScannedReceipt(val);
      } else {
        toast('Вставьте текст или ссылку чека');
      }
      break;
    }
    case 'add-tx-item': {
      const current = captureCurrentTxForm() || {};
      current.receiptItems = current.receiptItems || [];
      current.receiptItems.push({ name: '', price: '', quantity: 1, total: 0 });
      openTxForm(current);
      break;
    }
    case 'del-tx-item': {
      const idx = parseInt(el.dataset.idx, 10);
      const current = captureCurrentTxForm() || {};
      if (current.receiptItems && current.receiptItems.length > idx) {
        current.receiptItems.splice(idx, 1);
      }
      openTxForm(current);
      break;
    }
    case 'calc-tx-items-sum': {
      const current = captureCurrentTxForm() || {};
      const sum = (current.receiptItems || []).reduce((s, x) => s + (x.total || x.price || 0), 0);
      if (sum > 0) {
        current.amount = Math.round(sum * 100) / 100;
        const amountInput = document.getElementById('tx-amount');
        if (amountInput) amountInput.value = current.amount;
        toast('Сумма операции обновлена: ' + fmtMoney(current.amount, current.currency));
      }
      break;
    }
    case 'paste-receipt-xml': {
      let text = '';
      if (navigator.clipboard && navigator.clipboard.readText) {
        try { text = await navigator.clipboard.readText(); } catch (e) {}
      }
      if (!text) {
        text = prompt('Вставьте скопированный XML или текст чека с сайта ДПС:');
      }
      if (text && text.trim()) {
        const parsed = parseReceiptQr(text.trim());
        if (parsed) {
          if (ui.pendingReceipt && ui.pendingReceipt.rawUrl) {
            parsed.rawUrl = ui.pendingReceipt.rawUrl;
          }
          openReceiptPreviewModal(parsed);
          toast('Товары из чека успешно распознаны ✨');
        } else {
          toast('Не удалось распознать товары из вставленного текста');
        }
      }
      break;
    }
    case 'remove-tx-receipt': {
      const urlInput = document.getElementById('tx-receipt-url');
      if (urlInput) urlInput.value = '';
      const prev = document.getElementById('tx-receipt-preview');
      if (prev) {
        prev.style.display = 'none';
        prev.hidden = true;
      }
      const link = document.getElementById('tx-receipt-link');
      if (link) {
        link.href = '';
        link.style.display = 'none';
      }
      if (ui.tempTxForm) ui.tempTxForm.receiptUrl = '';
      toast('Чек откреплён');
      break;
    }
    case 'apply-receipt-save': {
      const r = ui.pendingReceipt;
      if (r) {
        const storeHint = ui.tempTxForm ? (ui.tempTxForm.description || '') : '';
        const descInput = document.getElementById('preview-receipt-desc');
        const description = descInput ? descInput.value.trim() : formatReceiptDescription(r, storeHint);
        const amount = r.amount || (ui.tempTxForm && ui.tempTxForm.amount) || 0;
        const date = r.date || (ui.tempTxForm && ui.tempTxForm.date) || todayISO();
        const store = r.storeName || storeHint || '';
        const categoryId = detectCategoryFromItems(r.items || [], store);
        const receiptUrl = r.rawUrl || (ui.tempTxForm && ui.tempTxForm.receiptUrl) || '';
        const receiptItems = (r.items && r.items.length) ? r.items : [];
        const type = (ui.tempTxForm && ui.tempTxForm.type) || 'expense';
        const currency = (ui.tempTxForm && ui.tempTxForm.currency) || 'UAH';

        if (ui.tempTxForm && ui.tempTxForm.id) {
          const t = state.transactions.find((x) => x.id === ui.tempTxForm.id);
          if (t) {
            Object.assign(t, { description, amount, date, categoryId, receiptUrl, receiptItems, type, currency });
          }
        } else {
          state.transactions.push({
            id: uid(), ts: Date.now(), type, amount, currency, date, description, categoryId,
            internal: false, altAmount: null, altCurrency: null, receiptUrl, receiptItems, source: 'manual', sourceId: null,
          });
        }

        const [ty, tm] = date.split('-').map(Number);
        if (ty && tm) { ui.opsY = ty; ui.opsM = tm - 1; }
        ui.screen = 'ops';
        history.replaceState(null, '', '#ops');
        save(); closeSheet(); render();
        toast('Операция сохранена с чеком ✨');
      }
      break;
    }
    case 'apply-receipt-full': {
      const r = ui.pendingReceipt;
      if (r && ui.tempTxForm) {
        const storeHint = ui.tempTxForm.description || '';
        const descInput = document.getElementById('preview-receipt-desc');
        ui.tempTxForm.description = descInput ? descInput.value.trim() : formatReceiptDescription(r, storeHint);
        if (r.amount) ui.tempTxForm.amount = r.amount;
        if (r.date) ui.tempTxForm.date = r.date;
        ui.tempTxForm.currency = 'UAH';
        const store = r.storeName || storeHint || '';
        ui.tempTxForm.categoryId = detectCategoryFromItems(r.items || [], store);
        ui.tempTxForm.receiptUrl = r.rawUrl || '';
        ui.tempTxForm.receiptItems = (r.items && r.items.length) ? r.items : [];
        closeSheet();
        openTxForm(ui.tempTxForm);
        toast('Данные чека применены ✨');
      }
      break;
    }
    case 'apply-receipt-desc-only': {
      const r = ui.pendingReceipt;
      if (r && ui.tempTxForm) {
        const descInput = document.getElementById('preview-receipt-desc');
        ui.tempTxForm.description = descInput ? descInput.value.trim() : formatReceiptDescription(r);
        ui.tempTxForm.currency = 'UAH';
        ui.tempTxForm.receiptUrl = r.rawUrl || '';
        closeSheet();
        openTxForm(ui.tempTxForm);
        toast('Описание чека добавлено ✨');
      }
      break;
    }
    case 'reload-tx-receipt-items': {
      const receiptUrl = document.getElementById('tx-receipt-url') ? document.getElementById('tx-receipt-url').value : '';
      if (!receiptUrl) { toast('Ссылка на чек отсутствует'); break; }
      toast('Запрашиваем товары с сервера ДПС…');
      try {
        const parsed = parseReceiptQr(receiptUrl);
        const detailed = await fetchReceiptDetails(parsed);
        if (detailed && detailed.items && detailed.items.length) {
          const form = document.getElementById('sheet-form');
          const txId = form ? form.dataset.id : null;
          const store = detailed.storeName || '';
          const newDesc = formatReceiptDescription(detailed);
          if (txId) {
            const t = state.transactions.find((x) => x.id === txId);
            if (t) {
              t.receiptItems = detailed.items;
              if (!t.description || t.description.includes('Чек №') || t.description === store) {
                t.description = newDesc;
              }
              save();
            }
          }
          if (ui.tempTxForm) {
            ui.tempTxForm.receiptItems = detailed.items;
            if (!ui.tempTxForm.description || ui.tempTxForm.description.includes('Чек №') || ui.tempTxForm.description === store) {
              ui.tempTxForm.description = newDesc;
            }
          }
          const currentT = captureCurrentTxForm();
          currentT.receiptItems = detailed.items;
          if (!currentT.description || currentT.description.includes('Чек №') || currentT.description === store) {
            currentT.description = newDesc;
          }
          openTxForm(currentT);
          toast('Товары из чека успешно загружены ✨');
        } else {
          toast('Касса ещё передаёт данные на сервер ДПС. Попробуйте через 10–15 минут.');
        }
      } catch (err) {
        toast('Ошибка при загрузке: ' + err.message);
      }
      break;
    }

    case 'edit-tx': openTxForm(state.transactions.find((t) => t.id === id)); break;
    case 'edit-sub': openSubForm(state.subscriptions.find((s) => s.id === id)); break;
    case 'edit-debt': openDebtForm(state.debts.find((d) => d.id === id)); break;
    case 'edit-category': openCategoryForm(state.categories.find((c) => c.id === id)); break;
    case 'add-category': openCategoryForm(null); break;

    case 'pay-sub': paySubscription(id); break;
    case 'pay-sub-early': paySubscriptionEarly(id); break;
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
    case 'srv-diagnose':
      withBusy(el, 'Проверяем…', async () => {
        alert(await diagnoseServer());
      });
      break;
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

    /* Действия ИИ-аналитика */
    case 'open-ai-chat': openAiChatModal(); break;
    case 'ai-quick-prompt': {
      const p = el.dataset.prompt || '';
      openAiChatModal(p);
      break;
    }
    case 'ai-chat-prompt': {
      const p = el.dataset.prompt || '';
      sendAiChatMessage(p);
      break;
    }
    case 'send-ai-msg': {
      sendAiChatMessage();
      break;
    }
    case 'clear-ai-history': {
      ui.aiChatHistory = [];
      openAiChatModal();
      toast('Диалог очищен');
      break;
    }
    case 'set-ai-model': {
      const m = el.dataset.val;
      const input = document.getElementById('openai-model');
      if (input) input.value = m;
      document.querySelectorAll('#openai-model-chips .chip').forEach((b) => b.classList.toggle('active', b === el));
      break;
    }
    case 'toggle-key-visibility': {
      const input = document.getElementById('openai-key');
      if (input) {
        input.type = input.type === 'password' ? 'text' : 'password';
      }
      break;
    }
    case 'save-ai-settings': {
      const keyEl = document.getElementById('openai-key');
      const modelEl = document.getElementById('openai-model');
      const baseUrlEl = document.getElementById('openai-base-url');
      if (keyEl) state.settings.openaiKey = keyEl.value.trim();
      if (modelEl) state.settings.openaiModel = modelEl.value.trim() || 'gpt-5.6-luna';
      if (baseUrlEl) state.settings.openaiBaseUrl = baseUrlEl.value.trim();
      save(); render();
      toast('Настройки ИИ сохранены ✨');
      break;
    }
    case 'test-ai-key': {
      const keyInput = document.getElementById('openai-key');
      const modelInput = document.getElementById('openai-model');
      const baseUrlInput = document.getElementById('openai-base-url');
      const key = (keyInput ? keyInput.value.trim() : '') || state.settings.openaiKey;
      const model = (modelInput ? modelInput.value.trim() : '') || state.settings.openaiModel;
      const baseUrl = (baseUrlInput ? baseUrlInput.value.trim() : '') || state.settings.openaiBaseUrl;
      if (!key) { toast('Сначала введите API-ключ'); break; }
      withBusy(el, 'Проверяем…', async () => {
        try {
          const res = await testAiConnection(key, model, baseUrl);
          toast('Связь с ' + (model || 'GPT') + ' успешна: ' + res + ' ✨');
        } catch (e) {
          alert('Ошибка проверки OpenAI: ' + e.message);
        }
      });
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
  if (e.target && e.target.id === 'ops-cat-select') {
    ui.opsCategory = e.target.value || null;
    render();
  }
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
function appHeight() {
  if (navigator.standalone === true) {
    const portrait = matchMedia('(orientation: portrait)').matches;
    return portrait
      ? Math.max(screen.height, screen.width)
      : Math.min(screen.height, screen.width);
  }
  return (window.visualViewport && window.visualViewport.height) || window.innerHeight;
}

/* Высота клавиатуры = насколько видимая область меньше экрана. Мелкие
   расхождения (строка статуса) игнорируем: клавиатура всегда высокая. */
function keyboardHeight(appH) {
  const vv = window.visualViewport;
  if (!vv) return 0;
  const gap = appH - (vv.height + vv.offsetTop);
  return gap > 120 ? Math.round(gap) : 0;
}

function setAppHeight() {
  const h = Math.round(appHeight());
  const root = document.documentElement;
  root.style.setProperty('--app-h', h + 'px');
  root.style.setProperty('--kb-h', keyboardHeight(h) + 'px');
}
window.addEventListener('resize', setAppHeight);
window.addEventListener('orientationchange', setAppHeight);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', setAppHeight);
  window.visualViewport.addEventListener('scroll', setAppHeight);
}
setAppHeight();

/* Поле, на котором стоит курсор, подводим к центру видимой части листа —
   иначе при открытии клавиатуры печатаешь вслепую */
document.addEventListener('focusin', (e) => {
  const field = e.target.closest && e.target.closest('.sheet input, .sheet select, .sheet textarea');
  if (!field) return;
  setTimeout(() => {
    setAppHeight();
    field.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 300); // ждём, пока клавиатура доедет
});

const initialScreen = location.hash.replace('#', '');
if (['home', 'ops', 'subs', 'debts', 'settings'].includes(initialScreen)) {
  ui.screen = initialScreen;
}

render();

refreshRate(false)
  .then((changed) => { if (changed) render(); })
  .catch(() => { /* останемся на сохранённом курсе */ });

/* Синхронизация при запуске, при возврате в приложение и раз в минуту,
   пока приложение открыто. Ошибку запоминаем: молча падающая синхронизация
   выглядит так, будто её вовсе нет. */
let syncFailures = 0;

function backgroundSync() {
  if (!serverConfigured()) return;
  // если сервер лежит, отступаем: 2, 4, 8, 15 минут — иначе разряжаем батарею
  if (syncFailures > 0) {
    const wait = Math.min(15, 2 ** syncFailures) * 60_000;
    if (Date.now() - (state.sync.lastErrorAt || 0) < wait) return;
  }
  syncAll()
    .then((added) => {
      const hadError = Boolean(state.sync.lastError);
      syncFailures = 0;
      state.sync.lastError = '';
      save();
      if (added || hadError) render();
      if (added) offerDebtSuggestions();
    })
    .catch((e) => {
      syncFailures++;
      state.sync.lastError = e.message;
      state.sync.lastErrorAt = Date.now();
      save();
      if (ui.screen === 'settings') render();
    });
}
backgroundSync();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) backgroundSync();
});
// проверяем и уже накопленные операции — вдруг среди них есть возврат долга
setTimeout(offerDebtSuggestions, 1200);
setInterval(() => { if (!document.hidden) backgroundSync(); }, 60_000);

if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.update().catch(() => {});
  }).catch(() => {});
}
