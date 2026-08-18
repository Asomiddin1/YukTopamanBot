require('dotenv').config();
let TelegramBot = require('node-telegram-bot-api');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const input = require('input');
const mysql = require('mysql2/promise');
const { OpenAI } = require('openai');

// ==========================================
// QULAB TUSHISHDAN MUTLAQ HIMOYA (ANTI-CRASH)
// ==========================================
process.on('uncaughtException', (err) => {
    console.error("⚠️ Kutilmagan xato (Bot o'chib qolishidan asrab qolindi):", err.message);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error("⚠️ Tarmoq uzilishi yoki ulanish xatosi (Kutmoqdamiz):", reason.message || reason);
});

// ES Module xatosini oldini olish
if (typeof TelegramBot !== 'function' && TelegramBot.default) {
    TelegramBot = TelegramBot.default;
}

// Bot va OpenRouter ulanishi
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const openai = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER,
});

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const stringSession = new StringSession(process.env.SESSION_STRING || '');
const adminId = process.env.ADMIN_ID;
let client;

bot.on('polling_error', (error) => console.log("⚠️ Telegram uzilishi (Kutmoqdamiz)..."));
bot.on('error', (error) => console.log("⚠️ Telegram Xatosi:", error.message));

// ==========================================
// MYSQL BAZA BILAN ISHLASH
// ==========================================
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

async function initDB() {
    try {
        await pool.query("CREATE TABLE IF NOT EXISTS drivers (chatId VARCHAR(50) PRIMARY KEY, home TEXT, current TEXT, isSearching INT DEFAULT 0, searchEndTime BIGINT, step TEXT, status TEXT, username TEXT, truckType VARCHAR(50) DEFAULT 'small')");

        try {
            await pool.query("ALTER TABLE drivers ADD COLUMN truckType VARCHAR(50) DEFAULT 'small'");
        } catch (e) { }

        await pool.query("CREATE TABLE IF NOT EXISTS channels (id INT AUTO_INCREMENT PRIMARY KEY, chatId VARCHAR(50), channelId VARCHAR(50), title TEXT, username TEXT)");
        console.log("✅ MySQL bazasiga ulandi va jadvallar tayyor!");
    } catch (err) {
        console.error("❌ MySQL ulanishda xato:", err.message);
    }
}
initDB();

const getDriver = async (chatId) => {
    const [rows] = await pool.query("SELECT * FROM drivers WHERE chatId = ?", [chatId.toString()]);
    return rows[0];
};

const updateDriver = async (chatId, field, value) => {
    const allowedFields = ['home', 'current', 'isSearching', 'searchEndTime', 'step', 'status', 'username', 'truckType'];
    if (allowedFields.includes(field)) {
        await pool.query(`UPDATE drivers SET ${field} = ? WHERE chatId = ?`, [value, chatId.toString()]);
    }
};

const getChannelsDetailed = async (chatId) => {
    const [rows] = await pool.query("SELECT id, channelId, title, username FROM channels WHERE chatId = ?", [chatId.toString()]);
    return rows;
};

const deleteChannel = async (id, chatId) => {
    await pool.query("DELETE FROM channels WHERE id = ? AND chatId = ?", [id, chatId.toString()]);
};

const getActiveSearches = async () => {
    const [rows] = await pool.query("SELECT * FROM drivers WHERE isSearching = 1");
    return rows;
};

function escapeHTML(str) { return str ? str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : ""; }

async function fetchChannelMessages(ch, limit = 35) {
    try {
        if (!client || !client.connected) return [];
        let peer = ch.username ? ch.username : BigInt(ch.channelId.toString().replace('-100', ''));

        const messagesPromise = client.getMessages(peer, { limit });
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 8000));
        return await Promise.race([messagesPromise, timeoutPromise]);
    } catch (e) {
        try {
            return await client.getMessages(ch.channelId, { limit });
        } catch (err) {
            console.log(`⚠️ Guruhdan xabarlar olinmadi (${ch.title}):`, err.message);
            return [];
        }
    }
}

// ==========================================
// MENYU VA KLAVIATURALAR
// ==========================================
const mainMenu = {
    reply_markup: {
        keyboard: [
            [{ text: "📍 Turgan joyni tanlash" }, { text: "🏁 Boradigan viloyatlar" }],
            [{ text: "🚚 Mashina yuk vazni" }],
            [{ text: "➕ Kanal/Guruh qo'shish" }, { text: "📊 Holat va Kanallar" }],
            [{ text: "🔍 Jonli qidiruv (30 daqiqa)" }, { text: "🛑 To'xtatish" }],
            [{ text: "🕒 So'nggi 30 daqiqani izlash" }]
        ],
        resize_keyboard: true
    }
};

