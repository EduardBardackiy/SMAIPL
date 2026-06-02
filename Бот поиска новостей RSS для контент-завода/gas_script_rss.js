/**
 * GAS state-machine для Telegram-бота новостей об ИИ.
 *
 * ВАЖНО:
 * - ВСЯ логика здесь.
 * - ВНЕШНИЙ СЛОЙ (SMAIPL / LLM) ПЕРЕДАЁТ ТОЛЬКО:
 *   { "user_id": "...", "command": "start_search|get_next|confirm_current|finish" }
 * - В ОТВЕТ ПОЛУЧАЕТ:
 *   { "success": true/false, "message": "...", "inline_keyboard": [ [text, command], ... ] }
 *
 * Новости берутся ТОЛЬКО из RSS (RSS_FEEDS).
 * Очередь и индексы хранятся по user_id в ScriptProperties.
 */

/* =========================
   КОНФИГ
========================= */

// RSS-ленты из https://rss.app/
const RSS_FEEDS = [
  {
    url: 'https://rss.app/feeds/k0vxTA5VF5AGXCq6.xml',
    sourceDomain: 'rss.app'
  },
  {
    url: 'https://rss.app/feeds/3ZvaTVg9sBI8yLex.xml',
    sourceDomain: 'rss.app'
  }
];

// Ограничения
const RSS_MAX_NEWS_PER_SEARCH = 10;      // максимум новостей в одной сессии поиска
const RSS_MAX_AGE_HOURS = 72;           // брать новости только за последние N часов
const RSS_MAX_CELL_LENGTH = 50000;      // ограничение Google Sheets
const STATE_KEY_PREFIX = 'rss_bot_state_';
// const MAX_SAVES_PER_SESSION = 2;        // лимит сохранений на сессию (отключено)

// Система отладки
var DEBUG_LOGS = [];
var DEBUG_ENABLED = false;

function debugLog(message) {
  var ts = new Date().toISOString();
  var line = '[' + ts + '] ' + message;
  Logger.log(line);
  if (DEBUG_ENABLED) {
    DEBUG_LOGS.push(line);
  }
}

function debugClear() {
  DEBUG_LOGS = [];
}

function debugEnable() {
  DEBUG_ENABLED = true;
  DEBUG_LOGS = [];
}

function debugDisable() {
  DEBUG_ENABLED = false;
  DEBUG_LOGS = [];
}

/* =========================
   ВХОДНАЯ ТОЧКА (Web App)
========================= */

/**
 * doPost — единая точка входа.
 * Ожидаемый JSON в теле:
 *   { "user_id": "12345", "command": "start_search|get_next|confirm_current|finish" }
 */
function doPost(e) {
  try {
    var body = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
    var payload = {};

    if (body) {
      try {
        payload = JSON.parse(body);
      } catch (parseErr) {
        payload.user_id = (e.parameter && e.parameter.user_id) || '';
        payload.command = (e.parameter && e.parameter.command) || '';
      }
    }

    var userId = (payload.user_id || '').toString().trim();
    var command = (payload.command || '').toString().trim();

    // debug-параметр (опционально)
    if (payload.debug === true || payload.debug === 'true' || (e.parameter && e.parameter.debug === 'true')) {
      debugEnable();
    } else {
      debugDisable();
    }

    if (!userId || !command) {
      return jsonResponse({
        success: false,
        message: 'Некорректный запрос: отсутствуют user_id или command.',
        inline_keyboard: []
      });
    }

    var result;

    switch (command) {
      case 'start_search':
        result = handleStartSearch(userId);
        break;
      case 'confirm_current':
        result = handleConfirmCurrent(userId);
        break;
      case 'get_next':
        result = handleGetNext(userId);
        break;
      case 'finish':
        result = handleFinish(userId);
        break;
      default:
        result = {
          success: false,
          message: 'Неизвестная команда: ' + command,
          inline_keyboard: [
            ['Найти новости', 'start_search'],
            ['Завершить', 'finish']
          ]
        };
    }

    if (!result || typeof result !== 'object') {
      result = {
        success: false,
        message: 'Внутренняя ошибка: пустой результат команды ' + command,
        inline_keyboard: [
          ['Найти новости', 'start_search'],
          ['Завершить', 'finish']
        ]
      };
    }
    if (typeof result.message !== 'string') {
      result.message = 'Внутренняя ошибка: отсутствует текст сообщения.';
    }
    if (!Array.isArray(result.inline_keyboard)) {
      result.inline_keyboard = [];
    }

    return jsonResponse(result);
  } catch (err) {
    Logger.log('doPost error: ' + err.toString());
    return jsonResponse({
      success: false,
      message: 'Сервис временно недоступен. Попробуйте позже.',
      inline_keyboard: [
        ['Найти новости', 'start_search'],
        ['Завершить', 'finish']
      ]
    });
  }
}

