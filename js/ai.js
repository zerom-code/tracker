/* ИИ-финансовый аналитик: формирование контекста данных, запросы к OpenAI API (GPT 5.6 Luna). */

/**
 * Собирает структурированный финансовый контекст приложения для передачи в промпт ИИ.
 */
function extractStoreAndProducts(desc) {
  if (!desc) return { store: 'Не указан', products: 'Покупка' };
  const trimmed = desc.trim();
  const m = trimmed.match(/^([^()]+?)\s*\((.+)\)$/);
  if (m) {
    return { store: m[1].trim(), products: m[2].trim() };
  }
  return { store: trimmed, products: trimmed };
}

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

  // Все операции за последние 90 дней со строгим разделением магазина и купленных товаров
  const cutoff = new Date(Date.now() - 90 * 86400 * 1000).toISOString().slice(0, 10);
  const recentTxs = state.transactions
    .filter((t) => (t.date >= cutoff))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const allTransactions = recentTxs.map((t) => {
    const { store, products } = extractStoreAndProducts(t.description);
    const cat = t.type === 'transfer' ? 'Перевод' : (categoryById(t.categoryId || FALLBACK_CATEGORY).name);
    const hasItems = !!(t.receiptItems && t.receiptItems.length);
    const items = hasItems
      ? t.receiptItems.map((it) => ({
          name: it.name,
          quantity: it.quantity || 1,
          pricePerUnit: `${it.price || it.total} ${t.currency}`,
          total: `${it.total} ${t.currency}`
        }))
      : [];

    return {
      date: t.date,
      type: t.type || 'expense',
      store: store,
      description: products,
      amount: `${t.amount} ${t.currency}`,
      category: cat,
      hasFiscalReceipt: hasItems,
      receiptPositions: items,
    };
  });

  // Все отдельные позиции из всех прикреплённых фискальных чеков
  const allFiscalReceiptItems = [];
  for (const t of recentTxs) {
    if (t.receiptItems && t.receiptItems.length) {
      const { store } = extractStoreAndProducts(t.description);
      const cat = categoryById(t.categoryId || FALLBACK_CATEGORY).name;
      for (const it of t.receiptItems) {
        allFiscalReceiptItems.push({
          date: t.date,
          store: store,
          productName: it.name,
          quantity: it.quantity || 1,
          unitPrice: `${it.price || it.total} ${t.currency}`,
          totalCost: `${it.total} ${t.currency}`,
          category: cat,
        });
      }
    }
  }

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
    monthlyOverview: monthsData,
    allFiscalReceiptItems: allFiscalReceiptItems,
    allTransactions: allTransactions,
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
    content: `Ты — личный финансовый ИИ-аналитик в приложении «Трекер трат».
У тебя есть доступ ко всем актуальным финансовым данным пользователя: списку всех транзакций ("allTransactions"), отдельным позициям из фискальных чеков ("allFiscalReceiptItems"), категориям, подпискам и долгам.

ДАННЫЕ ПОЛЬЗОВАТЕЛЯ (JSON):
${financialContext}

УНИВЕРСАЛЬНЫЕ ПРАВИЛА ФИНАНСОВОГО АНАЛИЗА (БЕЗ ХАРДКОДА — ДЛЯ ЛЮБОГО ТОВАРА И ВОПРОСА):

1. ТОЧНОСТЬ ТОВАРОВ И БРЕНДОВ:
   - Когда пользователь спрашивает про ЛЮБОЙ конкретный товар, продукт или бренд (например: KitKat, Пельмени, Пиво, Сыр, Кофе, Мясо, Молоко, Pepsi, Чипсы, Сосиски и т.д.):
     * Ищи ТОЛЬКО точные совпадения и упоминания именно этого товара/бренда в названиях позиций чеков (allFiscalReceiptItems / receiptPositions) и в описании (description).
     * НЕ приписывай к конкретному бренду или товару другие товары похожей категории (например, если спросили про «KitKat», учитывай только KitKat, а не «шоколадка», «печенье» или «торт», если в них нет KitKat).

2. ТОЧНЫЕ ЦЕНЫ ИЗ ЧЕКОВ VS ОБЩИЕ ЧЕКИ:
   - Если позиция есть в фискальном чеке (allFiscalReceiptItems / receiptPositions) или в чеке на один товар: назови её ТОЧНУЮ стоимость из чека (например: **31,30 ₴**).
   - Если товар упомянут в составе общего смешанного чека без построчной детализации (например: «квас и KitKat» на 1,75 $ или «пиво, чипсы и хлеб» на 250 ₴):
     * ЧЁТКО укажи, что сумма (1,75 $ или 250 ₴) — это стоимость ВСЕГО чека с другими продуктами, а цена конкретного товара в нём отдельно не выделена.
     * НИКОГДА не складывай общую сумму смешанного чека с другими покупками как будто это цена одного товара!
     * Подведи понятный итог: «Точно подтвержденная сумма по детальным чекам — X ₴. Также товар встречался в N общих чеках на сумму Y».

3. ОТВЕТ НА ВОПРОС «НА КАКОЙ ПРОДУКТ Я ПОТРАТИЛ БОЛЬШЕ ВСЕГО?»:
   - Проанализируй ВСЕ операции и позиции из чеков.
   - Сгруппируй однотипные продукты (например, все покупки пива, все покупки мяса, все покупки сладостей, полуфабрикатов и т.д.) динамически по их реальным названиям и смыслу.
   - Найди самый затратный и частый продукт, приведи список операций с правильными магазинами и суммами и подведи понятный итог.

4. ТОЧНОСТЬ МАГАЗИНОВ:
   - Всегда бери название магазина строго из поля "store" (ALKOMARKET — это ALKOMARKET, VARUS — это VARUS, АТБ — это АТБ). Никогда не путай магазины между собой.

5. ФОРМАТИРОВАНИЕ:
   - Выделяй жирным шрифтом названия товаров, магазинов и точные суммы (**31,30 ₴**, **VARUS**, **92,70 ₴**).
   - Используй аккуратные списки и эмодзи (🍫, 🍺, 🛒, 🥇, 💡, 📊). Отвечай кратко, честно и по делу.`
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