const regionsList = [
    "Andijon", "Buxoro", "Farg'ona", "Jizzax", "Xorazm",
    "Namangan", "Navoiy", "Qashqadaryo", "Qoraqalpog'iston",
    "Samarqand", "Sirdaryo", "Surxondaryo", "Toshkent"
];

function getCurrentLocationKeyboard() {
    let kb = [];
    for (let i = 0; i < regionsList.length; i += 2) {
        let row = [{ text: regionsList[i], callback_data: 'cur_' + regionsList[i] }];
        if (regionsList[i + 1]) row.push({ text: regionsList[i + 1], callback_data: 'cur_' + regionsList[i + 1] });
        kb.push(row);
    }
    return { inline_keyboard: kb };
}

function getDestLocationsKeyboard(selectedStr) {
    let selected = selectedStr ? selectedStr.split(',').map(s => s.trim()).filter(s => s) : [];
    let kb = [];
    for (let i = 0; i < regionsList.length; i += 2) {
        let r1 = regionsList[i];
        let r2 = regionsList[i + 1];

        let row = [{ text: (selected.includes(r1) ? "✅ " : "") + r1, callback_data: 'dest_' + r1 }];
        if (r2) row.push({ text: (selected.includes(r2) ? "✅ " : "") + r2, callback_data: 'dest_' + r2 });
        kb.push(row);
    }
    kb.push([{ text: "💾 Saqlash", callback_data: "dest_save" }]);
    return { inline_keyboard: kb };
}

function getTruckTypeKeyboard() {
    return {
        inline_keyboard: [
            [{ text: "🚛 Kichkina Isuzu (8 tonnagacha)", callback_data: "truck_small" }],
            [{ text: "🚚 Katta Isuzu (8 tonnadan ko'p)", callback_data: "truck_big" }],
            [{ text: "🔄 Barchasi (Farqi yo'q)", callback_data: "truck_all" }]
        ]
    };
}


// GPT-4o-mini BILAN QAT'IY TAHLIL

