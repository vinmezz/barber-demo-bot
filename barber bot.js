// ============================================================
// barber_bot.js  –  @prime_service_la_bot
// Barber-Demo LA | Telegram Bot
// Features: booking, price list, info, AI-chat (EN/RU/ES)
// Deploy: Railway / any Node.js host
// ============================================================

const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");

// ──────────────────────────────────────────────
// ENV  (set these in Railway → Variables)
// ──────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;           // BotFather token
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;   // Your personal Telegram ID

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ──────────────────────────────────────────────
// SHOP CONFIG  (edit to match real barber shop)
// ──────────────────────────────────────────────
const SHOP = {
  name: "Barber-Demo LA",
  address: "1234 Sunset Blvd, West Hollywood, CA 90028",
  phone: "+1 (323) 555-0199",
  instagram: "@barber_demo_la",
  hours: {
    en: "Mon–Sat: 9 AM – 8 PM\nSun: 10 AM – 6 PM",
    ru: "Пн–Сб: 9:00 – 20:00\nВс: 10:00 – 18:00",
    es: "Lun–Sáb: 9 AM – 8 PM\nDom: 10 AM – 6 PM",
  },
  // Booking link (Calendly / Square / manual)
  bookingUrl: "https://calendly.com/barber-demo-la",
};

const SERVICES = [
  { name_en: "Haircut",          name_ru: "Стрижка",              name_es: "Corte de cabello",  price: 35  },
  { name_en: "Haircut + Beard",  name_ru: "Стрижка + Борода",     name_es: "Corte + Barba",     price: 55  },
  { name_en: "Beard Trim",       name_ru: "Оформление бороды",    name_es: "Arreglo de barba",  price: 25  },
  { name_en: "Kids Haircut",     name_ru: "Детская стрижка",      name_es: "Corte niños",       price: 25  },
  { name_en: "Hot Towel Shave",  name_ru: "Бритьё с горячим пол.",name_es: "Afeitado toalla",   price: 45  },
  { name_en: "Hair Color",       name_ru: "Окрашивание",          name_es: "Coloración",        price: 80  },
  { name_en: "Fade",             name_ru: "Фейд",                 name_es: "Degradado",         price: 40  },
];

// ──────────────────────────────────────────────
// USER SESSION (in-memory, resets on restart)
// ──────────────────────────────────────────────
const sessions = {}; // chatId → { lang, history[], step, booking }

function getSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = { lang: null, history: [], step: null, booking: {} };
  }
  return sessions[chatId];
}

// ──────────────────────────────────────────────
// TEXTS
// ──────────────────────────────────────────────
const T = {
  chooseLanguage: "🌐 Choose language / Выберите язык / Elige idioma:",
  welcome: {
    en: (name) => `👋 Hey ${name}! Welcome to *${SHOP.name}*.\nWhat can I help you with?`,
    ru: (name) => `👋 Привет, ${name}! Добро пожаловать в *${SHOP.name}*.\nЧем могу помочь?`,
    es: (name) => `👋 ¡Hola ${name}! Bienvenido a *${SHOP.name}*.\n¿En qué puedo ayudarte?`,
  },
  menu: {
    en: "✂️ Main Menu",
    ru: "✂️ Главное меню",
    es: "✂️ Menú principal",
  },
  priceTitle: {
    en: "💈 Our Services & Prices:",
    ru: "💈 Наши услуги и цены:",
    es: "💈 Servicios y precios:",
  },
  infoTitle: {
    en: `📍 *${SHOP.name}*\n\n📌 ${SHOP.address}\n📞 ${SHOP.phone}\n📸 ${SHOP.instagram}`,
    ru: `📍 *${SHOP.name}*\n\n📌 ${SHOP.address}\n📞 ${SHOP.phone}\n📸 ${SHOP.instagram}`,
    es: `📍 *${SHOP.name}*\n\n📌 ${SHOP.address}\n📞 ${SHOP.phone}\n📸 ${SHOP.instagram}`,
  },
  hoursLabel: { en: "🕐 Hours:", ru: "🕐 Часы работы:", es: "🕐 Horario:" },
  bookingStart: {
    en: "📅 What's your name?",
    ru: "📅 Введите ваше имя:",
    es: "📅 ¿Cuál es tu nombre?",
  },
  bookingPhone: {
    en: "📱 Your phone number:",
    ru: "📱 Ваш номер телефона:",
    es: "📱 Tu número de teléfono:",
  },
  bookingDate: {
    en: "🗓 Preferred date & time (e.g. Jun 15, 3pm):",
    ru: "🗓 Удобная дата и время (например: 15 июня, 15:00):",
    es: "🗓 Fecha y hora preferida (ej: 15 jun, 3pm):",
  },
  bookingService: {
    en: "💈 Which service?",
    ru: "💈 Какая услуга?",
    es: "💈 ¿Qué servicio deseas?",
  },
  bookingConfirm: {
    en: (b) => `✅ *Booking received!*\n\nName: ${b.name}\nPhone: ${b.phone}\nDate: ${b.date}\nService: ${b.service}\n\nWe'll confirm shortly. You can also book online:\n${SHOP.bookingUrl}`,
    ru: (b) => `✅ *Заявка принята!*\n\nИмя: ${b.name}\nТел: ${b.phone}\nДата: ${b.date}\nУслуга: ${b.service}\n\nСкоро подтвердим. Также можно записаться онлайн:\n${SHOP.bookingUrl}`,
    es: (b) => `✅ *¡Cita recibida!*\n\nNombre: ${b.name}\nTel: ${b.phone}\nFecha: ${b.date}\nServicio: ${b.service}\n\nConfirmaremos pronto. También puedes reservar online:\n${SHOP.bookingUrl}`,
  },
  ownerNotify: (b, lang) =>
    `🔔 *Новая запись!*\n\nИмя: ${b.name}\nТел: ${b.phone}\nДата: ${b.date}\nУслуга: ${b.service}\nЯзык: ${lang}`,
  aiLabel: {
    en: "🤖 Ask me anything about the barbershop:",
    ru: "🤖 Задайте любой вопрос о барбершопе:",
    es: "🤖 Pregunta lo que quieras sobre la barbería:",
  },
  back: { en: "⬅️ Back", ru: "⬅️ Назад", es: "⬅️ Volver" },
  thinking: { en: "Thinking...", ru: "Думаю...", es: "Pensando..." },
};

