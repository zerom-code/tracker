/* ИИ-финансовый аналитик: формирование контекста данных, запросы к OpenAI API (GPT 5.6 Luna). */

/**
 * Собирает структурированный финансовый контекст приложения для передачи в промпт ИИ.
 */
function buildFinancialContext() {
  const baseCur = state.settings.baseCurrency || 'UAH';
  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth();
  const today = todayISO();
  const rateInfo = effectiveRate() ? `${effectiveRate().toFixed(2)} ₴ / 1 $` : 'нет данных';

  // Статистика за последние 3 месяца
  const monthsData = [];
  for (let i = 0; i < 3; i++) {
    let y = curY;
    let m = curM - i;
    if (m < 0) { m += 12; y -= 1; }
    
    const exp = sumBase(outflowOfMonth(y, m));
    const inc = sumBase(txOfMonth(y, m, 'income'));
    const tr = sumBase(txOfMonth(y, m, 'transfer'));
    
    const byCat = {};
    for (const t of txOfMonth(y, m, 'expense')) {
      const cat = categoryById(t.categoryId || FALLBACK_CATEGORY);
      byCat[cat.name] = (byCat[cat.name] || 0) + txBase(t);
    }
    
    monthsData.push({
      month: `${MONTHS_RU[m]} ${y}`,
      spent: `${exp.toFixed(2)} ${baseCur}`,
      income: `${inc.toFixed(2)} ${baseCur}`,
      transfers: `${tr.toFixed(2)} ${baseCur}`,
      byCategory: byCat,
    });
  }

  // Все операции за последние 60 дней с акцентом на описание купленного и товары из чеков
  const cutoff = new Date(Date.now() - 60 * 86400 * 1000).toISOString().slice(0, 10);
  const expenseTxs = state.transactions
    .filter((t) => (t.date >= cutoff && (t.type === 'expense' || !t.type)))
    .sort((a, b) => b.amount - a.amount); // сортируем по убыванию суммы

  const itemizedPurchases = [];
  for (const t of expenseTxs) {
    const cat = categoryById(t.categoryId || FALLBACK_CATEGORY).name;
    if (t.receiptItems && t.receiptItems.length) {
      for (const it of t.receiptItems) {
        itemizedPurchases.push({
          date: t.date,
          item: it.name,
          quantity: it.quantity || 1,
          pricePerUnit: it.price || it.total,
          totalCost: `${it.total} ${t.currency}`,
          store: t.description || 'Чек',
          category: cat
        });
      }
    } else {
      itemizedPurchases.push({
        date: t.date,
        item: t.description || 'Покупка без описания',
        totalCost: `${t.amount} ${t.currency}`,
        category: cat
      });
    }
  }

  const allRecentTxs = state.transactions
    .filter((t) => (t.date >= cutoff))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 150)
    .map((t) => {
      const cat = t.type === 'transfer' ? 'Перевод' : (categoryById(t.categoryId || FALLBACK_CATEGORY).name);
      let itemStr = '';
      if (t.receiptItems && t.receiptItems.length) {
        itemStr = ' [Детализация товаров из чека: ' + t.receiptItems.map((it) => `${it.name}: ${it.total} ${t.currency}`).join(', ') + ']';
      }
      return `Дата: ${t.date} | Тип: ${t.type || 'Расход'} | Сумма: ${t.amount} ${t.currency} | Категория: ${cat} | Описание (купленный товар/услуга): "${t.description || ''}"${itemStr}`;
    });

  // Подписки и рассрочки
  const subs = state.subscriptions.filter((s) => s.active !== false).map((s) => {
    let extra = '';
    if (s.plan) {
      extra = ` (Рассрочка: оплачено ${s.plan.paid} из ${s.plan.total} платежей, банк/кредитор: ${s.plan.lender || 'не указан'})`;
    }
    return `- ${s.name}: ${s.amount} ${s.currency} (${s.period === 'year' ? 'в год' : 'в месяц'}), след. платеж: ${s.nextDate}${extra}`;
  });

  // Долги
  const debts = state.debts.filter((d) => !d.settled && debtRemaining(d) > 0).map((d) => {
    const rem = debtRemaining(d);
    return `- ${d.direction === 'owe-me' ? 'Мне должен' : 'Я должен'} ${d.person}: остаток ${rem} ${d.currency}`;
  });

  return JSON.stringify({
    currentDate: today,
    baseCurrency: baseCur,
    usdRate: rateInfo,
    monthlyStats: monthsData,
    purchasesRankedByCost: itemizedPurchases.slice(0, 80),
    transactionsList: allRecentTxs,
    subscriptions: subs,
    debts: debts,
  }, null, 2);
}

/**
 * Отправляет вопрос пользователя и финансовый контекст модели OpenAI (GPT 5.6 Luna / custom).
 */