async function analyzeLoad(messageText, currentLocation, homeLocation, truckType = 'small') {
    if (messageText.length < 15) return false;

    try {
        const safeText = messageText.substring(0, 800).replace(/\s+/g, ' ').trim();

        let truckRule = "";
        if (truckType === 'small') {
            truckRule = `3. MASHINA TURI VA YUK VAZNI (KICHKINA ISUZU):
- Haydovchida Kichkina Isuzu (8 tonnagacha bo'lgan yuklar uchun).
- E'londa "kichkina isuzu", "mayda isuzu", "kichik isuzu", "isuzu", "labo", "porter", "gazel" so'zlari yoki 8 tonnagacha (masalan: 1t, 2t, 3t, 4t, 5t, 6t, 7t, 8 tonnagacha) og'irlik bo'lsa -> MOS.
- Agar e'londa yuk 8 tonnadan ortiq ekani ochiq aytilgan bo'lsa (masalan: 9t, 10t, 15t, 20t, 22t, fura, tirkama, katta mashina, 10 tonnalik) -> QAT'IY "MOS_EMAS".
- Agar yuk vazni yoki mashina turi yozilmagan bo'lsa, lekin yo'nalish to'g'ri bo'lsa -> "MOS".`;
        } else if (truckType === 'big') {
            truckRule = `3. MASHINA TURI VA YUK VAZNI (KATTA ISUZU):
- Haydovchida Katta Isuzu (8 tonnadan ortiq yuklar uchun).
- E'londa 8 tonnadan ortiq yuk (masalan: 9t, 10t, 12t, 15t, 20t, fura, katta isuzu, 10 tonnalik va h.k.) so'ralgan bo'lsa -> MOS.
- Agar e'londa "kichkina isuzu", "mayda isuzu", "labo", "porter" yoki aniq 8 tonnadan kam (1-5 tonna) kichik yuk aytilgan bo'lsa -> QAT'IY "MOS_EMAS".
- Agar yuk vazni yozilmagan bo'lsa, lekin yo'nalish to'g'ri bo'lsa -> "MOS".`;
        } else {
            truckRule = `3. MASHINA TURI: Har qanday yuk vazni va mashina turi mos keladi.`;
        }

        console.log(`\n--- 🤖 AI TAHLIL: [Turgan joy: ${currentLocation}] ➡️ [Boradigan: ${homeLocation}] (${truckType}) ---`);
        console.log(`📦 E'lon: "${safeText.substring(0, 100)}..."`);

        const prompt = `Sen O'zbekiston telegram yuk tashish e'lonlarini tahlil qiluvchi juda qat'iy va aqlli logistika tizimisan.

HAYDOVCHI MA'LUMOTLARI:
- Haydovchi HOZIR TURGAN hudud (Yuk faqat shu viloyat/tumandan boshlanishi shart): "${currentLocation}"
- Haydovchi BORISHI MUMKIN BO'LGAN hududlar (Yuk shu viloyatlarga borishi kerak): "${homeLocation}"
- Haydovchi mashinasi: ${truckType === 'small' ? 'Kichkina Isuzu (8 tonnagacha / mayda isuzu)' : (truckType === 'big' ? 'Katta Isuzu (8 tonnadan ko\'p)' : 'Barchasi')}

O'ZBEK TILI E'LONLARINI TO'G'RI TUSHUNISH QOIDALARI:
1. QAYERDAN (Yuk qayerdan yuklanadi):
   - So'z oxirida "-dan", "-den" qo'shimchasi bo'ladi (Masalan: "Arnasoydan", "Jizzaxdan", "Jarqo'rg'ondan", "Toshkentdan").
   - Yoki yo'nalish boshida birinchi kelgan shahar (Masalan: "Jizzax Arnasoy - Surxondaryo").
2. QAYERGA (Yuk qayerga yetkaziladi):
   - So'z oxirida "-ga", "-ka", "-qa" qo'shimchasi bo'ladi (Masalan: "Surxondaryoga", "Jarqo'rg'onga", "Toshkentga", "Chirchiqqa").
   - Yoki yo'nalishda ikkinchi kelgan shahar (Masalan: "Jizzax -> Surxondaryo").

MUHIM OGOHLANTIRISH VA QAT'IY SHARTLAR:
1. YUK BOSHLANISHI (QAYERDAN):
   - E'londagi yuk FAQAT VA FAQAT "${currentLocation}" viloyati (yoki uning tuman/shaharlari) dan boshlanishi SHART!
   - AGAR YUK BOSHQASIDAN BO'LSA (Masalan: e'londa "Jizzax Arnasoydan Surxondaryoga" deyilgan, lekin haydovchi Surxondaryoda turgan bo'lsa — bu yuk Jizzaxdan olinadi, haydovchiga to'g'ri kelmaydi!), BUNDAY TESKARI VA BEGONA YUKLARNI QAT'IY "MOS_EMAS" DEB BAHOLA!
2. YUK BORISHI (QAYERGA):
   - Yuk "${homeLocation}" ro'yxatida keltirilgan viloyatlardan biriga (yoki ularning tuman/shaharlariga) borishi SHART!
${truckRule}

E'lon matni:
"""${safeText}"""

Faqat ushbu JSON formatda javob ber:
{
  "qayerdan": "Yuk yuklanadigan joy (aniqlangan shahar/tuman)",
  "qayerga": "Yuk tushiriladigan joy (aniqlangan shahar/tuman)",
  "sabab": "Nega mos yoki mos emasligi (qisqa tushuntirish)",
  "natija": "MOS yoki MOS_EMAS"
}`;

        const chatCompletion = await openai.chat.completions.create({
            messages: [{ role: 'user', content: prompt }],
            model: 'openai/gpt-4o-mini',
            temperature: 0.0,
            response_format: { type: "json_object" }
        });

        const responseText = chatCompletion.choices[0]?.message?.content?.trim() || "{}";
        const resultJSON = JSON.parse(responseText);

        console.log(`🧠 AI XULOSASI: ${resultJSON.qayerdan} ➡️ ${resultJSON.qayerga} | Sabab: ${resultJSON.sabab} | Natija: ${resultJSON.natija}`);
        return resultJSON.natija === "MOS";
    } catch (error) {
        if (error.message.includes('429')) console.log("⏳ OpenRouter Limiti to'ldi. Kuting...");
        else console.error("❌ OpenRouter AI Xatosi:", error.message);
        return false;
    }
}

