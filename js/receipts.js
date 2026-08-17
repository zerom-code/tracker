/* Парсер и обработчик фискальных чеков Украины (ДПС, Checkbox, Вчасно и др.). */

/**
 * Разбирает QR-код чека (URL или текст) и извлекает известные реквизиты.
 */
function parseReceiptQr(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const text = raw.trim();

  // 0) Проверка на вставленный XML чека ДПС
  if (text.includes('<RQ') || text.includes('<DAT') || text.includes('<P ') || (text.startsWith('<?xml') && text.includes('NM='))) {
    const fromXml = parseFiscalXml(text);
    if (fromXml) return fromXml;
  }

  // 0.5) Проверка на скопированный текст чека ДПС (АРТ.№ ...)
  if (text.includes('АРТ.') || text.includes('Касовий чек') || text.includes('СУМА ДО СПЛАТИ')) {
    const fromTxt = parseReceiptText(text);
    if (fromTxt) return fromTxt;
  }

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
 * Разбирает XML фискального чека ДПС (формат DATECS/РРО).
 */
function parseFiscalXml(xmlString) {
  if (!xmlString || typeof xmlString !== 'string') return null;
  if (!xmlString.includes('<RQ') && !xmlString.includes('<DAT') && !xmlString.includes('<P ') && !xmlString.includes('<C ')) {
    return null;
  }

  const items = [];
  const pRegex = /<P\b([^>]+)\/?>/gi;
  let pMatch;
  while ((pMatch = pRegex.exec(xmlString)) !== null) {
    const attrs = pMatch[1];
    const nameMatch = attrs.match(/NM="([^"]+)"/i);
    const prcMatch = attrs.match(/PRC="([^"]+)"/i);
    const qMatch = attrs.match(/Q="([^"]+)"/i);
    const smMatch = attrs.match(/SM="([^"]+)"/i);

    if (nameMatch) {
      const name = nameMatch[1].trim();
      const price = prcMatch ? parseInt(prcMatch[1], 10) / 100 : 0;
      const quantity = qMatch ? parseInt(qMatch[1], 10) / 1000 : 1;
      const total = smMatch ? parseInt(smMatch[1], 10) / 100 : (price * quantity);
      items.push({ name, price, quantity, total });
    }
  }

  const fnMatch = xmlString.match(/FN="([^"]+)"/i);
  const noMatch = xmlString.match(/NO="([^"]+)"/i);
  const tsMatch = xmlString.match(/TS="([^"]+)"/i);
  const smMatch = xmlString.match(/<E\b[^>]*SM="([^"]+)"/i) || xmlString.match(/<M\b[^>]*SM="([^"]+)"/i);

  let date = '';
  let time = '';
  if (tsMatch && tsMatch[1].length >= 14) {
    const raw = tsMatch[1];
    date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    time = `${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}`;
  }

  const amount = smMatch ? parseInt(smMatch[1], 10) / 100 : (items.reduce((s, i) => s + i.total, 0));
  const fn = fnMatch ? fnMatch[1] : '';
  const detected = typeof detectMerchantInfo === 'function' ? detectMerchantInfo('', fn) : { name: '', category: null };

  return {
    type: 'tax_gov_xml',
    typeName: 'ДПС XML',
    rawUrl: '',
    fn,
    id: noMatch ? noMatch[1] : '',
    amount,
    date,
    time,
    storeName: detected.name || '',
    items,
  };
}

/**
 * Разбирает скопированный текст чека с сайта ДПС.
 */
function parseReceiptText(txt) {
  if (!txt || typeof txt !== 'string') return null;
  const items = [];
  const lines = txt.split(/\r?\n/);
  let totalSm = null;
  let date = '';
  let time = '';
  let fn = '';
  let id = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const artMatch = line.match(/^АРТ\.?\s*№?\s*\d*\s+(.+)$/i);
    if (artMatch) {
      items.push({ name: artMatch[1].trim(), price: 0, quantity: 1, total: 0 });
    }
    const smMatch = line.match(/(?:СУМА ДО СПЛАТИ|СУМА|ВСЬОГО|ИТОГО)[\s:]+(\d+[.,]\d{2})/i);
    if (smMatch) totalSm = parseFloat(smMatch[1].replace(',', '.'));

    const dtMatch = line.match(/(\d{2})[-.](\d{2})[-.](\d{4})\s+(\d{2}:\d{2}(?::\d{2})?)/);
    if (dtMatch) {
      date = `${dtMatch[3]}-${dtMatch[2]}-${dtMatch[1]}`;
      time = dtMatch[4];
    }
    const fnM = line.match(/(?:РРО\s+)?ФН\s*(\d{8,12})/i);
    if (fnM) fn = fnM[1];
    const idM = line.match(/ЧЕК\s+(?:ФН\s+)?(?:№\s*)?(\d+)/i);
    if (idM) id = idM[1];
  }

  if (!items.length) return null;

  const detected = typeof detectMerchantInfo === 'function' ? detectMerchantInfo('', fn) : { name: '', category: null };
  return {
    type: 'tax_gov_text',
    typeName: 'ДПС Текст',
    rawUrl: '',
    fn,
    id,
    amount: totalSm,
    date,
    time,
    storeName: detected.name || '',
    items,
  };
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

const KNOWN_FN_PATTERNS = [
  { pattern: /^300079|^300080|^300081|^300082/i, name: 'VARUS', category: 'products' }, // ТОВ "ОМЕГА" / VARUS
  { pattern: /^300122|^300022|^300123|^300023|^300124/i, name: 'АТБ', category: 'products' }, // ТОВ "АТБ-Маркет"
  { pattern: /^300055|^300056|^300057|^300058/i, name: 'Сільпо', category: 'products' }, // ТОВ "Сільпо-Фуд"
  { pattern: /^300071|^300072/i, name: 'Фора', category: 'products' },
  { pattern: /^300061|^300062/i, name: 'Novus', category: 'products' },
  { pattern: /^300091|^300092/i, name: 'Епіцентр', category: 'home' },
  { pattern: /^300045|^300046/i, name: 'EVA', category: 'health' },
  { pattern: /^300031|^300032/i, name: 'WOG', category: 'car' },
  { pattern: /^300035|^300036/i, name: 'OKKO', category: 'car' },
];

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
 * Определяет название магазина и категорию по тексту описания или фискальному номеру (ФН).
 */
function detectMerchantInfo(hint, fn = '') {
  // 1. По фискальному номеру РРО/ПРРО
  if (fn) {
    const cleanFn = String(fn).trim();
    for (const item of KNOWN_FN_PATTERNS) {
      if (item.pattern.test(cleanFn)) {
        return { name: item.name, category: item.category };
      }
    }
  }

  // 2. По тексту подсказки / существующего описания
  if (hint && typeof hint === 'string') {
    const text = hint.trim();
    for (const m of KNOWN_MERCHANTS) {
      for (const kw of m.keywords) {
        if (kw.test(text)) {
          return { name: m.name, category: m.category };
        }
      }
    }
    if (text && text !== 'Чек по QR' && !text.startsWith('Чек №')) {
      return { name: text.slice(0, 30), category: 'products' };
    }
  }

  // По умолчанию фискальные чеки из магазинов — это продукты
  return { name: '', category: 'products' };
}

/**
 * Формирует читаемый текст описания для операции из данных чека.
 */
function formatReceiptDescription(receipt, storeHint = '') {
  if (!receipt) return '';

  const detected = detectMerchantInfo(receipt.storeName || storeHint || '', receipt.fn);
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
