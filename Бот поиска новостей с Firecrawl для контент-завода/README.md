# Бот поиска новостей с Firecrawl для контент-завода

Пример ассистента/бота для поиска и сохранения новостей об ИИ, построенный по принципу: **LLM = только интерфейс**, а **вся логика и состояние — в Google Apps Script**.

## Что внутри

- `gas_script_firecrawl.js` — Google Apps Script (Web App): поиск/очередь/индексы/сохранение в Google Sheets + интеграция с Firecrawl.
- `prompt_v8_stateful.txt` — промпт для LLM (UI-слой) с правилами вызова действий Web App.

## Архитектура

Telegram/платформа → LLM (показывает карточки, вызывает действия) → Google Apps Script (логика + состояние) → Firecrawl (search/scrape) → Google Sheets (хранилище).

## Экшены (GAS Web App)

- `start_search` — собрать очередь и вернуть первую новость
- `get_current` — вернуть текущую новость
- `get_next` — перейти к следующей новости
- `confirm_current` — сохранить текущую новость и перейти дальше

## Настройка

В Script Properties у GAS должны быть заданы:

- `FIRECRAWL_API_KEY`
- `GOOGLE_SHEET_ID`

Разверните GAS как Web App и подставьте URL деплоя в `prompt_v8_stateful.txt` (поле `web_app_url`).