// ==========================================
// BOT BOSHQARUVI VA MENYU LOGIKASI
// ==========================================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const text = msg.text || "";
    const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name || "Noma'lum";

    let driver = await getDriver(chatId);

    if (!driver) {
        let initialStatus = (chatId === adminId) ? 'approved' : 'pending';
        await pool.query("INSERT INTO drivers (chatId, status, username, truckType) VALUES (?, ?, ?, 'small')", [chatId, initialStatus, username]);
        driver = await getDriver(chatId);

        if (chatId !== adminId && adminId) {
            bot.sendMessage(adminId, `🔔 <b>Yangi foydalanuvchi botdan foydalanishga ruxsat so'rayapti!</b>\n\n👤 Foydalanuvchi: ${username}\n🆔 ID: <code>${chatId}</code>`, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✅ Ruxsat berish", callback_data: `approve_${chatId}` }, { text: "🚫 Bloklash", callback_data: `block_${chatId}` }]
                    ]
                }
            });
        }
    } else {
        if (driver.username !== username) {
            await updateDriver(chatId, 'username', username);
            driver.username = username;
        }
    }

    if (!client || !client.connected) {
        bot.sendMessage(chatId, "⏳ Tizim Telegram serverlariga ulanmoqda...");
        return;
    }

    // ==========================================
    // ADMIN BUYRUQLARI
    // ==========================================
    if (chatId === adminId) {
        if (text.startsWith('/sendall ')) {
            const msgToSend = text.substring(9).trim();
            if (!msgToSend) return bot.sendMessage(adminId, "⚠️ Xabar matnini kiriting! Format: /sendall xabar_matni");

            try {
                const [users] = await pool.query("SELECT chatId FROM drivers WHERE status = 'approved'");
                let count = 0;
                bot.sendMessage(adminId, `⏳ Xabar yuborilmoqda...`);

                for (const u of users) {
                    try {
                        await bot.sendMessage(u.chatId, `📢 <b>Admindan e'lon:</b>\n\n${escapeHTML(msgToSend)}`, { parse_mode: 'HTML' });
                        count++;
                        await new Promise(r => setTimeout(r, 300));
                    } catch (e) { console.log(`Xabar yuborishda xato (${u.chatId}): ${e.message}`); }
                }
                bot.sendMessage(adminId, `✅ Xabar muvaffaqiyatli ${count} ta foydalanuvchiga yuborildi!`);
            } catch (err) {
                bot.sendMessage(adminId, "❌ Baza bilan xatolik yuz berdi: " + err.message);
            }
            return;
        }

        if (text.startsWith('/send ')) {
            const parts = text.split(' ');
            const targetId = parts[1];
            const msgToSend = parts.slice(2).join(' ');

            if (!targetId || !msgToSend) {
                return bot.sendMessage(adminId, "⚠️ Format noto'g'ri. Bunday yozing:\n<code>/send 123456789 Salom, yaxshimisiz?</code>", { parse_mode: 'HTML' });
            }

            try {
                await bot.sendMessage(targetId, `💬 <b>Admindan xabar:</b>\n\n${escapeHTML(msgToSend)}`, { parse_mode: 'HTML' });
                bot.sendMessage(adminId, `✅ Xabar <code>${targetId}</code> raqamiga yuborildi.`, { parse_mode: 'HTML' });
            } catch (e) {
                bot.sendMessage(adminId, `❌ Yuborib bo'lmadi. Ehtimol foydalanuvchi botni bloklagan. Xato: ${e.message}`);
            }
            return;
        }

        if (text.startsWith('/approve ')) {
            const targetId = text.split(' ')[1];
            if (targetId) {
                await updateDriver(targetId, 'status', 'approved');
                bot.sendMessage(adminId, `✅ <code>${targetId}</code> ID egasi blokdan chiqarildi va ruxsat berildi.`, { parse_mode: 'HTML' });
                bot.sendMessage(targetId, "🎉 Tabriklaymiz, sizga botdan foydalanish uchun ruxsat berildi! /start buyrug'ini bosing.");
            }
            return;
        }

        if (text.startsWith('/block ')) {
            const targetId = text.split(' ')[1];
            if (targetId) {
                await updateDriver(targetId, 'status', 'blocked');
                bot.sendMessage(adminId, `🚫 <code>${targetId}</code> ID egasi bloklandi.`, { parse_mode: 'HTML' });
                bot.sendMessage(targetId, "🚫 Sizning botdan foydalanishingiz rad etildi/bloklandi.");
            }
            return;
        }

        if (text === '/admin') {
            try {
                const [users] = await pool.query("SELECT * FROM drivers");
                let msgText = "👥 <b>Barcha foydalanuvchilar:</b>\n\n";
                users.forEach((u, i) => {
                    let s = u.status === 'approved' ? '✅' : (u.status === 'blocked' ? '🚫' : '⏳');
                    msgText += `${i + 1}. ${u.username} (<code>${u.chatId}</code>) - ${s}\n`;
                });
                msgText += "\n<i>Boshqaruv buyruqlari:</i>\n";
                msgText += "✅ Ruxsat berish: <code>/approve ID</code>\n";
                msgText += "🚫 Bloklash: <code>/block ID</code>\n";
                msgText += "💬 Shaxsiy xabar: <code>/send ID xabar_matni</code>\n";
                msgText += "📢 Hammaga xabar: <code>/sendall xabar_matni</code>\n";

                bot.sendMessage(adminId, msgText, { parse_mode: 'HTML' });
            } catch (err) {
                bot.sendMessage(adminId, "Xatolik yuz berdi: " + err.message);
            }
            return;
        }
    }

    if (chatId !== adminId && driver.status !== 'approved') {
        if (driver.status === 'pending') bot.sendMessage(chatId, "⏳ Sizning so'rovingiz Adminga yuborildi. Ruxsat kutilmoqda...");
        else if (driver.status === 'blocked') bot.sendMessage(chatId, "🚫 Kechirasiz, sizning botdan foydalanishingiz bloklangan.");
        return;
    }

    if (text === '/start') {
        bot.sendMessage(chatId, "Yuk qidiruvchi aqlli botga xush kelibsiz!", mainMenu);
        return;
    }

    if (text === "📊 Holat va Kanallar") {
        const channels = await getChannelsDetailed(chatId);
        let statusText = driver.isSearching ? "🟢 <b>Faol</b>" : "🔴 <b>To'xtatilgan</b>";
        let remainingTime = "";

        if (driver.isSearching && driver.searchEndTime) {
            const timeLeftMs = driver.searchEndTime - Date.now();
            if (timeLeftMs > 0) remainingTime = `(⏳ ${Math.floor(timeLeftMs / (1000 * 60))} daq. qoldi)`;
            else statusText = "🔴 <b>Vaqti tugagan</b>";
        }

        const currentText = driver.current ? escapeHTML(driver.current) : "<i>Tanlanmagan</i> ❌";
        const homeText = driver.home ? escapeHTML(driver.home) : "<i>Tanlanmagan</i> ❌";
        const truckName = driver.truckType === 'small' ? '🚛 Kichkina Isuzu (8 tonnagacha)' : (driver.truckType === 'big' ? '🚚 Katta Isuzu (8 tonnadan ko\'p)' : '🔄 Barchasi');

        let messageText = `📊 <b>SIZNİNG JORIY HOLATINGIZ:</b>\n\n📍 <b>Turgan joy:</b> ${currentText}\n🏁 <b>Boradigan viloyatlar:</b> ${homeText}\n🚚 <b>Mashina turi:</b> ${escapeHTML(truckName)}\n🔍 <b>Qidiruv:</b> ${statusText} ${remainingTime}\n\n📡 <b>KUZATILAYOTGAN KANALLAR (${channels.length} ta):</b>\n`;

        if (channels.length === 0) {
            messageText += "<i>Hali kanal qo'shilmagan.</i>";
        } else {
            channels.forEach((ch, index) => {
                let link = ch.username ? `@${ch.username}` : "<i>(Yopiq guruh)</i>";
                messageText += `${index + 1}. <b>${escapeHTML(ch.title)}</b> — ${link}\n`;
            });
        }

        let inlineKeyboard = [];
        if (channels.length > 0) {
            channels.forEach((ch) => {
                const displayName = escapeHTML(ch.title.substring(0, 25));
                inlineKeyboard.push([{ text: `❌ ${displayName}`, callback_data: `del_channel_${ch.id}` }]);
            });
        }

        bot.sendMessage(chatId, messageText, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: inlineKeyboard.length > 0 ? { inline_keyboard: inlineKeyboard } : undefined
        });
        return;
    }

    if (text === "📍 Turgan joyni tanlash") {
        await updateDriver(chatId, 'step', null);
        bot.sendMessage(chatId, "Hozir qaysi hududda turibsiz? (Bitta tanlang):", { reply_markup: getCurrentLocationKeyboard() });
        return;
    }

    if (text === "🏁 Boradigan viloyatlar") {
        await updateDriver(chatId, 'step', null);
        bot.sendMessage(chatId, "Yuk qaysi viloyatlarga kerak? (Bir nechtasini belgilashingiz mumkin, oxirida Saqlashni bosing):", { reply_markup: getDestLocationsKeyboard(driver.home) });
        return;
    }

    if (text === "🚚 Mashina yuk vazni") {
        await updateDriver(chatId, 'step', null);
        bot.sendMessage(chatId, "Qaysi turdagi mashina / yuk vaznini qidirmoqchisiz?", { reply_markup: getTruckTypeKeyboard() });
        return;
    }

    if (text === "🔍 Jonli qidiruv (30 daqiqa)" || text.startsWith("🔍 Jonli qidiruv")) {
        const channels = await getChannelsDetailed(chatId);
        if (!driver.home || !driver.current || channels.length === 0) {
            bot.sendMessage(chatId, "❌ Avval turgan joyingizni, boradigan viloyatlarni va kanal kiriting!");
            return;
        }
        await updateDriver(chatId, 'isSearching', 1);
        await updateDriver(chatId, 'searchEndTime', Date.now() + (30 * 60 * 1000));
        bot.sendMessage(chatId, `✅ <b>Jonli qidiruv boshlandi!</b>\n📍 ${escapeHTML(driver.current)} ➡️ ${escapeHTML(driver.home)}\n⏱ 30 daqiqa davomida guruhlarga kelgan yangi e'lonlarni kuzataman.`, { parse_mode: "HTML" });
        return;
    }

    if (text === "🛑 To'xtatish") {
        await updateDriver(chatId, 'isSearching', 0);
        bot.sendMessage(chatId, "🚫 Qidiruv to'xtatildi.");
        return;
    }

    // ==========================================
    // SO'NGGI 30 DAQIQANI ASINXRON IZLASH (TEZKOR)
    // ==========================================
    if (text === "🕒 So'nggi 30 daqiqani izlash") {
        const channels = await getChannelsDetailed(chatId);
        if (!driver.home || !driver.current || channels.length === 0) {
            bot.sendMessage(chatId, "❌ Avval turgan joyni, boradigan joylarni va kanal kiriting!");
            return;
        }

        bot.sendMessage(chatId, "⚡️ <b>So'nggi 30 daqiqadagi e'lonlar asinxron tahlil qilinmoqda...</b>\n<i>Mos yuk topilishi bilan darhol tashlanadi.</i>", { parse_mode: "HTML" });
        bot.sendChatAction(chatId, 'typing');

        let foundCount = 0;
        const startTimestamp = Math.floor((Date.now() - (30 * 60 * 1000)) / 1000);

        const channelTasks = channels.map(async (ch) => {
            try {
                console.log(`\n📡 Guruh o'qilmoqda: ${ch.title}`);
                const messages = await fetchChannelMessages(ch, 35);

                const recentMessages = messages.filter(msg => msg.date >= startTimestamp && msg.text && msg.text.length >= 15);

                await Promise.all(recentMessages.map(async (msg) => {
                    try {
                        const isMatch = await analyzeLoad(msg.text, driver.current, driver.home, driver.truckType || 'small');
                        if (isMatch) {
                            foundCount++;
                            let cleanId = ch.channelId.replace("-100", "");
                            let link = msg.chat?.username ? `https://t.me/${msg.chat.username}/${msg.id}` : `https://t.me/c/${cleanId}/${msg.id}`;
                            await bot.sendMessage(chatId, `🕒 <b>Yarim soatlik arxivdan:</b>\n\n📦 ${escapeHTML(msg.text)}\n\n🔗 <a href="${link}">Xabarga o'tish</a>\n🏢 ${escapeHTML(ch.title)}`, { parse_mode: "HTML", disable_web_page_preview: true });
                        }
                    } catch (e) {
                        console.error("Xabar tahlilida xato:", e.message);
                    }
                }));
            } catch (err) {
                console.log(`❌ Guruhni o'qishda XATO (${ch.title}):`, err.message);
            }
        });

        await Promise.all(channelTasks);
        bot.sendMessage(chatId, `✅ <b>Tekshiruv yakunlandi.</b> Jami topildi: ${foundCount} ta yuk.`, { parse_mode: "HTML" });
        return;
    }

    if (text === "➕ Kanal/Guruh qo'shish") {
        await updateDriver(chatId, 'step', 'add_channel');
        bot.sendMessage(chatId, "Kuzatmoqchi bo'lgan guruh ssilkasini yuboring:\n<i>O'zingiz u guruhga a'zo bo'lishingiz shart!</i>", { parse_mode: "HTML" });
        return;
    }

    if (driver.step === 'add_channel') {
        await updateDriver(chatId, 'step', null);
        try {
            const entity = await client.getEntity(text);
            const idStr = entity.id.toString();
            const channels = await getChannelsDetailed(chatId);
            const isExist = channels.find(c => c.channelId.replace('-100', '') === idStr.replace('-100', ''));

            const isNotMember = entity.left === true;

            if (!isExist) {
                await pool.query("INSERT INTO channels (chatId, channelId, title, username) VALUES (?, ?, ?, ?)", [chatId, idStr, entity.title || "Nomsiz", entity.username || ""]);

                if (isNotMember) {
                    bot.sendMessage(adminId, `🔔 <b>YANGI GURUHGA QO'SHILISH SO'ROVI</b>\n\n👤 Foydalanuvchi: ${driver.username}\n🔗 Ssilka: ${text}\n\nBu Ochiq guruh, lekin sizning Userbotingiz unga a'zo emas. Iltimos, Telegramingizdan shu guruhga qo'shilib qo'ying, aks holda yuklar kelmaydi!`, { parse_mode: 'HTML' });
                    bot.sendMessage(chatId, `⏳ <b>${escapeHTML(entity.title)}</b> bazaga qo'shildi!\n\n⚠️ Lekin bizning tizim hali bu guruhda yo'q. Adminga obuna bo'lish so'rovi yuborildi. Admin guruhga kirgach, xabarlar avtomatik kela boshlaydi.`, { parse_mode: "HTML", ...mainMenu });
                } else {
                    bot.sendMessage(chatId, `✅ <b>${escapeHTML(entity.title)}</b> muvaffaqiyatli qo'shildi!`, { parse_mode: "HTML", ...mainMenu });
                }
            } else {
                bot.sendMessage(chatId, "⚠️ Kanal allaqachon qo'shilgan.", mainMenu);
            }
        } catch (error) {
            bot.sendMessage(adminId, `🔔 <b>YOPIQ GURUH SO'ROVI</b>\n\n👤 Foydalanuvchi: ${driver.username}\n🔗 Ssilka: ${text}\n\nBu yopiq guruh bo'lishi mumkin. Iltimos, Userbot orqali shu guruhga obuna bo'ling.`, { parse_mode: 'HTML' });
            bot.sendMessage(chatId, `⏳ <b>Bu guruh yopiq yoki topilmadi!</b>\n\nAdminga obuna bo'lish so'rovi yuborildi. Admin bu guruhga qo'shilgandan so'ng, uni qaytadan qo'shib ko'rasiz.`, { parse_mode: "HTML", ...mainMenu });
        }
    }
});

