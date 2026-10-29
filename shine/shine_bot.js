// ============================================================
// shine_bot.js — VINMEZ demo: Shine Mobile Detailing (fictional)
// Same flow as Warded: site → /api/booking → Telegram card with
// "✋ Take job" → tech claims → On my way → Done + amount →
// client gets a review request. Owner gets /stats.
//
// ENV (Railway → Variables):
//   BOT_TOKEN        — BotFather token of the demo bot (required)
//   OWNER_ID         — owner's Telegram ID (gets every lead + /stats)
//   MASTERS_CHAT_ID  — technicians group ID (optional; until set, cards go to OWNER_ID)
//   CLAUDE_KEY       — Anthropic key for the site chat (optional; scripted replies without it)
//   ADMIN_PASSWORD   — password for /api/bookings (admin dashboard, later)
// ============================================================

const http = require("http");
const fs = require("fs");
const path = require("path");
const SITE_HTML = fs.readFileSync(path.join(__dirname, "public", "index.html"));
const TelegramBot = require("node-telegram-bot-api");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const OWNER_ID = process.env.OWNER_ID || "6418710736";
let MASTERS_CHAT_ID = process.env.MASTERS_CHAT_ID || "";
const CLAUDE_KEY = process.env.CLAUDE_KEY || "";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const UNCLAIMED_MIN = Number(process.env.UNCLAIMED_MIN || 10);

const bot = BOT_TOKEN ? new TelegramBot(BOT_TOKEN, { polling: true }) : null;
if (!bot) console.warn("⚠️ BOT_TOKEN not set — HTTP API runs, Telegram is off.");

// ── Business config ────────────────────────────────────────
const BIZ = { name: "Shine Mobile Detailing", phone: "(323) 555-0100", area: "West Hollywood · Beverly Hills · Santa Monica · Studio City · DTLA" };
const PACKAGES = {
  express: { en: "Express Wash", ru: "Экспресс-мойка", es: "Lavado Express", price: 49, mins: 45 },
  full:    { en: "Full Detail", ru: "Полный детейлинг", es: "Detallado Completo", price: 149, mins: 150 },
  ceramic: { en: "Ceramic Coating", ru: "Керамика", es: "Recubrimiento Cerámico", price: 499, mins: 360 },
};
const VEHICLES = {
  sedan: { en: "Sedan", ru: "Седан", es: "Sedán", add: 0 },
  suv:   { en: "SUV", ru: "Кроссовер/SUV", es: "SUV", add: 20 },
  truck: { en: "Truck / Van", ru: "Пикап/вэн", es: "Camioneta", add: 40 },
};
const priceFor = (pkg, veh) => {
  const p = PACKAGES[pkg]?.price || 0, a = VEHICLES[veh]?.add || 0;
  return p + (pkg === "ceramic" ? a * 2 : a);
};

// ── Storage (in memory; fine for a demo) ───────────────────
const jobs = new Map();            // ref → job
const techs = new Map();           // tgId → { name, taken, done, dropped, earned }
let seq = 1000 + Math.floor(Math.random() * 900);
const newRef = () => "SH-" + (++seq);
const sessions = new Map();        // chatId → { lang, step, draft }

const esc = (s) => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const laTime = (d) => new Date(d).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const teamChat = () => MASTERS_CHAT_ID || OWNER_ID;

// ── Job card (what the team sees) ──────────────────────────
function cardText(j) {
  let t = `🆕 <b>New order ${j.ref}</b>${j.urgent ? " · 🚨 ASAP" : ""}\n` +
    `🚗 ${esc(j.packageName)} · ${esc(j.vehicleName)}\n` +
    `📍 ${esc(j.address)}\n` +
    `🗓 ${esc(j.date)} ${esc(j.time)}\n` +
    `💵 <b>$${j.price}</b>${j.photo ? " · 📷 photo" : ""}\n` +
    `🌐 Source: ${j.source}`;
  if (j.notes) t += `\n📝 ${esc(j.notes)}`;
  if (j.status === "new") t += `\n\n👤 Client contact unlocks after you take the job.`;
  if (j.status !== "new") t += `\n\n✅ <b>Taken by ${esc(j.techName)}</b> · ${laTime(j.takenAt)}`;
  if (j.status === "onway") t += `\n🚗 On the way`;
  if (j.status === "done") t += `\n🏁 <b>Done · paid $${j.paid}</b> · ${laTime(j.doneAt)}`;
  if (j.status === "dropped") t += `\n↩️ Released back to the group`;
  return t;
}
const takeKb = (ref) => ({ inline_keyboard: [[{ text: "✋ Take job", callback_data: `take:${ref}` }]] });

