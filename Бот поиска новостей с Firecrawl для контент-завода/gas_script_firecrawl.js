function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

// ========================================
// STATE MANAGEMENT (Properties Service)
// ========================================

/**
 * Сохранить очередь новостей в Properties Service
 */
function saveNewsQueue(newsArray) {
  try {
    const props = PropertiesService.getScriptProperties();
    props.setProperty('news_queue', JSON.stringify(newsArray));
    props.setProperty('current_index', '0');
    Logger.log('Saved news queue: ' + newsArray.length + ' items');
    return true;
  } catch (err) {
    Logger.log('Error saving news queue: ' + err.toString());
    return false;
  }
}

/**
 * Получить очередь новостей из Properties Service
 */
function getNewsQueue() {
  try {
    const props = PropertiesService.getScriptProperties();
    const queueJson = props.getProperty('news_queue');
    if (!queueJson) {
      return null;
    }
    return JSON.parse(queueJson);
  } catch (err) {
    Logger.log('Error getting news queue: ' + err.toString());
    return null;
  }
}

/**
 * Получить текущий индекс
 */
function getCurrentIndex() {
  try {
    const props = PropertiesService.getScriptProperties();
    const index = props.getProperty('current_index');
    return index ? parseInt(index) : 0;
  } catch (err) {
    Logger.log('Error getting current index: ' + err.toString());
    return 0;
  }
}

/**
 * Увеличить текущий индекс
 */
function incrementCurrentIndex() {
  try {
    const props = PropertiesService.getScriptProperties();
    const currentIndex = getCurrentIndex();
    const newIndex = currentIndex + 1;
    props.setProperty('current_index', newIndex.toString());
    Logger.log('Incremented index: ' + currentIndex + ' -> ' + newIndex);
    return newIndex;
  } catch (err) {
    Logger.log('Error incrementing index: ' + err.toString());
    return currentIndex;
  }
}

/**
 * Установить текущий индекс
 */
function setCurrentIndex(index) {
  try {
    const props = PropertiesService.getScriptProperties();
    props.setProperty('current_index', index.toString());
    Logger.log('Set index to: ' + index);
    return index;
  } catch (err) {
    Logger.log('Error setting current index: ' + err.toString());
    return getCurrentIndex();
  }
}

/**
 * Очистить состояние
 */
function clearState() {
  try {
    const props = PropertiesService.getScriptProperties();
    props.deleteProperty('news_queue');
    props.deleteProperty('current_index');
    Logger.log('State cleared');
    return true;
  } catch (err) {
    Logger.log('Error clearing state: ' + err.toString());
    return false;
  }
}

// ========================================
// СЧЁТЧИК СОХРАНЕНИЙ + ДЕДУПЛИКАЦИЯ
// ========================================

const SAVED_IDS_MAX = 200; // храним последние 200 ID для дедупликации

/**
 * Получить счётчик сохранений в текущей сессии (с последнего start_search)
 */
function getSavedCountThisSession() {
  try {
    const props = PropertiesService.getScriptProperties();
    const count = props.getProperty('saved_count_this_session');
    return count ? parseInt(count) : 0;
  } catch (err) {
    Logger.log('Error getSavedCountThisSession: ' + err.toString());
    return 0;
  }
}

/**
 * Увеличить счётчик сохранений в текущей сессии
 */
function incrementSavedCountThisSession() {
  try {
    const props = PropertiesService.getScriptProperties();
    const count = getSavedCountThisSession() + 1;
    props.setProperty('saved_count_this_session', count.toString());
    Logger.log('Saved count this session: ' + count);
    return count;
  } catch (err) {
    Logger.log('Error incrementSavedCountThisSession: ' + err.toString());
    return 0;
  }
}

/**
 * Сбросить счётчик сохранений (вызывается при start_search)
 */
function resetSavedCountThisSession() {
  try {
    const props = PropertiesService.getScriptProperties();
    props.setProperty('saved_count_this_session', '0');
    Logger.log('Saved count this session reset to 0');
    return true;
  } catch (err) {
    Logger.log('Error resetSavedCountThisSession: ' + err.toString());
    return false;
  }
}

/**
 * Получить список уже сохранённых ID (для дедупликации)
 */
function getSavedIds() {
  try {
    const props = PropertiesService.getScriptProperties();
    const json = props.getProperty('saved_news_ids');
    if (!json) return [];
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    Logger.log('Error getSavedIds: ' + err.toString());
    return [];
  }
}

/**
 * Добавить ID в список сохранённых (храним последние SAVED_IDS_MAX)
 */
function addSavedId(newsId) {
  if (!newsId || typeof newsId !== 'string') {
    Logger.log('WARNING: addSavedId called with invalid ID: ' + newsId);
    return;
  }
  try {
    const props = PropertiesService.getScriptProperties();
    let ids = getSavedIds();
    const wasAlreadySaved = ids.indexOf(newsId) !== -1;
    
    if (!wasAlreadySaved) {
      ids.push(newsId);
      if (ids.length > SAVED_IDS_MAX) {
        ids = ids.slice(-SAVED_IDS_MAX);
      }
      props.setProperty('saved_news_ids', JSON.stringify(ids));
    }
  } catch (err) {
    // Ошибка при добавлении ID - игнорируем
  }
}

function handleRequest(e) {
  const requestTimestamp = new Date().toISOString();
  try {
    // Детальное логирование для отладки
    // Логируем каждый входящий запрос для диагностики (2026-01-28)
    const rawPayload = (e.postData && e.postData.contents) ? String(e.postData.contents).substring(0, 500) : 
                       (e.parameter && e.parameter.params) ? String(e.parameter.params).substring(0, 500) : 
                       (e.queryString || '').substring(0, 300);
    
    // Основное логирование запроса (урезанное, без DEBUG-маркеров)
    Logger.log('e.parameter: ' + JSON.stringify(e.parameter));
    Logger.log('e.parameters: ' + JSON.stringify(e.parameters));
    if (e.postData) {
      Logger.log('e.postData.type: ' + e.postData.type);
      Logger.log('e.postData.contents: ' + e.postData.contents);
    }
    Logger.log('e.queryString: ' + e.queryString);
    
    let params = {};
    let paramsString = null;
    
    // Способ 1: e.parameter.params (строка в формате key1::value1##key2::value2)
    if (e.parameter && e.parameter.params) {
      paramsString = e.parameter.params;
      Logger.log('Found params in e.parameter.params: ' + paramsString);
    }
    
    // Способ 1b: e.parameters.params (массив, берем первый элемент)
    if (!paramsString && e.parameters && e.parameters.params && e.parameters.params[0]) {
      paramsString = e.parameters.params[0];
      Logger.log('Found params in e.parameters.params[0]: ' + paramsString);
    }
    
    // Способ 2: e.parameter напрямую (если параметры переданы отдельно как action, query и т.д.)
    if (!paramsString && e.parameter && Object.keys(e.parameter).length > 0) {
      // Проверяем, есть ли уже action напрямую
      if (e.parameter.action) {
        params = e.parameter;
        Logger.log('Using e.parameter directly: ' + JSON.stringify(params));
      } else {
        // Пробуем найти params в любом ключе
        for (let key in e.parameter) {
          const value = e.parameter[key];
          if (typeof value === 'string' && (key.toLowerCase().includes('param') || value.includes('::'))) {
            paramsString = value;
            Logger.log('Found params-like string in e.parameter.' + key + ': ' + paramsString);
            break;
          }
        }
      }
    }
    
    // Способ 2b: e.queryString (если параметры в URL)
    if (!paramsString && e.queryString) {
      const urlParams = e.queryString.split('&');
      for (let param of urlParams) {
        if (param.startsWith('params=')) {
          paramsString = param.substring(7); // Убираем "params="
          Logger.log('Found params in queryString: ' + paramsString);
          break;
        }
      }
    }
    
    // Способ 3: POST data как JSON
    if (!paramsString && e.postData && e.postData.contents) {
      try {
        const jsonData = JSON.parse(e.postData.contents);
        Logger.log('Parsed POST JSON: ' + JSON.stringify(jsonData));
        
        if (jsonData.params) {
          // Если params - строка
          if (typeof jsonData.params === 'string') {
            paramsString = jsonData.params;
            Logger.log('Found params in POST JSON (string): ' + paramsString);
          } else {
            // Если params - объект
            params = { ...params, ...jsonData.params };
            Logger.log('Found params in POST JSON (object): ' + JSON.stringify(params));
          }
        } else if (jsonData.action) {
          // Если action и другие параметры напрямую в JSON
          params = { ...params, ...jsonData };
          Logger.log('Using POST JSON directly: ' + JSON.stringify(params));
        }
      } catch (parseErr) {
        Logger.log('POST JSON parse error: ' + parseErr.toString());
        // Пробуем как form data (application/x-www-form-urlencoded)
        try {
          const formData = e.postData.contents;
          Logger.log('POST form data (raw): ' + formData);
          
          // Пробуем найти params= в form data
          if (formData.includes('params=')) {
            // Вариант 1: params=value&other=value
            const match = formData.match(/params=([^&]+)/);
            if (match) {
              paramsString = decodeURIComponent(match[1].replace(/\+/g, ' '));
              Logger.log('Found params in POST form data (method 1): ' + paramsString);
            } else {
              // Вариант 2: params может быть в конце без &
              const parts = formData.split('params=');
              if (parts.length > 1) {
                paramsString = decodeURIComponent(parts[1].replace(/\+/g, ' '));
                Logger.log('Found params in POST form data (method 2): ' + paramsString);
              }
            }
          }
          
          // Если не нашли params, пробуем распарсить все параметры
          if (!paramsString && formData.includes('::')) {
            // Может быть params переданы напрямую как action::value##key::value
            paramsString = formData;
            Logger.log('Using entire form data as params string: ' + paramsString);
          }
        } catch (formErr) {
          Logger.log('Form data parse error: ' + formErr.toString());
        }
      }
    }
    
    // Способ 3b: e.parameter из POST form data (Google Apps Script автоматически парсит)
    if (!paramsString && e.parameter && e.parameter.params) {
      paramsString = e.parameter.params;
      Logger.log('Found params in e.parameter.params (POST form): ' + paramsString);
    }
    
    // Парсим paramsString если он найден
    if (paramsString) {
      // Декодируем URL-encoded строку если нужно
      try {
        paramsString = decodeURIComponent(paramsString);
      } catch (e) {
        // Не URL-encoded, оставляем как есть
      }
      
      Logger.log('Parsing params string (length: ' + paramsString.length + ')');
      
      // Улучшенный парсинг: обрабатываем параметры в правильном порядке
      // Формат: action::value##id::value##topic::value##audience::value##source::value##summary::длинный текст
      // summary (или text для обратной совместимости) всегда последний и может содержать ## и ::
      // Парсим параметры последовательно, зная их порядок
      
      const paramOrder = ['action', 'id', 'topic', 'audience', 'source', 'summary', 'text'];
      let currentPos = 0;
      
      for (let i = 0; i < paramOrder.length; i++) {
        const paramName = paramOrder[i];
        const searchPattern = paramName + '::';
        const paramStart = paramsString.indexOf(searchPattern, currentPos);
        
        if (paramStart === -1) {
          // Параметр не найден, пропускаем
          Logger.log('Parameter ' + paramName + ' not found');
          continue;
        }
        
        const valueStart = paramStart + searchPattern.length;
        
        // Если это не последний параметр (text), ищем начало следующего параметра
        if (i < paramOrder.length - 1) {
          const nextParamName = paramOrder[i + 1];
          const nextParamPattern = '##' + nextParamName + '::';
          const nextParamStart = paramsString.indexOf(nextParamPattern, valueStart);
          
          if (nextParamStart !== -1) {
            // Нашли следующий параметр, берем значение до него
            const value = paramsString.substring(valueStart, nextParamStart);
            params[paramName] = value.trim();
            Logger.log('Parsed ' + paramName + ' (length: ' + value.length + ')');
            currentPos = nextParamStart + 2; // Переходим за ##
          } else {
            // Следующий параметр не найден, но это не text - возможно формат неправильный
            // Пробуем найти любой следующий параметр
            let foundNext = false;
            for (let j = i + 1; j < paramOrder.length; j++) {
              const nextPattern = '##' + paramOrder[j] + '::';
              const nextStart = paramsString.indexOf(nextPattern, valueStart);
              if (nextStart !== -1) {
                const value = paramsString.substring(valueStart, nextStart);
                params[paramName] = value.trim();
                Logger.log('Parsed ' + paramName + ' (length: ' + value.length + ')');
                currentPos = nextStart + 2;
                foundNext = true;
                break;
              }
            }
            if (!foundNext) {
              // Это последний найденный параметр, берем все до конца
              const value = paramsString.substring(valueStart);
              params[paramName] = value.trim();
              Logger.log('Parsed ' + paramName + ' (last param, length: ' + value.length + ')');
              break;
            }
          }
        } else {
          // Это summary или text - последний параметр, берем все до конца строки
          const value = paramsString.substring(valueStart);
          params[paramName] = value.trim();
          Logger.log('Parsed ' + paramName + ' (last param, length: ' + value.length + ')');
          break;
        }
      }
      
      // Если не все параметры распарсились, пробуем старый метод как fallback
      if (Object.keys(params).length === 0) {
        Logger.log('Warning: new parsing method failed, using fallback');
        paramsString.split('##').forEach(pair => {
          const parts = pair.split('::');
          if (parts.length >= 2) {
            const key = parts[0].trim();
            const value = parts.slice(1).join('::').trim();
            params[key] = value;
            Logger.log('Fallback parsed: ' + key + ' (length: ' + value.length + ')');
          }
        });
      }
    }

    Logger.log('Final params: ' + JSON.stringify(params));
    
    // Логируем распарсенный action в таблицу Logs для полной трассировки 
    const action = params.action;

    if (!action) {
      return output({ 
        status: 'error', 
        message: 'No action provided',
        debug: { 
          received_parameter: e.parameter,
          received_parameters: e.parameters,
          received_postData: e.postData ? e.postData.contents : null,
          parsed_params: params,
          queryString: e.queryString
        }
      });
    }

    if (action === 'search_news') {
      return searchNews(params);
    }

    if (action === 'save_news') {
      return saveNews(params);
    }

    // NEW STATEFUL ACTIONS 
    
    if (action === 'start_search') {
      return startSearch(params);
    }

    if (action === 'get_current') {
      return getCurrent(params);
    }

    if (action === 'confirm_current') {
      return confirmCurrent(params);
    }

    if (action === 'get_next') {
      return getNext(params);
    }
    return output({ status: 'error', message: 'Unknown action: ' + action });

  } catch (err) {
    Logger.log('ERROR: ' + err.toString());
    Logger.log('Stack: ' + err.stack);
    return output({ 
      status: 'error', 
      message: err.toString(),
      stack: err.stack
    });
  }
}

/* =========================
   SCRAPE KOMMERSANT THEME PAGE
========================= */
/**
 * Скрапит страницу темы kommersant.ru/theme/2912 и извлекает ссылки на статьи
 * Это позволяет находить свежие новости, которые еще не попали в индекс Firecrawl Search
 * @param {string} apiKey - Firecrawl API ключ
 * @param {string} query - Поисковый запрос для фильтрации релевантных статей
 * @return {Array} Массив результатов в формате, совместимом с Firecrawl Search API
 */
