/**
 * GAS state-machine для ассистента "Редактор/Публикатор" на базе очереди в Google Sheets.
 *
 * ВАЖНО:
 * - Вся логика состояния и работы с таблицей находится здесь.
 * - Внешний слой (SMAIPL / LLM) НЕ хранит состояние и НЕ принимает решения.
 * - Внешний слой вызывает Web App только командами и показывает пользователю ответ как есть:
 *   {
 *     "success": true/false,
 *     "message": "...",
 *     "inline_keyboard": [ [text, command], ... ],
 *     "data": { ... }
 *   }
 *
 * Сценарий (высокоуровневый):
 * 1) get_next_item -> берём следующую строку из таблицы и "лочим" на user_id
 * 2) regenerate_text → save_text_draft (текст сразу одобряется) → изображение / approve_text (резерв)
 * 3) save_image / approve_image / publish_to_channel (готовность к 337 + mark_published)
 * 4) publish_to_telegram_and_mark (атомарно: sendPhoto + PUBLISHED/ERROR)
 * 5) mark_published (только после результата 337) [legacy]
 * 5) delete_published_row -> удаляем строку только после успешной публикации
 */
 
/* =========================
   КОНФИГ
========================= */
 
const PUBLISH_STATE_KEY_PREFIX = 'publisher_state_';
const PUBLISH_DEFAULT_SHEET_NAME = 'ToPublish'; // можно переопределить через Script Properties: PUBLISH_SHEET_NAME
const PUBLISH_DEFAULT_ARCHIVE_SHEET_NAME = 'PublishedArchive'; // можно переопределить через Script Properties: PUBLISH_ARCHIVE_SHEET_NAME
const PUBLISH_LOCK_TTL_MIN = 120;               // если лок "завис" > TTL — разрешаем перезахват
 
// Колонки "базовой" RSS-таблицы (как в gas_script_rss.js): A..G
// Добавочные колонки для пайплайна публикации начинаем с H.
const COLS = {
  createdAt: 1,     // A
  topic: 2,         // B
  audience: 3,      // C
  sourceUrl: 4,     // D
  summary: 5,       // E
  rawText: 6,       // F
  newsId: 7,        // G
  tgTextDraft: 8,   // H
  tgTextApproved: 9,// I
  imageUrl: 10,     // J
  imageApproved: 11,// K
  publishStatus: 12,// L (NEW|IN_PROGRESS|PUBLISHED|ERROR)
  publishResultRaw: 13, // M (сырой ответ 337)
  lockedBy: 14,     // N
  lockedAt: 15      // O
};
 
const REQUIRED_RESPONSE_FIELDS = ['success', 'message', 'inline_keyboard'];
 
/* =========================
  ВСПОМОГАТЕЛЬНЫЕ: Telegram UI (обход проблем рендера кнопок во внешнем слое)
========================= */

// Преобразует нашу плоскую клавиатуру вида:
// [ ['Текст', 'command'], ... ]
// в Telegram reply_markup.inline_keyboard (по 1 кнопке в строке).
function toTelegramInlineKeyboard_(inlineKeyboard) {
  var rows = [];
  if (!inlineKeyboard || !Array.isArray(inlineKeyboard)) return rows;
  inlineKeyboard.forEach(function (btn) {
    if (!btn || !Array.isArray(btn) || btn.length < 2) return;
    var text = (btn[0] || '').toString();
    var cmd = (btn[1] || '').toString();
    if (!text || !cmd) return;
    rows.push([{ text: text, callback_data: cmd }]);
  });
  return rows;
}

// Отправляет пользователю (chat_id=userId) сообщение с inline-кнопками напрямую через Bot API.
// Это нужно, потому что внешний слой иногда выводит function_result как сырой dict,
// и кнопки не отображаются в Telegram-клиенте.
function trySendTelegramUiToUser_(botToken, userId, text, inlineKeyboard) {
  try {
    var token = (botToken || '').toString().trim();
    var chatId = (userId || '').toString().trim();
    if (!token || !chatId) return;

    var url = 'https://api.telegram.org/bot' + token + '/sendMessage';
    var payload = {
      chat_id: chatId,
      text: (text || '').toString()
    };

    var kb = toTelegramInlineKeyboard_(inlineKeyboard);
    if (kb && kb.length) {
      payload.reply_markup = JSON.stringify({ inline_keyboard: kb });
    }

    UrlFetchApp.fetch(url, {
      method: 'post',
      payload: payload,
      muteHttpExceptions: true
    });
  } catch (e) {
    // молча игнорируем: это "best effort" UI-уведомление
    Logger.log('trySendTelegramUiToUser_ ERROR: ' + e);
  }
}

// По умолчанию прямую отправку UI выключаем, чтобы не было дублей сообщений:
// 1) SMAIPL/LLM показывает function_result
// 2) и GAS дополнительно шлёт sendMessage
//
// Включается только явным флагом в payload: ui_fallback::1
// либо Script Property: ENABLE_DIRECT_UI_FALLBACK = 1|true
function shouldSendDirectUiFallback_(payload) {
  try {
    var v = payload ? payload.ui_fallback : null;
    var enabledByPayload = (v === true || v === 'true' || v === 1 || v === '1');
    if (enabledByPayload) return true;

    var props = PropertiesService.getScriptProperties();
    var p = (props.getProperty('ENABLE_DIRECT_UI_FALLBACK') || '').toString().trim().toLowerCase();
    return (p === '1' || p === 'true' || p === 'yes' || p === 'y' || p === 'on');
  } catch (e) {
    return false;
  }
}

/* =========================
   ВХОДНАЯ ТОЧКА (Web App)
========================= */
 
function doPost(e) {
  try {
    var payload = parsePayload_(e);
    var userId = (payload.user_id || '').toString().trim();
    var command = (payload.command || '').toString().trim();
 
    if (!userId || !command) {
      return jsonResponse_({
        success: false,
        message: 'Некорректный запрос: отсутствуют user_id или command.',
        inline_keyboard: [
          ['Взять следующую новость', 'get_next_item'],
          ['Завершить', 'finish']
        ],
        data: {}
      });
    }
 
    var result;
    switch (command) {
      case 'start':
        result = handleStart_(userId);
        break;
      case 'get_next_item':
        result = handleGetNextItem_(userId);
        break;
      case 'save_text_draft':
        result = handleSaveTextDraft_(userId, payload);
        break;
      case 'regenerate_text':
        result = handleRegenerateText_(userId, payload);
        break;
      case 'approve_text':
        result = handleApproveText_(userId, payload);
        break;
      case 'save_image':
        result = handleSaveImage_(userId, payload);
        break;
      case 'approve_image':
        result = handleApproveImage_(userId, payload);
        break;
      case 'publish_to_channel':
        result = handlePublishToChannel_(userId, payload);
        break;
      case 'publish_to_telegram_and_mark':
        result = handlePublishToTelegramAndMark_(userId, payload);
        break;
      case 'mark_published':
        result = handleMarkPublished_(userId, payload);
        break;
      case 'delete_published_row':
        result = handleDeletePublishedRow_(userId, payload);
        break;
      case 'release_lock':
        result = handleReleaseLock_(userId, payload);
        break;
      case 'finish':
        result = handleFinish_(userId);
        break;
      default:
        result = {
          success: false,
          message: 'Неизвестная команда: ' + command,
          inline_keyboard: [
            ['Взять следующую новость', 'get_next_item'],
            ['Завершить', 'finish']
          ],
          data: {}
        };
    }
 
    result = normalizeResponse_(result);
    return jsonResponse_(result);
  } catch (err) {
    Logger.log('publisher doPost error: ' + err.toString());
    return jsonResponse_({
      success: false,
      message: 'Сервис временно недоступен. Попробуйте позже.',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    });
  }
}
 