async function publish(j) {
  if (!bot) return;
  const opts = { parse_mode: "HTML", reply_markup: takeKb(j.ref) };
  let msg;
  try {
    if (j.photo) msg = await bot.sendPhoto(teamChat(), j.photo, { caption: cardText(j), ...opts }, { filename: "car.jpg", contentType: "image/jpeg" });
    else msg = await bot.sendMessage(teamChat(), cardText(j), opts);
    j.card = { chat: msg.chat.id, id: msg.message_id, photo: !!j.photo };
  } catch (e) { console.error("publish:", e.message); }
  // If the team is a separate group, the owner also gets a short copy
  if (MASTERS_CHAT_ID && String(MASTERS_CHAT_ID) !== String(OWNER_ID)) {
    bot.sendMessage(OWNER_ID, `📥 Lead ${j.ref} posted to the team · ${esc(j.packageName)} · $${j.price}\n👤 ${esc(j.name)} · ${esc(j.phone)}`, { parse_mode: "HTML" }).catch(() => {});
  }
  // Nobody took it in N minutes → owner
  j.timer = setTimeout(() => {
    if (j.status === "new" || j.status === "dropped") {
      bot.sendMessage(OWNER_ID, `⏰ ${j.ref} has no taker after ${UNCLAIMED_MIN} min.\n👤 ${esc(j.name)} · ${esc(j.phone)}\n📍 ${esc(j.address)}`,
        { parse_mode: "HTML", reply_markup: takeKb(j.ref) }).catch(() => {});
      notifyClient(j, { en: "Thanks for waiting! A senior specialist will contact you shortly.", ru: "Спасибо, что ждёте! С вами скоро свяжется старший специалист.", es: "¡Gracias por esperar! Un especialista te contactará pronto." });
    }
  }, UNCLAIMED_MIN * 60 * 1000);
}

async function refreshCard(j, kb) {
  if (!bot || !j.card) return;
  const where = { chat_id: j.card.chat, message_id: j.card.id, parse_mode: "HTML", reply_markup: kb || { inline_keyboard: [] } };
  try {
    if (j.card.photo) await bot.editMessageCaption(cardText(j), where);
    else await bot.editMessageText(cardText(j), where);
  } catch (e) { if (!/not modified/.test(e.message)) console.error("edit:", e.message); }
}

function notifyClient(j, texts) {
  if (!bot || !j.clientChat) return;
  const t = texts[j.lang] || texts.en;
  bot.sendMessage(j.clientChat, t, { parse_mode: "HTML" }).catch(() => {});
}

function createJob(b) {
  const pkg = PACKAGES[b.package] ? b.package : "full";
  const veh = VEHICLES[b.vehicle] ? b.vehicle : "sedan";
  const j = {
    ref: newRef(), status: "new", created: new Date().toISOString(),
    source: b.source || "website", lang: ["en", "ru", "es"].includes(b.lang) ? b.lang : "en",
    package: pkg, packageName: PACKAGES[pkg].en, vehicle: veh, vehicleName: VEHICLES[veh].en,
    price: priceFor(pkg, veh), name: String(b.name || "").slice(0, 80), phone: String(b.phone || "").slice(0, 40),
    address: String(b.address || "").slice(0, 200), date: String(b.date || "").slice(0, 20), time: String(b.time || "").slice(0, 30),
    notes: String(b.notes || "").slice(0, 300), urgent: !!b.urgent, photo: b.photo || null, clientChat: b.clientChat || null,
  };
  jobs.set(j.ref, j);
  return j;
}

