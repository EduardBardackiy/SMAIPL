# Бот публикатор постов в VK

Пример ассистента/бота для **контент-завода**: берёт новости из очереди в Google Sheets, помогает подготовить текст поста, сгенерировать иллюстрацию и **опубликовать материал в сообщество VK** (с вложенной картинкой, не ссылкой в тексте). Проект построен по принципу **детерминированного бэкенда**: вся логика очереди, блокировок строк, статусов и публикации находится в **Google Apps Script**, а ассистент (SMAIPL/LLM) работает как «тонкий адаптер» — принимает сообщения и нажатия кнопок, вызывает API скрипта и отображает строго то, что вернул сервер.

Бот рассчитан на связку с другими ботами контент-завода ([RSS](https://github.com/EduardBardackiy/SMAIPL/tree/main/%D0%91%D0%BE%D1%82%20%D0%BF%D0%BE%D0%B8%D1%81%D0%BA%D0%B0%20%D0%BD%D0%BE%D0%B2%D0%BE%D1%81%D1%82%D0%B5%D0%B9%20RSS%20%D0%B4%D0%BB%D1%8F%20%D0%BA%D0%BE%D0%BD%D1%82%D0%B5%D0%BD%D1%82-%D0%B7%D0%B0%D0%B2%D0%BE%D0%B4%D0%B0), [Firecrawl](https://github.com/EduardBardackiy/SMAIPL/tree/main/%D0%91%D0%BE%D1%82%20%D0%BF%D0%BE%D0%B8%D1%81%D0%BA%D0%B0%20%D0%BD%D0%BE%D0%B2%D0%BE%D1%81%D1%82%D0%B5%D0%B9%20%D1%81%20Firecrawl%20%D0%B4%D0%BB%D1%8F%20%D0%BA%D0%BE%D0%BD%D1%82%D0%B5%D0%BD%D1%82-%D0%B7%D0%B0%D0%B2%D0%BE%D0%B4%D0%B0)): они наполняют таблицу, этот бот — **редактирует и публикует** в VK. Логически это «второй публикатор» рядом с [ботом для Telegram](https://github.com/EduardBardackiy/SMAIPL/tree/main/%D0%91%D0%BE%D1%82%20%D0%BF%D1%83%D0%B1%D0%BB%D0%B8%D0%BA%D0%B0%D1%82%D0%BE%D1%80%20%D0%BF%D0%BE%D1%81%D1%82%D0%BE%D0%B2%20%D0%B2%20%D0%A2%D0%93).

## Что умеет

- Берёт следующую новость из листа очереди и **блокирует строку** на текущего пользователя.
- Показывает карточку новости с inline-кнопками сценария.
- **Перегенерирует текст** (перефраз в SMAIPL) и сохраняет черновик поста в таблицу.
- **Генерирует изображение** через SMAIPL `openai_gpt_image` (функция **364**, GPT-image-1) в стиле редакционной tech-иллюстрации.
- **Сохраняет URL картинки** и **публикует пост в VK** с вложенным фото (VK API в GAS).
- После успешной публикации **архивирует строку** на лист `PublishedArchive` и удаляет из очереди.
- Поддерживает пропуск новости (снятие лока) и завершение сессии.

### Типовой сценарий (кнопки)

1. **Взять следующую новость** — `get_next_item`
2. **Перегенерировать текст** — `regenerate_text`
3. **Сохранить черновик текста** — `save_text_draft`
4. **Сгенерировать изображение** — `openai_gpt_image` (SMAIPL)
5. **Перегенерировать изображение** / **Принять изображение** — `save_image`
6. **Опубликовать в VK** — `send_to_vk`
7. **Снять лок (пропустить)** — `release_lock`
8. **Завершить** — `finish`

Шаг «Подготовить к публикации в VK» (`publish_to_channel`) **необязателен** — после принятия картинки можно сразу публиковать.

## Архитектура

| Компонент | Файл | Роль |
|-----------|------|------|
| Google Apps Script | `gas_script_vk_publisher.js` | State machine: очередь, локи, статусы, Sheets, **публикация в VK** (upload + wall.post) |
| SMAIPL + промпт | `prompt_vk_publisher_v1_stateful_windows.txt` | Правила: вызов **302** (`google_run_app_script`) и **364** (`openai_gpt_image`); не менять `message` и кнопки из GAS |

**Контракт ответа GAS:**

```json
{
  "success": true,
  "message": "текст для Telegram",
  "inline_keyboard": [["Подпись кнопки", "command"], ...],
  "data": { "row_id": 123, ... }
}
```

Кнопки в SMAIPL формируются из `inline_keyboard` в формате `##INLINE:[Кнопка1];[Кнопка2]##`.

**Важно:** ассистент **не выбирает строки**, **не придумывает статусы** и **не подтверждает публикацию** без реального ответа GAS.

## Структура таблицы

Скрипт ожидает лист очереди (по умолчанию **`ToPublish`**, можно переименовать через `PUBLISH_SHEET_NAME`) с колонками:

| Колонка | Поле | Назначение |
|---------|------|------------|
| A–G | createdAt, topic, audience, sourceUrl, summary, rawText, newsId | Базовые поля новости |
| H | postTextDraft | Черновик текста поста |
| I | postTextApproved | Одобренный текст |
| J | imageUrl | URL изображения |
| K | imageApproved | Флаг одобрения картинки |
| L–O | publishStatus, publishResultRaw, lockedBy, lockedAt | Статус пайплайна и лок |
| P–R | vkPublishStatus, vkPublishResultRaw, vkPostId | Результат публикации в VK |

Опубликованные строки переносятся на лист **`PublishedArchive`**.

## Быстрый старт

1. **Google Sheets** — таблица с новостями (можно наполнять RSS/Firecrawl-ботами из этого репозитория).
2. **Google Apps Script** — создайте проект, вставьте код из `gas_script_vk_publisher.js`, привяжите к таблице.
3. **Манифест `appsscript.json`** (создайте в проекте GAS, если его нет):

```json
{
  "timeZone": "Europe/Moscow",
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/spreadsheets"
  ]
}
```

4. **Script Properties** (обязательно):
   - `GOOGLE_SHEET_ID` — ID таблицы
   - `PUBLISH_SHEET_NAME` — имя листа очереди (например `Лист1` или `ToPublish`)
   - `PUBLISH_ARCHIVE_SHEET_NAME` — архив (по умолчанию `PublishedArchive`)
   - `VK_GROUP_ID` — числовой ID сообщества VK (строкой, без экспоненты)
   - `VK_GROUP_TOKEN` — токен сообщества с правами на `photos` и `wall`
5. **Deploy** → Web App: Execute as **Me**, доступ **Anyone** (или как принято у вас). Пройдите авторизацию OAuth (Sheets + внешние запросы).
6. **Промпт** — в `prompt_vk_publisher_v1_stateful_windows.txt` замените все `<ВАШ_DEPLOYMENT_ID>` на ID из URL вашего Web App.
7. **SMAIPL** — подключите промпт, убедитесь в доступе к функциям:
   - **302** `google_run_app_script`
   - **364** `openai_gpt_image`

## Публикация в VK

Публикация выполняется **внутри GAS**, без отдельной SMAIPL-функции для VK:

1. `photos.getWallUploadServer` → upload файла → `photos.saveWallPhoto`
2. `wall.post` с `attachments=photo...`

Токен сообщества хранится только в Script Properties, не выводится пользователю.

## Генерация иллюстраций

Промпт настроен на **редакционный tech-стиль** (ИИ, нейросети, промпт-инжиниринг): спокойная палитра, одна метафора, без «плакатного» неона и клише. По умолчанию: `1024x1024`, `quality: medium`.

## Зачем этот пример полезен

- Завершает цепочку контент-завода: **поиск → очередь → публикация в VK**.
- Показывает публикацию **с вложенной картинкой** через VK API из GAS.
- LLM не «рулит очередью», а делает перефраз и visual prompt в рамках жёстких правил.

## Файлы в папке

| Файл | Описание |
|------|----------|
| `gas_script_vk_publisher.js` | Backend: Web App, команды, Sheets, VK API |
| `prompt_vk_publisher_v1_stateful_windows.txt` | Промпт SMAIPL для Telegram-ассистента |
| `README.md` | Это описание |

## Важно

- Не публикуйте в открытый репозиторий **реальные** `VK_GROUP_TOKEN` и приватные URL деплоев с секретами — используйте плейсхолдеры и Script Properties.
- Публикация с картинкой использует **UrlFetchApp**; при интенсивных тестах возможны временные лимиты трафика Google или кратковременные сбои upload-серверов VK — предусмотрены повторные попытки в скрипте.
- Проект рассчитан на то, что ассистент **не подменяет** ответы GAS. Логи SMAIPL помогают диагностировать сбои на стороне промпта/платформы.