/**
 * doGet — прокси в doPost для отладки через URL.
 */
function doGet(e) {
  var payload = {
    user_id: (e.parameter && e.parameter.user_id) || '',
    command: (e.parameter && e.parameter.command) || '',
    debug: (e.parameter && e.parameter.debug) || ''
  };
  var fakeEvent = {
    postData: { contents: JSON.stringify(payload) },
    parameter: e.parameter
  };
  return doPost(fakeEvent);
}

/* =========================
   СОСТОЯНИЕ ПОЛЬЗОВАТЕЛЯ
========================= */

/**
 * Структура состояния:
 * {
 *   queue: [ {id, title, text, source}, ... ],
 *   currentIndex: 0,
 *   savedCount: 0
 * }
 */
function getUserState(userId) {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(STATE_KEY_PREFIX + userId);
  if (!raw) {
    return {
      queue: [],
      currentIndex: 0,
      savedCount: 0
    };
  }
  try {
    var state = JSON.parse(raw);
    if (!Array.isArray(state.queue)) state.queue = [];
    if (typeof state.currentIndex !== 'number') state.currentIndex = 0;
    if (typeof state.savedCount !== 'number') state.savedCount = 0;
    return state;
  } catch (err) {
    Logger.log('getUserState parse error for ' + userId + ': ' + err.toString());
    return {
      queue: [],
      currentIndex: 0,
      savedCount: 0
    };
  }
}

function saveUserState(userId, state) {
  try {
    var props = PropertiesService.getScriptProperties();
    props.setProperty(STATE_KEY_PREFIX + userId, JSON.stringify(state));
  } catch (err) {
    Logger.log('saveUserState error for ' + userId + ': ' + err.toString());
  }
}

function clearUserState(userId) {
  try {
    var props = PropertiesService.getScriptProperties();
    props.deleteProperty(STATE_KEY_PREFIX + userId);
  } catch (err) {
    Logger.log('clearUserState error for ' + userId + ': ' + err.toString());
  }
}

/* =========================
   ОБРАБОТЧИКИ КОМАНД
========================= */

function handleStartSearch(userId) {
  try {
    var news = loadNewsFromRss();
    if (!news.length) {
      clearUserState(userId);
      return {
        success: true,
        message: 'К сожалению, я не нашёл свежих новостей по этой теме.',
        inline_keyboard: [
          ['Найти новости', 'start_search'],
          ['Завершить', 'finish']
        ]
      };
    }

    var state = {
      queue: news,
      currentIndex: 0,
      savedCount: 0
    };
    saveUserState(userId, state);

    var first = state.queue[0];
    var msg = formatNewsMessage(first, state.savedCount, state.queue.length, state.currentIndex);

    return {
      success: true,
      message: msg,
      inline_keyboard: [
        ['Подтвердить', 'confirm_current'],
        ['Пропустить', 'get_next'],
        ['Завершить', 'finish']
      ]
    };
  } catch (err) {
    Logger.log('handleStartSearch error: ' + err.toString());
    return {
      success: false,
      message: 'Ошибка при поиске новостей: ' + err.toString(),
      inline_keyboard: [
        ['Найти новости', 'start_search'],
        ['Завершить', 'finish']
      ]
    };
  }
}