function scrapeKommersantThemePage(apiKey, query) {
  try {
    const themeUrl = 'https://www.kommersant.ru/theme/2912'; // Тема "Искусственный интеллект"
    Logger.log('=== SCRAPING KOMMERSANT THEME PAGE ===');
    Logger.log('URL: ' + themeUrl);
    
    // Скрапим страницу темы через Firecrawl Scrape API
    const payload = {
      url: themeUrl,
      formats: ["markdown", "html"], // Пробуем оба формата
      onlyMainContent: false // Нужен весь контент для извлечения ссылок
    };
    
    const response = UrlFetchApp.fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'post',
      contentType: 'application/json',
      headers: { 
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Accept-Language': 'ru-RU,ru;q=0.9'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    
    const statusCode = response.getResponseCode();
    const text = response.getContentText();
    
    Logger.log('Scrape response code: ' + statusCode);
    
    if (statusCode !== 200) {
      Logger.log('Failed to scrape kommersant.ru theme page: ' + statusCode);
      Logger.log('Response: ' + text.substring(0, 500));
      return [];
    }
    
    let data;
    try { 
      data = JSON.parse(text); 
    } catch (e) { 
      Logger.log('Failed to parse scrape response: ' + e.toString());
      Logger.log('Response text (first 500): ' + text.substring(0, 500));
      return [];
    }
    
    // Извлекаем markdown и HTML из ответа
    const markdown = data.data?.markdown || data.data?.content || data.markdown || data.content || '';
    const html = data.data?.html || data.html || '';
    
    Logger.log('Markdown length: ' + (markdown ? markdown.length : 0));
    Logger.log('HTML length: ' + (html ? html.length : 0));
    
    if (!markdown && !html) {
      Logger.log('No markdown or HTML content found in scrape response');
      Logger.log('Response keys: ' + Object.keys(data).join(', '));
      if (data.data) {
        Logger.log('Data keys: ' + Object.keys(data.data).join(', '));
      }
      return [];
    }
    
    const links = [];
    
    // Метод 1: Извлекаем ссылки из markdown
    if (markdown) {
      Logger.log('Extracting links from markdown...');
      // Формат ссылок в markdown: [текст](url) или [текст](url "title")
      const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\)\s]+|https?:\/\/[^\)]+)\)/g;
      let match;
      
      while ((match = linkRegex.exec(markdown)) !== null) {
        const linkText = match[1];
        let linkUrl = match[2];
        
        // Убираем кавычки и пробелы из конца URL
        linkUrl = linkUrl.trim().replace(/["']$/, '');
        
        // Нормализуем относительные URL
        if (linkUrl.startsWith('/')) {
          linkUrl = 'https://www.kommersant.ru' + linkUrl;
        }
        
        // Фильтруем только ссылки на статьи kommersant.ru
        // Исключаем: изображения, темы, теги, рубрики, главную страницу, служебные страницы
        const isArticle = linkUrl.includes('kommersant.ru/doc/');
        const isNotExcluded = !linkUrl.includes('/theme/') && 
                              !linkUrl.includes('/tag/') &&
                              !linkUrl.includes('/rubric/') &&
                              !linkUrl.includes('/invest?') &&
                              !linkUrl.includes('/tech?') &&
                              !linkUrl.includes('/lk/') &&
                              !linkUrl.includes('events.kommersant.ru') &&
                              !linkUrl.includes('.jpg') &&
                              !linkUrl.includes('.jpeg') &&
                              !linkUrl.includes('.png') &&
                              !linkUrl.includes('.gif') &&
                              !linkUrl.includes('im2.kommersant.ru') &&
                              !linkUrl.includes('from=burger') &&
                              !linkUrl.includes('from=actualno');
        
        if (isArticle || (linkUrl.includes('kommersant.ru/') && isNotExcluded)) {
          // Дополнительная проверка: заголовок не должен быть пустым или слишком коротким
          const cleanTitle = linkText.trim().replace(/^!\[/, '').replace(/\]$/, ''); // Убираем markdown изображения
          if (cleanTitle.length >= 10 && !cleanTitle.match(/^(Инвестиции|Технологии|E-mail|Книга|Подписывайтесь)/i)) {
            links.push({
              title: cleanTitle,
              url: linkUrl.trim()
            });
          }
        }
      }
      Logger.log('Found ' + links.length + ' links in markdown');
    }
    
    // Метод 2: Извлекаем ссылки из HTML (если markdown не дал результатов)
    if (html && links.length === 0) {
      Logger.log('Extracting links from HTML...');
      // Ищем ссылки в формате <a href="...">текст</a>
      const htmlLinkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi;
      let match;
      
      while ((match = htmlLinkRegex.exec(html)) !== null) {
        let linkUrl = match[1];
        const linkText = match[2];
        
        // Нормализуем относительные URL
        if (linkUrl.startsWith('/')) {
          linkUrl = 'https://www.kommersant.ru' + linkUrl;
        }
        
        // Фильтруем только ссылки на статьи kommersant.ru
        if (linkUrl.includes('kommersant.ru/doc/') || 
            (linkUrl.includes('kommersant.ru/') && 
             !linkUrl.includes('/theme/') && 
             !linkUrl.includes('/tag/') &&
             !linkUrl.includes('/rubric/'))) {
          links.push({
            title: linkText.trim(),
            url: linkUrl.trim()
          });
        }
      }
      Logger.log('Found ' + links.length + ' links in HTML');
    }
    
    // Удаляем дубликаты по URL
    const uniqueLinks = [];
    const seenUrls = new Set();
    for (const link of links) {
      if (!seenUrls.has(link.url)) {
        seenUrls.add(link.url);
        uniqueLinks.push(link);
      }
    }
    
    Logger.log('Total unique links: ' + uniqueLinks.length);
    
    // Фильтруем по релевантности (более мягкая фильтрация)
    const relevantKeywords = [
      'нейросет', 'нейросеть', 'нейросети', 'нейрос',
      'искусственный интеллект', 'ии', 'ai', 'искусственн',
      'машинное обучение', 'ml',
      'chatgpt', 'gpt', 'claude', 'gemini',
      'генеративн', 'llm', 'openai', 'nvidia'
    ];
    
    // Сначала пробуем найти релевантные ссылки
    let relevantLinks = uniqueLinks.filter(link => {
      const titleLower = link.title.toLowerCase();
      return relevantKeywords.some(keyword => titleLower.includes(keyword.toLowerCase()));
    });
    
    Logger.log('Relevant links (strict): ' + relevantLinks.length);
    
    // Если релевантных мало, берем все ссылки (так как страница темы уже про ИИ)
    if (relevantLinks.length < 3) {
      Logger.log('Too few relevant links, taking all links from theme page');
      relevantLinks = uniqueLinks;
    }
    
    // Преобразуем ссылки в формат, совместимый с Firecrawl Search API
    const results = relevantLinks.map((link, index) => {
      return {
        url: link.url,
        title: link.title,
        description: '', // Описание будет получено при скрапинге полного текста
        publishedAt: null, // Дата будет получена при скрапинге
        score: 0.8 - (index * 0.01) // Убывающий релевантность (первые ссылки более релевантны)
      };
    });
    
    Logger.log('Returning ' + results.length + ' results from theme page');
    
    // Ограничиваем количество результатов (берем первые 15)
    return results.slice(0, 15);
    
  } catch (err) {
    Logger.log('Error in scrapeKommersantThemePage: ' + err.toString());
    Logger.log('Error stack: ' + err.stack);
    return [];
  }
}