// ──────────────────────────────────────────────
// KEYBOARDS
// ──────────────────────────────────────────────
const langKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "🇺🇸 English", callback_data: "lang_en" },
        { text: "🇷🇺 Русский", callback_data: "lang_ru" },
        { text: "🇪🇸 Español", callback_data: "lang_es" },
      ],
    ],
  },
};

function mainMenuKeyboard(lang) {
  const btns = {
    en: [
      [{ text: "📅 Book Appointment", callback_data: "book" }],
      [{ text: "💈 Price List",        callback_data: "prices" }, { text: "📍 Info & Hours",  callback_data: "info" }],
      [{ text: "🤖 Ask AI",            callback_data: "ai" },     { text: "🌐 Language",      callback_data: "change_lang" }],
    ],
    ru: [
      [{ text: "📅 Записаться",     callback_data: "book" }],
      [{ text: "💈 Прайс-лист",     callback_data: "prices" }, { text: "📍 Адрес и часы", callback_data: "info" }],
      [{ text: "🤖 AI-чат",         callback_data: "ai" },     { text: "🌐 Язык",         callback_data: "change_lang" }],
    ],
    es: [
      [{ text: "📅 Reservar cita",  callback_data: "book" }],
      [{ text: "💈 Precios",        callback_data: "prices" }, { text: "📍 Info & Horario", callback_data: "info" }],
      [{ text: "🤖 Preguntar AI",   callback_data: "ai" },     { text: "🌐 Idioma",          callback_data: "change_lang" }],
    ],
  };
  return { reply_markup: { inline_keyboard: btns[lang] || btns.en } };
}

function servicesKeyboard(lang) {
  const nameKey = `name_${lang}`;
  const rows = SERVICES.map((s) => [{ text: `${s[nameKey] || s.name_en} — $${s.price}`, callback_data: `svc_${s.name_en}` }]);
  rows.push([{ text: T.back[lang], callback_data: "menu" }]);
  return { reply_markup: { inline_keyboard: rows } };
}

function backKeyboard(lang) {
  return { reply_markup: { inline_keyboard: [[{ text: T.back[lang], callback_data: "menu" }]] } };
}

// ──────────────────────────────────────────────
// AI CHAT
// ──────────────────────────────────────────────
const AI_SYSTEM = `You are a helpful assistant for ${SHOP.name}, a barbershop in Los Angeles.
Address: ${SHOP.address}. Phone: ${SHOP.phone}.
Services: ${SERVICES.map((s) => `${s.name_en} $${s.price}`).join(", ")}.
Hours: Mon-Sat 9am-8pm, Sun 10am-6pm.
Be friendly, concise (max 3 sentences). Answer in the same language the user writes in.
If asked about booking, mention: ${SHOP.bookingUrl}
Do not invent information not listed above.`;

async function askAI(history, userMessage) {
  const messages = [...history, { role: "user", content: userMessage }];
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 400,
    system: AI_SYSTEM,
    messages,
  });
  return response.content[0].text;
}

// ──────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────
function sendMenu(chatId, lang) {
  return bot.sendMessage(chatId, T.menu[lang], { parse_mode: "Markdown", ...mainMenuKeyboard(lang) });
}