// ==========================================
// CALLBACK QUERY (INLINE TUGMALAR)
// ==========================================
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id.toString();
    const messageId = query.message.message_id;

    if (chatId === adminId && (data.startsWith('approve_') || data.startsWith('block_'))) {
        const isApprove = data.startsWith('approve_');
        const targetChatId = data.split('_')[1];
        await updateDriver(targetChatId, 'status', isApprove ? 'approved' : 'blocked');

        bot.editMessageText(query.message.text + (isApprove ? "\n\n✅ <b>RUXSAT BERILDI</b>" : "\n\n🚫 <b>BLOKLANDI</b>"), {
            chat_id: chatId, message_id: messageId, parse_mode: 'HTML'
        });

        if (isApprove) {
            bot.sendMessage(targetChatId, "🎉 Tabriklaymiz, ruxsat berildi! /start ni bosing.", { reply_markup: { remove_keyboard: true } });
        } else {
            bot.sendMessage(targetChatId, "🚫 Sizning botdan foydalanishingiz rad etildi.");
        }
        bot.answerCallbackQuery(query.id);
        return;
    }

    let driver = await getDriver(chatId);

    if (data.startsWith('cur_')) {
        let region = data.replace('cur_', '');
        await updateDriver(chatId, 'current', region);
        bot.editMessageText(`✅ Turgan joyingiz: <b>${region}</b> etib belgilandi.`, {
            chat_id: chatId, message_id: messageId, parse_mode: "HTML"
        });
    }
    else if (data.startsWith('dest_')) {
        if (data === 'dest_save') {
            bot.editMessageText(`✅ Boradigan viloyatlar saqlandi:\n<b>${driver.home || "Tanlanmagan"}</b>`, {
                chat_id: chatId, message_id: messageId, parse_mode: "HTML"
            });
        } else {
            let region = data.replace('dest_', '');
            let selected = driver.home ? driver.home.split(',').map(s => s.trim()).filter(s => s) : [];

            if (selected.includes(region)) {
                selected = selected.filter(r => r !== region);
            } else {
                selected.push(region);
            }

            let newSelectedStr = selected.join(', ');
            await updateDriver(chatId, 'home', newSelectedStr);

            bot.editMessageReplyMarkup(getDestLocationsKeyboard(newSelectedStr), {
                chat_id: chatId, message_id: messageId
            });
        }
    }
    else if (data.startsWith('truck_')) {
        let type = data.replace('truck_', '');
        let typeName = type === 'small' ? '🚛 Kichkina Isuzu (8 tonnagacha)' : (type === 'big' ? '🚚 Katta Isuzu (8 tonnadan ko\'p)' : '🔄 Barchasi');
        await updateDriver(chatId, 'truckType', type);
        bot.editMessageText(`✅ Mashina turi belgilandi:\n<b>${typeName}</b>`, {
            chat_id: chatId, message_id: messageId, parse_mode: "HTML"
        });
    }
    else if (data.startsWith('del_channel_')) {
        const channelId = data.replace('del_channel_', '');
        await deleteChannel(channelId, chatId);

        const updatedChannels = await getChannelsDetailed(chatId);
        let statusText = driver.isSearching ? "🟢 <b>Faol</b>" : "🔴 <b>To'xtatilgan</b>";
        const currentText = driver.current ? escapeHTML(driver.current) : "<i>Tanlanmagan</i> ❌";
        const homeText = driver.home ? escapeHTML(driver.home) : "<i>Tanlanmagan</i> ❌";
        const truckName = driver.truckType === 'small' ? '🚛 Kichkina Isuzu (8 tonnagacha)' : (driver.truckType === 'big' ? '🚚 Katta Isuzu (8 tonnadan ko\'p)' : '🔄 Barchasi');

        let newMessageText = `📊 <b>SIZNİNG JORIY HOLATINGIZ:</b>\n\n📍 <b>Turgan joy:</b> ${currentText}\n🏁 <b>Boradigan viloyatlar:</b> ${homeText}\n🚚 <b>Mashina turi:</b> ${escapeHTML(truckName)}\n🔍 <b>Qidiruv:</b> ${statusText}\n\n📡 <b>KUZATILAYOTGAN KANALLAR (${updatedChannels.length} ta):</b>\n`;

        if (updatedChannels.length === 0) {
            newMessageText += "<i>Hali kanal qo'shilmagan.</i>";
        } else {
            updatedChannels.forEach((ch, index) => {
                let link = ch.username ? `@${ch.username}` : "<i>(Yopiq guruh)</i>";
                newMessageText += `${index + 1}. <b>${escapeHTML(ch.title)}</b> — ${link}\n`;
            });
        }

        let inlineKeyboard = [];
        if (updatedChannels.length > 0) {
            updatedChannels.forEach((ch) => {
                const displayName = escapeHTML(ch.title.substring(0, 25));
                inlineKeyboard.push([{ text: `❌ ${displayName}`, callback_data: `del_channel_${ch.id}` }]);
            });
        }

        bot.editMessageText(newMessageText, {
            chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
            reply_markup: inlineKeyboard.length > 0 ? { inline_keyboard: inlineKeyboard } : undefined
        });

        bot.answerCallbackQuery(query.id, { text: "✅ Kanal o'chirildi", show_alert: false });
        return;
    }
    bot.answerCallbackQuery(query.id);
});

