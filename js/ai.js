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

  // Детализированные операции за последние 60 дней (включая товары из чеков)
  const cutoff = new Date(Date.now() - 60 * 86400 * 1000).toISOString().slice(0, 10);
  const recentTxs = state.transactions
    .filter((t) => (t.date >= cutoff))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 150)
    .map((t) => {
      const cat = t.type === 'transfer' ? 'Перевод' : (categoryById(t.categoryId || FALLBACK_CATEGORY).name);
      let itemStr = '';
      if (t.receiptItems && t.receiptItems.length) {
        itemStr = ' [Товары из чека: ' + t.receiptItems.map((it) => `${it.name} (${it.quantity > 1 ? it.quantity + 'x ' : ''}${it.total} ${t.currency})`).join(', ') + ']';
      }
      return `${t.date}: ${t.type === 'expense' ? 'Расход' : (t.type === 'income' ? 'Доход' : 'Перевод')} ${t.amount} ${t.currency} | Категория: ${cat} | Описание: "${t.description || ''}"${itemStr}`;
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
    subscriptions: subs,
    debts: debts,
    transactionsSample: recentTxs,
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
У тебя есть актуальный доступ к детальным финансовым данным пользователя: транзакциям, категориям, подпискам, долгам и товарам из фискальных чеков (позиции с ценами).

ДАННЫЕ ПОЛЬЗОВАТЕЛЯ (JSON):
${financialContext}

ИНСТРУКЦИИ:
1. Отвечай дружелюбно, профессионально, кратко и по существу на том языке, на котором спросил пользователь (русский или украинский).
2. При анализе товаров из чеков (например, сладости, мясо, молочка, одежда, напитки) внимательно изучай поле [Товары из чека] в транзакциях и делай точные подсчеты.
3. Выделяй важные суммы, названия магазинов, товаров и процентов жирным шрифтом (например: **350,00 ₴**, **VARUS**, **КітКат**).
4. Структурируй ответы списками с эмодзи (🛒, 💡, 📊, 💰, 📉).
5. Если пользователь просит совет по экономии или оптимизации, давай конкретные практические рекомендации на основе его реальных привычек трат.
6. Не придумывай несуществующие траты — опирайся строго на предоставленные данные.`
  };

  const messages = [
    systemMessage,
    ...chatHistory.slice(-8), // держим последние 8 реплик для экономии токенов и фокуса
    { role: 'user', content: userMessage }
  ];

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model,
      messages: messages,
      temperature: 0.5,
    }),
  });

  if (!res.ok) {
    let errText = '';
    try {
      const errJson = await res.json();
      errText = (errJson.error && errJson.error.message) || JSON.stringify(errJson);
    } catch (e) {
      errText = `HTTP ${res.status}: ${res.statusText}`;
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
      max_tokens: 10,
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