function handleConfirmCurrent(userId) {
  try {
    var state = getUserState(userId);
    if (!state.queue.length) {
      return {
        success: false,
        message: 'Очередь пуста. Нажмите «Найти новости» для нового поиска.',
        inline_keyboard: [
          ['Найти новости', 'start_search'],
          ['Завершить', 'finish']
        ]
      };
    }

    // Проверка лимита отключена - можно сохранять неограниченное количество новостей
    // if (state.savedCount >= MAX_SAVES_PER_SESSION) {
    //   clearUserState(userId);
    //   return {
    //     success: true,
    //     message: '👋 Лимит сохранений достигнут. Новости сохранены в таблицу. До встречи!',
    //     inline_keyboard: []
    //   };
    // }

    var idx = state.currentIndex;
    if (idx < 0 || idx >= state.queue.length) {
      return {
        success: false,
        message: 'Внутренняя ошибка: индекс вне очереди. Попробуйте начать новый поиск.',
        inline_keyboard: [
          ['Найти новости', 'start_search'],
          ['Завершить', 'finish']
        ]
      };
    }

    var current = state.queue[idx];
    var saveResult = saveNewsToSheet(current, userId);
    if (!saveResult.ok) {
      return {
        success: false,
        message: saveResult.errorMessage,
        inline_keyboard: [
          ['Найти новости', 'start_search'],
          ['Завершить', 'finish']
        ]
      };
    }

    // Увеличиваем счетчик только если новость действительно была сохранена (не дубликат)
    if (!saveResult.duplicate) {
      state.savedCount += 1;
      saveUserState(userId, state);
    } else {
      // Если это дубликат, сохраняем состояние без увеличения счетчика
      saveUserState(userId, state);
    }

    // Формируем сообщение в зависимости от того, был ли это дубликат
    var messageText;
    if (saveResult.duplicate) {
      messageText = '⚠️ Эта новость уже была сохранена ранее (дубликат).\n\nЧто делать дальше?';
    } else {
      messageText = '✅ Новость сохранена в таблицу!\n\nЧто делать дальше?';
    }

    // Проверка лимита отключена - можно сохранять неограниченное количество новостей
    // if (state.savedCount >= MAX_SAVES_PER_SESSION) {
    //   clearUserState(userId);
    //   if (saveResult.duplicate) {
    //     return {
    //       success: true,
    //       message: '⚠️ Эта новость уже была сохранена ранее (дубликат).\n\n👋 Лимит в две новости за сессию достигнут. Работа завершена.',
    //       inline_keyboard: []
    //     };
    //   } else {
    //     return {
    //       success: true,
    //       message: '✅ Новость сохранена в таблицу!\n\n👋 Лимит в две новости за сессию достигнут. Работа завершена.',
    //       inline_keyboard: []
    //     };
    //   }
    // }

    return {
      success: true,
      message: messageText,
      inline_keyboard: [
        ['Показать следующую', 'get_next'],
        ['Завершить', 'finish']
      ]
    };
  } catch (err) {
    Logger.log('handleConfirmCurrent error: ' + err.toString());
    return {
      success: false,
      message: 'Ошибка при сохранении новости: ' + err.toString(),
      inline_keyboard: [
        ['Найти новости', 'start_search'],
        ['Завершить', 'finish']
      ]
    };
  }
}

function handleGetNext(userId) {
  try {
    var state = getUserState(userId);
    if (!state.queue.length) {
      return {
        success: true,
        message: 'Очередь пуста. Нажмите «Найти новости» для нового поиска.',
        inline_keyboard: [
          ['Найти новости', 'start_search'],
          ['Завершить', 'finish']
        ]
      };
    }

    state.currentIndex += 1;

    if (state.currentIndex >= state.queue.length) {
      clearUserState(userId);
      return {
        success: true,
        message: 'Все новости из очереди показаны.',
        inline_keyboard: [
          ['Найти новости', 'start_search'],
          ['Завершить', 'finish']
        ]
      };
    }

    saveUserState(userId, state);
    var current = state.queue[state.currentIndex];
    var msg = formatNewsMessage(current, state.savedCount, state.queue.length, state.currentIndex);

    return {
      success: true,
      message: msg,
      inline_keyboard: [
        ['Подтвердить', 'confirm_current'],
        ['Пропустить', 'get_next'],
        ['Завершить', 'finish']
      ]
    };
  } catch (err) {
    Logger.log('handleGetNext error: ' + err.toString());
    return {
      success: false,
      message: 'Ошибка при получении следующей новости: ' + err.toString(),
      inline_keyboard: [
        ['Найти новости', 'start_search'],
        ['Завершить', 'finish']
      ]
    };
  }
}