// ==========================================
// USERBOT - JONLI QIDIRUV (TEST SESSIYASI GENERATSIYASI BILAN)
// ==========================================
(async () => {
    client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 10, autoReconnect: true });
    await client.start({
        phoneNumber: async () => await input.text("Telefon raqam (Test userbot uchun): "),
        password: async () => await input.text("Parol (agar 2FA bo'lsa): "),
        phoneCode: async () => await input.text("Telegramdan kelgan Kod: "),
        onError: (err) => console.log(err),
    });

    console.log("✅ Tizim ulandi! Botingiz ishlashga tayyor.");

    // Yangi yaratilgan test sessiyasini konsolga chiqarish:
    const currentSavedSession = client.session.save();
    if (!process.env.SESSION_STRING || process.env.SESSION_STRING !== currentSavedSession) {
        console.log("\n=======================================================");
        console.log("🔑 SIZNING YANGI TEST SESSION_STRING KALITINGIZ:");
        console.log(currentSavedSession);
        console.log("👉 Bu qatorni .env faylidagi SESSION_STRING= ga qo'yib qo'ying!");
        console.log("=======================================================\n");
    }

    console.log("🔄 Guruhlar ro'yxati xotiraga yuklanmoqda (Biroz kuting)...");
    await client.getDialogs();
    console.log("✅ Guruhlar xotiraga muvaffaqiyatli yuklandi!");

    client.addEventHandler(async (event) => {
        (async () => {
            try {
                const message = event.message;
                const text = message?.message || message?.text || "";

                if (text.length < 15) return;

                let chatIdStr = "";
                if (message.chatId) {
                    chatIdStr = message.chatId.toString();
                } else if (message.peerId) {
                    const peer = message.peerId;
                    chatIdStr = (peer.channelId || peer.chatId || peer.userId || "").toString();
                }

                if (!chatIdStr) return;

                const drivers = await getActiveSearches();
                if (drivers.length === 0) return;

                const cleanMsgChatId = chatIdStr.replace('-100', '');

                await Promise.all(drivers.map(async (d) => {
                    if (Date.now() >= d.searchEndTime) {
                        await updateDriver(d.chatId, 'isSearching', 0);
                        bot.sendMessage(d.chatId, "⏰ 30 daqiqalik jonli qidiruv yakunlandi. Davom etish uchun yana 'Jonli qidiruv'ni bosing.");
                        return;
                    }

                    const channels = await getChannelsDetailed(d.chatId);
                    const isMyChannel = channels.find(c => c.channelId.replace('-100', '') === cleanMsgChatId);

                    if (isMyChannel) {
                        console.log(`✅ [${d.username}] Guruh bazada bor! Tezkor AI tahlili...`);

                        const isMatch = await analyzeLoad(text, d.current, d.home, d.truckType || 'small');
                        if (isMatch) {
                            console.log(`🎉 YUK MOS KELDI! Botga darhol yuborilmoqda.`);
                            const chat = await event.getChat().catch(() => null);
                            const chatTitle = chat ? (chat.title || chat.username || chatIdStr) : (isMyChannel.title || chatIdStr);
                            let link = chat?.username ? `https://t.me/${chat.username}/${message.id}` : `https://t.me/c/${cleanMsgChatId}/${message.id}`;

                            await bot.sendMessage(d.chatId, `🚨 <b>YANGI MOS YUK!</b>\n\n📦 ${escapeHTML(text)}\n\n🔗 <a href="${link}">Xabarga o'tish</a>\n🏢 ${escapeHTML(chatTitle)}`, { parse_mode: "HTML", disable_web_page_preview: true });
                        }
                    }
                }));
            } catch (err) {
                console.error("Userbot event xatosi:", err.message);
            }
        })();
    }, new NewMessage({ incoming: true, outgoing: true }));
})();