/* =========================
   SEARCH VIA FIRECRAWL
========================= */
function searchNews(p) {
  try {
    let query = p.query;
    if (!query) {
      return output({ status: 'error', message: 'Query is required' });
    }

    // Приоритетные источники для поиска новостей
    const prioritySources = [
      // На текущем этапе  приоритет у kommersant.ru и 3dnews.ru.
      // Приоритетные источники не фильтруются по дате, если дата не найдена (доверяем источнику).
      'kommersant.ru',   // Коммерсант - тема ИИ (основной источник)
      '3dnews.ru'        // 3DNews - дополнительный источник, если новостей с Коммерсанта мало
    ];

    // Ключевые слова для проверки релевантности (для тематики нейросетей и AI)
    const relevantKeywords = [
      'нейросет', 'нейросеть', 'нейросети',
      'искусственный интеллект', 'ии', 'ai',
      'машинное обучение', 'ml',
      'chatgpt', 'gpt', 'claude', 'gemini',
      'генеративн', 'llm',
      'компьютерное зрение', 'cv',
      'обработка естественного языка', 'nlp',
      'deep learning', 'глубокое обучение'
    ];

    const apiKey = PropertiesService.getScriptProperties().getProperty('FIRECRAWL_API_KEY');
    if (!apiKey) {
      return output({ 
        status: 'error', 
        message: 'Firecrawl API key not found. Please set FIRECRAWL_API_KEY in Script Properties.' 
      });
    }

    // Сначала ищем на приоритетных источниках
    let allResults = [];
    const baseQuery = query.replace(/\s+site:\S+/gi, '').trim(); // Убираем существующие site: фильтры
    
    // ========================================
    // ОСНОВНОЙ ПОИСК: Скрапинг страницы темы kommersant.ru/theme/2912 
    // Это основной источник новостей
    // ========================================
    try {
      Logger.log('=== SCRAPING KOMMERSANT.RU THEME PAGE (PRIMARY SOURCE) ===');
      const themePageResults = scrapeKommersantThemePage(apiKey, baseQuery);
      if (themePageResults && themePageResults.length > 0) {
        Logger.log('Found ' + themePageResults.length + ' results from kommersant.ru theme page');
        allResults = allResults.concat(themePageResults);
      } else {
        Logger.log('No results found from kommersant.ru theme page');
      }
    } catch (themeErr) {
      Logger.log('Error scraping kommersant.ru theme page: ' + themeErr.toString());
      Logger.log('Error stack: ' + themeErr.stack);
      // Не прерываем выполнение, если скрапинг темы не удался
    }
    
    // ========================================
    // ДОПОЛНИТЕЛЬНЫЙ ПОИСК: 3dnews.ru (только если новостей с Коммерсанта мало) 
    // Порог: если после фильтрации новостей с Коммерсанта меньше 5, добавляем 3dnews.ru
    // ========================================
    // Сначала проверяем, сколько новостей с Коммерсанта в результатах
    // Проверяем по URL в разных возможных полях
    const kommersantResults = allResults.filter(item => {
      const url = (item.url || item.link || item.source || '').toLowerCase();
      return url.includes('kommersant.ru');
    });
    
    Logger.log('Kommersant results found: ' + kommersantResults.length);
    
    // Если новостей с Коммерсанта мало (меньше 5), добавляем поиск на 3dnews.ru
    if (kommersantResults.length < 5) {
      Logger.log('Kommersant results too few (' + kommersantResults.length + '), adding 3dnews.ru search');
      
      const query3dnews = baseQuery + ' site:3dnews.ru';
      Logger.log('Search query (3dnews.ru): ' + query3dnews);
      
      try {
        const payload3dnews = {
          query: query3dnews,
          limit: 15, // Получаем больше для фильтрации
          scrapeOptions: { 
            formats: ["markdown"],
            onlyMainContent: true
          }
          // dateRange по-прежнему отключен — фильтруем по дате вручную ниже
        };
        
        Logger.log('Date filter: DISABLED in API (manual filter will be applied later)');

        const response3dnews = UrlFetchApp.fetch('https://api.firecrawl.dev/v1/search', {
          method: 'post',
          contentType: 'application/json',
          headers: { 
            'Authorization': 'Bearer ' + apiKey,
            'Content-Type': 'application/json'
          },
          payload: JSON.stringify(payload3dnews),
          muteHttpExceptions: true
        });

        const statusCode3dnews = response3dnews.getResponseCode();
        const text3dnews = response3dnews.getContentText();
        
        Logger.log('Firecrawl API response code (3dnews.ru): ' + statusCode3dnews);
        Logger.log('Firecrawl API response text (first 1000 chars): ' + text3dnews.substring(0, 1000));
        
        if (statusCode3dnews === 200) {
          const data3dnews = JSON.parse(text3dnews);
          if (data3dnews && data3dnews.data && Array.isArray(data3dnews.data)) {
            allResults = allResults.concat(data3dnews.data);
            Logger.log('Found ' + data3dnews.data.length + ' results from 3dnews.ru');
          } else {
            Logger.log('Response OK but no data array (3dnews.ru): ' + text3dnews.substring(0, 500));
          }
        } else {
          Logger.log('Firecrawl API error (3dnews.ru): ' + statusCode3dnews + ' - ' + text3dnews.substring(0, 200));
        }
      } catch (err3dnews) {
        Logger.log('Search error (3dnews.ru): ' + err3dnews.toString());
      }
    } else {
      Logger.log('Kommersant results sufficient (' + kommersantResults.length + '), skipping 3dnews.ru search');
    }
          
    if (allResults.length === 0) {
      Logger.log('WARNING: No results found from Firecrawl API (no API errors)');
      return output({ status: 'ok', news: [] });
    }

    // Функция для проверки, является ли источник приоритетным
    function isPrioritySource(url) {
      if (!url) return false;
      const urlLower = url.toLowerCase();
      return prioritySources.some(source => urlLower.includes(source));
    }

    // Функция для проверки релевантности по ключевым словам
    function isRelevant(title, text) {
      const combined = ((title || '') + ' ' + (text || '')).toLowerCase();
      return relevantKeywords.some(keyword => combined.includes(keyword.toLowerCase()));
    }

    // Обрабатываем и фильтруем результаты
    const idMap = new Map(); // Для отслеживания дубликатов ID
    const processedNews = allResults.map((item, index) => {
      const urlForId = (item.url || item.link || '').toString().trim();
      let idString;
      
      if (!urlForId) {
        const fallbackId = (item.title || item.headline || 'no-title-' + index).toString().trim();
        const idBytes = Utilities.computeDigest(
          Utilities.DigestAlgorithm.MD5,
          fallbackId + index
        );
        // Конвертируем байты в hex строку
        idString = idBytes.map(byte => {
          const hex = (byte < 0 ? byte + 256 : byte).toString(16);
          return hex.length === 1 ? '0' + hex : hex;
        }).join('').substring(0, 32);
      } else {
        // Используем полный URL для генерации ID (каждая статья должна иметь уникальный ID)
        // Приводим к нижнему регистру для стабильности, но сохраняем все параметры
        const normalizedUrl = urlForId.toLowerCase().trim();
        const idBytes = Utilities.computeDigest(
          Utilities.DigestAlgorithm.MD5,
          normalizedUrl
        );
        // Конвертируем байты в hex строку (MD5 дает 16 байт = 32 hex символа)
        idString = idBytes.map(byte => {
          const hex = (byte < 0 ? byte + 256 : byte).toString(16);
          return hex.length === 1 ? '0' + hex : hex;
        }).join('').substring(0, 32);
      }
      
      // Проверяем на дубликаты ID в текущем наборе результатов
      if (idMap.has(idString)) {
        Logger.log('⚠️ WARNING: Duplicate ID detected: "' + idString + '" for URLs: ' + urlForId + ' and ' + idMap.get(idString));
        // Добавляем индекс для уникальности (берем первые 28 символов и добавляем 4-значный индекс)
        idString = idString.substring(0, 28) + ('000' + index).slice(-4);
      }
      idMap.set(idString, urlForId);
      
      // Проверяем длину ID (должно быть минимум 16 символов)
      if (idString.length < 16) {
        Logger.log('⚠️ WARNING: Generated ID is too short: "' + idString + '" (length: ' + idString.length + ')');
        // Дополняем до 16 символов нулями
        while (idString.length < 16) {
          idString += '0';
        }
      }
      
      const title = (item.title || item.headline || 'Без заголовка').toString().trim();
      const source = urlForId;
      // Извлекаем текст из разных возможных полей Firecrawl Search API
      const text = (item.markdown || item.content || item.description || item.snippet || item.text || '').toString().trim();
      
      Logger.log('Generated ID: "' + idString + '" (length: ' + idString.length + ') for URL: ' + (urlForId || 'no URL'));
      
      return {
        id: idString,
        title: title,
        source: source,
        text: text,
        publishedAt: item.publishedAt || item.date || '',
        isPriority: isPrioritySource(source),
        isRelevant: isRelevant(title, text)
      };
    });

    // Функция для проверки, является ли домен разрешенным (kommersant.ru или 3dnews.ru)
        function isAllowedDomain(url) {
      if (!url) return false;
      const urlLower = url.toLowerCase();
      return urlLower.includes('kommersant.ru') || urlLower.includes('3dnews.ru');
    }


    // Применяем улучшенную фильтрацию
    const filteredNews = processedNews.filter(item => {
      // Исключаем главные страницы сайтов (path только "/" или пустой) — это не статьи
      // Пример: https://edutainme.com/ — главная, не новость
      if (item.source && /^https?:\/\/[^\/#?]+\/?(\?|#|$)/i.test(item.source.replace(/\s/g, ''))) {
        Logger.log('Filtered out homepage (not an article): ' + item.source);
        return false;
      }
      
      // Исключаем домены, которые не являются разрешенными (kommersant.ru или 3dnews.ru)
      if (!isAllowedDomain(item.source)) {
        Logger.log('Filtered out non-allowed domain: ' + item.source);
        return false;
      }
      
      // Минимальная длина текста: 100 символов для сайтов
      // ИСКЛЮЧЕНИЕ: Для приоритетных источников с пустым текстом не фильтруем,
      // так как текст будет получен позже при скрапинге полного текста (новости из темы kommersant.ru)
      const minLength = 100;
      const hasEmptyText = !item.text || item.text.length === 0;
      const isPriorityWithEmptyText = item.isPriority && hasEmptyText;
      
      if (!isPriorityWithEmptyText && (!item.text || item.text.length < minLength)) {
        Logger.log('Filtered out short text (length: ' + (item.text ? item.text.length : 0) + ', min: ' + minLength + '): ' + item.title);
        return false;
      }
      
      // Для приоритетных источников с пустым текстом логируем, но не фильтруем
      if (isPriorityWithEmptyText) {
        Logger.log('Keeping priority source with empty text (will get text later): ' + item.title + ' | URL: ' + item.source);
      }
      
      // Проверка релевантности (для приоритетных источников более мягкая проверка)
      // ИСПРАВЛЕНИЕ: Для приоритетных источников не проверяем релевантность
      // так как они уже отфильтрованы по источнику (kommersant.ru, 3dnews.ru)
      if (!item.isPriority && !item.isRelevant) {
        Logger.log('Filtered out non-relevant: ' + item.title);
        return false;
      }
      
      // Для приоритетных источников логируем, но не фильтруем по релевантности
      if (item.isPriority && !item.isRelevant) {
        Logger.log('Keeping priority source (relevance check skipped): ' + item.title + ' | URL: ' + item.source);
      }
      
      // Исключаем страницы книг, статей и не-новостных разделов - добавлено 2026-01-27
      // Проверяем как оригинальный URL, так и декодированный (для URL-кодированных ссылок)
      if (item.source) {
        const sourceLower = item.source.toLowerCase();
        let decodedSource = '';
        try {
          decodedSource = decodeURIComponent(item.source).toLowerCase();
        } catch (e) {
          decodedSource = sourceLower; // Если декодирование не удалось, используем оригинал
        }
        
        // Паттерны не-новостных страниц
        const nonNewsPatterns = [
          '/book/', '/article/', '/reviews/', '/corp.'
        ];
        
        const isNonNews = nonNewsPatterns.some(pattern => 
          sourceLower.includes(pattern) || decodedSource.includes(pattern)
        );
        
        if (isNonNews) {
          Logger.log('Filtered out non-news page: ' + item.source);
          return false;
        }
      }
      
      // Проверка на валидность заголовка
      if (!item.title || item.title === 'Без заголовка' || item.title.length < 10) {
        Logger.log('Filtered out invalid title: ' + item.title);
        return false;
      }
      
      // Фильтрация по дате: отсекаем новости старше 24 часов (1 день) (2026-02-06)
      // Это более мягкий фильтр, чем через API, так как Firecrawl dateRange не работает
      const oneDayAgo = new Date();
      oneDayAgo.setDate(oneDayAgo.getDate() - 1);

      let hasValidDate = false;
      let publishDate = null;

      // Проверяем publishedAt
      if (item.publishedAt) {
        try {
          publishDate = new Date(item.publishedAt);
          if (!isNaN(publishDate.getTime())) {
            hasValidDate = true;
            if (publishDate < oneDayAgo) {
              Logger.log('Filtered out old news (older than 24 hours): ' + item.title + ' | Date: ' + item.publishedAt);
              return false;
            }
          }
        } catch (err) {
          Logger.log('Could not parse publishedAt for: ' + item.title + ' | Date: ' + item.publishedAt);
        }
      }


      // Попытка извлечь дату из текста (формат: "10 февраля 2021" или "10 февраля 2021 года")
      // Это нужно, так как дата не всегда в URL и может отсутствовать в publishedAt
      if (!hasValidDate && item.text) {
        // Ищем дату в первых 500 символах текста (обычно дата публикации в начале статьи)
        const textStart = item.text.substring(0, 500);
        const dateMatch = textStart.match(/(\d{1,2})\s+(январ[яе]|феврал[яе]|март[ае]|апрел[яе]|ма[яе]|июн[яе]|июл[яе]|август[ае]|сентябр[яе]|октябр[яе]|ноябр[яе]|декабр[яе])\s+(\d{4})(?:\s+года)?/i);
        if (dateMatch) {
          const day = parseInt(dateMatch[1], 10);
          const monthNames = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
          const monthName = dateMatch[2].toLowerCase();
          const month = monthNames.findIndex(m => monthName.startsWith(m));
          const year = parseInt(dateMatch[3], 10);
          
          if (month >= 0 && day >= 1 && day <= 31 && year >= 2000 && year <= 2030) {
            publishDate = new Date(year, month, day);
            if (!isNaN(publishDate.getTime())) {
              hasValidDate = true;
              if (publishDate < oneDayAgo) {
                Logger.log('Filtered out old news (date from text older than 24 hours): ' + item.title + ' | Date from text: ' + day + ' ' + monthNames[month] + ' ' + year);
                return false;
              }
            }
          }
        }
      }

      // Если дата не найдена — применяем разные правила для приоритетных и не-приоритетных источников (2026-02-02)
      // Для приоритетных источников: доверяем и оставляем новость (даже без даты)
      // Для не-приоритетных: отфильтровываем (не можем проверить свежесть)
      if (!hasValidDate) {
        if (item.isPriority) {
          // Приоритетный источник без даты — оставляем (доверяем источнику)
          Logger.log('Keeping priority source without date (trusting source): ' + item.title + ' | URL: ' + item.source);
        } else {
          // Не-приоритетный источник без даты — отфильтровываем (не можем проверить свежесть)
          Logger.log('Filtered out non-priority news without valid date (cannot verify freshness): ' + item.title + ' | URL: ' + item.source);
          return false;
        }
      }
      
      return true;
    });

    // Сортируем: сначала приоритетные источники (kommersant.ru первый), потом по релевантности
    filteredNews.sort((a, b) => {
      // Сначала приоритетные источники
      if (a.isPriority && !b.isPriority) return -1;
      if (!a.isPriority && b.isPriority) return 1;
      
      // Если оба приоритетные - сортируем по приоритету источника
      if (a.isPriority && b.isPriority) {
        const aSource = (a.source || '').toLowerCase();
        const bSource = (b.source || '').toLowerCase();
        
        // kommersant.ru имеет наивысший приоритет
        const aIsKommersant = aSource.includes('kommersant.ru');
        const bIsKommersant = bSource.includes('kommersant.ru');
        if (aIsKommersant && !bIsKommersant) return -1;
        if (!aIsKommersant && bIsKommersant) return 1;
        
        // Потом 3dnews.ru
        // Остальные приоритетные источники идут после
      }
      
      // Потом по релевантности
      if (a.isRelevant && !b.isRelevant) return -1;
      if (!a.isRelevant && b.isRelevant) return 1;
      return 0;
    });

    // Убираем служебные поля перед возвратом
    const finalNews = filteredNews.slice(0, 10).map(item => ({
      id: item.id,
      title: item.title,
      source: item.source,
      text: item.text,
      publishedAt: item.publishedAt
    }));

    Logger.log('Processed ' + finalNews.length + ' news items (from ' + allResults.length + ' total results)');
    Logger.log('After filtering: ' + filteredNews.length + ' news items');
    
    // Детальное логирование источников для отладки 
    const sourcesCount = {};
    finalNews.forEach(item => {
      const domain = item.source ? item.source.match(/https?:\/\/([^\/]+)/)?.[1] || 'unknown' : 'unknown';
      sourcesCount[domain] = (sourcesCount[domain] || 0) + 1;
    });
    Logger.log('News by source (final top 10): ' + JSON.stringify(sourcesCount));
    
    // Логируем источники ДО ограничения до 10
    const sourcesCountBeforeLimit = {};
    filteredNews.forEach(item => {
      const domain = item.source ? item.source.match(/https?:\/\/([^\/]+)/)?.[1] || 'unknown' : 'unknown';
      sourcesCountBeforeLimit[domain] = (sourcesCountBeforeLimit[domain] || 0) + 1;
    });
    Logger.log('News by source (before limit 10): ' + JSON.stringify(sourcesCountBeforeLimit));
    Logger.log('Total news in queue: ' + finalNews.length);

    return output({ 
      status: 'ok', 
      news: finalNews
    });

  } catch (err) {
    Logger.log('searchNews error: ' + err.toString());
    Logger.log('Stack: ' + err.stack);
    return output({ 
      status: 'error', 
      message: 'Search error: ' + err.toString() 
    });
  }
}

/* =========================
   SCRAPE FULL TEXT VIA FIRECRAWL
========================= */

/* =========================
   СПЕЦИФИЧНАЯ ОБРАБОТКА ДЛЯ КАЖДОГО ИСТОЧНИКА 
========================= */

/**
 * Очищает текст для kommersant.ru
 * Специфичные правила для Коммерсантъ
 */
function cleanKommersantText(text) {
  if (!text) return '';
  
  // СПЕЦОБРЕЗКА ХВОСТА "Поделиться Поделиться Скопировать ссылку" и всего, что идёт после него.
  // Используем регэксп с \s+, т.к. между словами могут быть переносы/несколько пробелов (2026-02-06).
  var shareTailRegex = /Поделиться\s+Поделиться\s+Скопировать\s+ссылку/;
  var shareIdx = text.search(shareTailRegex);
  if (shareIdx !== -1) {
    text = text.substring(0, shareIdx);
  }
  
  const lines = text.split('\n');
  
  // Общие маркеры навигации
  const junkSectionMarkers = [
    'меню сайта', 'закрыть', 'коммерсантъ» для android', 'коммерсант для android',
    'новости компаний', 'закрыть ленту', 'оставаясь на сайте', 'правила использования куки',
    'скопировать ссылку', 'самые важные события дня', 'поделиться', 'вконтакте', 'telegram',
    'twitter', 'одноклассники', 'whatsapp'
  ];
  
  function isJunkSectionHeader(line) {
    var t = line.trim().toLowerCase();
    if (t.startsWith('#### ') && /####\s*\d{1,2}:\d{2}/.test(line.trim())) return true;
    if (!t.startsWith('#')) return false;
    return junkSectionMarkers.some(function(m) { return t.indexOf(m) !== -1; });
  }
  
  function isLinkOnlyLine(line) {
    var t = line.trim();
    if (/^\s*[-*]\s*\[[^\]]+\]\(https?:\S+\)\s*$/.test(line)) return true;
    if (/^\s*\[[^\]]+\]\(https?:\S+\)\s*$/.test(line)) return true;
    if (/^####\s*\d{1,2}:\d{2}/.test(t)) return true;
    return false;
  }
  
  function isLinkHeavyOrJunkLine(line) {
    var t = line.trim();
    if (!t) return true;
    if (/^закрыть\s+меню$/i.test(t)) return true;
    var linkMatches = t.match(/\]\(https?:\S+\)/g);
    if (linkMatches && linkMatches.length >= 2) return true;
    if (linkMatches && linkMatches.length >= 1 && t.length < 80) {
      var withoutLinks = t.replace(/\[[^\]]*\]\(https?:\S+\)/g, '').trim();
      if (withoutLinks.length < 15) return true;
    }
    return false;
  }
  
  function isContentLine(line) {
    var t = line.trim();
    if (t.length < 20) return false;
    if (/^[А-Яа-я]{5,20}\d{1,2}\s+[А-Яа-я]+\s+\d{4}/.test(t)) return false;
    if (/^\d+\s*карточек/.test(t.toLowerCase())) return false;
    if (/^\d+\.\s*###/.test(t)) return false;
    if (/^\d+\.\s*###\s+/.test(t)) return false;
    if (/^\d{1,2}\.\d{1,2}\.\d{4}/.test(t)) return true;
    if (t.startsWith('#')) return false;
    if (isLinkOnlyLine(line)) return false;
    if (junkSectionMarkers.some(function(m) { return t.toLowerCase().indexOf(m) !== -1; })) return false;
    return true;
  }
  
  // ШАГ 1: Удаляем строки из ссылок
  var withoutLinkOnly = lines.filter(function(line) {
    return !isLinkOnlyLine(line) && !isLinkHeavyOrJunkLine(line);
  });
  
  // ШАГ 2: Пропускаем блоки навигации
  var inJunkBlock = false;
  var passedLines = [];
  for (var i = 0; i < withoutLinkOnly.length; i++) {
    var line = withoutLinkOnly[i];
    if (isJunkSectionHeader(line)) {
      inJunkBlock = true;
      continue;
    }
    if (inJunkBlock) {
      if (isContentLine(line)) inJunkBlock = false;
      else continue;
    }
    passedLines.push(line);
  }
  
  // ШАГ 3: Начало статьи
  var startIndex = -1;
  for (var j = 0; j < passedLines.length; j++) {
    var line = passedLines[j];
    var trimmed = line.trim();
    if (/^[А-Яа-я]{5,20}\d{1,2}\s+[А-Яа-я]+\s+\d{4}/.test(trimmed)) {
      continue;
    }
    if (isContentLine(line)) {
      startIndex = j;
      Logger.log('CleanKommersant: article start at line ' + j + ': ' + trimmed.substring(0, 50));
      break;
    }
  }
  if (startIndex === -1) startIndex = 0;
  
  // ШАГ 4: Футер - kommersant.ru специфичные маркеры
  var strictFooterMarkers = [
    'самые важные события дня', 'новости компаний', 'закрыть ленту',
    '© ао «коммерсантъ»', 'сетевое издание «коммерсантъ»', 'зарегистрировано федеральной службой',
    'регистрационный номер', 'серия эл № фс77', 'партнерские проекты/материалы',
    'материалы с пометкой «промо»', 'официальное сообщение',
    'на kommersant.ru применяются рекомендательные технологии', 'благотворительный фонд русфонд',
    'kartoteka.ru', 'о «коммерсанте»', 'архив', 'контакты', 'реклама', 'вакансии', 'android',
    'обратная связь', 'правовая информация', 'e-mail рассылки', '18+', 'рейтинг@mail.ru'
  ];
  
  var endIndex = passedLines.length;
  var minContentLength = 12000;
  var currentContentLength = 0;
  
  for (var k = startIndex; k < passedLines.length; k++) {
    currentContentLength += passedLines[k].length;
    var t = passedLines[k].trim().toLowerCase();
    
    // Строгие маркеры футера
    if (currentContentLength >= minContentLength && strictFooterMarkers.some(function(m) { return t.indexOf(m) !== -1; })) {
      if (t.indexOf('источник:') !== -1 && /квартальный|отчет\s|отчёт\s|данные\s|idc|мтс|исследован|аналитик/i.test(t)) {
        continue;
      }
      endIndex = k;
      Logger.log('CleanKommersant: Found footer marker "' + t.substring(0, 50) + '" at line ' + k);
      break;
    }
    
    // СПЕЦИАЛЬНАЯ ОБРАБОТКА: Имя автора и заголовки других статей
    if (currentContentLength >= minContentLength) {
      const isAuthorName = /^[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+$/.test(t) && t.length < 50 && t.length > 5;
      
      if (isAuthorName) {
        let foundOtherArticles = false;
        for (let nextIdx = k + 1; nextIdx < Math.min(k + 4, passedLines.length); nextIdx++) {
          const nextLine = passedLines[nextIdx].trim();
          if ((nextLine.startsWith('### ') || nextLine.startsWith('## ')) && 
              (nextLine.includes('kommersant.ru/doc/') || nextLine.includes('myweekend.ru/doc/') || 
               nextLine.match(/^##\s+\[/))) {
            foundOtherArticles = true;
            break;
          }
          if (nextLine.toLowerCase().includes('самые важные события дня')) {
            foundOtherArticles = true;
            break;
          }
        }
        
        if (foundOtherArticles) {
          endIndex = k;
          Logger.log('CleanKommersant: Found author name "' + t + '" followed by other articles, cutting at line ' + k);
          break;
        }
      }
      
      // Заголовки других статей
      if ((t.startsWith('### ') || t.startsWith('## ')) && 
          (t.includes('kommersant.ru/doc/') || t.includes('myweekend.ru/doc/') || t.match(/^##\s+\[/))) {
        endIndex = k;
        Logger.log('CleanKommersant: Found other article header "' + t.substring(0, 50) + '" at line ' + k);
        break;
      }
    }
    
    // Разделитель
    if (currentContentLength >= minContentLength && /^[\*\-_]{3,}$/.test(t)) { 
      endIndex = k; 
      Logger.log('CleanKommersant: Found separator at line ' + k);
      break; 
    }
  }
  
  // Проверка минимальной длины
  var finalContentLength = 0;
  for (var m = startIndex; m < endIndex; m++) {
    finalContentLength += passedLines[m].length;
  }
  if (finalContentLength < 7000 && endIndex < passedLines.length) {
    Logger.log('WARNING: Cleaned text too short (' + finalContentLength + ' chars). Not cutting footer.');
    endIndex = passedLines.length;
  }
  
  var contentLines = passedLines.slice(startIndex, endIndex);
  var cleaned = contentLines.join('\n');
  
  // ШАГ 5: Паттерны для удаления (kommersant.ru специфичные)
  var removePatterns = [
    /Новости компанийВсе[\s\S]*?Подробнее/gi,
    /Новости компаний Все[\s\S]*?Подробнее/gi,
    /\n*Новости компаний\n+(Загрузка новости\.\.\.\n*)+/gi,
    /##\s+\d{2}\.\d{2}\.\d{4}[\s\S]{0,200}?\]\(https?:\/\/www\.kommersant\.ru\/doc\/\d+\)/gi,
    /####\s+\[[^\]]+\]\(https?:\/\/www\.kommersant\.ru\/doc\/\d+[^\)]*\)/gi,
    /##\s+\[[^\]]+\]\(https?:\/\/www\.kommersant\.ru\/doc\/\d+[^\)]*\)/gi,
    /##\s+\[[^\]]+\]\(https?:\/\/www\.myweekend\.ru\/doc\/\d+[^\)]*\)/gi,
    /###\s+«[^»]+»[\s\S]{0,100}?/gi,
    /Благотворительный фонд Русфонд[\s\S]*?Подробнее/gi,
    /^[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+$/gm,  // Имя автора
    /^в\s+[а-яё\s]+$/gim,  // Контекст после автора
    /^###\s+[А-ЯЁа-яё\s]+$/gm,  // Заголовки других статей
    /Самые важные события дня[\s\S]*?рассылке[\s\S]*?Коммерсантъ[\s\S]*?$/gi
  ];
  removePatterns.forEach(function(pattern) { cleaned = cleaned.replace(pattern, ''); });
  
  // ШАГ 6: Фильтр строк (kommersant.ru специфичные)
  var cleanedLines = cleaned.split('\n');
  var filteredLines = cleanedLines.filter(function(line) {
    var trimmed = line.trim().toLowerCase();
    if (trimmed.length < 3) return false;
    if (/^##\s+\d{2}\.\d{2}\.\d{4}$/.test(trimmed)) return false;
    if (/^####\s+\[/.test(trimmed) && trimmed.indexOf('kommersant.ru/doc/') !== -1) return false;
    if (trimmed.toLowerCase() === 'закрыть ленту') return false;
    if (/^##\s+\[/.test(trimmed) && trimmed.indexOf('kommersant.ru/doc/') !== -1) return false;
    if (/^###\s+«/.test(trimmed) && trimmed.length < 150) return false;
    if (trimmed.indexOf('новости компанийвсе') !== -1 || trimmed.indexOf('новости компаний все') !== -1) return false;
    if (trimmed === 'новости компаний') return false;
    if (/^загрузка новости\.\.\.?$/i.test(trimmed)) return false;
    if (trimmed.indexOf('благотворительный фонд русфонд') !== -1) return false;
    if (trimmed === 'kartoteka.ru') return false;
    return true;
  });
  
  cleaned = filteredLines.join('\n');
  cleaned = cleaned.trim();
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  
  Logger.log('CleanKommersant: Cleaned text length: ' + cleaned.length + ' chars (original: ' + text.length + ')');
  return cleaned;
}

/**
 * Очищает текст для 3dnews.ru
 * Специфичные правила: обрезка хвоста (форма репорта ошибки, «Вечерний 3DNews», «Материалы по теме», «Постоянный URL»)
 */
function clean3dnewsText(text) {
  if (!text) return '';

  // Специальная обрезка хвоста после основной новости.
  // Варианты хвоста (2026-02-06):
  // - "Если вы заметили ошибку — выделите ее мышью и нажмите CTRL+ENTER."
  // - блок рассылки "Вечерний 3DNews"
  // - "Материалы по теме"
  // - "Постоянный URL:"
  var tailMarkers = [
    'Если вы заметили ошибку — выделите ее мышью и нажмите CTRL+ENTER.',
    'Если вы заметили ошибку — выделите ее мышью и нажмите CTRL+ENTER',
    'Вечерний 3DNews',
    'Материалы по теме',
    'Постоянный URL:'
  ];

  var cutIndex = -1;
  for (var i = 0; i < tailMarkers.length; i++) {
    var marker = tailMarkers[i];
    var idx = text.indexOf(marker);
    if (idx !== -1 && (cutIndex === -1 || idx < cutIndex)) {
      cutIndex = idx;
    }
  }

  if (cutIndex !== -1) {
    text = text.substring(0, cutIndex);
  }

  // Далее применяем общую очистку (навигация, сервисные блоки и т.п.)
  return cleanScrapedTextOld(text);
}

/**
 * Общая функция очистки текста (для источников без специфичной обработки)
 */
function cleanGenericText(text) {
  // Используем общую функцию очистки
  return cleanScrapedTextOld(text);
}

/**
 * Очищает текст от навигации, меню, рекламы и других нерелевантных блоков.
 * Учитывает Коммерсантъ и др.: меню сайта, лента, новости компаний, списки ссылок.
 * 
 * ВАЖНО: Эта функция теперь является роутером - определяет источник и вызывает
 * соответствующую специфичную функцию для каждого источника.
 * 
 * @param {string} text - Текст для очистки
 * @param {string} sourceUrl - URL источника (опционально, для определения источника)
 */
function cleanScrapedText(text, sourceUrl) {
  if (!text) return '';
  
  // Если передан URL, определяем источник и вызываем специфичную функцию
  if (sourceUrl) {
    const urlLower = sourceUrl.toLowerCase();
    
    if (urlLower.includes('kommersant.ru')) {
      Logger.log('Using kommersant.ru-specific text cleaning');
      return cleanKommersantText(text);
    } else if (urlLower.includes('3dnews.ru')) {
      Logger.log('Using 3dnews.ru-specific text cleaning');
      return clean3dnewsText(text);
    }
  }
  
  // Если URL не передан или источник не определен - используем общую функцию
  Logger.log('Using generic text cleaning');
  return cleanGenericText(text);
}

/**
 * Старая функция cleanScrapedText (переименована для обратной совместимости)
 * TODO: Постепенно вынести общую логику в cleanGenericText
 */
function cleanScrapedTextOld(text) {
  if (!text) return '';
  
  const lines = text.split('\n');
  
  // Заголовки/блоки, которые считаем навигацией (не начало статьи)
  const junkSectionMarkers = [
    'меню сайта', 'закрыть', 'коммерсантъ» для android', 'коммерсант для android',
    'новости компаний', 'закрыть ленту', 'оставаясь на сайте', 'правила использования куки',
    'скопировать ссылку', 'самые важные события дня', 'поделиться', 'вконтакте', 'telegram',
    'twitter', 'одноклассники', 'whatsapp'
  ];
  
  function isJunkSectionHeader(line) {
    var t = line.trim().toLowerCase();
    if (t.startsWith('#### ') && /####\s*\d{1,2}:\d{2}/.test(line.trim())) return true; // Лента: #### 07:46...
    if (!t.startsWith('#')) return false;
    return junkSectionMarkers.some(function(m) { return t.indexOf(m) !== -1; });
  }
  
  // Строка — только одна ссылка в формате "- [text](url)" или "#### HH:MM..."
  function isLinkOnlyLine(line) {
    var t = line.trim();
    if (/^\s*[-*]\s*\[[^\]]+\]\(https?:\S+\)\s*$/.test(line)) return true;
    if (/^\s*\[[^\]]+\]\(https?:\S+\)\s*$/.test(line)) return true;
    if (/^####\s*\d{1,2}:\d{2}/.test(t)) return true;
    return false;
  }
  
  // Строка состоит в основном из ссылок: несколько "[text](url)" или "Закрыть меню"
  function isLinkHeavyOrJunkLine(line) {
    var t = line.trim();
    if (!t) return true;
    if (/^закрыть\s+меню$/i.test(t)) return true;
    var linkMatches = t.match(/\]\(https?:\S+\)/g);
    if (linkMatches && linkMatches.length >= 2) return true; // две и больше ссылок в строке
    if (linkMatches && linkMatches.length >= 1 && t.length < 80) {
      var withoutLinks = t.replace(/\[[^\]]*\]\(https?:\S+\)/g, '').trim();
      if (withoutLinks.length < 15) return true; // почти вся строка — ссылки
    }
    return false;
  }
  
  // Строка похожа на начало основного текста (дата или абзац без меню)
  function isContentLine(line) {
    var t = line.trim();
    if (t.length < 20) return false;
    // Пропускаем строки с навигацией (одно слово + дата без пробела)
    if (/^[А-Яа-я]{5,20}\d{1,2}\s+[А-Яа-я]+\s+\d{4}/.test(t)) return false;  // "Технологии18 апреля 2018"
    if (/^\d+\s*карточек/.test(t.toLowerCase())) return false;  // "8карточек•18 апреля 2018, 13:04"
    if (/^\d+\.\s*###/.test(t)) return false;  // "1. ### О чем речь?" - это навигация, не начало статьи
    if (/^\d+\.\s*###\s+/.test(t)) return false;  // "2. ### Что это такое?" - навигация
    if (/^\d{1,2}\.\d{1,2}\.\d{4}/.test(t)) return true; // дата 15.06.2023
    if (t.startsWith('#')) return false;
    if (isLinkOnlyLine(line)) return false;
    if (junkSectionMarkers.some(function(m) { return t.toLowerCase().indexOf(m) !== -1; })) return false;
    return true;
  }
  
  // ШАГ 1: Удаляем строки из ссылок (одна ссылка, несколько ссылок, "Закрыть меню")
  var withoutLinkOnly = lines.filter(function(line) {
    return !isLinkOnlyLine(line) && !isLinkHeavyOrJunkLine(line);
  });
  
  // ШАГ 2: Пропускаем блоки навигации: от заголовка-мусора до первой "контентной" строки
  var inJunkBlock = false;
  var passedLines = [];
  for (var i = 0; i < withoutLinkOnly.length; i++) {
    var line = withoutLinkOnly[i];
    var trimmed = line.trim();
    
    if (isJunkSectionHeader(line)) {
      inJunkBlock = true;
      continue;
    }
    if (inJunkBlock) {
      if (isContentLine(line)) inJunkBlock = false;
      else continue;
    }
    passedLines.push(line);
  }
  
  // ШАГ 3: Начало статьи — первая контентная строка (дата или нормальный абзац), не первый #
  // УЛУЧШЕНИЕ (2026-01-31): Пропускаем навигационные слова в начале (например, "Технологии18 апреля")
  var startIndex = -1;
  for (var j = 0; j < passedLines.length; j++) {
    var line = passedLines[j];
    var trimmed = line.trim();
    
    // Пропускаем строки, которые выглядят как навигация (одно слово + дата без пробела)
    if (/^[А-Яа-я]{5,20}\d{1,2}\s+[А-Яа-я]+\s+\d{4}/.test(trimmed)) {
      Logger.log('CleanScraped: Skipping navigation line: ' + trimmed.substring(0, 50));
      continue;  // Пропускаем строки типа "Технологии18 апреля 2018"
    }
    
    if (isContentLine(line)) {
      startIndex = j;
      Logger.log('CleanScraped: article start at line ' + j + ': ' + trimmed.substring(0, 50));
      break;
    }
  }
  if (startIndex === -1) startIndex = 0;
  
  // ШАГ 4: Футер — обрезаем после маркеров конца статьи
  // УЛУЧШЕНИЕ: Разделяем маркеры на строгие (точно футер) и мягкие (может быть в тексте)
  var strictFooterMarkers = [
    'материалы по теме', 'поделитьсяподписывайтесь', 'это кнопка согласия', 'подписывайтесь на наш',
    'читайте также', 'смотрите также', 'рекомендуем', 'популярное', 'последние новости',
    'источник:', 'фото на обложке', 'читать далее', 'продолжение статьи',
    'новости компаний', 'закрыть ленту', 'самые важные события дня',
    'о компании', 'редакция', 'о технологиях рекомендаций', 'политика конфиденциальности',
    'условия использования сервисов', 'условия использования материалов', 'реклама',
    'mail', 'о компании', 'редакция', 'еще',  // "Еще" в конце страницы
    // kommersant.ru специфичные маркеры (только строгие футеры)
    // УЛУЧШЕНИЕ (2026-02-01): Убраны маркеры, которые могут встречаться в середине статьи
    '© ао «коммерсантъ»', 'сетевое издание «коммерсантъ»', 'зарегистрировано федеральной службой',
    'регистрационный номер', 'серия эл № фс77', 'партнерские проекты/материалы',
    'новости компаний', 'материалы с пометкой «промо»', 'официальное сообщение',
    'на kommersant.ru применяются рекомендательные технологии', 'благотворительный фонд русфонд',
    'kartoteka.ru', 'о «коммерсанте»', 'архив', 'контакты', 'реклама', 'вакансии', 'android',
    'обратная связь', 'правовая информация', 'e-mail рассылки', '18+', 'рейтинг@mail.ru',
    'новости компанийвсе', 'новости компаний все', 'закрыть ленту',  // Строгие маркеры футера
    // 3dnews.ru специфичные маркеры
    'сегодня', '18+', 'о сайте', 'реклама', 'рассылка', 'контакты', 'новости hardware',
    'самое интересное в обзорах', 'итоги 2025-го', 'обзор', 'твиттер 3dnews', 'twitter.com/3d_news',
    'во время посещения сайта', 'использованием нами файлов cookie', 'метрических программ',
    'пользовательским соглашением', 'даёте согласие на обработку', 'трансграничную передачу',
    'персональных данных', 'понятно', 'защищено curator', 'электронное периодическое издание',
    'свидетельство о регистрации', 'при цитировании документа', 'полное заимствование документа',
    'яндекс.метрика', 'контакты', 'поиск', 'о сайте', 'soft', 'hard', 'тренды',
    // 3dnews.ru специфичные маркеры (только строгие футеры, не элементы в середине статьи)
    // УЛУЧШЕНИЕ (2026-02-01): Убраны маркеры, которые могут встречаться в середине статьи
    'защищено curator', 'электронное периодическое издание', 'свидетельство о регистрации',
    'при цитировании документа', 'полное заимствование документа', 'яндекс.метрика',
    'во время посещения сайта', 'использованием нами файлов cookie', 'метрических программ',
    'даёте согласие на обработку', 'трансграничную передачу', 'персональных данных', 'понятно',
    'о сайте контакты рассылка реклама копирайт поиск пользовательское соглашение'  // Футер навигации (одна строка)
  ];
  var endIndex = passedLines.length;
  // Ищем строгие маркеры футера, но только если они в конце текста (после минимум 1000 символов)
  // УЛУЧШЕНИЕ: Увеличено до 12000 символов для длинных статей (kommersant.ru, 3dnews.ru)
  var minContentLength = 12000;  // Минимум контента перед обрезкой (увеличено с 8000)
  var currentContentLength = 0;
  for (var k = startIndex; k < passedLines.length; k++) {
    currentContentLength += passedLines[k].length;
    var t = passedLines[k].trim().toLowerCase();
    
    // Если нашли строгий маркер И уже набрали минимум контента - обрезаем
    if (currentContentLength >= minContentLength && strictFooterMarkers.some(function(m) { return t.indexOf(m) !== -1; })) {
      // Исключение (2026-02-02): "Источник: квартальный отчет IDC" и т.п. — подпись к таблице/графику, не конец статьи (special.kommersant.ru)
      // Не обрезаем, если в строке с "источник:" указан отчёт/данные (квартальный отчёт, IDC, МТС и т.д.)
      if (t.indexOf('источник:') !== -1 && /квартальный|отчет\s|отчёт\s|данные\s|idc|мтс|исследован|аналитик/i.test(t)) {
        Logger.log('CleanScraped: Skipping "источник:" line (table/figure caption): ' + t.substring(0, 60));
        continue;
      }
      // Исключение (2026-02-02): "обзор" в тексте статьи (3dnews.ru) — "Распознавание образов", "учебник", "в обзорах" в длинных строках
      // Не обрезаем, если строка длинная и похожа на контент статьи (учебник, книга, pattern recognition)
      if (t.indexOf('обзор') !== -1 && (t.length > 120 || /учебник|книг|книга|pattern\s*recognition|образов\s+и\s+машинн/i.test(t))) {
        Logger.log('CleanScraped: Skipping "обзор" line (article content): ' + t.substring(0, 60));
        continue;
      }
      endIndex = k;
      Logger.log('CleanScraped: Found footer marker "' + t.substring(0, 50) + '" at line ' + k + ' (content length: ' + currentContentLength + ')');
      break;
    }
    
    // СПЕЦИАЛЬНАЯ ОБРАБОТКА ДЛЯ KOMMERSANT.RU (2026-02-05)
    // После основного текста обычно идет имя автора, затем заголовки других статей
    // Обрезаем после имени автора, если дальше идут заголовки других статей (### или ## с ссылками)
    if (currentContentLength >= minContentLength) {
      // Проверяем, не является ли текущая строка именем автора (одна строка с именем и фамилией)
      // Имя автора обычно: "Имя Фамилия" или "Имя Фамилия\nв контексте"
      const isAuthorName = /^[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+$/.test(t) && t.length < 50 && t.length > 5;
      
      if (isAuthorName) {
        // Проверяем следующие 2-3 строки - если там заголовки других статей (### или ## с ссылками), обрезаем
        let foundOtherArticles = false;
        for (let nextIdx = k + 1; nextIdx < Math.min(k + 4, passedLines.length); nextIdx++) {
          const nextLine = passedLines[nextIdx].trim();
          // Заголовок другой статьи: ### или ## с ссылкой на kommersant.ru/doc/ или myweekend.ru/doc/
          if ((nextLine.startsWith('### ') || nextLine.startsWith('## ')) && 
              (nextLine.includes('kommersant.ru/doc/') || nextLine.includes('myweekend.ru/doc/') || 
               nextLine.match(/^##\s+\[/))) {
            foundOtherArticles = true;
            break;
          }
          // Или футер "Самые важные события дня"
          if (nextLine.toLowerCase().includes('самые важные события дня')) {
            foundOtherArticles = true;
            break;
          }
        }
        
        if (foundOtherArticles) {
          endIndex = k;
          Logger.log('CleanScraped: Found author name "' + t + '" followed by other articles, cutting at line ' + k);
          break;
        }
      }
      
      // Также обрезаем при заголовках других статей (### или ## с ссылками), если уже достаточно контента
      if ((t.startsWith('### ') || t.startsWith('## ')) && 
          (t.includes('kommersant.ru/doc/') || t.includes('myweekend.ru/doc/') || t.match(/^##\s+\[/))) {
        endIndex = k;
        Logger.log('CleanScraped: Found other article header "' + t.substring(0, 50) + '" at line ' + k + ', cutting');
        break;
      }
    }
    
    // Разделитель из 3+ символов - тоже футер (только если достаточно контента)
    if (currentContentLength >= minContentLength && /^[\*\-_]{3,}$/.test(t)) { 
      endIndex = k; 
      Logger.log('CleanScraped: Found separator at line ' + k + ' (content length: ' + currentContentLength + ')');
      break; 
    }
  }
  
  // ДОПОЛНИТЕЛЬНАЯ ПРОВЕРКА Если текст получился слишком короткий после обрезки,
  // возможно, мы обрезали слишком рано - не обрезаем, если итоговый текст < 7000 символов
  // УЛУЧШЕНИЕ: Увеличено до 7000 для длинных статей (kommersant.ru, 3dnews.ru)
  var finalContentLength = 0;
  for (var m = startIndex; m < endIndex; m++) {
    finalContentLength += passedLines[m].length;
  }
  if (finalContentLength < 7000 && endIndex < passedLines.length) {
    Logger.log('WARNING: Cleaned text too short (' + finalContentLength + ' chars). Not cutting footer - might be too aggressive.');
    endIndex = passedLines.length;  // Не обрезаем, оставляем весь текст
  }
  
  var contentLines = passedLines.slice(startIndex, endIndex);
  var cleaned = contentLines.join('\n');
  
  // ШАГ 5: Паттерны для удаления в тексте
  var removePatterns = [
    /Pull to refresh/gi, /Feed settings/gi, /Rating limit/gi, /Level of difficulty/gi, /AllEasyMediumHard/gi,
    /sign in|sign up|log in|log out/gi, /Add to bookmarks/gi,
    /Total votes.*?↑.*?↓.*?\+\d+/gi, /Reading time.*?min/gi, /Reach and readers.*?\d+K?/gi,
    /Comments\d+/gi, /\[Read more\]/gi, /Your account/gi, /Language settings/gi,
    /© \d{4}.*?(Habr|RB\.RU)/gi, /Sections.*?Articles.*?News.*?Hubs/gi,
    /Information.*?How it works.*?For authors/gi, /Services.*?Corporate blogs.*?Advertising/gi,
    /Apply|Close|Dropdown|Warning/gi, /\*\*\*/g, /_{3,}/g,
    /\[!\[.*?\]\(.*?\)\]\(.*?\)/g, /\[.*?\]\("".*?""\)/g,
    /!\[\]\(https?:\S+\)/g,  // картинки вида ![](url) — реклама, баннеры
    /!\[\s*\]\(https?:\S+\)/g,  // пустые картинки ![ ](url) - удаляем все
    /!\[[^\]]{0,30}\]\(https?:\/\/resizer\.mail\.ru\/[^\)]+\)/gi,  // картинки с коротким описанием (до 30 символов) - удаляем
    // НЕ удаляем картинки с длинным описанием (могут быть частью статьи)
    // 3dnews.ru специфичные паттерны
    /Сегодня\s+\d{1,2}\s+[А-Яа-я]+\s+\d{4}/gi,  // "Сегодня 01 февраля 2026"
    /\*\*18\+\*\*/gi,  // "**18+**"
    /\[Твиттер 3DNews\]\(https?:\/\/twitter\.com\/3D_News[^\)]+\)/gi,  // Ссылка на Twitter
    /\|\s*\|/g,  // Таблицы "|     |"
    /\|[\s\-]+\|/g,  // Разделители таблиц "| --- | --- |"
    /Новости Hardware[\s\S]*?Самое интересное в обзорах/gi,  // Блок навигации
    /Самое интересное в обзорах[\s\S]*?\[!\[/gi,  // Блок "Самое интересное" до картинок
    /\[!\[[^\]]+\]\(https?:\/\/cdn\.3dnews\.ru\/[^\)]+\)[\s\S]{0,200}?\]\(https?:\/\/3dnews\.ru\/[^\)]+\)/gi,  // Ссылки на другие статьи с картинками
    /О сайте Контакты Рассылка Реклама Копирайт Поиск Пользовательское соглашение/gi,  // Футер навигации
    /Защищено CURATOR[\s\S]*$/gi,  // Все после "Защищено CURATOR"
    /Во время посещения сайта[\s\S]{0,500}?Понятно/gi,  // Блок про cookies
    /©\s+\d{4}—\d{4}[\s\S]*?3DNews[\s\S]*$/gi,  // Копирайт и всё после
    // kommersant.ru специфичные паттерны
    /Новости компанийВсе[\s\S]*?Подробнее/gi,  // Блок "Новости компаний" до "Подробнее"
    /Новости компаний Все[\s\S]*?Подробнее/gi,  // Блок "Новости компаний Все" до "Подробнее"
    /\n*Новости компаний\n+(Загрузка новости\.\.\.\n*)+/gi,  // Блок "Новости компаний" + повтор "Загрузка новости..." (kommersant.ru) (2026-02-02)
    /##\s+\d{2}\.\d{2}\.\d{4}[\s\S]{0,200}?\]\(https?:\/\/www\.kommersant\.ru\/doc\/\d+\)/gi,  // Блоки с датами и ссылками на другие статьи
    /####\s+\[[^\]]+\]\(https?:\/\/www\.kommersant\.ru\/doc\/\d+[^\)]*\)/gi,  // Ссылки на другие статьи kommersant.ru
    /Закрыть Ленту/gi,  // "Закрыть Ленту"
    /##\s+\[[^\]]+\]\(https?:\/\/www\.kommersant\.ru\/doc\/\d+[^\)]*\)/gi,  // Заголовки других статей
    /##\s+\[[^\]]+\]\(https?:\/\/www\.myweekend\.ru\/doc\/\d+[^\)]*\)/gi,  // Заголовки других статей (myweekend.ru) (2026-02-05)
    /###\s+«[^»]+»[\s\S]{0,100}?/gi,  // Подзаголовки других статей (например, "### «Дзен» отказался от счетчиков")
    /Благотворительный фонд Русфонд[\s\S]*?Подробнее/gi,  // Блок от "Благотворительный фонд Русфонд" до "Подробнее"
    // УЛУЧШЕНИЕ (2026-02-05): Удаляем контекст после имени автора и заголовки других статей
    /^[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+$/gm,  // Имя автора (одна строка)
    /^в\s+[а-яё\s]+$/gim,  // Контекст после автора (например, "в сервисах Google")
    /^###\s+[А-ЯЁа-яё\s]+$/gm,  // Заголовки других статей (### Заголовок)
    /Самые важные события дня[\s\S]*?рассылке[\s\S]*?Коммерсантъ[\s\S]*?$/gi  // Футер "Самые важные события дня в рассылке «Коммерсантъ»"
  ];
  removePatterns.forEach(function(pattern) { cleaned = cleaned.replace(pattern, ''); });
  
  // ШАГ 6: Фильтр строк — убираем оставшиеся навигационные
  var cleanedLines = cleaned.split('\n');
  var filteredLines = cleanedLines.filter(function(line) {
    var trimmed = line.trim().toLowerCase();
    if (trimmed.length < 3) return false;
    if (/^(article|news|post|rating|like|dislike|\d+|\[\d+\])$/i.test(trimmed)) return false;
    if (trimmed.indexOf('dropdown') !== -1 || trimmed.indexOf('checkbox') !== -1) return false;
    if (trimmed.indexOf('corporate blog') !== -1 || trimmed.indexOf('tutorial') !== -1) return false;
    if (/^(views?|reach)\s*\d+k?$/i.test(trimmed)) return false;
    if (/^(facebook|twitter|telegram|viber|вконтакте|поделиться)/i.test(trimmed)) return false;
    if (trimmed.indexOf('скопировать ссылку') !== -1) return false;
    if (trimmed.indexOf('оставаясь на сайте') !== -1 || trimmed.indexOf('правила использования куки') !== -1) return false;
    if (/^\d+\s+\d+\s*мин\./.test(trimmed)) return false; // "171  1 мин."
    if (/^\d+[kк]?\s+\d+\s*мин\./.test(trimmed)) return false; // "10K  7 мин."
    if (/^\[.*?\]\(https?:\/\/.*?\)$/.test(line.trim())) return false;
    if (trimmed.indexOf('xmail.ru') !== -1 || trimmed.indexOf('от российского сервиса mail') !== -1) return false;
    if (trimmed === 'перейти') return false;
    if (trimmed.indexOf('об эксперте:') !== -1 && trimmed.length < 100) return false; // короткие строки "Об эксперте: ..."
    // Дополнительные фильтры для рекламы
    if (trimmed === 'ещё' || trimmed === '**ещё**') return false;
    if (trimmed === 'реклама' || trimmed === '**реклама**') return false;
    if (trimmed.indexOf('сексуальный подтекст') !== -1) return false;
    if (trimmed.indexOf('нарушение закона') !== -1) return false;
    if (trimmed === 'мошеннический сайт') return false;
    if (trimmed === 'скрыть') return false;
    if (trimmed === 'другая причина') return false;
    if (trimmed.indexOf('mail.ruреклама') !== -1) return false;
    if (trimmed.indexOf('r.mradx.net') !== -1) return false;  // Рекламные картинки
    if (trimmed.indexOf('r.mail.ru/redir') !== -1) return false;  // Рекламные ссылки
    // 3dnews.ru специфичные строки
    if (/^сегодня\s+\d{1,2}\s+[а-я]+\s+\d{4}/i.test(trimmed)) return false;  // "Сегодня 01 февраля 2026"
    if (trimmed === '18+' || trimmed === '**18+**') return false;
    if (trimmed.indexOf('твиттер 3dnews') !== -1 || trimmed.indexOf('twitter.com/3d_news') !== -1) return false;
    if (/^\|\s*\|/.test(trimmed)) return false;  // Таблицы "|     |"
    if (/^\|[\s\-]+\|/.test(trimmed)) return false;  // Разделители таблиц
    if (trimmed.indexOf('новости hardware') !== -1) return false;
    if (trimmed.indexOf('самое интересное в обзорах') !== -1) return false;
    if (trimmed.indexOf('итоги 2025-го') !== -1 || trimmed.indexOf('обзор') !== -1 && trimmed.length < 150) return false;  // Короткие ссылки на обзоры
    if (trimmed.indexOf('cdn.3dnews.ru') !== -1) return false;  // Картинки из CDN
    if (trimmed.indexOf('о сайте') !== -1 && trimmed.length < 50) return false;
    if (trimmed.indexOf('контакты') !== -1 && trimmed.length < 30) return false;
    if (trimmed.indexOf('рассылка') !== -1 && trimmed.length < 30) return false;
    if (trimmed.indexOf('реклама') !== -1 && trimmed.length < 30) return false;
    if (trimmed.indexOf('во время посещения сайта') !== -1) return false;
    if (trimmed.indexOf('использованием нами файлов cookie') !== -1) return false;
    if (trimmed.indexOf('даёте согласие на обработку') !== -1) return false;
    if (trimmed === 'понятно') return false;
    if (trimmed.indexOf('защищено curator') !== -1) return false;
    if (trimmed.indexOf('электронное периодическое издание') !== -1) return false;
    if (trimmed.indexOf('свидетельство о регистрации') !== -1) return false;
    if (trimmed.indexOf('при цитировании документа') !== -1) return false;
    if (trimmed.indexOf('яндекс.метрика') !== -1) return false;
    if (trimmed === 'soft' || trimmed === 'hard' || trimmed === 'тренды') return false;
    // kommersant.ru специфичные строки
    if (/^##\s+\d{2}\.\d{2}\.\d{4}$/.test(trimmed)) return false;  // "## 30.01.2026"
    if (/^####\s+\[/.test(trimmed) && trimmed.indexOf('kommersant.ru/doc/') !== -1) return false;  // Ссылки на другие статьи
    if (trimmed.toLowerCase() === 'закрыть ленту') return false;
    if (/^##\s+\[/.test(trimmed) && trimmed.indexOf('kommersant.ru/doc/') !== -1) return false;  // Заголовки других статей
    if (/^###\s+«/.test(trimmed) && trimmed.length < 150) return false;  // Подзаголовки других статей
    if (trimmed.indexOf('новости компанийвсе') !== -1 || trimmed.indexOf('новости компаний все') !== -1) return false;
    if (trimmed === 'новости компаний') return false;  // Заголовок блока "Новости компаний" (kommersant.ru) (2026-02-02)
    if (/^загрузка новости\.\.\.?$/i.test(trimmed)) return false;  // Повторяющиеся строки "Загрузка новости..." (kommersant.ru) (2026-02-02)
    if (trimmed.indexOf('благотворительный фонд русфонд') !== -1) return false;
    if (trimmed === 'kartoteka.ru') return false;
    return true;
  });
  
  cleaned = filteredLines.join('\n');
  cleaned = cleaned.trim();
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  
  Logger.log('Cleaned text length: ' + cleaned.length + ' chars (original: ' + text.length + ')');
  return cleaned;
}

/* =========================
   URL VALIDATION
========================= */
function checkUrlAvailability(url) {
  try {
    Logger.log('Checking URL availability: ' + url);
    
    // Делаем HEAD-запрос для проверки доступности URL
    const options = {
      method: 'head',
      muteHttpExceptions: true,
      followRedirects: true,
      timeout: 5000 // 5 секунд таймаут
    };
    
    const response = UrlFetchApp.fetch(url, options);
    const statusCode = response.getResponseCode();
    
    Logger.log('URL status code: ' + statusCode);
    
    // Считаем URL доступным, если код 2xx или 3xx
    if (statusCode >= 200 && statusCode < 400) {
      Logger.log('✅ URL is available');
      return true;
    }
    
    Logger.log('❌ URL returned error status: ' + statusCode);
    return false;
    
  } catch (err) {
    Logger.log('❌ Error checking URL availability: ' + err.toString());
    // Если проверка не удалась (timeout, network error), считаем URL недоступным
    return false;
  }
}

/**
 * Возвращает URL без параметров, которые часто дают фрагмент страницы вместо полной статьи
 * (напр. is_ajax=1 может возвращать короткий фрагмент).
 */
function getCanonicalScrapeUrl(url) {
  if (!url || url.indexOf('?') === -1) return url;
  var base = url.split('?')[0];
  var q = url.substring(url.indexOf('?') + 1);
  var params = q.split('&').filter(function(p) {
    var name = p.split('=')[0];
    return name !== 'is_ajax' && name.indexOf('utm_') !== 0;
  });
  return params.length ? base + '?' + params.join('&') : base;
}

function scrapeFullText(url) {
  try {
    // Временно отключена проверка URL для отладки
    // if (!checkUrlAvailability(url)) {
    //   Logger.log('⚠️ URL is not available (404, timeout, or error). Skipping scrape.');
    //   return null;
    // }
    
    const apiKey = PropertiesService.getScriptProperties().getProperty('FIRECRAWL_API_KEY');
    if (!apiKey) {
      Logger.log('ERROR: Firecrawl API key not found for scraping');
      return null;
    }

    Logger.log('Scraping full text from URL: ' + url);

    const payload = {
      url: url,
      formats: ["markdown"],
      onlyMainContent: true
    };

    const response = UrlFetchApp.fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'post',
      contentType: 'application/json',
      headers: { 
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Accept-Language': 'ru-RU,ru;q=0.9'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const statusCode = response.getResponseCode();
    const text = response.getContentText();
    
    Logger.log('Scrape API response code: ' + statusCode);

    if (statusCode !== 200) {
      Logger.log('Scrape API error: ' + statusCode + ' - ' + text.substring(0, 500));
      return null;
    }

    let data;
    try { 
      data = JSON.parse(text); 
    } catch (e) { 
      Logger.log('Scrape JSON parse error: ' + e.toString());
      return null; 
    }

    // Извлекаем полный текст из ответа
    let fullText = data.data?.markdown || data.data?.content || data.markdown || data.content || '';
    
    if (fullText) {
      // Проверяем, что это не страница ошибки
      const errorIndicators = [
        // Английские
        'Whoops!',
        'Something went wrong',
        '404 page not found',
        'Page not found',
        'Error 404',
        '404 Not Found',
        'The page you are looking for',
        'This page does not exist',
        // Русские. НЕ «Ой!» отдельно — часто в обычных статьях 
        'Что-то пошло не так',
        'Страница не найдена',
        'страница не найдена',
        'Запрашиваемая страница не найдена',
        'запрашиваемая вами страница не найдена',
        '# 404',
        'Ошибка 404',
        'ошибка 404',
        'Страница удалена',
        'страница удалена',
        'неправильно набран ее адрес',
        'Возможно, она удалена'
      ];
      
      // Проверяем, что это не лента новостей вместо статьи
      const feedPageIndicators = [
        '# My feedType',
        'ArticlesPostsNews',
        'All≥0≥10≥25≥50≥100',
        'To set up filters',
        'Pull to refresh',
        'Feed settings'
      ];
      
      const lowerText = fullText.toLowerCase();
      const first500 = fullText.substring(0, 500); // Проверяем начало текста
      
      const hasError = errorIndicators.some(indicator => 
        lowerText.includes(indicator.toLowerCase())
      );
      
      const isFeedPage = feedPageIndicators.some(indicator =>
        first500.includes(indicator)
      );
      
      if (hasError) {
        const preview = fullText.substring(0, 200);
        Logger.log('WARNING: Scraped content appears to be an error page. Skipping.');
        Logger.log('Error indicators found in text. First 200 chars: ' + preview);
        return null;
      }
      
      if (isFeedPage) {
        const preview = fullText.substring(0, 200);
        Logger.log('WARNING: Scraped content appears to be a feed/listing page instead of article. Skipping.');
        Logger.log('Feed indicators found in text. First 200 chars: ' + preview);
        return null;
      }
      
      // Проверяем язык текста (должен быть русский)
      // Пропускаем первые 1000 символов (навигация/шапка сайта)
      // и проверяем основной контент, чтобы избежать ложных срабатываний из-за английских элементов в шапке
      const skipHeader = Math.min(1000, Math.floor(fullText.length * 0.1)); // Пропускаем 10% или 1000 символов
      const contentStart = skipHeader;
      const contentEnd = Math.min(contentStart + 2000, fullText.length); // Проверяем следующие 2000 символов
      const sample = fullText.substring(contentStart, contentEnd);
      
      const cyrillicCount = (sample.match(/[а-яёА-ЯЁ]/g) || []).length;
      const latinCount = (sample.match(/[a-zA-Z]/g) || []).length;
      
      Logger.log('Language check: skipped ' + skipHeader + ' chars, checking ' + sample.length + ' chars. Cyrillic: ' + cyrillicCount + ', Latin: ' + latinCount);
      
      // УЛУЧШЕННЫЙ ФИЛЬТР: Технические статьи могут содержать много английских терминов
      // Проверяем только если латинских букв В 5+ раза больше (было 3x) И их больше 200 (было 100)
      // Это позволяет пропускать технические статьи с английскими терминами (MLOps, AI, ANN и т.д.)
      // И не срабатывать на навигацию сайта
      if (cyrillicCount > 0 && latinCount > cyrillicCount * 5 && latinCount > 200) {
        const preview = fullText.substring(0, 200);
        Logger.log('WARNING: Scraped content appears to be in English (not Russian).');
        Logger.log('Cyrillic: ' + cyrillicCount + ', Latin: ' + latinCount + ' (ratio: ' + (latinCount / cyrillicCount).toFixed(2) + 'x)');
        Logger.log('First 200 chars: ' + preview);
        return null;
      }
      
      Logger.log('Language check passed - Cyrillic: ' + cyrillicCount + ', Latin: ' + latinCount);
      
      // Очистка от навигации и рекламных блоков (передаем URL для определения источника)
      fullText = cleanScrapedText(fullText, url);
      
      // ДОПОЛНИТЕЛЬНАЯ ПРОВЕРКА: Если после очистки остался только мусор (регистрация, реклама),
      // считаем скрапинг неудачным.
      if (fullText && fullText.trim().length > 0) {
        const lowerText = fullText.toLowerCase();
        const junkIndicators = [
          'регистрация', 'войти', '© vk', '1999-2026', 'объявление скрыто',
          'мы используем ваши ответы', 'рекламное объявление', 'скрыть объявление',
          'о рекламодателе', 'скопировать erid', 'не интересует', 'уже приобретено',
          'препятствует просмотру', 'недобросовестная реклама', 'скопируйте данные в почту',
          'xmail.ru', 'от российского сервиса mail'
        ];
        const junkCount = junkIndicators.filter(indicator => lowerText.indexOf(indicator) !== -1).length;
        // Если найдено 3+ маркера мусора и текст короткий (< 1000 символов), считаем это мусором
        if (junkCount >= 3 && fullText.trim().length < 1000) {
          Logger.log('WARNING: After cleaning, text still contains too much junk (' + junkCount + ' indicators). Treating as failed scrape.');
          fullText = null; // Помечаем как неудачный скрапинг
        }
      }
      
      // Проверяем минимальную длину контента (если слишком короткий, возможно это ошибка)
      // Для Telegram: минимум 200 символов, для сайтов: 500 символов 
      const isTelegram = url.toLowerCase().includes('t.me/') || url.toLowerCase().includes('telegram.me/');
      const minContentLength = isTelegram ? 200 : 500;
      
      if (!fullText || fullText.trim().length < minContentLength) {
        // Повторная попытка по каноническому URL (без is_ajax=1 и т.п.) — часто даёт полную статью
        var canonicalUrl = getCanonicalScrapeUrl(url);
        if (canonicalUrl !== url && fullText) {
          Logger.log('Content too short (' + fullText.trim().length + ' chars). Retrying with canonical URL: ' + canonicalUrl);
          var retryText = scrapeFullText(canonicalUrl);
          if (retryText && retryText.trim().length >= minContentLength) {
            Logger.log('Canonical URL succeeded, length: ' + retryText.trim().length);
            return retryText.trim();
          }
        }
        const preview = fullText ? fullText.substring(0, 200) : '(null)';
        const length = fullText ? fullText.trim().length : 0;
        Logger.log('WARNING: Scraped content is too short (' + length + ' chars, min: ' + minContentLength + '). Source type: ' + (isTelegram ? 'Telegram' : 'Website'));
        Logger.log('First 200 chars: ' + preview);
        return null;
      }
      
      Logger.log('Successfully scraped full text, length: ' + fullText.length);
      return fullText.trim();
    } else {
      Logger.log('No content found in scrape response');
      return null;
    }

  } catch (err) {
    Logger.log('scrapeFullText error: ' + err.toString());
    Logger.log('Stack: ' + err.stack);
    return null;
  }
}

/* =========================
   SAVE TO GOOGLE SHEETS
========================= */
function saveNews(p) {
  const timestamp = new Date().toISOString();
  const newsId = (p.id || '').toString().trim();
  try {
    Logger.log('=== SAVE NEWS DEBUG [' + timestamp + '] ===');
    Logger.log('Received parameters: ' + JSON.stringify(p));
    Logger.log('Parameter keys: ' + Object.keys(p).join(', '));
    Logger.log('id: ' + (p.id || 'missing') + ' (type: ' + typeof p.id + ', length: ' + ((p.id || '').toString().length) + ')');
    Logger.log('topic: ' + (p.topic || 'missing'));
    Logger.log('audience: ' + (p.audience || 'missing'));
    Logger.log('source: ' + (p.source || 'missing'));
    Logger.log('summary length: ' + ((p.summary || p.text || '').length));
    
    // Проверка обязательных параметров
    if (!p.id) {
      Logger.log('❌ ERROR: Missing required parameter: id');
    }
    if (!p.topic) {
      Logger.log('⚠️ WARNING: Missing parameter: topic');
    }
    if (!p.source) {
      Logger.log('⚠️ WARNING: Missing parameter: source');
    }
    if (!p.summary && !p.text) {
      Logger.log('⚠️ WARNING: Missing parameter: summary/text');
    }
    
    // Google Sheets имеет ограничение 50000 символов на ячейку
    const MAX_CELL_LENGTH = 50000;
    
    // Получаем сниппет (summary) - это то, что пользователь видел в боте
    // Используем summary, если передан, иначе text для обратной совместимости
    let summary = (p.summary || p.text || '').toString().trim();
    
    // Обрезаем summary, если он слишком длинный
    if (summary.length > MAX_CELL_LENGTH) {
      Logger.log('WARNING: Summary length (' + summary.length + ') exceeds Google Sheets limit. Truncating...');
      summary = summary.substring(0, MAX_CELL_LENGTH - 50) + '\n\n[... Обрезано ...]';
    }
    
    // Получаем полный текст через Scrape API
    const sourceUrl = (p.source || '').toString().trim();
    let fullText = null;
    
    if (sourceUrl) {
      Logger.log('Fetching full text from URL: ' + sourceUrl);
      // Используем стандартный метод скрапинга
      fullText = scrapeFullText(sourceUrl);
      
      // Проверяем, что полученный текст не является страницей ошибки
      // НЕ используем «Ой!» отдельно — часто встречается в обычных статьях 
      if (fullText) {
        const errorIndicators = [
          'Whoops!', 'Something went wrong', '404 page not found', 'Page not found',
          'Что-то пошло не так', 'Страница не найдена', '# 404', 'Ошибка 404'
        ];
        const lowerText = fullText.toLowerCase();
        const hasError = errorIndicators.some(indicator => lowerText.includes(indicator.toLowerCase()));
        
        if (hasError) {
          Logger.log('WARNING: Scraped text contains error indicators. Using summary instead.');
          fullText = null; // Отбрасываем невалидный текст
        }
      }

      // Проверяем, что скрапленный текст — не страница опроса/формы (Google Forms и т.п.) 
      // Если на странице опрос вместо статьи — в таблицу попадёт мусор. Отбрасываем такой контент, сохраняем с summary.
      if (fullText) {
        const surveyFormIndicators = [
          'Never submit passwords through Google Forms',
          'This content is neither created nor endorsed by Google',
          'Indicates required question',
          'Clear form',
          'docs.google.com/forms',
          'Опрос читателей',
          'мини-опрос',
          'который поможет нам стать еще интереснее',
          'Report abuse',
          'Contact form owner',
          'Help Forms improve'
        ];
        const lowerFull = fullText.toLowerCase();
        const surveyCount = surveyFormIndicators.filter(function(ind) {
          return lowerFull.indexOf(ind.toLowerCase()) !== -1;
        }).length;
        if (surveyCount >= 2) {
          Logger.log('WARNING: Scraped text looks like survey/form page (' + surveyCount + ' indicators). Using summary instead.');
          fullText = null;
        }
      }
    } else {
      Logger.log('WARNING: No source URL provided, cannot scrape full text');
    }
    
      // Если скрапинг не удался, но есть summary, сохраняем с summary
      // Это позволяет сохранять новости с сайтов, которые требуют авторизацию или показывают неполный контент
      let finalText = null;
      if (!fullText) {
        // Минимальная длина summary по умолчанию
        const MIN_SUMMARY_LENGTH = 50;
        const summaryLength = summary ? summary.trim().length : 0;
        
        // Для доверенных доменов (kommersant.ru, 3dnews.ru) разрешаем сохранять даже короткое summary (например, только заголовок)
        const isTrustedDomain = sourceUrl.indexOf('kommersant.ru') !== -1 || sourceUrl.indexOf('3dnews.ru') !== -1;
        
        if (summary && (summaryLength >= MIN_SUMMARY_LENGTH || isTrustedDomain)) {
          Logger.log('WARNING: Scraping failed, but summary is available (' + summaryLength + ' chars, trustedDomain=' + isTrustedDomain + '). Saving with summary only.');
          // Используем summary как полный текст
          finalText = summary;
        } else {
          Logger.log('ERROR: Cannot save news - scraping returned null and summary is too short or missing. length=' + summaryLength + ', trustedDomain=' + isTrustedDomain);
          return output({
            status: 'error',
            message: 'К сожалению, произошла ошибка при сохранении новости: не удалось получить полный текст. Новость не сохранена.',
            reason: 'scraping_failed'
          });
        }
      } else {
        // Используем успешно скрапленный текст
        finalText = fullText;
      }
      
      // Дополнительная проверка: если finalText содержит признаки ошибки или опроса/формы, не сохраняем мусор (2026-02-02)
      if (finalText) {
        const errorIndicators = ['Whoops!', 'Something went wrong', '404 page not found'];
        const lowerText = finalText.toLowerCase();
        const hasError = errorIndicators.some(indicator => lowerText.includes(indicator.toLowerCase()));
        
        if (hasError) {
          Logger.log('ERROR: Final text contains error indicators. News will not be saved.');
          return output({
            status: 'error',
            message: 'Страница содержит ошибку. Новость не сохранена.',
            reason: 'error_page'
          });
        }

        var surveyFormIndicators2 = [
          'Never submit passwords through Google Forms',
          'Indicates required question',
          'Опрос читателей',
          'мини-опрос',
          'docs.google.com/forms'
        ];
        var surveyCount2 = surveyFormIndicators2.filter(function(ind) {
          return lowerText.indexOf(ind.toLowerCase()) !== -1;
        }).length;
        if (surveyCount2 >= 2 && summary && summary.trim().length >= 100) {
          Logger.log('WARNING: Final text looks like survey/form. Replacing with summary.');
          finalText = summary;
        } else if (surveyCount2 >= 2) {
          Logger.log('ERROR: Final text looks like survey/form and no usable summary. News will not be saved.');
          return output({
            status: 'error',
            message: 'Не удалось извлечь текст новости (страница содержит опрос/форму). Новость не сохранена.',
            reason: 'survey_or_form_page'
          });
        }
      }
    
    // Обрезаем finalText, если он слишком длинный
    if (finalText.length > MAX_CELL_LENGTH) {
      Logger.log('WARNING: Text length (' + finalText.length + ') exceeds Google Sheets limit (' + MAX_CELL_LENGTH + '). Truncating...');
      finalText = finalText.substring(0, MAX_CELL_LENGTH - 100) + '\n\n[... Текст обрезан из-за ограничения Google Sheets (максимум 50000 символов). Полный текст доступен по ссылке на источник ...]';
      Logger.log('Text truncated to ' + finalText.length + ' characters');
    }
    
    Logger.log('Final text length: ' + finalText.length + ' (scraped: ' + (fullText ? 'yes' : 'no') + ')');
    
    // Получаем ID таблицы из свойств скрипта
    const tableId = PropertiesService.getScriptProperties().getProperty('GOOGLE_SHEET_ID');
    if (!tableId || tableId === 'PASTE_TABLE_ID_HERE') {
      return output({ 
        status: 'error', 
        message: 'Google Sheet ID not configured. Please set GOOGLE_SHEET_ID in Script Properties.' 
      });
    }

    const sheet = SpreadsheetApp.openById(tableId).getSheets()[0];
    
    // Проверяем, есть ли заголовки
    const headerRow = sheet.getRange(1, 1, 1, 7).getValues()[0];
    if (!headerRow[0] || headerRow[0] === '') {
      // Создаём заголовки (7 колонок: A-Дата/время, B-Тема, C-Целевая аудитория, D-Ссылка, E-Краткое описание, F-Текст новости, G-ID)
      sheet.getRange(1, 1, 1, 7).setValues([[
        'Дата/время',
        'Тема',
        'Целевая аудитория',
        'Ссылка на источник',
        'Краткое описание',
        'Текст новости',
        'ID новости'
      ]]);
      Logger.log('Created headers in sheet');
    } else {
      // Если раньше колонка называлась "Саммари", переименуем её в "Краткое описание"
      if (headerRow[4] === 'Саммари') {
        sheet.getRange(1, 5).setValue('Краткое описание');
        Logger.log('Renamed header "Саммари" to "Краткое описание"');
      }
    }

    // Используем дату из параметра, если передана, иначе текущую
    let dateTime;
    if (p.date) {
      // Пробуем распарсить переданную дату
      try {
        const parsedDate = new Date(p.date);
        if (!isNaN(parsedDate.getTime())) {
          dateTime = Utilities.formatDate(parsedDate, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
        } else {
          dateTime = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
        }
      } catch (e) {
        dateTime = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
      }
    } else {
      const now = new Date();
      dateTime = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
    }

    // Подготавливаем данные для записи
    // Порядок колонок: A-Дата/время, B-Тема, C-Целевая аудитория, D-Ссылка, E-Краткое описание, F-Текст новости, G-ID
    const newsIdForSave = (p.id || '').toString().trim();
    const rowData = [
      dateTime,                                    // A - Дата/время
      (p.topic || '').toString(),                  // B - Тема
      (p.audience || '').toString(),               // C - Целевая аудитория (строка через запятую)
      (p.source || '').toString(),                 // D - Ссылка на источник
      summary,                                     // E - Краткое описание (заголовок/сниппет)
      finalText,                                   // F - Текст новости (полный текст)
      newsIdForSave                                 // G - ID новости
    ];

    Logger.log('Row data to save: ' + JSON.stringify(rowData.map((v, i) => {
      const cols = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
      return cols[i] + ': ' + (v.length > 50 ? v.substring(0, 50) + '...' : v);
    })));

    // Используем блокировку для предотвращения race condition при параллельных запросах
    const lock = LockService.getScriptLock();
    let lockAcquired = false;
    let newRow = null; // Инициализируем переменную для номера строки
    
    try {
      Logger.log('Attempting to acquire lock...');
      // Используем waitLock для гарантированного получения блокировки
      // waitLock ждет до 30 секунд, пока блокировка не будет доступна
      // Увеличено с 20 до 30 секунд для надежности при параллельных запросах
      lock.waitLock(30000);
      lockAcquired = true;
      Logger.log('✅ Lock acquired successfully');
      
      // ВАЖНО: Получаем lastRow ПОСЛЕ получения блокировки, чтобы избежать race condition
      const lastRow = sheet.getLastRow();
      const newsId = (p.id || '').toString().trim();
      
      // Проверяем, что ID не пустой и валидный
      if (!newsId || newsId === '') {
        Logger.log('❌ ERROR: News ID is empty or missing! Cannot save without ID.');
        Logger.log('Received params: id=' + (p.id || 'undefined') + ', topic=' + (p.topic || 'undefined'));
        Logger.log('All received params: ' + JSON.stringify(p));
        if (lockAcquired) {
          lock.releaseLock();
        }
        return output({ 
          status: 'error', 
          message: 'News ID is required but was not provided or is empty',
          debug: {
            received_id: p.id,
            received_params: Object.keys(p),
            all_params: p
          }
        });
      }
      
      // Проверяем, что ID не является плейсхолдером из промпта
      const placeholderPatterns = [
        '[РЕАЛЬНЫЙ_ID_ИЗ_ОБЪЕКТА_НОВОСТИ]',
        '[РЕАЛЬНАЯ_ТЕМА_ПОИСКА]',
        '[РЕАЛЬНАЯ_ЦА_ЧЕРЕЗ_ЗАПЯТУЮ]',
        '[РЕАЛЬНАЯ_ССЫЛКА_ИЗ_ОБЪЕКТА_НОВОСТИ]',
        '{{id_новости}}',
        '{{тема_поиска}}',
        '{{id}}',
        '{{topic}}'
      ];
      
      const isPlaceholder = placeholderPatterns.some(pattern => 
        newsId.includes(pattern) || newsId.includes('[') || newsId.includes(']') || newsId.includes('{{') || newsId.includes('}}')
      );
      
      if (isPlaceholder) {
        Logger.log('🚨 CRITICAL ERROR: Bot sent a placeholder instead of real ID!');
        Logger.log('Received ID: ' + newsId);
        Logger.log('This means the bot is copying placeholders from the prompt instead of using real values!');
        if (lockAcquired) {
          lock.releaseLock();
        }
        return output({ 
          status: 'error', 
          message: 'CRITICAL ERROR: ID contains placeholder text. Bot must use real ID from search results, not copy placeholders from prompt.',
          received_id: newsId,
          hint: 'Check bot prompt - it should extract ID from news object returned by searchNews function'
        });
      }
      
      // Проверяем, что ID выглядит валидным (должен быть hex MD5 хеш, минимум 16 символов)
      if (newsId.length < 16) {
        Logger.log('⚠️ WARNING: News ID seems invalid (too short): "' + newsId + '" (length: ' + newsId.length + ')');
        Logger.log('This might indicate a problem with ID generation in searchNews function or bot is using wrong ID');
        Logger.log('Source URL: ' + (p.source || 'missing'));
      }
      
      // Проверяем, что ID состоит только из hex символов (0-9, a-f)
      const hexPattern = /^[0-9a-f]+$/i;
      if (!hexPattern.test(newsId)) {
        Logger.log('⚠️ WARNING: News ID contains non-hex characters: "' + newsId + '"');
        Logger.log('Expected format: 32 hex characters (MD5 hash), got: ' + newsId);
      }
      
      // Если ID слишком короткий или невалидный, но все равно пытаемся сохранить
      // (может быть это старый формат ID)
      
      Logger.log('Current last row in sheet (after lock): ' + lastRow);
      Logger.log('Checking for duplicate news ID: "' + newsId + '" (length: ' + newsId.length + ')');
      
      // Проверяем дубликаты только если есть данные (больше 1 строки, так как строка 1 - заголовки)
      if (lastRow > 1) {
        const existingIds = sheet.getRange(2, 7, lastRow - 1, 1).getValues(); // Колонка G (ID)
        const existingIdsStrings = existingIds.map(r => (r[0] || '').toString().trim()).filter(id => id.length > 0);
        Logger.log('Existing IDs in sheet (' + existingIdsStrings.length + '): ' + JSON.stringify(existingIdsStrings));
        Logger.log('Checking if news ID "' + newsId + '" exists in ' + existingIdsStrings.length + ' existing IDs');
        
        const alreadyExists = existingIdsStrings.some(existingId => existingId === newsId);
        
        if (alreadyExists) {
          const existingRow = existingIdsStrings.indexOf(newsId) + 2;
          Logger.log('⚠️ DUPLICATE DETECTED: News with ID "' + newsId + '" already exists in row ' + existingRow + ', skipping save');
          Logger.log('Duplicate check: Found ' + existingIdsStrings.length + ' existing IDs');
          if (lockAcquired) {
            lock.releaseLock();
          }
          return output({ 
            status: 'ok', 
            message: 'News already exists (duplicate)',
            saved_id: newsId,
            duplicate: true,
            existing_row: existingRow
          });
        } else {
          Logger.log('✅ News ID "' + newsId + '" is new, proceeding with save');
        }
      } else {
        Logger.log('No existing data (only headers or empty sheet), skipping duplicate check');
      }
      
      // Используем insertRowAfter для надежной вставки строки
      // Это гарантирует, что строка будет вставлена после последней строки
      Logger.log('Inserting row after row ' + lastRow + ' for news ID: ' + (p.id || 'no ID'));
      
      // Вставляем новую строку после последней строки
      sheet.insertRowAfter(lastRow);
      
      // Записываем данные в новую строку
      newRow = lastRow + 1; // Обновляем внешнюю переменную newRow
      Logger.log('Writing data to row ' + newRow + ' for ID: "' + newsId + '"');
      
      try {
        sheet.getRange(newRow, 1, 1, 7).setValues([rowData]);
        Logger.log('Data written successfully to row ' + newRow);
      } catch (writeErr) {
        Logger.log('❌ ERROR writing data to row ' + newRow + ': ' + writeErr.toString());
        if (lockAcquired) {
          lock.releaseLock();
        }
        throw writeErr; // Пробрасываем ошибку дальше
      }
      
      // Принудительно применяем изменения перед освобождением блокировки
      try {
        SpreadsheetApp.flush();
        Logger.log('SpreadsheetApp.flush() completed');
      } catch (flushErr) {
        Logger.log('⚠️ WARNING: SpreadsheetApp.flush() error: ' + flushErr.toString());
        // Не пробрасываем ошибку, так как данные могут быть уже записаны
      }
      
      // Небольшая задержка для гарантии применения изменений
      Utilities.sleep(200); // Увеличено с 100 до 200 мс для надежности
      
      // Перечитываем lastRow после записи для проверки
      const verifiedLastRow = sheet.getLastRow();
      Logger.log('Row inserted. Verified last row: ' + verifiedLastRow + ' (expected: ' + newRow + ')');
      
      if (verifiedLastRow !== newRow) {
        Logger.log('WARNING: Last row mismatch! Expected ' + newRow + ' but got ' + verifiedLastRow);
      }
      
      // Дополнительная проверка: читаем записанные данные для подтверждения
      const writtenData = sheet.getRange(newRow, 1, 1, 7).getValues()[0];
      const writtenId = (writtenData[6] || '').toString().trim(); // ID теперь в колонке G (индекс 6)
      Logger.log('Verification: Written ID in row ' + newRow + ' is: "' + writtenId + '"');
      
      if (writtenId !== newsId) {
        Logger.log('ERROR: ID mismatch! Expected "' + newsId + '" but got "' + writtenId + '"');
      }
      
      Logger.log('✅ News saved successfully. ID: "' + newsId + '" at row ' + newRow + ' at ' + timestamp);
      
      if (lockAcquired) {
        lock.releaseLock();
        Logger.log('Lock released');
      }
      
      // Возвращаем результат успешного сохранения с блокировкой
      return output({ 
        status: 'ok', 
        message: 'News saved successfully',
        saved_id: newsIdForSave,
        saved_at_row: newRow,
        timestamp: timestamp
      });
    } catch (lockErr) {
      Logger.log('⚠️ Lock error: ' + lockErr.toString());
      Logger.log('Lock error stack: ' + lockErr.stack);
      
      // Если не удалось получить блокировку, проверяем дубликаты и пытаемся сохранить
      try {
        const newsIdNoLock = (p.id || '').toString().trim();
        
        // Проверяем, что ID не пустой
        if (!newsIdNoLock || newsIdNoLock === '') {
          Logger.log('ERROR: News ID is empty or missing (no lock path)! Cannot save without ID.');
          return output({ 
            status: 'error', 
            message: 'News ID is required but was not provided or is empty',
            debug: {
              received_id: p.id,
              received_params: Object.keys(p)
            }
          });
        }
        
        const lastRow = sheet.getLastRow();
        // Проверяем дубликаты только если есть данные (больше 1 строки, так как строка 1 - заголовки)
        if (lastRow > 1) {
          const existingIds = sheet.getRange(2, 7, lastRow - 1, 1).getValues(); // Колонка G (ID)
          const existingIdsStrings = existingIds.map(r => (r[0] || '').toString().trim()).filter(id => id.length > 0);
          const alreadyExists = existingIdsStrings.some(existingId => existingId === newsIdNoLock);
          
          if (alreadyExists) {
            Logger.log('News with ID "' + newsIdNoLock + '" already exists (checked without lock), skipping save');
            return output({ 
              status: 'ok', 
              message: 'News already exists (duplicate)',
              saved_id: newsIdNoLock,
              duplicate: true
            });
          }
        }
        
        // Получаем lastRow перед сохранением
        const lastRowNoLock = sheet.getLastRow();
        Logger.log('Attempting to save without lock after row: ' + lastRowNoLock + ' for ID: "' + newsIdNoLock + '"');
        
        // Вставляем новую строку после последней
        Logger.log('Inserting row after ' + lastRowNoLock + ' (no lock path)');
        sheet.insertRowAfter(lastRowNoLock);
        const newRowNoLock = lastRowNoLock + 1;
        
        try {
          sheet.getRange(newRowNoLock, 1, 1, 7).setValues([rowData]);
          Logger.log('Data written successfully to row ' + newRowNoLock + ' (no lock)');
        } catch (writeErr) {
          Logger.log('❌ ERROR writing data to row ' + newRowNoLock + ' (no lock): ' + writeErr.toString());
          throw writeErr;
        }
        
        // Принудительно применяем изменения
        try {
          SpreadsheetApp.flush();
          Logger.log('SpreadsheetApp.flush() completed (no lock)');
        } catch (flushErr) {
          Logger.log('⚠️ WARNING: SpreadsheetApp.flush() error (no lock): ' + flushErr.toString());
        }
        Utilities.sleep(200); // Увеличено с 100 до 200 мс
        
        // Дополнительная проверка: читаем записанные данные для подтверждения
        const writtenDataNoLock = sheet.getRange(newRowNoLock, 1, 1, 7).getValues()[0];
        const writtenIdNoLock = (writtenDataNoLock[6] || '').toString().trim(); // ID теперь в колонке G (индекс 6)
        Logger.log('Verification (no lock): Written ID in row ' + newRowNoLock + ' is: "' + writtenIdNoLock + '"');
        
        if (writtenIdNoLock !== newsIdNoLock) {
          Logger.log('ERROR (no lock): ID mismatch! Expected "' + newsIdNoLock + '" but got "' + writtenIdNoLock + '"');
        }
        
        Logger.log('✅ News saved without lock. ID: "' + newsIdNoLock + '" at row ' + newRowNoLock + ' at ' + timestamp);
        
        // Устанавливаем newRow для корректной проверки в конце функции
        newRow = newRowNoLock;
        
        return output({ 
          status: 'ok', 
          message: 'News saved successfully (without lock)',
          saved_id: newsIdNoLock,
          saved_at_row: newRowNoLock,
          timestamp: timestamp
        });
      } catch (saveErr) {
        Logger.log('❌ Error saving without lock: ' + saveErr.toString());
        Logger.log('Error stack: ' + saveErr.stack);
        if (lockAcquired) {
          try {
            lock.releaseLock();
          } catch (releaseErr) {
            Logger.log('Error releasing lock: ' + releaseErr.toString());
          }
        }
        return output({ 
          status: 'error', 
          message: 'Failed to save news: ' + saveErr.toString(),
          error_details: saveErr.toString(),
          saved_id: newsIdForSave
        });
      }
    }

    // Если мы дошли сюда, значит что-то пошло не так
    // (это не должно происходить в нормальных условиях)
    Logger.log('⚠️ WARNING: Reached end of saveNews without returning result. newRow=' + newRow);
    if (lockAcquired) {
      try {
        lock.releaseLock();
      } catch (releaseErr) {
        Logger.log('Error releasing lock at end: ' + releaseErr.toString());
      }
    }
    return output({ 
      status: 'error', 
      message: 'Unexpected error: save completed but no row number recorded',
      saved_id: newsIdForSave,
      debug: {
        newRow: newRow,
        hasId: !!p.id,
        hasSource: !!p.source
      }
    });

  } catch (err) {
    Logger.log('❌ CRITICAL saveNews error: ' + err.toString());
    Logger.log('Error stack: ' + err.stack);
    Logger.log('Error occurred at timestamp: ' + timestamp);
    Logger.log('Parameters received: ' + JSON.stringify(p));
    return output({ 
      status: 'error', 
      message: 'Save error: ' + err.toString(),
      error_details: err.toString(),
      error_type: err.name || 'Unknown',
      saved_id: (p.id || '').toString().trim()
    });
  }
}

/* =========================
   STATEFUL NEWS ACTIONS 
========================= */

/**
 * Перемешивает массив на месте (Fisher-Yates). При каждом новом поиске порядок новостей будет разным.
 */
function shuffleArray(arr) {
  for (var i = arr.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

/**
 * start_search - Начать новый поиск, сохранить queue
 */
function startSearch(p) {
  try {
    const query = p.query || "нейросети, искусственный интеллект, машинное обучение";
    
    Logger.log('=== START_SEARCH ===');
    Logger.log('Query: ' + query);
    
    // Вызываем существующую функцию searchNews
    Logger.log('Calling searchNews with query: ' + query);
    const searchResult = searchNews({ query: query });
    
    if (!searchResult) {
      Logger.log('ERROR: searchNews returned null or undefined');
      return output({
        status: 'error',
        message: 'Ошибка при вызове функции поиска'
      });
    }
    
    // Парсим результат
    let resultText;
    try {
      resultText = searchResult.getContent();
      Logger.log('searchResult.getContent() succeeded, length: ' + (resultText ? resultText.length : 0));
    } catch (getContentErr) {
      Logger.log('ERROR getting content from searchResult: ' + getContentErr.toString());
      return output({
        status: 'error',
        message: 'Ошибка при обработке результатов поиска: ' + getContentErr.toString()
      });
    }
    
    let resultData;
    try {
      resultData = JSON.parse(resultText);
      Logger.log('JSON parse succeeded');
    } catch (parseErr) {
      Logger.log('ERROR parsing JSON from searchResult: ' + parseErr.toString());
      Logger.log('Raw result text (first 500 chars): ' + (resultText ? resultText.substring(0, 500) : '(null)'));
      return output({
        status: 'error',
        message: 'Ошибка при парсинге результатов поиска: ' + parseErr.toString()
      });
    }
    
    // Краткое логирование для диагностики 
    Logger.log('resultData.status: ' + (resultData.status || '(empty)'));
    Logger.log('resultData.news exists: ' + !!resultData.news);
    Logger.log('resultData.news length: ' + (resultData.news ? resultData.news.length : 0));
    if (resultData.error) {
      Logger.log('resultData.error: ' + resultData.error);
    }
    if (resultData.message) {
      Logger.log('resultData.message: ' + resultData.message);
    }
    if (resultData.error_code) {
      Logger.log('resultData.error_code: ' + resultData.error_code);
    }
    
    // Если searchNews вернул ошибку (например, проблема с API токеном), передаём её дальше
    if (resultData.status === 'error') {
      Logger.log('ERROR from searchNews: ' + (resultData.message || resultData.error || 'Unknown error'));
      return output({
        status: 'error',
        action: 'api_error',
        message: resultData.message || 'Ошибка при поиске новостей',
        error_code: resultData.error_code || null,
        error_details: resultData.error_details || null
      });
    }
    
    if (resultData.status === 'ok' && resultData.news && resultData.news.length > 0) {
      // Сброс счётчика сохранений для новой сессии поиска
      resetSavedCountThisSession();
      
      // Очищаем saved_news_ids при новом поиске (2026-01-28: пользователь сам пропускает сохранённые)
      const props = PropertiesService.getScriptProperties();
      props.deleteProperty('saved_news_ids');
      Logger.log('Cleared saved_news_ids for new search');
      
      // Сбрасываем индекс при новом поиске
      // Иначе индекс остаётся от предыдущей сессии и бот начинает не с начала очереди
      setCurrentIndex(0);
      Logger.log('Reset current_index to 0 for new search');
      
      // Перемешиваем порядок новостей — при каждом запуске поиска разная последовательность
      var newsToSave = resultData.news.slice();
      shuffleArray(newsToSave);
      
      // Сохраняем перемешанную queue в Properties
      saveNewsQueue(newsToSave);
      
      // Возвращаем первую новость (уже в новом порядке)
      const firstNews = newsToSave[0];
      
      return output({
        status: 'ok',
        action: 'news_found',
        current_news: firstNews,
        total_in_queue: newsToSave.length,
        current_index: 0
      });
    } else {
      // Краткое логирование при отсутствии результатов (2026-01-28)
      Logger.log('resultData.status: ' + (resultData.status || '(empty)'));
      Logger.log('resultData.news exists: ' + !!resultData.news);
      Logger.log('resultData.news length: ' + (resultData.news ? resultData.news.length : 0));
      
      return output({
        status: 'ok',
        action: 'no_news',
        message: 'Новостей не найдено'
      });
    }
    
  } catch (err) {
    Logger.log('startSearch error: ' + err.toString());
    return output({
      status: 'error',
      message: 'Ошибка поиска: ' + err.toString()
    });
  }
}

/**
 * get_current - Получить текущую новость из queue
 */
function getCurrent(p) {
  try {
    const queue = getNewsQueue();
    const index = getCurrentIndex();
    
    if (!queue || queue.length === 0) {
      return output({
        status: 'ok',
        action: 'no_queue',
        message: 'Очередь пуста. Используйте [Найти новости]'
      });
    }
    
    if (index >= queue.length) {
      return output({
        status: 'ok',
        action: 'queue_end',
        message: 'Все новости показаны. Используйте [Найти новости] для нового поиска'
      });
    }
    
    const currentNews = queue[index];
    
    return output({
      status: 'ok',
      action: 'news_found',
      current_news: currentNews,
      total_in_queue: queue.length,
      current_index: index
    });
    
  } catch (err) {
    Logger.log('getCurrent error: ' + err.toString());
    return output({
      status: 'error',
      message: 'Ошибка получения новости: ' + err.toString()
    });
  }
}

/**
 * confirm_current - Подтвердить и сохранить текущую новость
 */
function confirmCurrent(p) {
  // Блокировка для предотвращения параллельных вызовов confirm_current
  const lock = LockService.getScriptLock();
  let lockAcquired = false;
  
  try {
    // Пытаемся получить блокировку (максимум 5 секунд)
    lock.waitLock(5000);
    lockAcquired = true;
    Logger.log('✅ Lock acquired for confirmCurrent');
    
    const queue = getNewsQueue();
    const index = getCurrentIndex();
    
    if (!queue || queue.length === 0) {
      if (lockAcquired) lock.releaseLock();
      return output({
        status: 'error',
        message: 'Очередь пуста'
      });
    }
    
    if (index >= queue.length) {
      if (lockAcquired) lock.releaseLock();
      return output({
        status: 'error',
        message: 'Индекс выходит за границы очереди'
      });
    }
    
    const currentNews = queue[index];
    const topic = p.topic || 'нейросети и искусственный интеллект';
    const audience = p.audience || 'разработчики AI/ML, бизнес-пользователи AI, исследователи в области AI';
    
    Logger.log('=== CONFIRM_CURRENT ===');
    Logger.log('Current index BEFORE save: ' + index);
    Logger.log('Queue length: ' + queue.length);
    Logger.log('News ID: ' + currentNews.id);
    Logger.log('News URL: ' + currentNews.source);
    Logger.log('News title: ' + (currentNews.title || 'missing'));
    Logger.log('News text length: ' + (currentNews.text ? currentNews.text.length : 0));
    
    // Если text пустой, используем title как summary
    // Это нужно для новостей с Коммерсанта, которые приходят из scrapeKommersantThemePage без текста
    let summaryText = currentNews.text;
    if (!summaryText || summaryText.trim().length === 0) {
      summaryText = currentNews.title || 'Новость без описания';
      Logger.log('⚠️ WARNING: Empty text, using title as summary: ' + summaryText);
    }
    
    // Вызываем существующую функцию saveNews
    const saveResult = saveNews({
      id: currentNews.id,
      topic: topic,
      audience: audience,
      source: currentNews.source,
      summary: summaryText
    });
    
    // Парсим результат
    const resultText = saveResult.getContent();
    const resultData = JSON.parse(resultText);
    
    // Проверяем, не был ли это дубликат
    // Если saveNews вернул duplicate: true, НЕ увеличиваем счетчик и индекс
    if (resultData.status === 'ok' && resultData.duplicate === true) {
      Logger.log('⚠️ DUPLICATE DETECTED in confirmCurrent: News ID "' + currentNews.id + '" already exists. Skipping counter increment.');
      if (lockAcquired) lock.releaseLock();
      return output({
        status: 'ok',
        action: 'news_saved',
        message: 'Новость уже была сохранена ранее (дубликат)',
        total_requests: resultData.total_requests || 0,
        duplicate: true,
        has_more: index + 1 < queue.length,
        next_index: index,
        total_in_queue: queue.length
      });
    }
    
    // Проверяем, что сохранение реально произошло
    // Увеличиваем счетчик ТОЛЬКО если сохранение успешно и есть подтверждение (saved_at_row или saved_id)
    if (resultData.status === 'ok' && (resultData.saved_at_row || resultData.saved_id)) {
      // Увеличиваем счётчик сохранений в текущей сессии (используется только для статистики и отображения)
      const savedCountBefore = getSavedCountThisSession();
      const savedCount = incrementSavedCountThisSession();
      Logger.log('Saved count: ' + savedCountBefore + ' -> ' + savedCount + ' | News saved at row: ' + (resultData.saved_at_row || 'unknown'));
      
      // Увеличиваем индекс для следующей новости
      const newIndex = incrementCurrentIndex();
      
      Logger.log('Index AFTER save: ' + index + ' -> ' + newIndex);
      Logger.log('Has more news: ' + (newIndex < queue.length));
      
      const hasMore = newIndex < queue.length;
      
      // Если очередь закончилась — это естественный конец поиска (лимит по размеру очереди)
      if (!hasMore) {
        Logger.log('Queue exhausted after save. Returning limit_reached (no more news in queue).');
        if (lockAcquired) lock.releaseLock();
        return output({
          status: 'ok',
          action: 'limit_reached',
          message: 'Новость сохранена. Это была последняя новость из очереди.',
          total_requests: resultData.total_requests || 0,
          saved_this_session: savedCount,
          has_more: false,
          next_index: newIndex,
          total_in_queue: queue.length
        });
      }
      
      if (lockAcquired) lock.releaseLock();
      return output({
        status: 'ok',
        action: 'news_saved',
        message: 'Новость сохранена!',
        total_requests: resultData.total_requests || 0,
        has_more: hasMore,
        next_index: newIndex,
        total_in_queue: queue.length,
        saved_this_session: savedCount
      });
    } else if (resultData.status === 'ok' && !resultData.saved_at_row && !resultData.saved_id) {
      // Статус 'ok', но нет подтверждения сохранения - это ошибка
      Logger.log('⚠️ WARNING: saveNews returned status=ok but no saved_at_row or saved_id. News may not have been saved.');
      if (lockAcquired) lock.releaseLock();
      return output({
        status: 'error',
        message: 'Ошибка сохранения: сохранение не подтверждено. Попробуйте еще раз.'
      });
    } else {
      if (lockAcquired) lock.releaseLock();
      return output({
        status: 'error',
        message: 'Ошибка сохранения: ' + (resultData.message || 'Unknown error')
      });
    }
    
  } catch (err) {
    Logger.log('confirmCurrent error: ' + err.toString());
    if (lockAcquired) {
      try {
        lock.releaseLock();
      } catch (releaseErr) {
        Logger.log('Error releasing lock in confirmCurrent: ' + releaseErr.toString());
      }
    }
    return output({
      status: 'error',
      message: 'Ошибка подтверждения: ' + err.toString()
    });
  }
}

/**
 * get_next - Пропустить текущую и показать следующую новость
 */
function getNext(p) {
  try {
    const queue = getNewsQueue();
    
    if (!queue || queue.length === 0) {
      return output({
        status: 'ok',
        action: 'no_queue',
        message: 'Очередь пуста. Используйте [Найти новости]'
      });
    }
    
    // ИСПРАВЛЕНИЕ: Получаем текущий индекс ПЕРЕД увеличением
    // Это нужно, чтобы не пропускать новости, если индекс уже был увеличен в confirmCurrent
    const currentIndex = getCurrentIndex();
    
    Logger.log('=== GET_NEXT ===');
    Logger.log('Current index: ' + currentIndex + ' (total in queue: ' + queue.length + ')');
    
    // Проверяем, не вышли ли за границы очереди ДО увеличения
    if (currentIndex >= queue.length) {
      return output({
        status: 'ok',
        action: 'queue_end',
        message: 'Все новости из очереди показаны. Используйте [Найти новости] для нового поиска'
      });
    }
    
    // Увеличиваем индекс, чтобы перейти к следующей новости
    const newIndex = incrementCurrentIndex();
    
    Logger.log('Moved to next index: ' + currentIndex + ' -> ' + newIndex);
    
    // Проверяем, не вышли ли за границы очереди ПОСЛЕ увеличения
    if (newIndex >= queue.length) {
      // Добавляем информацию о количестве сохраненных новостей для корректного отображения
      const savedCount = getSavedCountThisSession();
      return output({
        status: 'ok',
        action: 'queue_end',
        message: 'Все новости из очереди показаны. Используйте [Найти новости] для нового поиска',
        saved_this_session: savedCount
      });
    }
    
    const nextNews = queue[newIndex];
    
    return output({
      status: 'ok',
      action: 'news_found',
      current_news: nextNews,
      total_in_queue: queue.length,
      current_index: newIndex
    });
    
  } catch (err) {
    Logger.log('getNext error: ' + err.toString());
    return output({
      status: 'error',
      message: 'Ошибка получения следующей новости: ' + err.toString()
    });
  }
}

/* =========================
   OUTPUT HELPER
========================= */
function output(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* =========================
   SETUP FUNCTION (запустить один раз для настройки)
========================= */
function setup() {
  const properties = PropertiesService.getScriptProperties();
  
  // Установите эти значения:
  // properties.setProperty('FIRECRAWL_API_KEY', 'ваш_api_ключ_firecrawl');
  // properties.setProperty('GOOGLE_SHEET_ID', 'id_вашей_google_таблицы');
  
  Logger.log('Setup complete. Please set FIRECRAWL_API_KEY and GOOGLE_SHEET_ID in Script Properties.');
}