function handleFinish(userId) {
  try {
    clearUserState(userId);
    return {
      success: true,
      message: '👋 Работа завершена! Новости сохранены в таблицу (если вы их подтверждали). До встречи!',
      inline_keyboard: []
    };
  } catch (err) {
    Logger.log('handleFinish error: ' + err.toString());
    return {
      success: false,
      message: 'Ошибка завершения сессии: ' + err.toString(),
      inline_keyboard: []
    };
  }
}

/* =========================
   РАБОТА С RSS
========================= */

function loadNewsFromRss() {
  var allItems = [];

  RSS_FEEDS.forEach(function (feedCfg) {
    try {
      var items = rssFetchFeed(feedCfg);
      allItems = allItems.concat(items);
    } catch (err) {
      Logger.log('loadNewsFromRss feed error: ' + err.toString());
    }
  });

  var filtered = rssFilterAndNormalizeNews(allItems);
  if (!filtered.length) {
    return [];
  }

  if (filtered.length > RSS_MAX_NEWS_PER_SEARCH) {
    filtered = filtered.slice(0, RSS_MAX_NEWS_PER_SEARCH);
  }

  return filtered.map(function (item) {
    var text = item.fullText || item.description || item.title || '';
    if (text.length > RSS_MAX_CELL_LENGTH) {
      text = text.substring(0, RSS_MAX_CELL_LENGTH - 100) +
        '\n\n[... Текст обрезан из-за ограничения Google Sheets ...]';
    }
    return {
      id: item.id,
      title: item.title || 'Без заголовка',
      text: text,
      source: item.source
    };
  });
}

function rssFetchFeed(feedCfg) {
  var url = feedCfg.url;
  var sourceDomain = feedCfg.sourceDomain || '';

  if (!url || url.indexOf('PASTE_') === 0) {
    Logger.log('RSS feed URL not configured (placeholder): ' + url);
    return [];
  }

  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var code = response.getResponseCode();
  if (code !== 200) {
    Logger.log('RSS fetch error ' + code + ' for ' + url);
    return [];
  }

  var xmlText = response.getContentText();
  var document = XmlService.parse(xmlText);
  var root = document.getRootElement();

  var items = [];

  if (root.getName().toLowerCase() === 'rss') {
    var channel = root.getChild('channel');
    if (!channel) return [];
    var itemElements = channel.getChildren('item');
    itemElements.forEach(function (itemEl) {
      var parsed = rssParseItem(itemEl, sourceDomain);
      if (parsed) items.push(parsed);
    });
  } else if (root.getName().toLowerCase() === 'feed') {
    var entryElements = root.getChildren('entry');
    entryElements.forEach(function (entryEl) {
      var parsedAtom = rssParseAtomEntry(entryEl, sourceDomain);
      if (parsedAtom) items.push(parsedAtom);
    });
  }

  return items;
}

function rssParseItem(itemEl, sourceDomain) {
  try {
    var titleEl = itemEl.getChild('title');
    var linkEl = itemEl.getChild('link');
    var descEl = itemEl.getChild('description');
    var pubDateEl = itemEl.getChild('pubDate');

    var title = titleEl ? titleEl.getText().trim() : '';
    var link = linkEl ? linkEl.getText().trim() : '';
    var description = descEl ? descEl.getText().trim() : '';
    var pubDateRaw = pubDateEl ? pubDateEl.getText().trim() : '';

    var text = rssStripHtml(description);

    return {
      title: title,
      link: link,
      description: text,
      publishedAt: pubDateRaw,
      sourceDomain: sourceDomain
    };
  } catch (err) {
    Logger.log('rssParseItem error: ' + err.toString());
    return null;
  }
}