async function askAiAssistant(userMessage, chatHistory = []) {
  const apiKey = (state.settings.openaiKey || '').trim();
  if (!apiKey) {
    throw new Error('API-ключ OpenAI не указан. Добавьте его во вкладке «Ещё» в настройках.');
  }

  const model = (state.settings.openaiModel || 'gpt-5.6-luna').trim();
  const baseUrl = (state.settings.openaiBaseUrl || 'https://api.openai.com/v1/chat/completions').trim();

  const financialContext = buildFinancialContext();

  const systemMessage = {
    role: 'system',
    content: `Ты — личный финансовый ИИ-аналитик и эксперт по оптимизации расходов в приложении «Трекер трат».
У тебя есть доступ к финансовым данным пользователя: списку транзакций, категориям, подпискам, долгам и товарам.

ДАННЫЕ ПОЛЬЗОВАТЕЛЯ (JSON):
${financialContext}

КРИТИЧЕСКИ ВАЖНЫЕ ПРАВИЛА:
1. Поле "Описание" (description) или "item" содержит конкретное название товара, услуги или купленных продуктов, указанное пользователем или банком (например: "Пельмени", "Сосиски", "Мясо и куриные продукты", "Пиво и орешки", "Сидр и настойки", "КітКат", "Атб-Маркет").
2. Сумма операции (amount/totalCost) — это точная стоимость этого товара или набора товаров.
3. Если пользователь спрашивает "На какой товар я потратил больше всего?", "Какие самые дорогие покупки?", "Сколько ушло на конкретный товар?":
   - ОБЯЗАТЕЛЬНО проанализируй поле "Описание" (description / item) и суммы (totalCost / amount), а также детализацию чеков.
   - Составь конкретный ТОП-рейтинг самых дорогих товаров/покупок от большей суммы к меньшей (например: 1. **Мясо и куриные продукты** — **427 ₴**, 2. **Пельмени** — **360,30 ₴**, 3. **Сосиски** — **259 ₴**...).
   - Если в описании указан один товар (например, "Пельмени 360,30 ₴"), считай всю сумму стоимостью этого товара.
   - НИКОГДА не говори, что "нельзя определить самый дорогой товар" или "нет цен каждой позиции". Ты ВСЕГДА можешь ранжировать покупки по описаниям и суммам транзакций.
4. Отвечай дружелюбно, профессионально, кратко и по существу на языке пользователя.
5. Выделяй важные суммы, названия магазинов, товаров и процентов жирным шрифтом (**360,30 ₴**, **Пельмени**, **VARUS**).
6. Структурируй ответы красивыми списками с эмодзи (🛒, 🥇, 🥈, 🥉, 💡, 📊, 💰).`
  };

  const messages = [
    systemMessage,
    ...chatHistory.slice(-8), // держим последние 8 реплик для экономии токенов и фокуса
    { role: 'user', content: userMessage }
  ];

  const requestBody = {
    model: model,
    messages: messages,
    max_completion_tokens: 2500,
  };

  let res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    let errJson = null;
    let errText = '';
    try {
      errJson = await res.json();
      errText = (errJson.error && errJson.error.message) || JSON.stringify(errJson);
    } catch (e) {
      errText = `HTTP ${res.status}: ${res.statusText}`;
    }

    // Авто-повтор для моделей с поддержкой роли 'developer' вместо 'system'
    if (res.status === 400 && errText && (errText.includes('developer') || errText.includes('system') || errText.includes('role'))) {
      const devMessages = messages.map((m, idx) => (idx === 0 && m.role === 'system') ? { ...m, role: 'developer' } : m);
      const retryRes = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: model,
          messages: devMessages,
          max_completion_tokens: 2500,
        }),
      });
      if (retryRes.ok) {
        const data = await retryRes.json();
        const answer = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (answer) return answer.trim();
      }
    }

    if (res.status === 401) {
      throw new Error('Неверный API-ключ OpenAI. Проверьте ключ в настройках «Ещё».');
    }
    if (res.status === 429) {
      throw new Error('Превышен лимит запросов OpenAI или недостаточно средств на балансе.');
    }
    throw new Error(`Ошибка OpenAI (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const answer = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!answer) {
    throw new Error('Пустой ответ от ИИ модели.');
  }

  return answer.trim();
}

/**
 * Быстрая проверка подключения к API OpenAI.
 */
async function testAiConnection(apiKey, model, baseUrl) {
  const key = (apiKey || state.settings.openaiKey || '').trim();
  if (!key) throw new Error('Введите API ключ');

  const m = (model || state.settings.openaiModel || 'gpt-5.6-luna').trim();
  const url = (baseUrl || state.settings.openaiBaseUrl || 'https://api.openai.com/v1/chat/completions').trim();

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: m,
      messages: [{ role: 'user', content: 'Привет! Ответь одним словом "Готово".' }],
      max_completion_tokens: 50,
    }),
  });

  if (!res.ok) {
    const errJson = await res.json().catch(() => ({}));
    const msg = (errJson.error && errJson.error.message) || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || 'Успешно';
}
