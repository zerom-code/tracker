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

const KNOWN_MERCHANTS = [
  { keywords: [/varus|варус/i, /омега/i], name: 'VARUS', category: 'products' },
  { keywords: [/атб|atb/i], name: 'АТБ', category: 'products' },
  { keywords: [/сільпо|сильпо|silpo/i, /фоззі|fozzy/i], name: 'Сільпо', category: 'products' },
  { keywords: [/фора|fora/i], name: 'Фора', category: 'products' },
  { keywords: [/novus|новус/i], name: 'Novus', category: 'products' },
  { keywords: [/ашан|auchan/i], name: 'Ашан', category: 'products' },
  { keywords: [/metro|метро/i], name: 'METRO', category: 'products' },
  { keywords: [/епіцентр|эпицентр|epicentr/i], name: 'Епіцентр', category: 'home' },
  { keywords: [/eva|єва/i, /prostor|простор/i], name: 'EVA', category: 'health' },
  { keywords: [/wog|вого/i], name: 'WOG', category: 'car' },
  { keywords: [/okko|окко/i], name: 'OKKO', category: 'car' },
  { keywords: [/socar|сокар/i], name: 'SOCAR', category: 'car' },
  { keywords: [/upg|упг/i], name: 'UPG', category: 'car' },
  { keywords: [/аптека|анц|бажаємо здоров|подорожник|віталюкс|911|фарм/i], name: 'Аптека', category: 'health' },
  { keywords: [/mcdonald|макдоналд|кфс|kfc/i], name: 'McDonald’s', category: 'cafe' },
  { keywords: [/rozetka|розетка/i], name: 'Rozetka', category: 'other' },
  { keywords: [/нова пошта|новапошта|nova poshta/i], name: 'Нова Пошта', category: 'connection' },
  { keywords: [/sinsay|синсей|zara|h&m|lc waikiki|reserved/i], name: 'Одяг', category: 'clothes' },
];

/**
 * Определяет название магазина и категорию по тексту (из Monobank или чека).
 */
function detectMerchantInfo(hint) {
  if (!hint || typeof hint !== 'string') return { name: '', category: null };
  const text = hint.trim();
  for (const m of KNOWN_MERCHANTS) {
    for (const kw of m.keywords) {
      if (kw.test(text)) {
        return { name: m.name, category: m.category };
      }
    }
  }
  return { name: text.slice(0, 30), category: null };
}

/**
 * Формирует читаемый текст описания для операции из данных чека.
 */
function formatReceiptDescription(receipt, storeHint = '') {
  if (!receipt) return '';

  const detected = detectMerchantInfo(receipt.storeName || storeHint || '');
  const store = detected.name || receipt.storeName || storeHint || '';

  // Если есть список распознанных товаров
  if (receipt.items && receipt.items.length > 0) {
    const itemNames = receipt.items.map((it) => it.name.trim()).filter(Boolean);
    const maxItems = 6;
    const shown = itemNames.slice(0, maxItems).join(', ');
    const more = itemNames.length > maxItems ? ` (ще ${itemNames.length - maxItems})` : '';
    return store ? `${store} (${shown}${more})` : `${shown}${more}`;
  }

  // Если есть номер чека
  if (receipt.id) {
    const checkNum = String(receipt.id).replace(/^0+/, '') || receipt.id;
    return store ? `${store} (Чек № ${checkNum})` : `Чек № ${checkNum}`;
  }

  return store ? `${store}` : 'Чек по QR';
}