function rssParseAtomEntry(entryEl, sourceDomain) {
  try {
    var ns = entryEl.getNamespace();
    var titleEl = entryEl.getChild('title', ns);
    var linkEl = entryEl.getChild('link', ns);
    var summaryEl = entryEl.getChild('summary', ns);
    var updatedEl = entryEl.getChild('updated', ns);

    var title = titleEl ? titleEl.getText().trim() : '';
    var link = '';
    if (linkEl) {
      var href = linkEl.getAttribute('href');
      if (href) link = href.getValue();
    }
    var description = summaryEl ? summaryEl.getText().trim() : '';
    var pubDateRaw = updatedEl ? updatedEl.getText().trim() : '';

    var text = rssStripHtml(description);

    return {
      title: title,
      link: link,
      description: text,
      publishedAt: pubDateRaw,
      sourceDomain: sourceDomain
    };
  } catch (err) {
    Logger.log('rssParseAtomEntry error: ' + err.toString());
    return null;
  }
}

function rssStripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function rssFilterAndNormalizeNews(items) {
  var now = new Date();
  var maxAgeMs = RSS_MAX_AGE_HOURS * 60 * 60 * 1000;

  var idMap = {};
  var result = [];

  function passFilter(requireRelevance) {
    idMap = {};
    var out = [];

    items.forEach(function (item) {
      var title = (item.title || '').toString().trim();
      var description = (item.description || '').toString().trim();
      var link = (item.link || '').toString().trim();
      var publishedAtRaw = (item.publishedAt || '').toString().trim();

      if (!title && !description) return;
      if (!link) return;

      var combined = (title + ' ' + description).toLowerCase();
      if (requireRelevance) {
        var relevant = rssIsRelevantToAI(combined);
        if (!relevant) return;
      }

      var publishedDate = rssParseDate(publishedAtRaw);
      if (publishedDate) {
        var ageMs = now.getTime() - publishedDate.getTime();
        if (ageMs > maxAgeMs) return;
      }

      var id = rssGenerateId(link);
      if (idMap[id]) return;
      idMap[id] = true;

      var fullText = description || title;
      if (fullText.length > RSS_MAX_CELL_LENGTH) {
        fullText = fullText.substring(0, RSS_MAX_CELL_LENGTH - 100) + '...';
      }

      out.push({
        id: id,
        title: title || 'Без заголовка',
        description: fullText,
        source: link,
        publishedAt: publishedAtRaw || ''
      });
    });

    return out;
  }

  // 1) Строгая релевантность по ключевым словам.
  result = passFilter(true);

  // 2) Если новые фиды не прошли ключевики (но контент в лентах есть),
  // повторяем попытку без релевантности, чтобы бот не уходил в "пусто".
  if (!result.length) {
    result = passFilter(false);
  }

  result.sort(function (a, b) {
    var da = rssParseDate(a.publishedAt);
    var db = rssParseDate(b.publishedAt);
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return db.getTime() - da.getTime();
  });

  return result;
}

function rssIsRelevantToAI(text) {
  var lower = text.toLowerCase();
  var keywords = ['нейросет', 'искусственный интеллект', 'ai', 'ml', 'chatgpt', 'gpt', 'claude', 'gemini', 'llm'];
  for (var i = 0; i < keywords.length; i++) {
    if (lower.indexOf(keywords[i]) !== -1) return true;
  }
  return false;
}

function rssParseDate(dateStr) {
  if (!dateStr) return null;
  try {
    var d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return d;
  } catch (err) {
    return null;
  }
}

function rssGenerateId(url) {
  var str = (url || '').toString().trim().toLowerCase();
  if (!str) {
    str = 'no-url-' + new Date().getTime();
  }
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, str);
  var hex = bytes.map(function (b) {
    var v = b < 0 ? b + 256 : b;
    var h = v.toString(16);
    return h.length === 1 ? '0' + h : h;
  }).join('');
  return hex.substring(0, 32);
}

/* =========================
   СОХРАНЕНИЕ В ТАБЛИЦУ
========================= */