// ── Telegram: team side ────────────────────────────────────
function tech(u) {
  const id = String(u.id);
  if (!techs.has(id)) techs.set(id, { name: u.first_name + (u.username ? ` (@${u.username})` : ""), taken: 0, done: 0, dropped: 0, earned: 0 });
  return techs.get(id);
}
const workKb = (ref, s) => ({ inline_keyboard: s === "onway"
  ? [[{ text: "🏁 Done — enter amount", callback_data: `done:${ref}` }], [{ text: "❌ Drop", callback_data: `drop:${ref}` }]]
  : [[{ text: "🚗 On my way", callback_data: `go:${ref}` }, { text: "❌ Drop", callback_data: `drop:${ref}` }], [{ text: "🏁 Done — enter amount", callback_data: `done:${ref}` }]] });

if (bot) {
  bot.on("callback_query", async (q) => {
    const [act, ref, extra] = (q.data || "").split(":");
    const ans = (text, alert) => bot.answerCallbackQuery(q.id, { text, show_alert: !!alert }).catch(() => {});

    // client-side buttons
    if (act === "lang" || act === "pkg" || act === "veh" || act === "when" || act === "rate") return clientButton(q, act, ref, extra);

    const j = jobs.get(ref);
    if (!j) return ans("This demo job expired (bot restarted).", true);
    const me = String(q.from.id);

    if (act === "take") {
      if (j.status !== "new" && j.status !== "dropped") return ans(`Already taken by ${j.techName}`, true);
      j.status = "taken"; j.tech = me; j.techName = tech(q.from).name; j.takenAt = new Date().toISOString();
      tech(q.from).taken++;
      clearTimeout(j.timer);
      ans("✅ Job is yours. Details sent in private chat.");
      await refreshCard(j);
      bot.sendMessage(me,
        `✅ <b>You took ${j.ref}</b>\n🚗 ${esc(j.packageName)} · ${esc(j.vehicleName)} · <b>$${j.price}</b>\n` +
        `👤 ${esc(j.name)} · <code>${esc(j.phone)}</code>\n📍 ${esc(j.address)}\n🗓 ${esc(j.date)} ${esc(j.time)}` +
        (j.notes ? `\n📝 ${esc(j.notes)}` : "") + `\n\nCall the client within 5 minutes to confirm.`,
        { parse_mode: "HTML", reply_markup: workKb(j.ref, "taken") }
      ).catch(() => bot.sendMessage(q.message.chat.id, `${q.from.first_name}, open a private chat with me and press Start so I can send you the job details.`).catch(() => {}));
      notifyClient(j, {
        en: `✅ Your order ${j.ref} is confirmed. Your detailer is <b>${esc(q.from.first_name)}</b>, they will call you shortly.`,
        ru: `✅ Заказ ${j.ref} подтверждён. Ваш мастер — <b>${esc(q.from.first_name)}</b>, он скоро позвонит.`,
        es: `✅ Tu pedido ${j.ref} está confirmado. Tu detallador es <b>${esc(q.from.first_name)}</b>, te llamará pronto.`,
      });
      return;
    }

    if (j.tech !== me && me !== String(OWNER_ID)) return ans("This is not your job.", true);

    if (act === "go") {
      j.status = "onway"; ans("🚗 Client notified");
      bot.editMessageReplyMarkup(workKb(ref, "onway"), { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
      await refreshCard(j);
      notifyClient(j, { en: "🚗 Your detailer is on the way.", ru: "🚗 Мастер выехал к вам.", es: "🚗 Tu detallador va en camino." });
    } else if (act === "drop") {
      j.status = "dropped"; tech(q.from).dropped++; ans("Released back to the group");
      bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
      await refreshCard(j, takeKb(ref));
      bot.sendMessage(OWNER_ID, `↩️ ${j.techName} dropped ${j.ref}`).catch(() => {});
    } else if (act === "done") {
      sessions.set(me, { ...(sessions.get(me) || {}), step: "amount", ref });
      ans();
      bot.sendMessage(me, `💵 How much did the client pay for ${j.ref}? Send a number, e.g. <code>${j.price}</code>`, { parse_mode: "HTML" });
    }
  });

  bot.on("my_chat_member", (u) => {
    if (["group", "supergroup"].includes(u.chat.type) && ["member", "administrator"].includes(u.new_chat_member.status)) {
      bot.sendMessage(OWNER_ID, `👥 Bot added to group "${u.chat.title}".\nGroup ID: <code>${u.chat.id}</code>\nSend /setteam in that group to route jobs there.`, { parse_mode: "HTML" }).catch(() => {});
    }
  });
}

// ── Telegram: client side (booking inside Telegram) ────────
const L = {
  hello: { en: `👋 Hi! This is <b>${BIZ.name}</b>, a mobile car wash. We come to you.\n\nPick a package:`, ru: `👋 Здравствуйте! Это <b>${BIZ.name}</b>, выездная мойка. Мы приедем к вам.\n\nВыберите пакет:`, es: `👋 ¡Hola! Somos <b>${BIZ.name}</b>, lavado a domicilio.\n\nElige un paquete:` },
  veh: { en: "What do you drive?", ru: "Какая у вас машина?", es: "¿Qué vehículo tienes?" },
  price: { en: (p) => `💵 Your price: <b>$${p}</b>\nWhen do you need it?`, ru: (p) => `💵 Ваша цена: <b>$${p}</b>\nКогда удобно?`, es: (p) => `💵 Tu precio: <b>$${p}</b>\n¿Cuándo lo necesitas?` },
  addr: { en: "📍 Send the address where the car is parked.", ru: "📍 Пришлите адрес, где стоит машина.", es: "📍 Envía la dirección donde está el auto." },
  phone: { en: "📱 Your name and phone number?", ru: "📱 Ваше имя и номер телефона?", es: "📱 ¿Tu nombre y teléfono?" },
  photo: { en: "📷 Send a photo of the car (or type “skip”).", ru: "📷 Пришлите фото машины (или напишите «нет»).", es: "📷 Envía una foto del auto (o escribe “no”)." },
  sent: { en: (r) => `✅ Request <b>${r}</b> sent. A detailer will confirm within a few minutes.`, ru: (r) => `✅ Заявка <b>${r}</b> отправлена. Мастер подтвердит в течение нескольких минут.`, es: (r) => `✅ Solicitud <b>${r}</b> enviada. Un detallador confirmará en minutos.` },
  review: { en: "🏁 All done! How was the service?", ru: "🏁 Готово! Как вам работа?", es: "🏁 ¡Listo! ¿Qué tal el servicio?" },
  paid: { en: "One more question for quality control: how much did you pay the detailer?", ru: "И вопрос для контроля качества: сколько вы заплатили мастеру?", es: "Una pregunta de control de calidad: ¿cuánto pagaste al detallador?" },
  thanks: { en: "Thank you! ⭐ Leave a Google review here: g.page/shine-demo (demo link)", ru: "Спасибо! ⭐ Оставьте отзыв в Google: g.page/shine-demo (демо-ссылка)", es: "¡Gracias! ⭐ Deja una reseña en Google: g.page/shine-demo (demo)" },
};
const tr = (k, lang, ...a) => { const v = L[k][lang] || L[k].en; return typeof v === "function" ? v(...a) : v; };
const pkgKb = (lang) => ({ inline_keyboard: Object.entries(PACKAGES).map(([k, p]) => [{ text: `${p[lang]} · from $${p.price}`, callback_data: `pkg:${k}` }]) });
const vehKb = (lang) => ({ inline_keyboard: [Object.entries(VEHICLES).map(([k, v]) => ({ text: v[lang], callback_data: `veh:${k}` }))] });
const whenKb = (lang) => ({ inline_keyboard: [[
  { text: lang === "ru" ? "Сегодня" : lang === "es" ? "Hoy" : "Today", callback_data: "when:today" },
  { text: lang === "ru" ? "Завтра" : lang === "es" ? "Mañana" : "Tomorrow", callback_data: "when:tomorrow" },
  { text: "ASAP 🚨", callback_data: "when:asap" }]] });

function ses(id) { if (!sessions.has(String(id))) sessions.set(String(id), { lang: "en", draft: {} }); return sessions.get(String(id)); }

async function clientButton(q, act, val, extra) {
  const id = String(q.message.chat.id), s = ses(id);
  bot.answerCallbackQuery(q.id).catch(() => {});
  if (act === "lang") { s.lang = val; s.draft = {}; return bot.sendMessage(id, tr("hello", s.lang), { parse_mode: "HTML", reply_markup: pkgKb(s.lang) }); }
  if (act === "pkg") { s.draft.package = val; return bot.sendMessage(id, tr("veh", s.lang), { reply_markup: vehKb(s.lang) }); }
  if (act === "veh") { s.draft.vehicle = val; return bot.sendMessage(id, tr("price", s.lang, priceFor(s.draft.package, val)), { parse_mode: "HTML", reply_markup: whenKb(s.lang) }); }
  if (act === "when") {
    const d = new Date(Date.now() + (val === "tomorrow" ? 864e5 : 0)).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    s.draft.date = val === "asap" ? "ASAP" : d; s.draft.time = val === "asap" ? "Now" : "flexible"; s.draft.urgent = val === "asap";
    s.step = "addr"; return bot.sendMessage(id, tr("addr", s.lang));
  }
  if (act === "rate") {
    const j = jobs.get(val); if (!j) return;
    j.rating = Number(extra);
    s.step = "paid"; s.ref = val;
    return bot.sendMessage(id, tr("paid", s.lang));
  }
}

if (bot) {
  bot.onText(/^\/start/, (m) => {
    if (m.chat.type !== "private") return;
    bot.sendMessage(m.chat.id, `🇺🇸 Choose language · 🇷🇺 Выберите язык · 🇪🇸 Elige idioma`, {
      reply_markup: { inline_keyboard: [[{ text: "English", callback_data: "lang:en" }, { text: "Русский", callback_data: "lang:ru" }, { text: "Español", callback_data: "lang:es" }]] } });
  });

  bot.onText(/^\/setteam/, (m) => {
    if (String(m.from.id) !== String(OWNER_ID)) return;
    if (!["group", "supergroup"].includes(m.chat.type)) return bot.sendMessage(m.chat.id, "Send /setteam inside the technicians group.");
    MASTERS_CHAT_ID = String(m.chat.id);
    bot.sendMessage(m.chat.id, `✅ New jobs will be posted here.\n(Group ID ${m.chat.id}. To keep this after a restart, set MASTERS_CHAT_ID on Railway.)`);
  });

  bot.onText(/^\/stats/, (m) => {
    if (String(m.from.id) !== String(OWNER_ID)) return;
    bot.sendMessage(m.chat.id, statsText(), { parse_mode: "HTML" });
  });

  bot.onText(/^\/test/, async (m) => {
    if (String(m.from.id) !== String(OWNER_ID)) return;
    const j = createJob({ package: "full", vehicle: "suv", name: "Alex Rivera (test)", phone: "(323) 555-0148", address: "8560 Sunset Blvd, West Hollywood", date: "tomorrow", time: "10:00–12:00", source: "test" });
    await publish(j);
  });

  bot.on("message", async (m) => {
    if (m.chat.type !== "private" || (m.text && m.text.startsWith("/"))) return;
    const id = String(m.chat.id), s = ses(id);

    if (s.step === "amount") {                 // technician closes a job
      const j = jobs.get(s.ref), amt = Number(String(m.text || "").replace(/[^0-9.]/g, ""));
      if (!j || !amt) return bot.sendMessage(id, "Send the amount as a number, e.g. 149");
      j.status = "done"; j.paid = amt; j.doneAt = new Date().toISOString(); s.step = null;
      const t = techs.get(id); if (t) { t.done++; t.earned += amt; }
      await refreshCard(j);
      bot.sendMessage(id, `🏁 ${j.ref} closed · $${amt}. Thanks!`);
      if (amt < j.price) bot.sendMessage(OWNER_ID, `⚠️ ${j.ref}: quoted $${j.price}, tech reported $${amt}.`).catch(() => {});
      if (j.clientChat) {
        bot.sendMessage(j.clientChat, tr("review", j.lang), { reply_markup: { inline_keyboard: [[1, 2, 3, 4, 5].map(n => ({ text: n + "⭐", callback_data: `rate:${j.ref}:${n}` }))] } }).catch(() => {});
      }
      return;
    }
    if (s.step === "paid") {                    // client reports what they paid (anti-skim check)
      const j = jobs.get(s.ref), amt = Number(String(m.text || "").replace(/[^0-9.]/g, ""));
      s.step = null;
      bot.sendMessage(id, tr("thanks", s.lang));
      if (j) {
        j.clientPaid = amt || m.text;
        const flag = amt && j.paid && amt > j.paid ? `\n🚩 Client says $${amt}, tech reported $${j.paid}` : " ✅ matches";
        bot.sendMessage(OWNER_ID, `⭐ ${j.ref}: rating ${j.rating || "—"}/5 · client paid ${amt ? "$" + amt : esc(m.text)}${flag}`).catch(() => {});
      }
      return;
    }
    if (s.step === "addr") { s.draft.address = m.text || (m.location ? `${m.location.latitude},${m.location.longitude}` : ""); s.step = "phone"; return bot.sendMessage(id, tr("phone", s.lang)); }
    if (s.step === "phone") {
      const txt = m.text || ""; const ph = (txt.match(/[\d()+\-\s]{7,}/) || [""])[0].trim();
      s.draft.phone = ph || txt; s.draft.name = txt.replace(ph, "").replace(/[,;]/g, " ").trim() || m.from.first_name;
      s.step = "photo"; return bot.sendMessage(id, tr("photo", s.lang));
    }
    if (s.step === "photo") {
      let photo = null;
      if (m.photo) photo = m.photo[m.photo.length - 1].file_id;
      const j = createJob({ ...s.draft, lang: s.lang, source: "Telegram", clientChat: id, photo });
      s.step = null; s.draft = {};
      await publish(j);
      return bot.sendMessage(id, tr("sent", s.lang, j.ref), { parse_mode: "HTML" });
    }
    // free text with no flow → restart menu
    bot.sendMessage(id, tr("hello", s.lang), { parse_mode: "HTML", reply_markup: pkgKb(s.lang) });
  });

  bot.on("polling_error", (e) => console.error("polling:", e.code, e.message));
}

// ── Stats (owner /stats and admin API) ─────────────────────
function stats() {
  const all = [...jobs.values()];
  const done = all.filter(j => j.status === "done");
  return {
    total: all.length, open: all.filter(j => ["new", "dropped"].includes(j.status)).length,
    inProgress: all.filter(j => ["taken", "onway"].includes(j.status)).length,
    done: done.length, revenue: done.reduce((a, j) => a + (j.paid || 0), 0),
    leaderboard: [...techs.values()].sort((a, b) => b.done - a.done || b.earned - a.earned),
  };
}
function statsText() {
  const s = stats();
  let t = `📊 <b>${BIZ.name} · since last restart</b>\nOrders: ${s.total} · open ${s.open} · in progress ${s.inProgress} · done ${s.done}\nRevenue: <b>$${s.revenue}</b>\n\n🏆 <b>Technicians</b>`;
  if (!s.leaderboard.length) t += "\nNo jobs taken yet.";
  s.leaderboard.forEach((x, i) => { t += `\n${i + 1}. ${esc(x.name)} — taken ${x.taken}, done ${x.done}, dropped ${x.dropped}, $${x.earned}`; });
  return t;
}

// ── Site chat (Claude, with a scripted fallback) ───────────
const CHAT_SYSTEM = `You are the website assistant of ${BIZ.name}, a fictional mobile car wash and detailing company in Los Angeles (demo built by VINMEZ).
Packages (sedan prices): Express Wash $49 (~45 min: hand wash, wheels, windows, quick vacuum); Full Detail $149 (~2.5 h: + clay bar, sealant, seat shampoo or leather care); Ceramic Coating $499 (~6 h: + paint correction, 9H ceramic, 2-year protection). SUV +$20 (+$40 for ceramic), truck/van +$40 (+$80 for ceramic).
Membership: every 2 weeks, 15% off. Hours 7am–8pm, 7 days. We bring water and power. Service area: ${BIZ.area}. Pay after the job: card, Zelle or cash.
Reply in the customer's language (English, Spanish or Russian), 1–3 short sentences. To book, point them to the booking form on this page or ask for address, car and time. Never invent discounts.`;
async function aiReply(messages) {
  if (!CLAUDE_KEY) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": CLAUDE_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 300, system: CHAT_SYSTEM, messages: messages.slice(-8) }),
    });
    const d = await r.json();
    return d?.content?.[0]?.text || null;
  } catch { return null; }
}

