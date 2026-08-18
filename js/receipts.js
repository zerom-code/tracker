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

      // Преобразование времени (HHmmss -> HH:mm:ss или HHmm -> HH:mm:00)
      let time = '';
      if (timeRaw.length === 6) {
        time = `${timeRaw.slice(0, 2)}:${timeRaw.slice(2, 4)}:${timeRaw.slice(4, 6)}`;
      } else if (timeRaw.length === 4) {
        time = `${timeRaw.slice(0, 2)}:${timeRaw.slice(2, 4)}:00`;
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
 * Форматирует и разделяет слипшиеся слова в названиях позиций чека.
 * Например: "КуркаСтегноЗЧастиноюСпинки" -> "Курка Стегно З Частиною Спинки"
 */
function cleanProductName(name) {
  if (!name || typeof name !== 'string') return '';
  let cleaned = name.trim();
  cleaned = cleaned.replace(/([A-ZА-ЯІЇЄҐ])([A-ZА-ЯІЇЄҐ][a-zа-яіїєґ])/g, '$1 $2');
  cleaned = cleaned.replace(/([a-zа-яіїєґ0-9])([A-ZА-ЯІЇЄҐ])/g, '$1 $2');
  return cleaned.replace(/\s+/g, ' ').trim();
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
      const name = cleanProductName(nameMatch[1]);
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
  const lines = txt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let totalSm = null;
  let date = '';
  let time = '';
  let fn = '';
  let id = '';
  let currentItem = null;
  let pendingCalc = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Сумма чека
    const smMatch = line.match(/(?:СУМА ДО СПЛАТИ|СУМА|СУМА:\s*|ВСЬОГО|ИТОГО|БЕЗГОТІВКОВА|РАЗОМ)[\s:]+(\d+[.,]\d{2})(?:\s*(?:ГРН|UAH|Б|А|В|Г))?/i);
    if (smMatch && totalSm === null) {
      totalSm = parseFloat(smMatch[1].replace(',', '.'));
    }

    // Дата и время (ДД.ММ.ГГГГ ЧЧ:ММ:СС или ДД-ММ-ГГГГ)
    const dtMatch = line.match(/(\d{2})[-.](\d{2})[-.](\d{4})\s+(\d{2}:\d{2}(?::\d{2})?)/);
    if (dtMatch && !date) {
      date = `${dtMatch[3]}-${dtMatch[2]}-${dtMatch[1]}`;
      time = dtMatch[4];
    }

    // Фискальный номер кассы/ПРРО
    const fnM = line.match(/(?:РРО\s+)?(?:ПРРО\s+)?ФН\s*(\d{8,12})/i);
    if (fnM && !fn) fn = fnM[1];

    // Номер чека (Чек № 001292789 или Чек 2574394 или ЧЕК ФН ...)
    const idM = line.match(/ЧЕК\s+(?:ФН\s+)?(?:№\s*)?(\d+)/i) || line.match(/ЧЕК\s+(\d+)/i);
    if (idM && !id) id = idM[1];

    // Конец товарной части чека (итоги / подвал)
    if (line.match(/^(?:СУМА ДО СПЛАТИ|СУМА|ВСЬОГО|ИТОГО|РАЗОМ|ГОТІВКА|БЕЗГОТІВКА|КАРТКА|ПДВ|ДИСКОНТ|Скидка|ЧЕК:|Контрольне число|ФІСКАЛЬНИЙ ЧЕК|ЗН\s+|ПЛАТНИК|ОТРИМУВАЧ)/i)) {
      if (currentItem) {
        items.push(currentItem);
        currentItem = null;
      }
      if (line.match(/^(?:СУМА ДО СПЛАТИ|СУМА|ВСЬОГО|ИТОГО|РАЗОМ|ГОТІВКА|БЕЗГОТІВКА)/i)) {
        // продолжаем извлекать метаданные даты и ФН ниже
      }
    }

    // АТБ формат: строка множителя "2 0.064 X 139.89" или "2 2 X 177.90" перед названием товара
    const atbPreCalcMatch = line.match(/^\d+\s+(\d+[.,]?\d*)\s*[xх*×]\s*(\d+[.,]?\d*)$/i);
    if (atbPreCalcMatch) {
      if (currentItem) { items.push(currentItem); currentItem = null; }
      pendingCalc = {
        quantity: parseFloat(atbPreCalcMatch[1].replace(',', '.')),
        price: parseFloat(atbPreCalcMatch[2].replace(',', '.')),
      };
      continue;
    }

    // АТБ формат: однострочная позиция "1 Название товара ... 186.70 А" или "1 Пакет 4.50 А"
    const atbLineMatch = line.match(/^(\d+)\s+(.+?)\s+(\d+[.,]\d{2})\s+[А-ЯA-Z]$/);
    if (atbLineMatch) {
      if (currentItem) { items.push(currentItem); currentItem = null; }
      const name = cleanProductName(atbLineMatch[2]);
      const total = parseFloat(atbLineMatch[3].replace(',', '.'));
      items.push({
        name,
        quantity: 1,
        price: total,
        total,
      });
      pendingCalc = null;
      continue;
    }

    // 1. Поиск строки расчёта с любыми единицами измерения: "1.000 шт x 12.00 = 12.00 А"
    const calcMatch = line.match(/^(\d+[.,]?\d*)\s*(?:[а-яіїєґa-z./]+)?\s*[xх*×]\s*(\d+[.,]?\d*)\s*=\s*(\d+[.,]?\d*)/i)
      || line.match(/^(\d+[.,]?\d*)\s*(?:[а-яіїєґa-z./]+)?\s*[xх*×]\s*(\d+[.,]?\d*)/i);

    if (calcMatch && currentItem) {
      currentItem.quantity = parseFloat(calcMatch[1].replace(',', '.'));
      currentItem.price = parseFloat(calcMatch[2].replace(',', '.'));
      currentItem.total = calcMatch[3] ? parseFloat(calcMatch[3].replace(',', '.')) : (currentItem.quantity * currentItem.price);
      items.push(currentItem);
      currentItem = null;
      continue;
    }

    // 2. Строка с ценой/суммой: "= 12.00" или "12.00 А" или "178.85 Б"
    const singlePriceMatch = line.match(/=\s*(\d+[.,]\d{2})\s*[а-яa-z]?$/i) || line.match(/^(\d+[.,]\d{2})\s*[А-ЯA-Z]$/);
    if (singlePriceMatch && currentItem) {
      currentItem.total = parseFloat(singlePriceMatch[1].replace(',', '.'));
      if (!currentItem.price) currentItem.price = currentItem.total;
      items.push(currentItem);
      currentItem = null;
      continue;
    }

    // 3. Начало новой позиции по "АРТ. №" или "1. Название"
    const artMatch = line.match(/^АРТ\.?\s*№?\s*\d*\s+(.+)$/i) || line.match(/^\d+\.\s+(.+)$/i);
    if (artMatch) {
      if (currentItem) items.push(currentItem);
      currentItem = {
        name: cleanProductName(artMatch[1]),
        quantity: 1,
        price: 0,
        total: 0,
      };
      continue;
    }

    // 4. Позиция после штрих-кода в АТБ с ценой в конце: "Часник імпорт 1 гат 8.95 А" или "Пельмені ... 355.80 А"
    const atbSubItemMatch = line.match(/^(.+?)\s+(\d+[.,]\d{2})\s+[А-ЯA-Z]$/);
    if (atbSubItemMatch && !line.startsWith('-') && !line.startsWith('=')) {
      if (currentItem) { items.push(currentItem); currentItem = null; }
      const name = cleanProductName(atbSubItemMatch[1]);
      const total = parseFloat(atbSubItemMatch[2].replace(',', '.'));
      items.push({
        name,
        quantity: pendingCalc ? pendingCalc.quantity : 1,
        price: pendingCalc ? pendingCalc.price : total,
        total,
      });
      pendingCalc = null;
      continue;
    }

    // 5. NovaPay / Новая почта: "Переказ коштів за послуги ТОВ "Нова пошта"..."
    if (/переказ коштів за послуги/i.test(line)) {
      if (currentItem) { items.push(currentItem); currentItem = null; }
      currentItem = {
        name: 'Послуги Нова пошта (Доставка)',
        quantity: 1,
        price: 0,
        total: 0,
      };
      continue;
    }

    // 6. Дополнение многострочного названия товара
    if (currentItem && !line.match(/^(?:Дисконт|Знижка|Штрих|ПДВ|Код|Ідент|Термінал|Комісія|Платіжна|Вид|ЕПЗ|RRN|СУМА)/i) && !line.startsWith('-') && !line.startsWith('=')) {
      currentItem.name = cleanProductName(currentItem.name + ' ' + line);
    }
  }

  if (currentItem) items.push(currentItem);

  // Извлечение названия магазина из шапки
  const storeName = extractUniversalStoreName(lines);
  const detected = typeof detectMerchantInfo === 'function' ? detectMerchantInfo(storeName, fn, items) : { name: storeName, category: null };

  return {
    type: 'tax_gov_text',
    typeName: 'Касовий чек',
    rawUrl: '',
    fn,
    id,
    amount: totalSm,
    date,
    time,
    storeName: detected.name || storeName || '',
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
  if (typeof serverConfigured === 'function' && serverConfigured()) {
    try {
      const q = new URLSearchParams({
        url: receipt.rawUrl || '',
        fn: receipt.fn || '',
        id: receipt.id || '',
        date: receipt.date || '',
        time: receipt.time || '',
        sm: receipt.amount != null ? String(receipt.amount) : '',
      }).toString();
      const res = await serverFetch('/api/receipt?' + q);
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
 * Нормализует бренд магазина к эталонному виду (VARUS, АТБ, SINSAY, Сільпо и т.д.).
 */
function normalizeBrandName(storeName = '', companyName = '') {
  const combined = (storeName + ' ' + companyName).trim();
  if (/нова\s*пошта|новапошта|novapay|нова\s*пей|новапей/i.test(combined)) return 'Нова пошта';
  if (/varus|варус/i.test(combined)) return 'VARUS';
  if (/атб|atb/i.test(combined)) return 'АТБ';
  if (/сільпо|сильпо|silpo/i.test(combined)) return 'Сільпо';
  if (/novus|новус/i.test(combined)) return 'Novus';
  if (/фора|fora/i.test(combined)) return 'Фора';
  if (/sinsay|синсей/i.test(combined)) return 'SINSAY';
  if (/епіцентр|эпицентр|epicentr/i.test(combined)) return 'Епіцентр';
  if (/eva|єва|prostor|простор/i.test(combined)) return 'EVA';
  if (/ашан|auchan/i.test(combined)) return 'Ашан';
  if (/metro|метро/i.test(combined)) return 'METRO';
  if (/вигідна покупка|аврора|avrora/i.test(combined)) return 'Аврора';
  if (/jysk|юск/i.test(combined)) return 'JYSK';
  if (/mcdonald|макдоналд/i.test(combined)) return 'McDonald’s';
  if (/kfc|кфс/i.test(combined)) return 'KFC';
  if (/wog|вого/i.test(combined)) return 'WOG';
  if (/okko|окко/i.test(combined)) return 'OKKO';
  if (/upg|упг/i.test(combined)) return 'UPG';
  if (/socar|сокар/i.test(combined)) return 'SOCAR';

  if (/^продукти(?:-\d+)?$/i.test(storeName) && /атб/i.test(companyName)) {
    return 'АТБ';
  }

  let clean = storeName || companyName || '';
  clean = clean.replace(/(?:-\d+|\s+№\s*\d+|\s+\d+)$/, '').trim();
  return clean;
}

/**
 * Универсально извлекает название магазина/бренда или юрлица из шапки чека.
 */
function extractUniversalStoreName(rawLines) {
  if (!rawLines || !rawLines.length) return '';
  let company = '';
  let shop = '';

  for (let i = 0; i < Math.min(rawLines.length, 12); i++) {
    const line = rawLines[i].trim();
    if (!line || line.startsWith('-') || line.startsWith('=')) break;
    if (line.includes('Касовий чек') || line.includes('РРО ФН') || line.includes('ПРРО ФН')) break;

    const shopMatch = line.match(/(?:МАГАЗИН|СУПЕРМАРКЕТ|МАРКЕТ|ТОРГОВА ТОЧКА|АПТЕКА|АЗС|КАФЕ|РЕСТОРАН|ВІДДІЛЕННЯ)\s*(.+)?/i);
    if (shopMatch && !shop) {
      let raw = (shopMatch[1] || '').trim();
      if (raw) {
        raw = raw.replace(/(?:\s+|^)(?:ТЦ|ТРЦ|ТОЦ|ТРК|ТК|№|\d+)[^а-яa-z].*$/i, '').trim();
        raw = raw.replace(/["'«»]/g, '').trim();
        if (raw) shop = raw;
      }
    }

    const compMatch = line.match(/(?:ТОВ|ДП|ПП|АТ|ПРАТ|ПАТ|ВАТ|ФОП)\s+["'«]?([^"'»\n]+)["'»]?/i);
    if (compMatch && !company) {
      company = compMatch[1].trim().replace(/["'«»]/g, '').trim();
    }
  }

  return normalizeBrandName(shop, company);
}

/**
 * Умный классификатор категории по списку реально купленных товаров и названию магазина.
 */
function detectCategoryFromItems(items = [], storeName = '') {
  const text = (storeName + ' ' + (items || []).map((i) => i.name).join(' ')).toLowerCase();

  // Новая почта / доставка / почтовые переводы
  if (/нова\s*пошта|novapay|новапей|поштовий\s*переказ|доставка|пошта|meest|міст\s*експрес|укрпошта/i.test(text)) {
    return 'transport';
  }
  if (/кепка|штани|светр|куртка|футболка|джинси|сорочка|сукня|шорти|шкарпетки|білизна|плаття|взуття|одяг|sinsay|zara|h&m|reserved|cropp|house|stradivarius|pull&bear|bershka|lc waikiki/i.test(text)) {
    return 'clothes';
  }
  if (/ліки|таблетк|мазь|краплі|спрей|пластир|вітамін|шприц|бинт|аптек|анц|подорожник|бажаємо здоров|eva|єва|prostor|простор|косметик/i.test(text)) {
    return 'health';
  }
  if (/паливо|бензин|дизель|газ\s+lpg|wog|okko|upg|socar|авто|миття|паркув|таксі|uber|bolt|уклон/i.test(text)) {
    return 'transport';
  }
  if (/піца|бургер|кава|чай|еспресо|капучино|латте|шаурма|суші|рол|ресторан|кафе|mcdonald|kfc/i.test(text)) {
    return 'cafe';
  }
  if (/папір|клей|ручка|зошит|олівець|коректор|книга|підручник/i.test(text)) {
    return 'education';
  }
  if (/цемент|фарба|плитка|дюбель|шуруп|інструмент|кріплення|епіцентр|jysk|лерой|нова лінія|господар/i.test(text)) {
    return 'home';
  }
  return 'groceries';
}

/**
 * Определяет название магазина и категорию по тексту описания, названию или товарам.
 */
function detectMerchantInfo(hint = '', fn = '', items = []) {
  const norm = normalizeBrandName(hint);
  const cat = detectCategoryFromItems(items, norm || hint);
  return {
    name: norm || hint.trim(),
    category: cat,
  };
}

/**
 * Формирует читаемый текст описания для операции из данных чека.
 */
function formatReceiptDescription(receipt, storeHint = '') {
  if (!receipt) return storeHint || '';

  const rawStore = receipt.storeName || storeHint || '';
  const store = normalizeBrandName(rawStore);

  // Если есть список распознанных товаров
  if (receipt.items && receipt.items.length > 0) {
    const itemNames = receipt.items.map((it) => it.name.trim()).filter(Boolean);
    const maxItems = 6;
    const shown = itemNames.slice(0, maxItems).join(', ');
    const more = itemNames.length > maxItems ? ` (ще ${itemNames.length - maxItems})` : '';
    return store ? `${store} (${shown}${more})` : `${shown}${more}`;
  }

  // Если товаров в чеке нет, но в storeHint уже было подробное описание со скобками — сохраняем его
  if (storeHint && storeHint.includes('(')) {
    return storeHint;
  }

  // Если товаров нет — красивое чистое название магазина (или номер если вообще нет названия)
  if (store) return store;
  if (receipt.id) {
    const checkNum = String(receipt.id).replace(/^0+/, '') || receipt.id;
    return `Чек № ${checkNum}`;
  }

  return storeHint || 'Чек по QR';
}