function buildPriceList(lang) {
  const nameKey = `name_${lang}`;
  const lines = SERVICES.map((s) => `• ${s[nameKey] || s.name_en} — *$${s.price}*`);
  return `${T.priceTitle[lang]}\n\n${lines.join("\n")}`;
}

// ──────────────────────────────────────────────
// /start
// ──────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  session.step = "choose_lang";
  await bot.sendMessage(chatId, T.chooseLanguage, langKeyboard);
});

// ──────────────────────────────────────────────
// CALLBACK QUERIES
// ──────────────────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const session = getSession(chatId);
  const firstName = query.from.first_name || "friend";

  await bot.answerCallbackQuery(query.id);

  // ── Language selection ──
  if (data.startsWith("lang_")) {
    session.lang = data.replace("lang_", "");
    session.step = null;
    await bot.sendMessage(chatId, T.welcome[session.lang](firstName), {
      parse_mode: "Markdown",
      ...mainMenuKeyboard(session.lang),
    });
    return;
  }

  const lang = session.lang || "en";

  if (data === "change_lang") {
    session.step = "choose_lang";
    await bot.sendMessage(chatId, T.chooseLanguage, langKeyboard);
    return;
  }

  if (data === "menu") {
    session.step = null;
    await sendMenu(chatId, lang);
    return;
  }

  // ── Price list ──
  if (data === "prices") {
    await bot.sendMessage(chatId, buildPriceList(lang), {
      parse_mode: "Markdown",
      ...backKeyboard(lang),
    });
    return;
  }

  // ── Info ──
  if (data === "info") {
    const text = `${T.infoTitle[lang]}\n\n${T.hoursLabel[lang]}\n${SHOP.hours[lang]}`;
    await bot.sendMessage(chatId, text, { parse_mode: "Markdown", ...backKeyboard(lang) });
    return;
  }

  // ── Booking: start ──
  if (data === "book") {
    session.step = "book_name";
    session.booking = {};
    await bot.sendMessage(chatId, T.bookingStart[lang], backKeyboard(lang));
    return;
  }

  // ── Booking: service selected ──
  if (data.startsWith("svc_")) {
    const svcName = data.replace("svc_", "");
    session.booking.service = svcName;
    session.step = "book_date";
    await bot.sendMessage(chatId, T.bookingDate[lang], backKeyboard(lang));
    return;
  }

  // ── AI chat: enter mode ──
  if (data === "ai") {
    session.step = "ai_chat";
    session.history = [];
    await bot.sendMessage(chatId, T.aiLabel[lang], backKeyboard(lang));
    return;
  }
});

// ──────────────────────────────────────────────
// TEXT MESSAGES (booking flow + AI chat)
// ──────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  const lang = session.lang || "en";
  const text = msg.text.trim();

  // ── No language selected yet ──
  if (!session.lang) {
    await bot.sendMessage(chatId, T.chooseLanguage, langKeyboard);
    return;
  }

  // ── Booking flow ──
  if (session.step === "book_name") {
    session.booking.name = text;
    session.step = "book_phone";
    await bot.sendMessage(chatId, T.bookingPhone[lang], backKeyboard(lang));
    return;
  }

  if (session.step === "book_phone") {
    session.booking.phone = text;
    session.step = "book_service";
    await bot.sendMessage(chatId, T.bookingService[lang], servicesKeyboard(lang));
    return;
  }

  if (session.step === "book_date") {
    session.booking.date = text;
    session.step = null;

    const b = session.booking;
    // Confirm to user
    await bot.sendMessage(chatId, T.bookingConfirm[lang](b), {
      parse_mode: "Markdown",
      ...mainMenuKeyboard(lang),
    });
    // Notify owner
    if (OWNER_CHAT_ID) {
      await bot.sendMessage(OWNER_CHAT_ID, T.ownerNotify(b, lang), { parse_mode: "Markdown" });
    }
    return;
  }

  // ── AI Chat ──
  if (session.step === "ai_chat") {
    const thinking = await bot.sendMessage(chatId, T.thinking[lang]);
    try {
      const reply = await askAI(session.history, text);
      session.history.push({ role: "user", content: text });
      session.history.push({ role: "assistant", content: reply });
      // Keep last 10 messages to save tokens
      if (session.history.length > 10) session.history = session.history.slice(-10);
      await bot.deleteMessage(chatId, thinking.message_id);
      await bot.sendMessage(chatId, reply, backKeyboard(lang));
    } catch (err) {
      await bot.deleteMessage(chatId, thinking.message_id);
      await bot.sendMessage(chatId, "⚠️ Error. Try again.", backKeyboard(lang));
      console.error("AI error:", err);
    }
    return;
  }

  // ── Fallback ──
  await sendMenu(chatId, lang);
});

console.log("✅ Barber bot started...");
