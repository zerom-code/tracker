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

  // Автоматическая группировка продуктов по ключевым словам для быстрого и точного анализа
  const productKeywordMap = {};
  const keywordsList = [
    { key: 'Пиво', match: /пив[оаеи]/i },
    { key: 'Сидр', match: /сидр/i },
    { key: 'Настойки и крепкий алкоголь', match: /настойк|водк|виски|ром|джин|коньяк/i },
    { key: 'Вино', match: /вин[оа]/i },
    { key: 'Мясо и курица', match: /мяс|куриц|курк|говяд|свин|фарш|печень|стегн/i },
    { key: 'Пельмени и полуфабрикаты', match: /пельмен|вареник|лазань/i },
    { key: 'Сосиски и колбасы', match: /сосиск|колбас|ковбас|сард/i },
    { key: 'Сладости и KitKat', match: /kitkat|кіткат|шоколад|батончик|конфет|печень|торт/i },
    { key: 'Снеки, чипсы и орешки', match: /чипс|орешк|горіх|сухарик|снек/i },
    { key: 'Напитки и кофе', match: /pepsi|пепси|кола|cola|кофе|кава|чай|сок|энергетик|енергетик/i },
    { key: 'Сыр и молочка', match: /сыр|сир|молок|сметан|творог|йогурт/i },
  ];

  for (const t of expenseTxs) {
    const textToSearch = `${t.description || ''} ${(t.receiptItems || []).map((x) => x.name).join(' ')}`;
    const { store, products } = extractStoreAndProducts(t.description);
    
    for (const kw of keywordsList) {
      if (kw.match.test(textToSearch)) {
        if (!productKeywordMap[kw.key]) {
          productKeywordMap[kw.key] = { totalEstimatedSpent: 0, count: 0, purchases: [] };
        }
        productKeywordMap[kw.key].totalEstimatedSpent += t.amount;
        productKeywordMap[kw.key].count += 1;
        productKeywordMap[kw.key].purchases.push({
          date: t.date,
          store: store,
          amount: `${t.amount} ${t.currency}`,
          description: products,
        });
      }
    }
  }

  const groupedProductsRanking = Object.entries(productKeywordMap)
    .map(([name, data]) => ({
      productGroup: name,
      mentionsCount: data.count,
      totalSum: `${data.totalEstimatedSpent.toFixed(2)} ${baseCur}`,
      purchasesList: data.purchases,
    }))
    .sort((a, b) => parseFloat(b.totalSum) - parseFloat(a.totalSum));

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
    aggregatedProductGroupsBySpending: groupedProductsRanking,
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

КРИТИЧЕСКИ ВАЖНЫЕ ПРАВИЛА:
1. СТРОГАЯ ТОЧНОСТЬ МАГАЗИНОВ:
   Поле "store" содержит название магазина (например, ALKOMARKET, АТБ, VARUS).
   НИКОГДА не путай магазины! Если покупка совершена в ALKOMARKET ("Пиво и орешки" 172 ₴) — пиши строго ALKOMARKET, а не АТБ!
2. АНАЛИЗ ВОПРОСА "НА КАКОЙ ПРОДУКТ Я ПОТРАТИЛ БОЛЬШЕ ВСЕГО?":
   - Пользователь имеет в виду конкретный продукт/тип товара во ВСЕХ магазинах за период (например: Пиво, Мясо/Курица, Сладости/KitKat, Сидр, Пельмени и т.д.).
   - Используй готовый блок "aggregatedProductGroupsBySpending" и "detailedPurchasesList".
   - Определи продукт-лидер, на который ушло больше всего денег и который чаще всего покупался.
   - Приведи СПИСОК ВСЕХ покупок этого продукта с ТОЧНЫМ указанием правильного магазина, суммы и даты.
   - Подведи четкий суммарный итог (сколько всего потрачено на этот продукт).
3. ФОРМАТИРОВАНИЕ:
   - Выделяй жирным шрифтом названия продуктов, магазинов и суммы (например: **Пиво**, **ALKOMARKET — 172 ₴**, **VARUS — 596,63 ₴**).
   - Используй понятные списки с эмодзи (🍺, 🛒, 🥇, 🥈, 💡, 📊).
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
