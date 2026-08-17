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

  // Все операции за последние 60 дней со строгим разделением магазина и купленных товаров
  const cutoff = new Date(Date.now() - 60 * 86400 * 1000).toISOString().slice(0, 10);
  const expenseTxs = state.transactions
    .filter((t) => (t.date >= cutoff && (t.type === 'expense' || !t.type)))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const detailedPurchases = expenseTxs.map((t) => {
    const { store, products } = extractStoreAndProducts(t.description);
    const cat = categoryById(t.categoryId || FALLBACK_CATEGORY).name;
    const items = (t.receiptItems && t.receiptItems.length)
      ? t.receiptItems.map((it) => `${it.name} (${it.total} ${t.currency})`).join(', ')
      : '';
    return {
      date: t.date,
      store: store,
      purchasedProducts: products,
      amount: `${t.amount} ${t.currency}`,
      category: cat,
      itemizedReceipt: items || 'нет детализации позиций',
    };
  });

  // Автоматическая группировка продуктов по ключевым словам со строгим разделением точных цен и смешанных чеков
  const productKeywordMap = {};
  const keywordsList = [
    { key: 'Батончики KitKat', match: /kit\s*kat|кіт\s*кат/i },
    { key: 'Шоколад и сладости', match: /шоколад|конфет|цукерк|печень|торт|вафл/i },
    { key: 'Пиво', match: /пив[оаеи]/i },
    { key: 'Сидр', match: /сидр/i },
    { key: 'Настойки и крепкий алкоголь', match: /настойк|водк|виски|ром|джин|коньяк/i },
    { key: 'Вино', match: /вин[оа]/i },
    { key: 'Мясо и птица', match: /мяс|куриц|курк|говяд|свин|фарш|печень|стегн/i },
    { key: 'Пельмени и полуфабрикаты', match: /пельмен|вареник|лазань/i },
    { key: 'Сосиски и колбасы', match: /сосиск|колбас|ковбас|сард/i },
    { key: 'Чипсы и сухарики', match: /чипс|сухарик/i },
    { key: 'Орешки', match: /орешк|горіх/i },
    { key: 'Квас и безалкогольные напитки', match: /квас|pepsi|пепси|кола|cola|сок|энергетик|енергетик/i },
    { key: 'Сыр и молочные продукты', match: /сыр|сир|молок|сметан|творог|йогурт/i },
  ];

  for (const t of expenseTxs) {
    const { store, products } = extractStoreAndProducts(t.description);
    
    for (const kw of keywordsList) {
      let matchedInItems = false;
      let exactItemSum = 0;
      const matchedItemNames = [];

      if (t.receiptItems && t.receiptItems.length) {
        for (const it of t.receiptItems) {
          if (kw.match.test(it.name)) {
            matchedInItems = true;
            exactItemSum += (it.total || 0);
            matchedItemNames.push(`${it.name}: ${it.total} ${t.currency}`);
          }
        }
      }

      const matchedInDesc = kw.match.test(t.description || '');

      if (matchedInItems || matchedInDesc) {
        if (!productKeywordMap[kw.key]) {
          productKeywordMap[kw.key] = {
            exactConfirmedSpent: 0,
            currency: t.currency,
            exactPurchases: [],
            mixedChecks: [],
          };
        }

        if (matchedInItems) {
          productKeywordMap[kw.key].exactConfirmedSpent += exactItemSum;
          productKeywordMap[kw.key].exactPurchases.push({
            date: t.date,
            store: store,
            exactCost: `${exactItemSum.toFixed(2)} ${t.currency}`,
            items: matchedItemNames.join(', '),
          });
        } else {
          // Если в описании только этот продукт или смешанный чек
          const isMixed = /[,+]| и | з | с /i.test(products);
          if (!isMixed) {
            productKeywordMap[kw.key].exactConfirmedSpent += t.amount;
            productKeywordMap[kw.key].exactPurchases.push({
              date: t.date,
              store: store,
              exactCost: `${t.amount} ${t.currency}`,
              description: products,
            });
          } else {
            productKeywordMap[kw.key].mixedChecks.push({
              date: t.date,
              store: store,
              totalCheckAmount: `${t.amount} ${t.currency}`,
              checkDescription: products,
              note: 'В чеке было несколько товаров, цена конкретно этого товара отдельно не выделена',
            });
          }
        }
      }
    }
  }

  const groupedProductsRanking = Object.entries(productKeywordMap)
    .map(([name, data]) => ({
      productGroup: name,
      exactConfirmedSum: `${data.exactConfirmedSpent.toFixed(2)} ${data.currency || baseCur}`,
      exactPurchasesList: data.exactPurchases,
      mixedChecksList: data.mixedChecks,
    }))
    .sort((a, b) => parseFloat(b.exactConfirmedSum) - parseFloat(a.exactConfirmedSum));

  const allRecentTxs = state.transactions
    .filter((t) => (t.date >= cutoff))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 150)
    .map((t) => {
      const { store, products } = extractStoreAndProducts(t.description);
      const cat = t.type === 'transfer' ? 'Перевод' : (categoryById(t.categoryId || FALLBACK_CATEGORY).name);
      return `Дата: ${t.date} | Магазин: "${store}" | Куплено: "${products}" | Сумма: ${t.amount} ${t.currency} | Категория: ${cat}`;
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
    aggregatedProductGroups: groupedProductsRanking,
    detailedPurchasesList: detailedPurchases,
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
У тебя есть доступ к актуальным финансовым данным пользователя: списку транзакций, категориям, подпискам, долгам и товарам.

ДАННЫЕ ПОЛЬЗОВАТЕЛЯ (JSON):
${financialContext}

КРИТИЧЕСКИ ВАЖНЫЕ ПРАВИЛА ТОЧНОСТИ:
1. СТРОГОСТЬ БРЕНДОВ И НАЗВАНИЙ:
   - Если пользователь спрашивает про конкретный товар/бренд (например, «KitKat»):
     * Ищи ТОЛЬКО точные упоминания этого бренда (KitKat / КітКат).
     * НЕ включай общие слова «шоколадка x2», «торт» или «конфеты», если там не указан именно этот бренд.
2. ТОЧНЫЕ ЦЕНЫ ИЗ ЧЕКОВ VS ОБЩИЕ ЧЕКИ:
   - Если есть чек с детальными позициями ("exactPurchasesList"): назови ТОЧНУЮ подтверждённую сумму и стоимость каждого товара (например: **KitKat белый 42 г — 31,30 ₴**, **KitKat Nestlé 42 г — 31,90 ₴**, **KitKat Nestlé 40 г — 29,50 ₴**, всего за 3 шт = **92,70 ₴**).
   - Если товар упомянут в составе общего чека ("mixedChecksList", например «квас и KitKat» на сумму 1,75 $):
     * ЧЁТКО поясни, что 1,75 $ — это сумма ВСЕГО чека с квасом, а точная цена батончика отдельно не выделена.
     * НИКОГДА не прибавляй сумму всего смешанного чека (на 700 грн или 16 $) к стоимости одного товара!
3. ТОЧНОСТЬ МАГАЗИНОВ:
   - Магазин указан в поле "store" (ALKOMARKET, АТБ, VARUS). Всегда строго пиши правильный магазин.
4. ФОРМАТИРОВАНИЕ:
   - Выделяй жирным шрифтом названия продуктов, магазинов и точные суммы (**31,30 ₴**, **92,70 ₴**, **VARUS**).
   - Используй понятные списки с эмодзи (🍫, 🍺, 🛒, 🥇, 💡, 📊).
   - Отвечай дружелюбно, профессионально, честно и без выдумок.`
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