function saveNewsToSheet(news, userId) {
  try {
    var rawId = PropertiesService.getScriptProperties().getProperty('GOOGLE_SHEET_ID');
    var tableId = rssExtractSheetId(rawId);
    if (!tableId || tableId === 'PASTE_TABLE_ID_HERE') {
      return {
        ok: false,
        errorMessage: 'GOOGLE_SHEET_ID не настроен. Укажите его в Script Properties.'
      };
    }

    var ss;
    try {
      ss = SpreadsheetApp.openById(tableId);
    } catch (openErr) {
      return {
        ok: false,
        errorMessage: 'Не удалось открыть таблицу: ' + openErr.toString()
      };
    }
    var sheet = ss.getSheets()[0];

    var headerRow = sheet.getRange(1, 1, 1, 7).getValues()[0];
    if (!headerRow[0]) {
      sheet.getRange(1, 1, 1, 7).setValues([[
        'Дата/время',
        'Тема',
        'Целевая аудитория',
        'Ссылка на источник',
        'Краткое описание',
        'Текст новости',
        'ID новости'
      ]]);
    }

    var now = new Date();
    var dateTime = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');

    var id = (news.id || '').toString().trim();
    if (!id) {
      return {
        ok: false,
        errorMessage: 'ID новости пустой, сохранение невозможно.'
      };
    }

    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      var idRange = sheet.getRange('G2:G' + lastRow);
      var existingIds = idRange.getValues();
      var alreadyExists = existingIds.some(function (row) {
        var val = (row[0] || '').toString().trim();
        return val && val === id;
      });
      if (alreadyExists) {
        return { 
          ok: true, 
          duplicate: true,
          message: 'Новость уже существует в таблице (дубликат)'
        };
      }
    }

    var fullText = news.text || '';
    if (fullText.length > RSS_MAX_CELL_LENGTH) {
      fullText = fullText.substring(0, RSS_MAX_CELL_LENGTH - 100) +
        '\n\n[... Текст обрезан из-за ограничения Google Sheets ...]';
    }

    var summary = news.title || '';
    if (!summary) {
      summary = fullText.length > 500 ? fullText.substring(0, 500) + '…' : fullText;
    }

    var rowData = [
      dateTime,
      'нейросети',
      'разработчики AI/ML, бизнес-пользователи AI',
      (news.source || '').toString(),
      summary,
      fullText,
      id
    ];

    var rowBefore = sheet.getLastRow();
    sheet.appendRow(rowData);
    var rowAfter = sheet.getLastRow();
    
    // Проверяем, что строка действительно была добавлена
    if (rowAfter <= rowBefore) {
      Logger.log('saveNewsToSheet: appendRow не добавил строку. rowBefore=' + rowBefore + ', rowAfter=' + rowAfter);
      return {
        ok: false,
        errorMessage: 'Не удалось добавить строку в таблицу. Попробуйте еще раз.'
      };
    }

    debugLog('saveNewsToSheet: новость сохранена успешно. ID=' + id + ', строка=' + rowAfter);
    return { ok: true, saved: true, rowNumber: rowAfter };
  } catch (err) {
    Logger.log('saveNewsToSheet error: ' + err.toString());
    return {
      ok: false,
      errorMessage: 'Ошибка сохранения новости в таблицу: ' + err.toString()
    };
  }
}

function rssExtractSheetId(value) {
  if (!value || typeof value !== 'string') return null;
  var s = value.trim();
  if (!s) return null;
  var match = s.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  return s;
}

/* =========================
   ФОРМАТИРОВАНИЕ ОТВЕТА
========================= */

function formatNewsMessage(news, savedCount, totalInQueue, currentIndex) {
  var parts = [];
  parts.push('📰 Новость об искусственном интеллекте');
  parts.push('');
  parts.push(news.title || '');
  parts.push('');
  parts.push(news.text || '');
  parts.push('');
  parts.push('Источник: ' + (news.source || ''));
  parts.push('');
  parts.push('Сохранено за сессию: ' + savedCount);
  
  var humanIndex = 1;
  if (typeof currentIndex === 'number' && currentIndex >= 0) {
    humanIndex = currentIndex + 1;
  }
  parts.push('Новость в очереди: ' + humanIndex + ' из ' + totalInQueue);
  return parts.join('\n');
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

