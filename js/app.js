/* Интерфейс: отрисовка экранов, формы, обработка действий. */

const now = new Date();
const ui = {
  screen: 'home',
  opsFilter: 'all',            // all | expense | transfer
  opsY: now.getFullYear(),
  opsM: now.getMonth(),
  debtsTab: 'owe-me',          // owe-me | i-owe
};

const MONTHS_RU_PREP = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне',
  'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];

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
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2800);
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
  const spentBase = sumBase(txOfMonth(y, m, 'expense'));
  const transfersBase = sumBase(txOfMonth(y, m, 'transfer'));
  const spent = moneyBoth(spentBase);

  const subsMonthly = activeSubs().reduce((acc, s) => acc + subMonthlyBase(s), 0);
  const subs = moneyBoth(subsMonthly);

  const oweMe = moneyBoth(activeDebts('owe-me').reduce((a, d) => a + toBase(d.amount, d.currency), 0));
  const iOwe = moneyBoth(activeDebts('i-owe').reduce((a, d) => a + toBase(d.amount, d.currency), 0));

  // топ категорий месяца
  const byCat = {};
  for (const t of txOfMonth(y, m, 'expense')) {
    const id = t.categoryId || FALLBACK_CATEGORY;
    byCat[id] = (byCat[id] || 0) + toBase(t.amount, t.currency);
  }
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 6);
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
        <span style="color:var(--muted);font-size:14px">Переводы за месяц</span>
        <span style="font-weight:700">${fmtMoney(transfersBase, state.settings.baseCurrency)}</span>
      </div>
    </div>

    <div class="stat-grid" style="margin-bottom:12px">
      <div class="card">
        <div class="stat-label">Подписки в месяц</div>
        <div class="stat-value">${subs.main}</div>
        <div class="row-sub">≈ ${subs.other}</div>
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
        const c = categoryById(id);
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
      <h3>Ближайшие подписки</h3>
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
  const monthTx = txOfMonth(y, m).filter((t) => ui.opsFilter === 'all' || t.type === ui.opsFilter);
  const sorted = monthTx.sort((a, b) =>
    a.date === b.date ? (b.ts || 0) - (a.ts || 0) : (a.date < b.date ? 1 : -1));

  const expSum = sumBase(txOfMonth(y, m, 'expense'));
  const trSum = sumBase(txOfMonth(y, m, 'transfer'));

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

    <div class="segmented" style="margin-bottom:12px">
      <button data-action="ops-filter" data-val="all" class="${ui.opsFilter === 'all' ? 'active' : ''}">Все</button>
      <button data-action="ops-filter" data-val="expense" class="${ui.opsFilter === 'expense' ? 'active' : ''}">Расходы</button>
      <button data-action="ops-filter" data-val="transfer" class="${ui.opsFilter === 'transfer' ? 'active' : ''}">Переводы</button>
    </div>

    <div class="card">
      <div class="rate-line">
        <span style="color:var(--muted)">Расходы: <b style="color:var(--text)">${fmtMoney(expSum, state.settings.baseCurrency)}</b></span>
        <span style="color:var(--muted)">Переводы: <b style="color:var(--accent)">${fmtMoney(trSum, state.settings.baseCurrency)}</b></span>
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
  const cat = isTr ? null : categoryById(t.categoryId);
  const emoji = isTr ? '🔁' : cat.emoji;
  const title = t.description || (isTr ? 'Перевод' : cat.name);
  const subParts = [isTr ? 'Перевод' : cat.name];
  if (t.source === 'mono') subParts.push('Monobank');
  return `
    <div class="row" data-action="edit-tx" data-id="${t.id}">
      <div class="row-emoji">${emoji}</div>
      <div class="row-main">
        <div class="row-title">${esc(title)}</div>
        <div class="row-sub">${esc(subParts.join(' · '))}</div>
      </div>
      <div class="row-right">
        <div class="row-amount ${isTr ? 'transfer' : 'expense'}">−${fmtMoney(t.amount, t.currency)}</div>
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
    ? `<button class="icon-btn ok" data-action="pay-sub" data-id="${s.id}" title="Отметить оплаченной">✓</button>`
    : '';

  return `
    <div class="row" data-action="edit-sub" data-id="${s.id}">
      <div class="row-emoji">🔁</div>
      <div class="row-main">
        <div class="row-title">${esc(s.name)}</div>
        <div class="row-sub">${badge} ${dateStr} · ${s.period === 'year' ? 'ежегодно' : 'ежемесячно'}</div>
      </div>
      <div class="inline-actions">
        <div class="row-right">
          <div class="row-amount">${fmtMoney(s.amount, s.currency)}</div>
          <div class="row-sub">${s.period === 'year' ? '/год' : '/мес'}</div>
        </div>
        ${payBtn}
      </div>
    </div>`;
}

function renderSubs() {
  const act = activeSubs().slice().sort((a, b) => (a.nextDate < b.nextDate ? -1 : 1));
  const paused = state.subscriptions.filter((s) => s.active === false);
  const monthly = moneyBoth(act.reduce((acc, s) => acc + subMonthlyBase(s), 0));

  return `
    <h1 class="screen-title">Подписки</h1>

    <div class="card">
      <h3>В месяц</h3>
      <div class="big-amount">${monthly.main}</div>
      <div class="sub-amount">≈ ${monthly.other}</div>
    </div>

    ${act.length ? `<div class="card" style="padding:4px 16px">${act.map(subRow).join('')}</div>` : `
    <div class="empty">
      <div class="empty-icon">🔁</div>
      Добавьте подписки кнопкой «+»:<br>Netflix, iCloud, Spotify — всё, что списывается регулярно.
    </div>`}

    ${paused.length ? `
    <div class="group-label">Приостановленные</div>
    <div class="card" style="padding:4px 16px">
      ${paused.map((s) => `
      <div class="row settled" data-action="edit-sub" data-id="${s.id}">
        <div class="row-emoji">⏸️</div>
        <div class="row-main"><div class="row-title">${esc(s.name)}</div></div>
        <div class="row-right"><div class="row-amount">${fmtMoney(s.amount, s.currency)}</div></div>
      </div>`).join('')}
    </div>` : ''}

    <p class="hint">Когда подходит дата — нажмите «✓», подписка запишется в расходы, а дата сдвинется на следующий период.</p>
  `;
}

/* ---------- долги ---------- */

function debtRow(d) {
  const settleBtn = d.settled ? '' :
    `<button class="icon-btn ok" data-action="settle-debt" data-id="${d.id}" title="Погашен">✓</button>`;
  return `
    <div class="row ${d.settled ? 'settled' : ''}" data-action="edit-debt" data-id="${d.id}">
      <div class="row-emoji">${d.direction === 'owe-me' ? '📥' : '📤'}</div>
      <div class="row-main">
        <div class="row-title">${esc(d.person)}</div>
        <div class="row-sub">${esc(d.description || 'без описания')}</div>
      </div>
      <div class="inline-actions">
        <div class="row-right">
          <div class="row-amount ${d.settled ? '' : (d.direction === 'owe-me' ? 'positive' : 'negative')}">${fmtMoney(d.amount, d.currency)}</div>
        </div>
        ${settleBtn}
      </div>
    </div>`;
}

function renderDebts() {
  const dir = ui.debtsTab;
  const active = activeDebts(dir);
  const settled = state.debts.filter((d) => d.direction === dir && d.settled);
  const total = moneyBoth(active.reduce((a, d) => a + toBase(d.amount, d.currency), 0));

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
          <input type="radio" name="mono-acc" value="${esc(a.id)}" style="width:auto" ${i === firstSupported ? 'checked' : ''} ${a.supported ? '' : 'disabled'}>
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
    <p class="hint">Списания станут расходами (категория — по типу магазина), переводы и снятие наличных попадут в «Переводы». Уже импортированные операции не дублируются.</p>
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
  `;
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
  const t = tx || {
    type: ui.screen === 'ops' && ui.opsFilter === 'transfer' ? 'transfer' : 'expense',
    amount: '', currency: state.settings.baseCurrency,
    categoryId: null, description: '', date: todayISO(),
  };

  openSheet(`
    ${sheetHead(isNew ? 'Новая операция' : 'Изменить операцию')}
    <form id="sheet-form" data-form="tx" data-id="${tx ? tx.id : ''}">
      <div class="field">
        <div class="segmented" id="tx-type-seg">
          ${segButtons([['expense', 'Расход'], ['transfer', 'Перевод']], t.type)}
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
        <input id="tx-desc" type="text" placeholder="${t.type === 'transfer' ? 'например: маме на карту' : 'например: кофе с собой'}" value="${esc(t.description)}">
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

  const id = form.dataset.id;
  if (id) {
    const t = state.transactions.find((x) => x.id === id);
    if (!t) return;
    Object.assign(t, {
      type, amount, currency, date, description,
      categoryId: type === 'expense' ? (catBtn ? catBtn.dataset.cat : FALLBACK_CATEGORY) : null,
    });
  } else {
    state.transactions.push({
      id: uid(), ts: Date.now(), type, amount, currency, date, description,
      categoryId: type === 'expense' ? (catBtn ? catBtn.dataset.cat : FALLBACK_CATEGORY) : null,
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
    nextDate: todayISO(), active: true,
  };

  openSheet(`
    ${sheetHead(isNew ? 'Новая подписка' : 'Изменить подписку')}
    <form id="sheet-form" data-form="sub" data-id="${sub ? sub.id : ''}">
      <div class="field">
        <label>Название</label>
        <input id="sub-name" type="text" placeholder="Netflix, iCloud…" value="${esc(s.name)}" required>
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
      ${isNew ? '' : `
      <div class="field">
        <label style="display:flex;align-items:center;gap:10px;font-size:15px;color:var(--text)">
          <input id="sub-active" type="checkbox" style="width:auto" ${s.active !== false ? 'checked' : ''}>
          Подписка активна
        </label>
      </div>`}
      <button type="submit" class="btn">${isNew ? 'Добавить' : 'Сохранить'}</button>
      ${isNew ? '' : `<button type="button" class="btn danger-ghost" data-action="del-sub" data-id="${sub.id}">Удалить подписку</button>`}
    </form>
  `);
}

function submitSubForm(form) {
  const name = document.getElementById('sub-name').value.trim();
  const amount = parseAmount(document.getElementById('sub-amount').value);
  if (!name) { toast('Укажите название подписки'); return; }
  if (!amount) { toast('Введите сумму больше нуля'); return; }
  const data = {
    name, amount,
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
  const isNew = !debt;
  const d = debt || {
    direction: ui.debtsTab, person: '', amount: '', currency: 'UAH',
    description: '', date: todayISO(), settled: false,
  };

  openSheet(`
    ${sheetHead(isNew ? 'Новый долг' : 'Изменить долг')}
    <form id="sheet-form" data-form="debt" data-id="${debt ? debt.id : ''}">
      <div class="field">
        <div class="segmented" id="debt-dir-seg">
          ${segButtons([['owe-me', 'Мне должны'], ['i-owe', 'Я должен']], d.direction)}
        </div>
      </div>
      <div class="field">
        <label>Кто</label>
        <input id="debt-person" type="text" placeholder="Имя" value="${esc(d.person)}" required>
      </div>
      <div class="field">
        <label>Сумма</label>
        <div class="amount-row">
          <input id="debt-amount" type="text" inputmode="decimal" placeholder="0" value="${d.amount || ''}" required>
          <div class="segmented" id="debt-cur-seg">
            ${segButtons([['UAH', '₴'], ['USD', '$']], d.currency)}
          </div>
        </div>
      </div>
      <div class="field">
        <label>За что</label>
        <input id="debt-desc" type="text" placeholder="например: за билеты на концерт" value="${esc(d.description)}">
      </div>
      <div class="field">
        <label>Дата</label>
        <input id="debt-date" type="date" value="${d.date}">
      </div>
      ${isNew ? '' : `
      <div class="field">
        <label style="display:flex;align-items:center;gap:10px;font-size:15px;color:var(--text)">
          <input id="debt-settled" type="checkbox" style="width:auto" ${d.settled ? 'checked' : ''}>
          Долг погашен
        </label>
      </div>`}
      <button type="submit" class="btn">${isNew ? 'Добавить' : 'Сохранить'}</button>
      ${isNew ? '' : `<button type="button" class="btn danger-ghost" data-action="del-debt" data-id="${debt.id}">Удалить долг</button>`}
    </form>
  `);
}

function submitDebtForm(form) {
  const person = document.getElementById('debt-person').value.trim();
  const amount = parseAmount(document.getElementById('debt-amount').value);
  if (!person) { toast('Укажите, кто должен'); return; }
  if (!amount) { toast('Введите сумму больше нуля'); return; }
  const settledEl = document.getElementById('debt-settled');
  const data = {
    direction: segValue('#debt-dir-seg') || 'owe-me',
    person, amount,
    currency: segValue('#debt-cur-seg') || 'UAH',
    description: document.getElementById('debt-desc').value.trim(),
    date: document.getElementById('debt-date').value || todayISO(),
  };
  const id = form.dataset.id;
  if (id) {
    const d = state.debts.find((x) => x.id === id);
    if (!d) return;
    Object.assign(d, data, { settled: settledEl ? settledEl.checked : d.settled });
  } else {
    state.debts.push({ id: uid(), ...data, settled: false });
  }
  save(); closeSheet(); render();
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
  state.transactions.push({
    id: uid(), ts: Date.now(), type: 'expense',
    amount: s.amount, currency: s.currency,
    categoryId: 'subs', description: s.name,
    date: todayISO(), source: 'manual', sourceId: null,
  });
  s.nextDate = addPeriod(s.nextDate, s.period);
  save(); render();
  toast('Записано в расходы, дата сдвинута');
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
    render();
    toast(r.added
      ? `Добавлено операций: ${r.added}` + (r.duplicates ? `, пропущено дублей: ${r.duplicates}` : '')
      : 'Новых операций нет' + (r.duplicates ? ` (дублей: ${r.duplicates})` : ''));
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Импортировать операции';
    toast(e.message);
  }
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
  const { action, id, val } = el.dataset;

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
      if (d) { d.settled = true; save(); render(); toast('Долг погашен 🎉'); }
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
});

fabEl.addEventListener('click', () => {
  if (ui.screen === 'subs') openSubForm(null);
  else if (ui.screen === 'debts') openDebtForm(null);
  else openTxForm(null);
});

/* ================= запуск ================= */

// Реальная высота экрана: vh/dvh в standalone-режиме iOS считаются
// без области статус-бара, поэтому меряем окно в JS.
function setAppHeight() {
  document.documentElement.style.setProperty('--app-h', window.innerHeight + 'px');
}
window.addEventListener('resize', setAppHeight);
window.addEventListener('orientationchange', setAppHeight);
setAppHeight();

const initialScreen = location.hash.replace('#', '');
if (['home', 'ops', 'subs', 'debts', 'settings'].includes(initialScreen)) {
  ui.screen = initialScreen;
}

render();

refreshRate(false)
  .then((changed) => { if (changed) render(); })
  .catch(() => { /* останемся на сохранённом курсе */ });

if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