// ── HTTP API ────────────────────────────────────────────────
const readBody = (req, max = 8e6) => new Promise((ok, no) => {
  let b = ""; req.on("data", c => { b += c; if (b.length > max) { no(new Error("too big")); req.destroy(); } });
  req.on("end", () => ok(b)); req.on("error", no);
});
const sendJSON = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const hits = new Map();
const limited = (ip) => { const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < 60000); arr.push(now); hits.set(ip, arr); return arr.length > 10; };

http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0];

  if (req.method === "GET" && req.url === "/health") return sendJSON(res, 200, { ok: true, bot: !!bot, team: MASTERS_CHAT_ID ? "group" : "owner" });
  if (req.method === "GET" && (req.url === "/" || req.url.startsWith("/?") || req.url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end(SITE_HTML);
  }

  if (req.method === "POST" && req.url === "/api/booking") {
    if (limited(ip)) return sendJSON(res, 429, { error: "Too many requests, try again in a minute." });
    try {
      const b = JSON.parse(await readBody(req));
      if (!b.name || !b.phone || !b.address) return sendJSON(res, 400, { error: "Name, phone and address are required." });
      let photo = null;
      if (typeof b.photo === "string" && b.photo.startsWith("data:image/")) photo = Buffer.from(b.photo.split(",")[1] || "", "base64");
      const j = createJob({ ...b, photo, source: "website", clientChat: null });
      await publish(j);
      return sendJSON(res, 200, { ok: true, ref: j.ref, price: j.price });
    } catch (e) { return sendJSON(res, 400, { error: "Bad request" }); }
  }

  if (req.method === "POST" && req.url === "/api/chat") {
    if (limited(ip)) return sendJSON(res, 429, { error: "Too many requests" });
    try {
      const { messages } = JSON.parse(await readBody(req, 2e4));
      const clean = (Array.isArray(messages) ? messages : []).filter(x => x && ["user", "assistant"].includes(x.role) && typeof x.content === "string")
        .map(x => ({ role: x.role, content: x.content.slice(0, 1000) }));
      while (clean.length && clean[0].role !== "user") clean.shift();
      if (!clean.length) return sendJSON(res, 400, { error: "No message" });
      const reply = await aiReply(clean);
      return sendJSON(res, 200, { reply });
    } catch { return sendJSON(res, 400, { error: "Bad request" }); }
  }

  if (req.method === "GET" && req.url === "/api/bookings") {
    const auth = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (!ADMIN_PASSWORD || auth !== ADMIN_PASSWORD) return sendJSON(res, 401, { error: "Unauthorized" });
    const list = [...jobs.values()].map(({ photo, timer, card, ...j }) => ({ ...j, photo: !!photo }));
    return sendJSON(res, 200, { stats: stats(), jobs: list });
  }

  sendJSON(res, 404, { error: "Not found" });
}).listen(process.env.PORT || 3000, () => console.log("🌐 Shine demo API on port " + (process.env.PORT || 3000)));
