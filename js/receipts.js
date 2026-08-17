/* Парсер и обработчик фискальных чеков Украины (ДПС, Checkbox, Вчасно и др.). */

/**
 * Разбирает QR-код чека (URL или текст) и извлекает известные реквизиты.
 */
function parseReceiptQr(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const text = raw.trim();

  // 1) ДПС Украины: cabinet.tax.gov.ua/cashregs/check?...
  if (text.includes('cabinet.tax.gov.ua') || text.includes('tax.gov.ua/cashregs')) {
    try {
      const url = new URL(text);
      const fn = url.searchParams.get('fn') || '';
      const id = url.searchParams.get('id') || '';
      const sm = url.searchParams.get('sm') || '';
      const dateRaw = url.searchParams.get('date') || '';
      const timeRaw = url.searchParams.get('time') || '';
      const mac = url.searchParams.get('mac') || '';

      // Преобразование даты (YYYYMMDD -> YYYY-MM-DD)
      let date = '';
      if (dateRaw.length === 8) {
        date = `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`;
      }

      // Преобразование времени (HHmmss -> HH:mm:ss или HHmm -> HH:mm)
      let time = '';
      if (timeRaw.length === 6) {
        time = `${timeRaw.slice(0, 2)}:${timeRaw.slice(2, 4)}:${timeRaw.slice(4, 6)}`;
      } else if (timeRaw.length === 4) {
        time = `${timeRaw.slice(0, 2)}:${timeRaw.slice(2, 4)}`;
      }

      const amount = parseFloat(sm.replace(',', '.')) || null;

      return {
        type: 'tax_gov_ua',
        typeName: 'ДПС України',
        rawUrl: text,
        fn,
        id,
        amount,
        date,
        time,
        mac,
        storeName: '',
        items: [],
      };
    } catch (e) {
      // если не валидный URL, пробуем вытащить параметры регулярками
    }
  }

  // 2) Checkbox (my.checkbox.ua / check.gov.ua)
  const checkboxMatch = text.match(/(?:my\.checkbox\.ua|check\.gov\.ua|checkbox\.in\.ua)\/(?:check|receipts)\/([a-zA-Z0-9_-]+)/i);
  if (checkboxMatch) {
    return {
      type: 'checkbox',
      typeName: 'Checkbox (ПРРО)',
      rawUrl: text,
      id: checkboxMatch[1],
      amount: null,
      date: '',
      time: '',
      storeName: '',
      items: [],
    };
  }

  // 3) Вчасно.Каса (kasa.vchasno.ua)
  const vchasnoMatch = text.match(/kasa\.vchasno\.ua\/check\/([a-zA-Z0-9_-]+)/i);
  if (vchasnoMatch) {
    return {
      type: 'vchasno',
      typeName: 'Вчасно.Каса',
      rawUrl: text,
      id: vchasnoMatch[1],
      amount: null,
      date: '',
      time: '',
      storeName: '',
      items: [],
    };
  }

  // 4) Другие фискальные или магазинные ссылки
  if (/^https?:\/\//i.test(text)) {
    return {
      type: 'url',
      typeName: 'Електронний чек',
      rawUrl: text,
      id: '',
      amount: null,
      date: '',
      time: '',
      storeName: '',
      items: [],
    };
  }

  return null;
}

/**
 * Запрашивает детальную информацию о чеке (список товаров, продавца, сумму).
 */
async function fetchReceiptDetails(receipt) {
  if (!receipt) return null;

  // 1) Checkbox: прямой публичный JSON API
  if (receipt.type === 'checkbox' && receipt.id) {
    try {
      const res = await fetch(`https://api.checkbox.in.ua/api/v1/receipts/${receipt.id}`, {
        headers: { 'Accept': 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        const items = (data.goods || []).map((g) => {
          const good = g.good || {};
          return {
            name: good.name || g.name || 'Товар',
            price: (g.price || 0) / 100,
            quantity: (g.quantity || 1000) / 1000,
            total: (g.sum || (g.price * (g.quantity || 1000) / 1000)) / 100,
          };
        });

        const amount = data.total_sum ? data.total_sum / 100 : receipt.amount;
        const dateRaw = data.created_at || '';
        let date = receipt.date;
        if (dateRaw && dateRaw.length >= 10) date = dateRaw.slice(0, 10);

        const storeName = (data.organization && data.organization.name) ||
          (data.department && data.department.name) || '';

        return {
          ...receipt,
          amount,
          date,
          storeName,
          items,
        };
      }
    } catch (e) {
      console.warn('Checkbox fetch error:', e);
    }
  }

  // 2) Запрос через наш личный сервер (если подключен server.js), чтобы обойти CORS
  if (typeof serverConfigured === 'function' && serverConfigured() && receipt.rawUrl) {
    try {
      const res = await serverFetch('/api/receipt?url=' + encodeURIComponent(receipt.rawUrl));
      if (res && res.success) {
        return {
          ...receipt,
          storeName: res.storeName || receipt.storeName,
          amount: res.amount || receipt.amount,
          date: res.date || receipt.date,
          items: (res.items && res.items.length) ? res.items : receipt.items,
        };
      }
    } catch (e) {
      console.warn('Server receipt fetch error:', e);
    }
  }

  return receipt;
}

/**
 * Формирует читаемый текст описания для операции из данных чека.
 */
function formatReceiptDescription(receipt, storeHint = '') {
  if (!receipt) return '';

  const store = receipt.storeName || storeHint || '';
  const prefix = store ? `${store}: ` : '';

  // Если есть список распознанных товаров
  if (receipt.items && receipt.items.length > 0) {
    const itemNames = receipt.items.map((it) => it.name.trim()).filter(Boolean);
    // Берем первые 5-7 товаров для емкого описания
    const maxItems = 6;
    const shown = itemNames.slice(0, maxItems).join(', ');
    const more = itemNames.length > maxItems ? ` ... (ще ${itemNames.length - maxItems})` : '';
    return `${prefix}${shown}${more}`;
  }

  // Если есть фискальный номер и номер чека
  if (receipt.id && receipt.fn) {
    return `${prefix}Чек № ${receipt.id} (ФН ${receipt.fn})`;
  }
  if (receipt.id) {
    return `${prefix}Чек № ${receipt.id}`;
  }

  return store ? `${store} (Чек за ${receipt.date || 'сьогодні'})` : 'Покупка по чеку';
}
