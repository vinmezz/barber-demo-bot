# 🪒 Barber-Demo LA — Telegram Bot

## Что умеет

- 📅 Запись на стрижку (имя → телефон → услуга → дата)
- 💈 Прайс-лист с кнопками
- 📍 Адрес, телефон, часы работы
- 🤖 AI-чат на базе Claude (отвечает на любые вопросы о барбершопе)
- 🌐 3 языка: EN / RU / ES
- 🔔 Уведомление владельцу при каждой новой записи

-----

## Деплой на Railway

### 1. Переменные окружения (Variables)

```
BOT_TOKEN=          # токен от @BotFather
ANTHROPIC_API_KEY=  # ключ с console.anthropic.com
OWNER_CHAT_ID=      # твой Telegram user ID (получить у @userinfobot)
```

### 2. Команды

```bash
npm install
npm start
```

### 3. На Railway

- New Project → Deploy from GitHub repo
- Добавь переменные во вкладке Variables
- Убедись что Start Command: `npm start`

-----

## Настройка бота

В файле `barber_bot.js` найди секцию `SHOP CONFIG` и замени:

```js
const SHOP = {
  name: "Barber-Demo LA",          // Название
  address: "...",                   // Адрес
  phone: "+1 ...",                  // Телефон
  instagram: "@...",                // Instagram
  bookingUrl: "https://calendly...", // Ссылка для онлайн-записи
};
```

И секцию `SERVICES` — добавь/удали услуги и цены.

-----

## Команды бота (BotFather → /setcommands)

```
start - Запустить бота / Start bot
```