/**
 * GAS state-machine: Publisher для VK (сообщество).
 *
 * Архитектура:
 * - GAS: детерминированная работа с очередью в Google Sheets (локи/статусы/архив).
 * - Внешний слой (SMAIPL/LLM): не хранит состояние очереди, вызывает Web App (302).
 * - Публикация в VK выполняется в GAS (VK API через UrlFetchApp): upload фото + wall.post.
 *
 * Важно: токены НЕ хранить в коде и НЕ передавать в ответы пользователю.
 */

/* =========================
   КОНФИГ
========================= */

const VK_PUBLISH_STATE_KEY_PREFIX = 'vk_publisher_state_';
const VK_PUBLISH_DEFAULT_SHEET_NAME = 'ToPublish'; // можно переопределить через Script Properties: PUBLISH_SHEET_NAME
const VK_PUBLISH_DEFAULT_ARCHIVE_SHEET_NAME = 'PublishedArchive'; // можно переопределить через Script Properties: PUBLISH_ARCHIVE_SHEET_NAME
const VK_PUBLISH_LOCK_TTL_MIN = 120;

// Базовые колонки новостей (A..G) + служебные колонки пайплайна (H..O) уже есть в таблице.
// Для VK добавляем колонки после O (P..U) при первом запуске ensureHeader_.
const COLS = {
  createdAt: 1,     // A
  topic: 2,         // B
  audience: 3,      // C
  sourceUrl: 4,     // D
  summary: 5,       // E
  rawText: 6,       // F
  newsId: 7,        // G

  // Общий текст поста (источник для VK). Исторически колонка H могла называться "TG текст".
  postTextDraft: 8,    // H
  postTextApproved: 9, // I
  imageUrl: 10,      // J
  imageApproved: 11, // K
  publishStatus: 12, // L
  publishResultRaw: 13, // M
  lockedBy: 14,      // N
  lockedAt: 15,      // O

  // VK pipeline (new)
  vkPublishStatus: 16,     // P
  vkPublishResultRaw: 17,  // Q
  vkPostId: 18             // R (остальные оставляем резервом, если расширим)
};

const REQUIRED_RESPONSE_FIELDS = ['success', 'message', 'inline_keyboard'];

/* =========================
   ENTRYPOINTS
========================= */