function doGet(e) {
  var param = e.parameter || {};
  var payload = {
    user_id: (param.user_id || '').toString(),
    command: (param.command || '').toString(),
    row_id: (param.row_id || '').toString()
  };
  // одна строка params в query (?params=user_id::...##command::...) — как у некоторых клиентов
  if (param.params && typeof param.params === 'string' && param.params.indexOf('::') !== -1) {
    var fromQuery = parseParamsString_(param.params);
    Object.keys(fromQuery).forEach(function (k) {
      payload[k] = fromQuery[k];
    });
  }
  var fakeEvent = {
    postData: { contents: JSON.stringify(payload) },
    parameter: param
  };
  return doPost(fakeEvent);
}
 
/* =========================
   ХЕНДЛЕРЫ КОМАНД
========================= */
 
function handleStart_(userId) {
  saveUserState_(userId, {
    rowId: null,
    newsId: null
  });
  return {
    success: true,
    message: 'Готово. Нажмите «Взять следующую новость», чтобы начать подготовку поста.',
    inline_keyboard: [
      ['Взять следующую новость', 'get_next_item'],
      ['Завершить', 'finish']
    ],
    data: {}
  };
}
 
function handleGetNextItem_(userId) {
  var ctx = openContext_();
  ensureHeader_(ctx.sheet);
 
  // если у пользователя уже есть лок — сначала отдадим текущую
  var state = getUserState_(userId);
  if (state && state.rowId) {
    var existing = readRowAsItem_(ctx.sheet, state.rowId);
    if (existing && existing.newsId) {
      return buildItemResponse_(
        'Текущая новость уже выбрана. Продолжаем с неё. Сначала нажмите «Перегенерировать текст» — появится черновик поста и кнопка сохранения.',
        existing
      );
    }
  }
 
  var nextRow = findAndLockNextRow_(ctx.sheet, userId);
  if (!nextRow) {
    clearUserState_(userId);
    return {
      success: true,
      message: 'В таблице нет новостей для публикации. Добавьте новости и попробуйте снова.',
      inline_keyboard: [
        ['Обновить', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }
 
  saveUserState_(userId, { rowId: nextRow.rowId, newsId: nextRow.newsId });
  return buildItemResponse_(
    'Новость получена из таблицы. Исходник ниже. Нажмите «Перегенерировать текст», чтобы получить перефраз для поста; затем — «Сохранить черновик новости».',
    nextRow
  );
}
 
function handleSaveTextDraft_(userId, payload) {
  var rowId = safeInt_(payload.row_id);
  if (!rowId) {
    // Фолбэк: иногда SMAIPL может не подставить row_id корректно.
    // Тогда берём rowId из state, который выставляется на get_next_item.
    var st = getUserState_(userId);
    rowId = st && st.rowId ? st.rowId : null;
  }
  var tgText = (payload.tg_text || payload.post_text || '').toString();
  if (!rowId || !tgText.trim()) {
    return {
      success: false,
      message: 'Некорректный запрос: нужны row_id и tg_text (не пустой).',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }
 
  var ctx = openContext_();
  ensureHeader_(ctx.sheet);
 
  if (!ensureRowLocked_(ctx.sheet, rowId, userId)) {
    return {
      success: false,
      message: 'Эта строка не залочена на вас или лок истёк. Нажмите «Взять следующую новость».',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }
 
  ctx.sheet.getRange(rowId, COLS.tgTextDraft).setValue(tgText);
  ctx.sheet.getRange(rowId, COLS.tgTextApproved).setValue(true);
  ctx.sheet.getRange(rowId, COLS.publishStatus).setValue('IN_PROGRESS');
 
  var item = readRowAsItem_(ctx.sheet, rowId);
  var msg =
    'Текст поста сохранён в таблице и принят. Следующий шаг — картинка к посту: нажмите «Сгенерировать изображение» (ассистент создаст изображение и запишет URL в таблицу через GAS).\n\nТекст поста:\n\n' +
    tgText;
  return {
    success: true,
    message: msg,
    inline_keyboard: [
      ['Сгенерировать изображение', 'save_image'],
      ['Завершить', 'finish']
    ],
    data: {
      row_id: rowId,
      news_id: item.newsId || '',
      tg_text_draft: tgText
    }
  };
}

function handleRegenerateText_(userId, payload) {
  var rowId = safeInt_(payload.row_id);
  if (!rowId) {
    var st0 = getUserState_(userId);
    rowId = st0 && st0.rowId ? st0.rowId : null;
  }
  if (!rowId) {
    return {
      success: false,
      message: 'Некорректный запрос: нужен row_id (или сначала «Взять следующую новость»).',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }

  var ctx = openContext_();
  ensureHeader_(ctx.sheet);

  if (!ensureRowLocked_(ctx.sheet, rowId, userId)) {
    return {
      success: false,
      message: 'Эта строка не залочена на вас или лок истёк. Нажмите «Взять следующую новость».',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }

  var item = readRowAsItem_(ctx.sheet, rowId);
  var intro =
    'Сформируй готовый текст поста по данным ниже (перефраз, не копия ячеек). Если в диалоге уже был блок «Черновик поста (перефраз)» — сделай новую редакцию: другой заход и структура, те же факты.\n\nИсходные данные новости:';
  return {
    success: true,
    message: intro + '\n\n' + formatNewsItemForEditor_(item),
    inline_keyboard: draftingKeyboard_(),
    data: itemToPublisherData_(item)
  };
}
 
function handleApproveText_(userId, payload) {
  var rowId = safeInt_(payload.row_id);
  if (!rowId) {
    var st = getUserState_(userId);
    rowId = st && st.rowId ? st.rowId : null;
  }
  if (!rowId) {
    return {
      success: false,
      message: 'Некорректный запрос: нужен row_id.',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }
 
  var ctx = openContext_();
  ensureHeader_(ctx.sheet);
 
  if (!ensureRowLocked_(ctx.sheet, rowId, userId)) {
    return {
      success: false,
      message: 'Эта строка не залочена на вас или лок истёк. Нажмите «Взять следующую новость».',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }
 
  ctx.sheet.getRange(rowId, COLS.tgTextApproved).setValue(true);
  var item = readRowAsItem_(ctx.sheet, rowId);

  var approvedBody = (item.tgTextDraft || '').toString();
  var msg =
    'Текст одобрен. Следующий шаг: сгенерировать и согласовать изображение.' +
    (approvedBody.trim()
      ? '\n\nУтверждённый текст поста:\n\n' + approvedBody
      : '');

  return {
    success: true,
    message: msg,
    inline_keyboard: [
      ['Сгенерировать изображение', 'save_image'],
      ['Завершить', 'finish']
    ],
    data: {
      row_id: rowId,
      news_id: item.newsId || '',
      tg_text_draft: item.tgTextDraft || ''
    }
  };
}
 
function handleSaveImage_(userId, payload) {
  var rowId = safeInt_(payload.row_id);
  if (!rowId) {
    var st = getUserState_(userId);
    rowId = st && st.rowId ? st.rowId : null;
  }
  var imageUrl = (payload.image_url || '').toString().trim();
  var imagePrompt = (payload.image_prompt || '').toString().trim();
  if (!rowId || !imageUrl) {
    return {
      success: false,
      message: 'Некорректный запрос: нужны row_id и image_url.',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }

  var ctx = openContext_();
  ensureHeader_(ctx.sheet);
  var rowValidation = validateRowIdForAction_(ctx.sheet, rowId);
  if (!rowValidation.ok) {
    // Если модель подставила технический id (message_id/from_user_id и т.п.),
    // fallback берём row_id из состояния пользователя (которое выставляется на get_next_item).
    var st = getUserState_(userId);
    if (st && st.rowId && st.rowId !== rowId) {
      rowId = st.rowId;
      rowValidation = validateRowIdForAction_(ctx.sheet, rowId);
    }
  }
  if (!rowValidation.ok) {
    return {
      success: false,
      message: rowValidation.message,
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }

  if (!ensureRowLocked_(ctx.sheet, rowId, userId)) {
    return {
      success: false,
      message: 'Эта строка не залочена на вас или лок истёк. Нажмите «Взять следующую новость».',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }

  ctx.sheet.getRange(rowId, COLS.imageUrl).setValue(imageUrl);
  // Новый сценарий: сохранение изображения = подтверждение изображения.
  ctx.sheet.getRange(rowId, COLS.imageApproved).setValue(true);
  if (imagePrompt) {
    // сохраняем prompt рядом с URL (в рамках минимальной схемы — в publishResultRaw не используем)
    ctx.sheet.getRange(rowId, COLS.publishResultRaw).setValue('image_prompt: ' + imagePrompt);
  }
 
  var item = readRowAsItem_(ctx.sheet, rowId);
  var msg =
    'Изображение сохранено и автоматически одобрено.' +
    ' Если нужно изменить картинку — нажмите «Сгенерировать изображение» для перегенерации.' +
    ' Иначе можно сразу публиковать в канал.' +
    '\n\nСсылка на файл:\n' +
    imageUrl;

  // Опционально: автопубликация сразу после save_image, чтобы не зависеть от клика "Опубликовать в канал"
  // (внешний слой иногда "имитирует" публикацию без реального вызова GAS).
  var autoPublish = payload.auto_publish === true || payload.auto_publish === 'true' || payload.auto_publish === 1 || payload.auto_publish === '1';
  if (autoPublish) {
    var botToken = (payload.bot_token || '').toString().trim();
    var channelId = (payload.channel_id || '').toString().trim();
    // Если не передали, пробуем Script Properties (удобно, чтобы убрать токен из промпта).
    if (!botToken || !channelId) {
      var props = PropertiesService.getScriptProperties();
      if (!botToken) botToken = (props.getProperty('TELEGRAM_BOT_TOKEN') || '').toString().trim();
      if (!channelId) channelId = (props.getProperty('TELEGRAM_CHANNEL_ID') || '').toString().trim();
    }
    if (botToken && channelId) {
      return handlePublishToTelegramAndMark_(userId, {
        row_id: rowId,
        bot_token: botToken,
        channel_id: channelId
      });
    }
    // Если не хватает параметров — просто возвращаем обычный экран save_image.
  }

  return {
    success: true,
    message: msg,
    inline_keyboard: [
      ['Сгенерировать изображение', 'save_image'],
      ['Опубликовать в канал', 'publish_to_telegram_and_mark'],
      ['Завершить', 'finish']
    ],
    data: {
      row_id: rowId,
      news_id: item.newsId || '',
      image_url: imageUrl
    }
  };
}
 
function handleApproveImage_(userId, payload) {
  var rowId = safeInt_(payload.row_id);
  if (!rowId) {
    var st = getUserState_(userId);
    rowId = st && st.rowId ? st.rowId : null;
  }
  if (!rowId) {
    return {
      success: false,
      message: 'Некорректный запрос: нужен row_id.',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }
 
  var ctx = openContext_();
  ensureHeader_(ctx.sheet);
 
  if (!ensureRowLocked_(ctx.sheet, rowId, userId)) {
    return {
      success: false,
      message: 'Эта строка не залочена на вас или лок истёк. Нажмите «Взять следующую новость».',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }

  var itemBefore = readRowAsItem_(ctx.sheet, rowId);
  var imgUrl = (itemBefore.imageUrl || '').toString().trim();
  if (!imgUrl) {
    return {
      success: false,
      message:
        'В таблице нет URL изображения. Снова нажмите «Сгенерировать изображение» и убедитесь, что после DALL·E выполнен вызов GAS save_image (без него файл не попадает в таблицу).',
      inline_keyboard: [
        ['Завершить', 'finish']
      ],
      data: { row_id: rowId }
    };
  }
 
  ctx.sheet.getRange(rowId, COLS.imageApproved).setValue(true);
  var item = readRowAsItem_(ctx.sheet, rowId);
 
  return {
    success: true,
    message:
      'Изображение одобрено. Нажмите «Опубликовать в канал» — ассистент отправит пост в канал и отметит результат в таблице.',
    inline_keyboard: [
      ['Опубликовать в канал', 'publish_to_telegram_and_mark'],
      ['Завершить', 'finish']
    ],
    data: {
      row_id: rowId,
      news_id: item.newsId || '',
      tg_text_draft: item.tgTextDraft || '',
      image_url: item.imageUrl || ''
    }
  };
}

function handlePublishToChannel_(userId, payload) {
  var rowId = safeInt_(payload.row_id);
  if (!rowId) {
    var st = getUserState_(userId);
    rowId = st && st.rowId ? st.rowId : null;
  }
  if (!rowId) {
    return {
      success: false,
      message: 'Некорректный запрос: нужен row_id.',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }

  var ctx = openContext_();
  ensureHeader_(ctx.sheet);

  if (!ensureRowLocked_(ctx.sheet, rowId, userId)) {
    return {
      success: false,
      message: 'Эта строка не залочена на вас или лок истёк. Нажмите «Взять следующую новость».',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }

  var item = readRowAsItem_(ctx.sheet, rowId);
  var tg = (item.tgTextDraft || '').toString().trim();
  var img = (item.imageUrl || '').toString().trim();

  if (!tg) {
    return {
      success: false,
      message: 'Нет текста поста в таблице. Сохраните черновик новости.',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: { row_id: rowId }
    };
  }
  if (!img) {
    return {
      success: false,
      message: 'Нет URL изображения. Сохраните изображение.',
      inline_keyboard: [
        ['Завершить', 'finish']
      ],
      data: { row_id: rowId }
    };
  }
  if (!item.imageApproved) {
    return {
      success: false,
      message: 'Изображение ещё не подтверждено в таблице. Нажмите «Сохранить изображение» (или перегенерируйте и снова сохраните).',
      inline_keyboard: [
        ['Сгенерировать изображение', 'save_image'],
        ['Завершить', 'finish']
      ],
      data: { row_id: rowId, image_url: img }
    };
  }

  return {
    success: true,
    message:
      'Данные для публикации готовы.\n' +
      'TG_TEXT_DRAFT:\n' +
      tg +
      '\n\nIMAGE_URL:\n' +
      img +
      '\n\nДальше: отправь пост в канал и отметь результат через mark_published (см. data).',
    inline_keyboard: [
      ['Опубликовать в канал', 'publish_to_telegram_and_mark'],
      ['Завершить', 'finish']
    ],
    data: {
      row_id: rowId,
      news_id: item.newsId || '',
      tg_text_draft: tg,
      image_url: img
    }
  };
}

function handlePublishToTelegramAndMark_(userId, payload) {
  var rowId = safeInt_(payload.row_id);
  if (!rowId) {
    var st = getUserState_(userId);
    rowId = st && st.rowId ? st.rowId : null;
  }

  var botToken = (payload.bot_token || '').toString().trim();
  var channelId = (payload.channel_id || '').toString().trim();

  if (!rowId) {
    return {
      success: false,
      message: 'Некорректный запрос: нужен row_id.',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }

  if (!botToken || !channelId) {
    return {
      success: false,
      message: 'Некорректный запрос: нужны channel_id и bot_token.',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: { row_id: rowId }
    };
  }

  var ctx = openContext_();
  ensureHeader_(ctx.sheet);

  if (!ensureRowLocked_(ctx.sheet, rowId, userId)) {
    return {
      success: false,
      message: 'Эта строка не залочена на вас или лок истёк. Нажмите «Взять следующую новость».',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }

  var item = readRowAsItem_(ctx.sheet, rowId);
  var tg = (item.tgTextDraft || '').toString().trim();
  var img = (item.imageUrl || '').toString().trim();

  if (!tg) {
    return {
      success: false,
      message: 'Нет текста поста в таблице. Сохраните черновик новости.',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: { row_id: rowId }
    };
  }
  if (!img) {
    return {
      success: false,
      message: 'Нет URL изображения. Сохраните изображение.',
      inline_keyboard: [
        ['Завершить', 'finish']
      ],
      data: { row_id: rowId }
    };
  }
  if (!item.imageApproved) {
    return {
      success: false,
      message: 'Изображение ещё не подтверждено в таблице. Нажмите «Сохранить изображение» (или перегенерируйте и снова сохраните).',
      inline_keyboard: [
        ['Сгенерировать изображение', 'save_image'],
        ['Завершить', 'finish']
      ],
      data: { row_id: rowId, image_url: img }
    };
  }

  // Telegram Bot API: отправляем 1 фото с caption.
  var url = 'https://api.telegram.org/bot' + botToken + '/sendPhoto';
  var reqPayload = {
    chat_id: channelId,
    photo: img,
    caption: tg
  };

  var publishOk = false;
  var raw = '';
  var telegramMessageId = null;
  try {
    var resp = UrlFetchApp.fetch(url, {
      method: 'post',
      payload: reqPayload,
      muteHttpExceptions: true
    });
    raw = resp.getContentText ? resp.getContentText() : '';

    var parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch (e) {
      parsed = null;
    }

    publishOk = parsed && parsed.ok === true;
    if (publishOk && parsed && parsed.result && parsed.result.message_id) {
      telegramMessageId = parsed.result.message_id;
    }
    if (!publishOk && parsed && parsed.description) {
      raw = parsed.description;
    }
  } catch (err) {
    raw = (err && err.toString) ? err.toString() : 'Ошибка UrlFetchApp';
  }

  ctx.sheet.getRange(rowId, COLS.publishResultRaw).setValue(raw || '');
  ctx.sheet.getRange(rowId, COLS.publishStatus).setValue(publishOk ? 'PUBLISHED' : 'ERROR');

  var itemNewsId = item.newsId || '';

  if (publishOk) {
    // Архивируем строку и удаляем из очереди, чтобы не требовать отдельного клика "Удалить".
    var archiveOk = false;
    var archiveErr = '';
    try {
      archivePublishedAndRemoveFromQueue_(ctx.sheet, rowId, {
        telegram_message_id: telegramMessageId,
        publish_result_raw: raw || ''
      });
      archiveOk = true;
    } catch (archiveE) {
      archiveOk = false;
      archiveErr = (archiveE && archiveE.toString) ? archiveE.toString() : String(archiveE);
    }

    clearUserState_(userId);

    var msgOk = archiveOk
      ? 'Работа с этой новостью завершена. Строка архивирована и удалена из очереди. Чтобы взять следующую новость, запустите бота заново.'
      : ('Публикация успешна, но архивирование/удаление строки не удалось. ' + (archiveErr || '') + ' Чтобы взять следующую новость, запустите бота заново.');

    var resOk = {
      success: archiveOk,
      message: msgOk,
      inline_keyboard: [
        ['Завершить', 'finish']
      ],
      data: {
        row_id: rowId,
        news_id: itemNewsId,
        publish_ok: true,
        telegram_message_id: telegramMessageId || '',
        publish_result_raw: raw || '',
        archived_and_removed: archiveOk
      }
    };
    if (shouldSendDirectUiFallback_(payload)) {
      trySendTelegramUiToUser_(botToken, userId, resOk.message, resOk.inline_keyboard);
    }
    return resOk;
  }

  var resErr = {
    success: false,
    message: 'Ошибка публикации в канал. Не удалось отправить пост. ' + (raw ? raw.toString() : ''),
    inline_keyboard: [
      ['Повторить позже (снять лок)', 'release_lock'],
      ['Завершить', 'finish']
    ],
    data: {
      row_id: rowId,
      news_id: itemNewsId,
      publish_ok: false,
      publish_result_raw: raw || ''
    }
  };
  if (shouldSendDirectUiFallback_(payload)) {
    trySendTelegramUiToUser_(botToken, userId, resErr.message, resErr.inline_keyboard);
  }
  return resErr;
}

/* =========================
   ВСПОМОГАТЕЛЬНЫЕ: архивирование публикации
========================= */

function archivePublishedAndRemoveFromQueue_(publishSheet, rowId, meta) {
  if (!publishSheet) throw new Error('archive: publishSheet is required');
  if (!rowId || rowId < 2) throw new Error('archive: invalid rowId');

  var ss = publishSheet.getParent();
  var props = PropertiesService.getScriptProperties();
  var archiveName = (props.getProperty('PUBLISH_ARCHIVE_SHEET_NAME') || PUBLISH_DEFAULT_ARCHIVE_SHEET_NAME).toString().trim();
  if (!archiveName) archiveName = PUBLISH_DEFAULT_ARCHIVE_SHEET_NAME;

  var archiveSheet = ss.getSheetByName(archiveName);
  if (!archiveSheet) archiveSheet = ss.insertSheet(archiveName);

  // Убедимся, что в архиве есть шапка.
  var header = archiveSheet.getRange(1, 1, 1, archiveSheet.getLastColumn() || 1).getValues()[0];
  if (!header || !header[0]) {
    // Базовая шапка: копируем шапку publish-листа (A..O) + добавляем 3 колонки метаданных.
    var pubHeader = publishSheet.getRange(1, 1, 1, COLS.lockedAt).getValues()[0];
    var outHeader = pubHeader.slice(0);
    outHeader.push('Archived at');
    outHeader.push('Telegram message_id');
    outHeader.push('Publish result raw');
    archiveSheet.getRange(1, 1, 1, outHeader.length).setValues([outHeader]);
  }

  // Копируем строку A..O из очереди.
  var rowValues = publishSheet.getRange(rowId, 1, 1, COLS.lockedAt).getValues()[0];
  var archivedAt = new Date();
  var msgId = meta && meta.telegram_message_id ? String(meta.telegram_message_id) : '';
  var pubRaw = meta && meta.publish_result_raw ? String(meta.publish_result_raw) : '';

  var outRow = rowValues.slice(0);
  outRow.push(archivedAt);
  outRow.push(msgId);
  outRow.push(pubRaw);

  archiveSheet.appendRow(outRow);

  // Удаляем из очереди.
  publishSheet.deleteRow(rowId);
}
 
function handleMarkPublished_(userId, payload) {
  var rowId = safeInt_(payload.row_id);
  if (!rowId) {
    var st = getUserState_(userId);
    rowId = st && st.rowId ? st.rowId : null;
  }
  var publishOk = payload.publish_ok === true || payload.publish_ok === 'true' || payload.publish_ok === 1 || payload.publish_ok === '1';
  var raw = '';
  if (payload.publish_result_raw !== undefined && payload.publish_result_raw !== null) {
    raw = (typeof payload.publish_result_raw === 'string') ? payload.publish_result_raw : JSON.stringify(payload.publish_result_raw);
  }
 
  if (!rowId) {
    return {
      success: false,
      message: 'Некорректный запрос: нужен row_id.',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }
 
  var ctx = openContext_();
  ensureHeader_(ctx.sheet);
 
  if (!ensureRowLocked_(ctx.sheet, rowId, userId)) {
    return {
      success: false,
      message: 'Эта строка не залочена на вас или лок истёк. Нажмите «Взять следующую новость».',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }
 
  ctx.sheet.getRange(rowId, COLS.publishResultRaw).setValue(raw || '');
  ctx.sheet.getRange(rowId, COLS.publishStatus).setValue(publishOk ? 'PUBLISHED' : 'ERROR');
 
  var item = readRowAsItem_(ctx.sheet, rowId);
  return {
    success: publishOk,
    message: publishOk
      ? 'Публикация отмечена как успешная. Можно удалить строку из таблицы.'
      : 'Публикация отмечена как НЕуспешная. Строка не будет удалена.',
    inline_keyboard: publishOk
      ? [['Удалить строку из таблицы', 'delete_published_row'], ['Взять следующую новость', 'get_next_item'], ['Завершить', 'finish']]
      : [['Повторить позже (снять лок)', 'release_lock'], ['Завершить', 'finish']],
    data: {
      row_id: rowId,
      news_id: item.newsId || '',
      publish_ok: publishOk,
      publish_result_raw: raw || ''
    }
  };
}
 
function handleDeletePublishedRow_(userId, payload) {
  var rowId = safeInt_(payload.row_id);
  if (!rowId) {
    var st = getUserState_(userId);
    rowId = st && st.rowId ? st.rowId : null;
  }
  if (!rowId) {
    return {
      success: false,
      message: 'Некорректный запрос: нужен row_id.',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }
 
  var ctx = openContext_();
  ensureHeader_(ctx.sheet);
 
  if (!ensureRowLocked_(ctx.sheet, rowId, userId)) {
    return {
      success: false,
      message: 'Эта строка не залочена на вас или лок истёк. Нажмите «Взять следующую новость».',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }
 
  var status = (ctx.sheet.getRange(rowId, COLS.publishStatus).getValue() || '').toString().trim();
  if (status !== 'PUBLISHED') {
    var resNotPublished = {
      success: false,
      message: 'Удаление запрещено: публикация ещё не отмечена как PUBLISHED.',
      inline_keyboard: [
        ['Завершить', 'finish']
      ],
      data: { row_id: rowId }
    };
    if (shouldSendDirectUiFallback_(payload)) {
      // Best-effort UI на случай, если внешний слой не отрисовал кнопки.
      var bt = (payload.bot_token || '').toString().trim();
      trySendTelegramUiToUser_(bt, userId, resNotPublished.message, resNotPublished.inline_keyboard);
    }
    return resNotPublished;
  }
 
  ctx.sheet.deleteRow(rowId);
  clearUserState_(userId);
 
  var resDeleted = {
    success: true,
    message: 'Строка удалена из таблицы. Работа с этой новостью завершена. Чтобы взять следующую новость, запустите бота заново.',
    inline_keyboard: [
      ['Завершить', 'finish']
    ],
    data: {}
  };
  if (shouldSendDirectUiFallback_(payload)) {
    // Best-effort UI на случай, если внешний слой не отрисовал кнопки.
    var bt2 = (payload.bot_token || '').toString().trim();
    trySendTelegramUiToUser_(bt2, userId, resDeleted.message, resDeleted.inline_keyboard);
  }
  return resDeleted;
}
 
function handleReleaseLock_(userId, payload) {
  var rowId = safeInt_(payload.row_id);
  var ctx = openContext_();
  ensureHeader_(ctx.sheet);
 
  var state = getUserState_(userId);
  if (!rowId && state && state.rowId) rowId = state.rowId;
  if (!rowId) {
    clearUserState_(userId);
    return {
      success: true,
      message: 'Лок снят (ничего не было залочено).',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }
 
  if (isRowLockedBy_(ctx.sheet, rowId, userId)) {
    ctx.sheet.getRange(rowId, COLS.lockedBy).setValue('');
    ctx.sheet.getRange(rowId, COLS.lockedAt).setValue('');
  }
  clearUserState_(userId);
 
  return {
    success: true,
    message: 'Лок снят. Можно взять следующую новость.',
    inline_keyboard: [
      ['Взять следующую новость', 'get_next_item'],
      ['Завершить', 'finish']
    ],
    data: {}
  };
}
 
function handleFinish_(userId) {
  // по умолчанию лок не снимаем автоматически, чтобы не потерять в процессе.
  // если нужно "жёстко" — можно добавить отдельную кнопку release_lock.
  clearUserState_(userId);
  return {
    success: true,
    message: '👋 Работа завершена.',
    inline_keyboard: [],
    data: {}
  };
}
 
/* =========================
   ВСПОМОГАТЕЛЬНЫЕ: таблица
========================= */
 
function openContext_() {
  var props = PropertiesService.getScriptProperties();
  var rawId = props.getProperty('GOOGLE_SHEET_ID');
  var sheetId = extractSheetId_(rawId);
  if (!sheetId) {
    throw new Error('GOOGLE_SHEET_ID не настроен.');
  }
  var ss = SpreadsheetApp.openById(sheetId);
  var sheetName = (props.getProperty('PUBLISH_SHEET_NAME') || PUBLISH_DEFAULT_SHEET_NAME).toString().trim();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.getSheets()[0];
  }
  return { ss: ss, sheet: sheet };
}
 
function ensureHeader_(sheet) {
  var header = sheet.getRange(1, 1, 1, COLS.lockedAt).getValues()[0];
  if (header && header[0]) {
    // если базовая шапка есть, но не хватает добавочных колонок — расширим
    var lastNeeded = COLS.lockedAt;
    var existingLast = sheet.getLastColumn();
    if (existingLast < lastNeeded) {
      sheet.insertColumnsAfter(existingLast, lastNeeded - existingLast);
    }
    return;
  }
 
  // создаём шапку (совместимую с RSS-скриптом + наши поля)
  sheet.getRange(1, 1, 1, COLS.lockedAt).setValues([[
    'Дата/время',          // A
    'Тема',                // B
    'Целевая аудитория',   // C
    'Ссылка на источник',  // D
    'Краткое описание',    // E
    'Текст новости',       // F
    'ID новости',          // G
    'TG текст (черновик)', // H
    'TG текст одобрен',    // I
    'URL изображения',     // J
    'Изображение одобрено',// K
    'Статус публикации',   // L
    'Результат публикации (raw)', // M
    'Locked by',           // N
    'Locked at'            // O
  ]]);
}
 
// Приводит значение ячейки Google Sheets к boolean.
// Sheets иногда возвращает булевы значения как строки ("TRUE"/"FALSE") или числа (1/0).
function cellToBool_(v) {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  if (typeof v === 'number') return v !== 0;

  var s = v.toString().trim().toLowerCase();
  if (!s) return false;
  if (s === 'true' || s === '1' || s === 'yes' || s === 'y' || s === 'да' || s === 'истина') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'n' || s === 'нет' || s === 'ложь') return false;
  return false;
}

function readRowAsItem_(sheet, rowId) {
  if (!rowId || rowId < 2) return null;
  var values = sheet.getRange(rowId, 1, 1, COLS.lockedAt).getValues()[0];
  if (!values || values.length < COLS.newsId) return null;
  var newsId = (values[COLS.newsId - 1] || '').toString().trim();
  if (!newsId) return null;
 
  return {
    rowId: rowId,
    createdAt: values[COLS.createdAt - 1] || '',
    topic: values[COLS.topic - 1] || '',
    audience: values[COLS.audience - 1] || '',
    sourceUrl: (values[COLS.sourceUrl - 1] || '').toString(),
    summary: (values[COLS.summary - 1] || '').toString(),
    rawText: (values[COLS.rawText - 1] || '').toString(),
    newsId: newsId,
    tgTextDraft: (values[COLS.tgTextDraft - 1] || '').toString(),
    tgTextApproved: cellToBool_(values[COLS.tgTextApproved - 1]),
    imageUrl: (values[COLS.imageUrl - 1] || '').toString(),
    imageApproved: cellToBool_(values[COLS.imageApproved - 1]),
    publishStatus: (values[COLS.publishStatus - 1] || '').toString(),
    publishResultRaw: (values[COLS.publishResultRaw - 1] || '').toString(),
    lockedBy: (values[COLS.lockedBy - 1] || '').toString(),
    lockedAt: values[COLS.lockedAt - 1] || ''
  };
}
 
function formatNewsItemForEditor_(item) {
  var lines = [];
  lines.push('📰 Новость из таблицы');
  lines.push('');
  lines.push(item.summary ? item.summary : (item.topic ? item.topic : ''));
  lines.push('');
  if (item.rawText) {
    lines.push(item.rawText);
    lines.push('');
  }
  lines.push('Источник: ' + (item.sourceUrl || ''));
  lines.push('');
  lines.push('row_id: ' + item.rowId);
  return lines.join('\n');
}

function itemToPublisherData_(item) {
  return {
    row_id: item.rowId,
    news_id: item.newsId,
    source_url: item.sourceUrl,
    summary: item.summary,
    raw_text: item.rawText,
    tg_text_draft: item.tgTextDraft,
    tg_text_approved: item.tgTextApproved,
    image_url: item.imageUrl,
    image_approved: item.imageApproved,
    publish_status: item.publishStatus
  };
}

function sourceOnlyKeyboard_() {
  return [
    ['Перегенерировать текст', 'regenerate_text'],
    ['Снять лок (пропустить)', 'release_lock'],
    ['Завершить', 'finish']
  ];
}

function draftingKeyboard_() {
  return [
    ['Сохранить черновик новости', 'save_text_draft'],
    ['Перегенерировать текст', 'regenerate_text'],
    ['Снять лок (пропустить)', 'release_lock'],
    ['Завершить', 'finish']
  ];
}

function buildItemResponse_(prefixText, item) {
  var msg = [];
  if (prefixText) {
    msg.push(prefixText);
    msg.push('');
  }
  msg.push(formatNewsItemForEditor_(item));

  return {
    success: true,
    message: msg.join('\n'),
    inline_keyboard: sourceOnlyKeyboard_(),
    data: itemToPublisherData_(item)
  };
}
 
function findAndLockNextRow_(sheet, userId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
 
  var range = sheet.getRange(2, 1, lastRow - 1, COLS.lockedAt);
  var rows = range.getValues();
 
  var now = new Date();
  for (var i = 0; i < rows.length; i++) {
    var rowId = i + 2;
    var newsId = (rows[i][COLS.newsId - 1] || '').toString().trim();
    if (!newsId) continue;
 
    var status = (rows[i][COLS.publishStatus - 1] || '').toString().trim();
    if (status === 'PUBLISHED') continue;
 
    var lockedBy = (rows[i][COLS.lockedBy - 1] || '').toString().trim();
    var lockedAtVal = rows[i][COLS.lockedAt - 1];
 
    // если строка залочена на нас — можно продолжать
    if (lockedBy && lockedBy === userId) {
      return readRowAsItem_(sheet, rowId);
    }
 
    // если залочена на другого — проверяем TTL
    if (lockedBy && lockedBy !== userId) {
      if (!isLockExpired_(lockedAtVal, now)) {
        continue;
      }
      // lock expired -> можно перехватить
    }
 
    // берём строку (NEW или IN_PROGRESS)
    lockRow_(sheet, rowId, userId, now);
    // если статус пустой — считаем NEW и сразу переводим в IN_PROGRESS
    if (!status) {
      sheet.getRange(rowId, COLS.publishStatus).setValue('IN_PROGRESS');
    }
    return readRowAsItem_(sheet, rowId);
  }
 
  return null;
}
 
function lockRow_(sheet, rowId, userId, now) {
  sheet.getRange(rowId, COLS.lockedBy).setValue(userId);
  // Храним timestamp числом, чтобы избежать проблем парсинга Date-времени
  // в Google Sheets (оно часто возвращается строкой в локализованном формате).
  sheet.getRange(rowId, COLS.lockedAt).setValue(now.getTime());
}
 
function isRowLockedBy_(sheet, rowId, userId) {
  var lockedBy = (sheet.getRange(rowId, COLS.lockedBy).getValue() || '').toString().trim();
  if (!lockedBy) return false;
  if (lockedBy !== userId) return false;
 
  var lockedAtVal = sheet.getRange(rowId, COLS.lockedAt).getValue();
  // Если lockedAt не удаётся распарсить (локализованный формат Sheets),
  // но lockedBy совпадает — считаем lock валидным, чтобы не получать ложные
  // "лок истёк" прямо в пользовательском сценарии.
  var parsed = parseLockMs_(lockedAtVal);
  if (!parsed.ok) return true;

  var ageMin = (new Date().getTime() - parsed.ms) / 60000;
  return ageMin <= PUBLISH_LOCK_TTL_MIN;
}
 
/**
 * Гарантирует лок под текущего пользователя.
 * Если лок отсутствует/не совпадает/не удаётся валидно проверить TTL — перехватываем лок.
 */
function ensureRowLocked_(sheet, rowId, userId) {
  var lockedBy = (sheet.getRange(rowId, COLS.lockedBy).getValue() || '').toString().trim();
  var statusVal = (sheet.getRange(rowId, COLS.publishStatus).getValue() || '').toString().trim();

  if (!lockedBy) {
    lockRow_(sheet, rowId, userId, new Date());
    if (!statusVal) sheet.getRange(rowId, COLS.publishStatus).setValue('IN_PROGRESS');
    return true;
  }
  if (lockedBy === userId) return true;

  var lockedAtVal = sheet.getRange(rowId, COLS.lockedAt).getValue();
  var parsed = parseLockMs_(lockedAtVal);
  if (!parsed.ok) {
    lockRow_(sheet, rowId, userId, new Date());
    if (!statusVal) sheet.getRange(rowId, COLS.publishStatus).setValue('IN_PROGRESS');
    return true;
  }

  var ageMin = (new Date().getTime() - parsed.ms) / 60000;
  if (ageMin > PUBLISH_LOCK_TTL_MIN) {
    lockRow_(sheet, rowId, userId, new Date());
    if (!statusVal) sheet.getRange(rowId, COLS.publishStatus).setValue('IN_PROGRESS');
    return true;
  }

  return false;
}

function isLockExpired_(lockedAtVal, now) {
  if (!lockedAtVal) return true;
  var parsed = parseLockMs_(lockedAtVal);
  if (!parsed.ok) return true;
  var nowMs = now instanceof Date ? now.getTime() : new Date().getTime();
  var ageMin = (nowMs - parsed.ms) / 60000;
  return ageMin > PUBLISH_LOCK_TTL_MIN;
}

function parseLockMs_(lockedAtVal) {
  try {
    if (lockedAtVal instanceof Date) {
      var ms = lockedAtVal.getTime();
      if (isFinite(ms)) return { ok: true, ms: ms };
      return { ok: false, ms: null };
    }

    if (typeof lockedAtVal === 'number') {
      if (isFinite(lockedAtVal)) return { ok: true, ms: lockedAtVal };
      return { ok: false, ms: null };
    }

    // string/other
    if (lockedAtVal !== null && lockedAtVal !== undefined) {
      var s = lockedAtVal.toString().trim();
      if (!s) return { ok: false, ms: null };

      var asNum = parseFloat(s);
      if (isFinite(asNum)) {
        // если строка выглядит как число — используем как timestamp
        // (Sheets часто возвращает именно такие значения)
        if (!isNaN(asNum)) return { ok: true, ms: asNum };
      }

      // dd.MM.yyyy HH:mm:ss (и похожие)
      var m = s.match(/(\d{2})\.(\d{2})\.(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
      if (m) {
        var dd = parseInt(m[1], 10);
        var mm = parseInt(m[2], 10) - 1;
        var yyyy = parseInt(m[3], 10);
        var hh = parseInt(m[4], 10);
        var min = parseInt(m[5], 10);
        var ss = m[6] ? parseInt(m[6], 10) : 0;
        var ms2 = new Date(yyyy, mm, dd, hh, min, ss).getTime();
        if (isFinite(ms2)) return { ok: true, ms: ms2 };
      }

      // fallback: ISO-like
      var d = new Date(s);
      if (!isNaN(d.getTime())) return { ok: true, ms: d.getTime() };
    }

    return { ok: false, ms: null };
  } catch (e) {
    return { ok: false, ms: null };
  }
}
 
/* =========================
   ВСПОМОГАТЕЛЬНЫЕ: state
========================= */
 
function getUserState_(userId) {
  var raw = PropertiesService.getScriptProperties().getProperty(PUBLISH_STATE_KEY_PREFIX + userId);
  if (!raw) return { rowId: null, newsId: null };
  try {
    var s = JSON.parse(raw);
    return {
      rowId: s && s.rowId ? s.rowId : null,
      newsId: s && s.newsId ? s.newsId : null
    };
  } catch (e) {
    return { rowId: null, newsId: null };
  }
}
 
function saveUserState_(userId, state) {
  PropertiesService.getScriptProperties().setProperty(PUBLISH_STATE_KEY_PREFIX + userId, JSON.stringify(state || {}));
}
 
function clearUserState_(userId) {
  PropertiesService.getScriptProperties().deleteProperty(PUBLISH_STATE_KEY_PREFIX + userId);
}
 
/* =========================
   ВСПОМОГАТЕЛЬНЫЕ: payload/response
========================= */
 
function parsePayload_(e) {
  var body = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
  if (body && body.charCodeAt(0) === 0xfeff) {
    body = body.slice(1);
  }
  var payload = {};
  if (body) {
    try {
      payload = JSON.parse(body);
      if (typeof payload !== 'object' || payload === null) {
        payload = {};
      }
    } catch (parseErr) {
      payload = {};
    }
  }

  // Тело целиком — строка params (без JSON), если клиент так шлёт POST
  if ((!payload.user_id || !payload.command) && body && typeof body === 'string') {
    var t = body.trim();
    if (t.charAt(0) !== '{' && t.indexOf('user_id::') !== -1 && t.indexOf('command::') !== -1) {
      var rawPairs = parseParamsString_(t);
      if (rawPairs.user_id && rawPairs.command) {
        Object.keys(rawPairs).forEach(function (k) {
          payload[k] = rawPairs[k];
        });
      }
    }
    // x-www-form-urlencoded: params=user_id%3A%3A...
    if ((!payload.user_id || !payload.command) && t.indexOf('params=') !== -1) {
      try {
        var eq = t.indexOf('params=');
        var rest = t.substring(eq + 'params='.length);
        var amp = rest.indexOf('&');
        var enc = amp === -1 ? rest : rest.substring(0, amp);
        var dec = decodeURIComponent(enc.replace(/\+/g, ' '));
        var formParsed = parseParamsString_(dec);
        Object.keys(formParsed).forEach(function (k) {
          if (payload[k] === undefined) payload[k] = formParsed[k];
        });
      } catch (formErr) {
        Logger.log('parsePayload_ form decode: ' + formErr);
      }
    }
  }
 
  // поддержка params-строки вида: "user_id::123##command::get_next_item##row_id::5..."
  if (payload && typeof payload.params === 'string' && payload.params.indexOf('::') !== -1) {
    var parsed = parseParamsString_(payload.params);
    Object.keys(parsed).forEach(function (k) { payload[k] = parsed[k]; });
  }
 
  // querystring fallback
  if (e && e.parameter) {
    Object.keys(e.parameter).forEach(function (k) {
      if (payload[k] === undefined) payload[k] = e.parameter[k];
    });
  }
  return payload;
}
 
function parseParamsString_(s) {
  var out = {};
  if (!s) return out;
  var parts = s.split('##');
  parts.forEach(function (p) {
    var idx = p.indexOf('::');
    if (idx === -1) return;
    var key = p.substring(0, idx).trim();
    var val = p.substring(idx + 2);
    if (key) out[key] = val;
  });
  return out;
}
 
function normalizeResponse_(result) {
  if (!result || typeof result !== 'object') {
    return {
      success: false,
      message: 'Внутренняя ошибка: пустой результат.',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }
  REQUIRED_RESPONSE_FIELDS.forEach(function (k) {
    if (result[k] === undefined) {
      if (k === 'inline_keyboard') result[k] = [];
      if (k === 'message') result[k] = '';
      if (k === 'success') result[k] = false;
    }
  });
  if (!Array.isArray(result.inline_keyboard)) result.inline_keyboard = [];
  if (typeof result.message !== 'string') result.message = String(result.message || '');
  if (typeof result.success !== 'boolean') result.success = !!result.success;
  if (!result.data || typeof result.data !== 'object') result.data = {};
  return result;
}
 
function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
 
function extractSheetId_(value) {
  if (!value || typeof value !== 'string') return null;
  var s = value.trim();
  if (!s) return null;
  var match = s.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  return s;
}
 
function safeInt_(v) {
  var n = parseInt(v, 10);
  if (isNaN(n) || !isFinite(n)) return null;
  return n;
}

/**
 * Безопасная валидация row_id для пользовательских действий.
 * Защищает от попадания технических ID (message_id и т.п.), которые
 * могут приводить к исключению getRange(...) и общему fallback-ответу.
 */
function validateRowIdForAction_(sheet, rowId) {
  if (!rowId || rowId < 2) {
    return {
      ok: false,
      message: 'Некорректный row_id. Нажмите «Взять следующую новость» и повторите шаг.'
    };
  }

  var lastRow = sheet.getLastRow();
  if (!lastRow || rowId > lastRow) {
    return {
      ok: false,
      message: 'row_id вне диапазона таблицы. Нажмите «Взять следующую новость» и повторите шаг.'
    };
  }

  var item = readRowAsItem_(sheet, rowId);
  if (!item || !item.newsId) {
    return {
      ok: false,
      message: 'Строка для публикации не найдена. Нажмите «Взять следующую новость».'
    };
  }

  return { ok: true };
}

/**
 * Тестовая функция для локализации проблем доступа.
 * Запускается прямо из интерфейса GAS (Run -> тест).
 *
 * Что делает:
 * - открывает таблицу по Script Properties GOOGLE_SHEET_ID
 * - логирует имя листа и размеры таблицы
 * - пытается прочитать значения из строки 2 (первые 7 колонок A..G)
 *
 * Важно:
 * - Ничего не меняет в таблице.
 * - Использует те же helpers, что и Web App.
 */
function testPublisherSheetAccess() {
  var props = PropertiesService.getScriptProperties();
  var rawId = props.getProperty('GOOGLE_SHEET_ID');
  var publishSheetName = props.getProperty('PUBLISH_SHEET_NAME');

  Logger.log('TEST Publisher: GOOGLE_SHEET_ID=' + rawId);
  Logger.log('TEST Publisher: PUBLISH_SHEET_NAME=' + publishSheetName);

  var ctx = openContext_();
  var sheet = ctx.sheet;

  Logger.log('TEST Publisher: opened sheet name=' + (sheet ? sheet.getName() : 'null'));

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  Logger.log('TEST Publisher: lastRow=' + lastRow + ', lastCol=' + lastCol);

  if (!lastRow || lastRow < 2) {
    return {
      ok: false,
      reason: 'No data rows',
      lastRow: lastRow,
      lastCol: lastCol
    };
  }

  // Для диагностики доступа обычно достаточно прочитать базовые колонки A..G.
  var colsToRead = Math.min(lastCol, 7);
  var row2 = sheet.getRange(2, 1, 1, colsToRead).getValues()[0];

  Logger.log('TEST Publisher: row2 A..(A+' + (colsToRead - 1) + ')=' + JSON.stringify(row2));

  return {
    ok: true,
    openedSheet: sheet.getName(),
    lastRow: lastRow,
    lastCol: lastCol,
    row2_firstCols: row2
  };
}

/**
 * Тестовая функция для получения OAuth-разрешений UrlFetchApp (внешние запросы).
 *
 * Зачем:
 * - Если Web App падает с ошибкой вида:
 *   "You do not have permission to call UrlFetchApp.fetch. Required permissions: .../script.external_request"
 *   то нужно один раз выдать авторизацию проекту.
 *
 * Как использовать:
 * - В редакторе Apps Script: Run -> testPublisherUrlFetchAccess
 * - Пройти окно разрешений (OAuth consent).
 *
 * Важно:
 * - Ничего не пишет в таблицу.
 * - Делает простой GET на стабильный публичный URL.
 */
function testPublisherUrlFetchAccess() {
  var testUrl = 'https://www.google.com/generate_204';
  try {
    var resp = UrlFetchApp.fetch(testUrl, {
      method: 'get',
      muteHttpExceptions: true,
      followRedirects: true
    });
    var code = resp.getResponseCode ? resp.getResponseCode() : null;
    var text = resp.getContentText ? resp.getContentText() : '';
    Logger.log('TEST Publisher UrlFetch: url=' + testUrl + ' code=' + code);
    return {
      ok: true,
      url: testUrl,
      response_code: code,
      content_preview: (text || '').toString().slice(0, 200)
    };
  } catch (e) {
    Logger.log('TEST Publisher UrlFetch ERROR: ' + e);
    return {
      ok: false,
      url: testUrl,
      error: (e && e.toString) ? e.toString() : String(e)
    };
  }
}