function doPost(e) {
  try {
    var payload = parsePayload_(e);
    var userId = (payload.user_id || payload.userId || '').toString().trim();
    var command = (payload.command || '').toString().trim();
    if (!userId) {
      return jsonResponse_(normalizeResponse_({
        success: false,
        message: 'Некорректный запрос: отсутствует user_id.',
        inline_keyboard: [
          ['Взять следующую новость', 'get_next_item'],
          ['Завершить', 'finish']
        ],
        data: {}
      }));
    }

    var result;
    switch (command) {
      case 'start':
        result = handleStart_(userId);
        break;
      case 'get_next_item':
        result = handleGetNextItem_(userId);
        break;
      case 'regenerate_text':
        result = handleRegenerateText_(userId, payload);
        break;
      case 'save_text_draft':
        result = handleSaveTextDraft_(userId, payload);
        break;
      case 'save_image':
        result = handleSaveImage_(userId, payload);
        break;
      case 'publish_to_channel':
        // alias для совместимости с full-pipeline промптами
        result = handlePublishToVkPrepare_(userId, payload);
        break;
      case 'publish_to_vk_prepare':
        result = handlePublishToVkPrepare_(userId, payload);
        break;
      case 'send_to_vk':
        result = handleSendToVk_(userId, payload);
        break;
      case 'mark_vk_published':
        result = handleMarkVkPublished_(userId, payload);
        break;
      case 'mark_published':
        // alias для совместимости с full-pipeline промптами
        result = handleMarkVkPublished_(userId, payload);
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

    return jsonResponse_(normalizeResponse_(result));
  } catch (err) {
    Logger.log('vk publisher doPost error: ' + err);
    return jsonResponse_(normalizeResponse_({
      success: false,
      message: 'Сервис временно недоступен. Попробуйте позже.',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    }));
  }
}

function doGet(e) {
  var param = e && e.parameter ? e.parameter : {};
  var payload = {
    user_id: (param.user_id || '').toString(),
    command: (param.command || '').toString(),
    row_id: (param.row_id || '').toString()
  };
  if (param.params && typeof param.params === 'string' && param.params.indexOf('::') !== -1) {
    var fromQuery = parseParamsString_(param.params);
    Object.keys(fromQuery).forEach(function (k) {
      payload[k] = fromQuery[k];
    });
  }
  var fakeEvent = { postData: { contents: JSON.stringify(payload) }, parameter: param };
  return doPost(fakeEvent);
}

/* =========================
   ХЕНДЛЕРЫ
========================= */

function handleStart_(userId) {
  saveUserState_(userId, { rowId: null, newsId: null });
  return {
    success: true,
    message: 'Готово. Нажмите «Взять следующую новость», чтобы выбрать пост для публикации в VK.',
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

  var state = getUserState_(userId);
  if (state && state.rowId) {
    var existing = readRowAsItem_(ctx.sheet, state.rowId);
    if (existing && existing.newsId) {
      return buildItemResponse_(
        'Текущая новость уже выбрана. Нажмите «Перегенерировать текст».',
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
    'Новость получена. Нажмите «Перегенерировать текст», чтобы получить исходник для перефраза и перейти к сохранению черновика.',
    nextRow
  );
}

function handleRegenerateText_(userId, payload) {
  var rowId = safeInt_(payload.row_id);
  if (!rowId) {
    var st = getUserState_(userId);
    rowId = st && st.rowId ? st.rowId : null;
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
  return {
    success: true,
    message:
      'Исходник для перефраза готов.\n' +
      'row_id: ' + rowId + '\n\n' +
      'Тема: ' + (item.topic || '-') + '\n' +
      'Аудитория: ' + (item.audience || '-') + '\n' +
      'Источник: ' + (item.sourceUrl || '-') + '\n\n' +
      'Кратко:\n' + (item.summary || '-') + '\n\n' +
      'Текст:\n' + (item.rawText || '-'),
    inline_keyboard: [
      ['Сохранить черновик текста', 'save_text_draft'],
      ['Снять лок (пропустить)', 'release_lock'],
      ['Завершить', 'finish']
    ],
    data: {
      row_id: rowId,
      news_id: item.newsId || '',
      source_url: item.sourceUrl || '',
      summary: item.summary || '',
      raw_text: item.rawText || ''
    }
  };
}

function handleSaveTextDraft_(userId, payload) {
  var rowId = safeInt_(payload.row_id);
  if (!rowId) {
    var st = getUserState_(userId);
    rowId = st && st.rowId ? st.rowId : null;
  }
  var postText = (payload.tg_text || payload.post_text || payload.vk_message || '').toString();
  if (!rowId || !postText.trim()) {
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

  ctx.sheet.getRange(rowId, COLS.postTextDraft).setValue(postText);
  ctx.sheet.getRange(rowId, COLS.postTextApproved).setValue(true);
  ctx.sheet.getRange(rowId, COLS.publishStatus).setValue('IN_PROGRESS');

  return {
    success: true,
    message:
      'Текст поста сохранён в таблице и принят.\n\n' +
      'Текст поста:\n\n' + postText,
    inline_keyboard: [
      ['Сгенерировать изображение', 'save_image'],
      ['Завершить', 'finish']
    ],
    data: { row_id: rowId, post_text_draft: postText }
  };
}

function handleSaveImage_(userId, payload) {
  var rowId = safeInt_(payload.row_id);
  if (!rowId) {
    var st = getUserState_(userId);
    rowId = st && st.rowId ? st.rowId : null;
  }
  var imageUrl = (payload.image_url || '').toString().trim();
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
  ctx.sheet.getRange(rowId, COLS.imageApproved).setValue(true);

  return {
    success: true,
    message:
      'Изображение сохранено и автоматически одобрено.\n\n' +
      'Ссылка на файл:\n' + imageUrl,
    inline_keyboard: [
      ['Опубликовать в VK', 'send_to_vk'],
      ['Завершить', 'finish']
    ],
    data: { row_id: rowId, image_url: imageUrl }
  };
}

function handlePublishToVkPrepare_(userId, payload) {
  var rowId = safeInt_(payload.row_id);
  if (!rowId) {
    var st = getUserState_(userId);
    rowId = st && st.rowId ? st.rowId : null;
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
  var postText = (item.postTextDraft || '').toString().trim();
  var imageUrl = (item.imageUrl || '').toString().trim();
  if (!postText) {
    return {
      success: false,
      message: 'В строке нет готового текста поста (колонка H). Сначала подготовьте текст и сохраните черновик.',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: { row_id: rowId, news_id: item.newsId || '' }
    };
  }

  ctx.sheet.getRange(rowId, COLS.vkPublishStatus).setValue('IN_PROGRESS');

  var msg =
    'Готово к публикации в VK.\n' +
    'row_id: ' + rowId + '\n\n' +
    'VK_MESSAGE:\n' +
    postText +
    (imageUrl ? ('\n\nIMAGE_URL:\n' + imageUrl) : '');

  return {
    success: true,
    message: msg,
    inline_keyboard: [
      ['Опубликовать в VK', 'send_to_vk'],
      ['Снять лок (пропустить)', 'release_lock'],
      ['Завершить', 'finish']
    ],
    data: {
      row_id: rowId,
      news_id: item.newsId || '',
      vk_message: postText,
      image_url: imageUrl
    }
  };
}

function handleSendToVk_(userId, payload) {
  var rowId = safeInt_(payload.row_id);
  if (!rowId) {
    var st = getUserState_(userId);
    rowId = st && st.rowId ? st.rowId : null;
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
  var postText = (item.postTextDraft || '').toString().trim();
  var imageUrl = (item.imageUrl || '').toString().trim();
  if (!postText) {
    return {
      success: false,
      message: 'В строке нет готового текста поста (колонка H). Сначала подготовьте текст и сохраните черновик.',
      inline_keyboard: [
        ['Подготовить к публикации в VK', 'publish_to_channel'],
        ['Завершить', 'finish']
      ],
      data: { row_id: rowId, news_id: item.newsId || '' }
    };
  }

  ctx.sheet.getRange(rowId, COLS.vkPublishStatus).setValue('IN_PROGRESS');

  try {
    var vkCfg = getVkConfig_();
    var vkResult = vkPublishWallPost_(vkCfg, {
      message: postText,
      imageUrl: imageUrl
    });

    var raw = JSON.stringify(vkResult || {});
    var postId = (vkResult && vkResult.post_id !== undefined && vkResult.post_id !== null)
      ? vkResult.post_id.toString()
      : '';

    ctx.sheet.getRange(rowId, COLS.vkPublishResultRaw).setValue(raw);
    ctx.sheet.getRange(rowId, COLS.vkPublishStatus).setValue('PUBLISHED');
    if (postId) ctx.sheet.getRange(rowId, COLS.vkPostId).setValue(postId);

    // Автоматически архивируем и удаляем строку после успешной публикации.
    // Это делает PublishedArchive актуальным без ручного шага delete_published_row.
    archiveAndDeleteRow_(ctx, rowId);
    clearUserState_(userId);

    return {
      success: true,
      message:
        'Публикация в VK выполнена. Строка архивирована и удалена из очереди.\n\n' +
        (postId ? ('vk_post_id: ' + postId) : ''),
      inline_keyboard: [
        ['Завершить', 'finish']
      ],
      data: { row_id: rowId, publish_ok: true, vk_post_id: postId }
    };
  } catch (err) {
    var errStr = (err && err.stack) ? err.stack.toString() : (err ? err.toString() : 'Unknown error');
    ctx.sheet.getRange(rowId, COLS.vkPublishResultRaw).setValue(errStr);
    ctx.sheet.getRange(rowId, COLS.vkPublishStatus).setValue('ERROR');

    var userErr = formatVkErrorForUser_(errStr);
    var retryHint = isRetryableVkUploadError_(errStr)
      ? 'Это похоже на временный сбой VK или лимит GAS. Подождите 1–2 минуты и нажмите «Опубликовать в VK» снова.'
      : 'Проверьте image_url и настройки VK, затем повторите публикацию.';

    return {
      success: true,
      message:
        'Публикация в VK завершилась ошибкой.\n\n' +
        retryHint + '\n\n' +
        'Ошибка:\n' + userErr,
      inline_keyboard: [
        ['Опубликовать в VK', 'send_to_vk'],
        ['Завершить', 'finish']
      ],
      data: { row_id: rowId, publish_ok: false }
    };
  }
}

function handleMarkVkPublished_(userId, payload) {
  var rowId = safeInt_(payload.row_id);
  var publishOk = toBool_(payload.publish_ok);
  var raw = (payload.publish_result_raw || '').toString();
  var vkPostId = (payload.vk_post_id || payload.post_id || '').toString();

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

  ctx.sheet.getRange(rowId, COLS.vkPublishResultRaw).setValue(raw || '');
  ctx.sheet.getRange(rowId, COLS.vkPublishStatus).setValue(publishOk ? 'PUBLISHED' : 'ERROR');
  if (vkPostId) ctx.sheet.getRange(rowId, COLS.vkPostId).setValue(vkPostId);

  var keyboard;
  if (publishOk) {
    keyboard = [
      ['Удалить строку из таблицы', 'delete_published_row'],
      ['Завершить', 'finish']
    ];
  } else {
    keyboard = [
      ['Подготовить к публикации в VK', 'publish_to_channel'],
      ['Завершить', 'finish']
    ];
  }

  return {
    success: true,
    message: publishOk
      ? 'Публикация в VK отмечена как успешная. Теперь можно удалить строку из очереди.'
      : 'Публикация в VK отмечена как ошибка. Можно повторить подготовку публикации.',
    inline_keyboard: keyboard,
    data: { row_id: rowId, publish_ok: publishOk, vk_post_id: vkPostId }
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

  var status = (ctx.sheet.getRange(rowId, COLS.vkPublishStatus).getValue() || '').toString().trim();
  if (status !== 'PUBLISHED') {
    return {
      success: false,
      message: 'Нельзя удалять строку: публикация в VK не в статусе PUBLISHED.',
      inline_keyboard: [
        ['Подготовить к публикации в VK', 'publish_to_channel'],
        ['Завершить', 'finish']
      ],
      data: { row_id: rowId, vk_publish_status: status }
    };
  }

  archiveAndDeleteRow_(ctx, rowId);
  clearUserState_(userId);
  return {
    success: true,
    message: 'Строка архивирована и удалена из очереди. Работа с этой новостью завершена.',
    inline_keyboard: [
      ['Завершить', 'finish']
    ],
    data: {}
  };
}

function handleReleaseLock_(userId, payload) {
  var rowId = safeInt_(payload.row_id);
  if (!rowId) {
    var st = getUserState_(userId);
    rowId = st && st.rowId ? st.rowId : null;
  }
  if (!rowId) {
    clearUserState_(userId);
    return {
      success: true,
      message: 'Лок снят (или нечего снимать). Нажмите «Взять следующую новость».',
      inline_keyboard: [
        ['Взять следующую новость', 'get_next_item'],
        ['Завершить', 'finish']
      ],
      data: {}
    };
  }
  var ctx = openContext_();
  ensureHeader_(ctx.sheet);
  if (ensureRowLocked_(ctx.sheet, rowId, userId)) {
    unlockRow_(ctx.sheet, rowId);
  }
  clearUserState_(userId);
  return {
    success: true,
    message: 'Лок снят. Нажмите «Взять следующую новость».',
    inline_keyboard: [
      ['Взять следующую новость', 'get_next_item'],
      ['Завершить', 'finish']
    ],
    data: {}
  };
}

function handleFinish_(userId) {
  clearUserState_(userId);
  return {
    success: true,
    message: 'Готово. Сессия завершена.',
    inline_keyboard: [],
    data: {}
  };
}

/* =========================
   VK API (UrlFetchApp)
========================= */

function getVkConfig_() {
  var props = PropertiesService.getScriptProperties();
  var groupIdRaw = (props.getProperty('VK_GROUP_ID') || '').toString().trim();
  var token = (props.getProperty('VK_GROUP_TOKEN') || '').toString().trim();
  if (!groupIdRaw) throw new Error('Missing VK_GROUP_ID in Script Properties');
  if (!token) throw new Error('Missing VK_GROUP_TOKEN in Script Properties');
  // VK требует integer group_id. В Script Properties иногда попадает строка в научной нотации (например "2.35365188E8").
  var groupIdNum = Number(groupIdRaw);
  var groupId = (isFinite(groupIdNum) && !isNaN(groupIdNum)) ? Math.trunc(groupIdNum) : NaN;
  if (!groupId || isNaN(groupId)) throw new Error('Invalid VK_GROUP_ID: ' + groupIdRaw);
  return { groupId: groupId, token: token, apiVersion: '5.236' };
}

function vkPublishWallPost_(cfg, payload) {
  var groupId = cfg.groupId;
  var token = cfg.token;
  var message = (payload && payload.message ? payload.message : '').toString();
  var imageUrl = (payload && payload.imageUrl ? payload.imageUrl : '').toString().trim();

  var attachments = '';
  if (imageUrl) {
    var photo = vkUploadPhotoForWall_(cfg, imageUrl);
    attachments = 'photo' + photo.owner_id + '_' + photo.id;
  }

  var params = {
    // Важно: передаём числовые параметры строкой, чтобы не улетали в научной нотации.
    owner_id: (-Math.abs(groupId)).toString(),
    from_group: '1',
    message: message
  };
  if (attachments) params.attachments = attachments;

  var res = vkApiCall_(cfg, 'wall.post', params);
  if (!res || !res.post_id) throw new Error('VK wall.post: empty post_id');
  return { post_id: res.post_id, attachments: attachments };
}

function vkUploadPhotoForWall_(cfg, imageUrl) {
  var lastErr = null;
  var maxAttempts = 3;
  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return vkUploadPhotoForWallOnce_(cfg, imageUrl);
    } catch (e) {
      lastErr = e;
      var errMsg = (e && e.message) ? e.message.toString() : e.toString();
      if (attempt < maxAttempts && isRetryableVkUploadError_(errMsg)) {
        Utilities.sleep(1500 * attempt);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('VK upload failed');
}

function vkUploadPhotoForWallOnce_(cfg, imageUrl) {
  var groupId = cfg.groupId;
  var uploadServer = vkApiCall_(cfg, 'photos.getWallUploadServer', { group_id: groupId.toString() });
  if (!uploadServer || !uploadServer.upload_url) throw new Error('VK photos.getWallUploadServer: no upload_url');

  var blob = fetchImageAsBlob_(imageUrl);
  var uploadHttp = UrlFetchApp.fetch(uploadServer.upload_url, {
    method: 'post',
    payload: { photo: blob },
    muteHttpExceptions: true,
    followRedirects: true
  });
  var uploadCode = uploadHttp.getResponseCode();
  var uploadRespRaw = uploadHttp.getContentText();

  if (uploadCode < 200 || uploadCode >= 300) {
    throw new Error(
      'VK upload HTTP ' + uploadCode + ': ' + summarizeNonJsonResponse_(uploadRespRaw)
    );
  }

  var uploadResp;
  try {
    uploadResp = JSON.parse(uploadRespRaw);
  } catch (e) {
    throw new Error('VK upload: invalid JSON (' + summarizeNonJsonResponse_(uploadRespRaw) + ')');
  }
  if (!uploadResp || !uploadResp.photo || !uploadResp.server || !uploadResp.hash) {
    throw new Error('VK upload: missing fields: ' + summarizeNonJsonResponse_(uploadRespRaw));
  }

  var saved = vkApiCall_(cfg, 'photos.saveWallPhoto', {
    group_id: groupId.toString(),
    photo: uploadResp.photo,
    server: uploadResp.server,
    hash: uploadResp.hash
  });
  if (!saved || !saved.length) throw new Error('VK photos.saveWallPhoto: empty response');
  return saved[0];
}

function isRetryableVkUploadError_(errMsg) {
  var s = (errMsg || '').toString().toLowerCase();
  return (
    s.indexOf('temporarily unavailable') !== -1 ||
    s.indexOf('invalid json') !== -1 ||
    s.indexOf('vk upload http 5') !== -1 ||
    s.indexOf('vk upload http 502') !== -1 ||
    s.indexOf('vk upload http 503') !== -1 ||
    s.indexOf('bandwidth quota exceeded') !== -1 ||
    s.indexOf('превышена квота') !== -1
  );
}

function summarizeNonJsonResponse_(raw) {
  var text = (raw || '').toString().replace(/\s+/g, ' ').trim();
  if (!text) return '(empty response)';
  if (text.indexOf('<!DOCTYPE') !== -1 || text.indexOf('<html') !== -1) {
    if (text.indexOf('temporarily unavailable') !== -1) {
      return 'HTML: The page is temporarily unavailable (сервер загрузки VK недоступен)';
    }
    return 'HTML response (not JSON)';
  }
  return text.length > 240 ? (text.slice(0, 240) + '…') : text;
}

function formatVkErrorForUser_(errStr) {
  var s = (errStr || '').toString();
  if (s.indexOf('<!DOCTYPE') !== -1 || s.indexOf('<html') !== -1) {
    if (s.indexOf('temporarily unavailable') !== -1) {
      return 'Сервер загрузки фото VK временно недоступен. Повторите публикацию через 1–2 минуты.';
    }
    return 'Сервер загрузки фото VK вернул HTML вместо JSON. Повторите позже.';
  }
  if (s.indexOf('Bandwidth quota exceeded') !== -1 || s.indexOf('Превышена квота') !== -1) {
    return 'Превышена квота исходящего трафика Google Apps Script. Подождите и повторите (лучше с меньшим изображением).';
  }
  return s.length > 600 ? (s.slice(0, 600) + '…') : s;
}

function vkApiCall_(cfg, method, params) {
  var token = cfg.token;
  var v = cfg.apiVersion || '5.236';
  var url = 'https://api.vk.com/method/' + method;

  var payload = {};
  Object.keys(params || {}).forEach(function (k) {
    var val = params[k];
    if (val === undefined || val === null) return;
    // UrlFetchApp может сериализовать числа в научную нотацию (2.35E8).
    // VK для *_id требует integer-строку, поэтому нормализуем параметры в строку.
    payload[k] = (typeof val === 'string') ? val : String(val);
  });
  payload.access_token = token;
  payload.v = v;

  var resp = UrlFetchApp.fetch(url, {
    method: 'post',
    payload: payload,
    muteHttpExceptions: true,
    followRedirects: true
  });
  var text = resp.getContentText();
  var obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error('VK ' + method + ': invalid JSON: ' + text);
  }
  if (obj && obj.error) {
    throw new Error('VK ' + method + ' error: ' + JSON.stringify(obj.error));
  }
  if (!obj || obj.response === undefined) {
    throw new Error('VK ' + method + ': missing response: ' + text);
  }
  return obj.response;
}

function fetchImageAsBlob_(url) {
  var resp = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Image download failed (' + code + '): ' + url);
  }
  var blob = resp.getBlob();
  var bytes = blob.getBytes();
  var maxBytes = 4 * 1024 * 1024; // ~4 MB — тяжёлые файлы чаще ломают upload VK / квоту GAS
  if (bytes && bytes.length > maxBytes) {
    throw new Error(
      'Image too large for VK upload (' + Math.round(bytes.length / 1024) + ' KB). Use a smaller JPG/PNG.'
    );
  }
  var contentType = (blob.getContentType() || '').toString().toLowerCase();
  var fileName = 'image.jpg';
  if (contentType.indexOf('png') !== -1) fileName = 'image.png';
  else if (contentType.indexOf('webp') !== -1) fileName = 'image.webp';
  try {
    blob = blob.setName(fileName);
  } catch (e) {
    // ignore
  }
  return blob;
}

/* =========================
   SHEETS / QUEUE
========================= */

function openContext_() {
  var props = PropertiesService.getScriptProperties();
  var sheetId = (props.getProperty('GOOGLE_SHEET_ID') || '').toString().trim();
  if (!sheetId) throw new Error('Missing GOOGLE_SHEET_ID in Script Properties');
  var sheetName = (props.getProperty('PUBLISH_SHEET_NAME') || VK_PUBLISH_DEFAULT_SHEET_NAME).toString();
  var archiveName = (props.getProperty('PUBLISH_ARCHIVE_SHEET_NAME') || VK_PUBLISH_DEFAULT_ARCHIVE_SHEET_NAME).toString();

  var id = extractSpreadsheetId_(sheetId);
  var ss = SpreadsheetApp.openById(id);
  var sheet = ss.getSheetByName(sheetName) || ss.getSheets()[0];
  var archive = ss.getSheetByName(archiveName) || ss.insertSheet(archiveName);
  return { ss: ss, sheet: sheet, archive: archive };
}

function ensureHeader_(sheet) {
  var lastCol = sheet.getLastColumn();
  var header = sheet.getRange(1, 1, 1, Math.max(lastCol, 18)).getValues()[0];
  // Минимальный набор заголовков для VK-колонок (P..R)
  if (!header[COLS.vkPublishStatus - 1]) header[COLS.vkPublishStatus - 1] = 'VK_PUBLISH_STATUS';
  if (!header[COLS.vkPublishResultRaw - 1]) header[COLS.vkPublishResultRaw - 1] = 'VK_PUBLISH_RESULT_RAW';
  if (!header[COLS.vkPostId - 1]) header[COLS.vkPostId - 1] = 'VK_POST_ID';
  sheet.getRange(1, 1, 1, header.length).setValues([header]);
}

function readRowAsItem_(sheet, rowId) {
  var lastCol = Math.max(sheet.getLastColumn(), COLS.vkPostId);
  var values = sheet.getRange(rowId, 1, 1, lastCol).getValues()[0];
  return {
    rowId: rowId,
    createdAt: values[COLS.createdAt - 1],
    topic: (values[COLS.topic - 1] || '').toString(),
    audience: (values[COLS.audience - 1] || '').toString(),
    sourceUrl: (values[COLS.sourceUrl - 1] || '').toString(),
    summary: (values[COLS.summary - 1] || '').toString(),
    rawText: (values[COLS.rawText - 1] || '').toString(),
    newsId: (values[COLS.newsId - 1] || '').toString(),
    postTextDraft: (values[COLS.postTextDraft - 1] || '').toString(),
    imageUrl: (values[COLS.imageUrl - 1] || '').toString(),
    vkPublishStatus: (values[COLS.vkPublishStatus - 1] || '').toString(),
    vkPublishResultRaw: (values[COLS.vkPublishResultRaw - 1] || '').toString(),
    vkPostId: (values[COLS.vkPostId - 1] || '').toString(),
    lockedBy: (values[COLS.lockedBy - 1] || '').toString(),
    lockedAt: values[COLS.lockedAt - 1]
  };
}

function buildItemResponse_(hint, item) {
  var msg =
    '📰 Новость из таблицы\n' +
    (hint ? (hint + '\n\n') : '') +
    'row_id: ' + item.rowId + '\n' +
    'Тема: ' + (item.topic || '-') + '\n' +
    'Аудитория: ' + (item.audience || '-') + '\n' +
    'Источник: ' + (item.sourceUrl || '-') + '\n\n' +
    'Кратко:\n' + (item.summary || '-') + '\n\n' +
    'Текст:\n' + (item.rawText || '-');
  return {
    success: true,
    message: msg,
    inline_keyboard: [
      ['Перегенерировать текст', 'regenerate_text'],
      ['Снять лок (пропустить)', 'release_lock'],
      ['Завершить', 'finish']
    ],
    data: { row_id: item.rowId, news_id: item.newsId || '' }
  };
}

function findAndLockNextRow_(sheet, userId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  var now = new Date();
  var values = sheet.getRange(2, 1, lastRow - 1, Math.max(sheet.getLastColumn(), COLS.vkPostId)).getValues();
  for (var i = 0; i < values.length; i++) {
    var rowId = i + 2;
    var newsId = (values[i][COLS.newsId - 1] || '').toString().trim();
    if (!newsId) continue;

    var lockedBy = (values[i][COLS.lockedBy - 1] || '').toString().trim();
    var lockedAt = values[i][COLS.lockedAt - 1];
    if (lockedBy && lockedBy !== userId) {
      if (!isLockExpired_(lockedAt)) continue;
    }

    // пропускаем уже опубликованные в VK
    var vkStatus = (values[i][COLS.vkPublishStatus - 1] || '').toString().trim();
    if (vkStatus === 'PUBLISHED') continue;

    sheet.getRange(rowId, COLS.lockedBy).setValue(userId);
    sheet.getRange(rowId, COLS.lockedAt).setValue(now);
    return readRowAsItem_(sheet, rowId);
  }
  return null;
}

function ensureRowLocked_(sheet, rowId, userId) {
  var lockedBy = (sheet.getRange(rowId, COLS.lockedBy).getValue() || '').toString().trim();
  var lockedAt = sheet.getRange(rowId, COLS.lockedAt).getValue();
  // Если строка не залочена — берём лок на себя.
  // Это защищает сценарий от "потерянного" лока при сохранённом user-state (rowId) во внешнем слое.
  if (!lockedBy) {
    sheet.getRange(rowId, COLS.lockedBy).setValue(userId);
    sheet.getRange(rowId, COLS.lockedAt).setValue(new Date());
    return true;
  }
  if (lockedBy !== userId) {
    if (!isLockExpired_(lockedAt)) return false;
    // если истёк — перезахват
    sheet.getRange(rowId, COLS.lockedBy).setValue(userId);
    sheet.getRange(rowId, COLS.lockedAt).setValue(new Date());
    return true;
  }
  if (isLockExpired_(lockedAt)) {
    sheet.getRange(rowId, COLS.lockedAt).setValue(new Date());
  }
  return true;
}

function unlockRow_(sheet, rowId) {
  sheet.getRange(rowId, COLS.lockedBy).setValue('');
  sheet.getRange(rowId, COLS.lockedAt).setValue('');
}

function archiveAndDeleteRow_(ctx, rowId) {
  var lastCol = Math.max(ctx.sheet.getLastColumn(), COLS.vkPostId);
  var row = ctx.sheet.getRange(rowId, 1, 1, lastCol).getValues()[0];
  ctx.archive.appendRow(row);
  ctx.sheet.deleteRow(rowId);
}

function isLockExpired_(lockedAt) {
  if (!lockedAt) return true;
  try {
    var dt = lockedAt instanceof Date ? lockedAt : new Date(lockedAt);
    var mins = (new Date().getTime() - dt.getTime()) / 60000.0;
    return mins > VK_PUBLISH_LOCK_TTL_MIN;
  } catch (e) {
    return true;
  }
}

/* =========================
   STATE (PropertiesService)
========================= */

function getUserState_(userId) {
  try {
    var key = VK_PUBLISH_STATE_KEY_PREFIX + userId;
    var v = PropertiesService.getUserProperties().getProperty(key);
    return v ? JSON.parse(v) : null;
  } catch (e) {
    return null;
  }
}

function saveUserState_(userId, state) {
  var key = VK_PUBLISH_STATE_KEY_PREFIX + userId;
  PropertiesService.getUserProperties().setProperty(key, JSON.stringify(state || {}));
}

function clearUserState_(userId) {
  var key = VK_PUBLISH_STATE_KEY_PREFIX + userId;
  PropertiesService.getUserProperties().deleteProperty(key);
}

/* =========================
   PARSING / HELPERS
========================= */

function parsePayload_(e) {
  var json = e && e.postData && e.postData.contents ? e.postData.contents : '';
  var payload = {};
  if (json) {
    try {
      payload = JSON.parse(json);
    } catch (e1) {
      payload = {};
    }
  }
  var param = e && e.parameter ? e.parameter : {};
  // поддержка params=user_id::...##command::...
  if (param.params && typeof param.params === 'string' && param.params.indexOf('::') !== -1) {
    var parsed = parseParamsString_(param.params);
    Object.keys(parsed).forEach(function (k) {
      payload[k] = parsed[k];
    });
  }
  // прямая подстановка query params тоже допустима
  Object.keys(param).forEach(function (k) {
    if (payload[k] === undefined) payload[k] = param[k];
  });
  return payload || {};
}

function parseParamsString_(s) {
  var out = {};
  if (!s) return out;
  var parts = s.split('##');
  parts.forEach(function (p) {
    var idx = p.indexOf('::');
    if (idx === -1) return;
    var k = p.slice(0, idx).trim();
    var v = p.slice(idx + 2);
    if (!k) return;
    out[k] = v;
  });
  return out;
}

function safeInt_(v) {
  var n = parseInt((v || '').toString(), 10);
  return isNaN(n) ? null : n;
}

function toBool_(v) {
  if (v === true || v === 1) return true;
  var s = (v || '').toString().trim().toLowerCase();
  return (s === 'true' || s === '1' || s === 'yes' || s === 'y' || s === 'on');
}

function extractSpreadsheetId_(s) {
  var str = (s || '').toString().trim();
  var m = str.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : str;
}

function normalizeResponse_(r) {
  var res = r || {};
  REQUIRED_RESPONSE_FIELDS.forEach(function (k) {
    if (res[k] === undefined) {
      if (k === 'success') res[k] = false;
      if (k === 'message') res[k] = '';
      if (k === 'inline_keyboard') res[k] = [];
    }
  });
  if (!res.data) res.data = {};
  if (!Array.isArray(res.inline_keyboard)) res.inline_keyboard = [];
  res.message = (res.message || '').toString();
  return res;
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

