require('dotenv').config();
let TelegramBot = require('node-telegram-bot-api');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const input = require('input');
const sqlite3 = require('sqlite3').verbose();
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

// --- BAZA BILAN ISHLASH ---
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error("Bazaga ulanishda xato:", err);
    else console.log("✅ SQLite bazasiga ulandi!");
});

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS drivers (chatId TEXT PRIMARY KEY, home TEXT, current TEXT, isSearching INTEGER, searchEndTime INTEGER, step TEXT, status TEXT, username TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS channels (id INTEGER PRIMARY KEY AUTOINCREMENT, chatId TEXT, channelId TEXT, title TEXT, username TEXT)");
    db.run("ALTER TABLE drivers ADD COLUMN status TEXT", (err) => { });
    db.run("ALTER TABLE drivers ADD COLUMN username TEXT", (err) => { });
});

const getDriver = (chatId) => new Promise(res => db.get("SELECT * FROM drivers WHERE chatId = ?", [chatId.toString()], (e, r) => res(r)));
const updateDriver = (chatId, field, value) => new Promise(res => db.run(`UPDATE drivers SET ${field} = ? WHERE chatId = ?`, [value, chatId.toString()], res));
const getChannelsDetailed = (chatId) => new Promise(res => db.all("SELECT id, channelId, title, username FROM channels WHERE chatId = ?", [chatId.toString()], (e, r) => res(r || [])));
const deleteChannel = (id, chatId) => new Promise(res => db.run("DELETE FROM channels WHERE id = ? AND chatId = ?", [id, chatId.toString()], res));
const getActiveSearches = () => new Promise(res => db.all("SELECT * FROM drivers WHERE isSearching = 1", (e, r) => res(r || [])));
function escapeHTML(str) { return str ? str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : ""; }

// ==========================================
// MENYU VA KLAVIATURALAR
// ==========================================
const mainMenu = {
    reply_markup: {
        keyboard: [
            [{ text: "📍 Turgan joyni tanlash" }, { text: "🏁 Boradigan viloyatlar" }],
            [{ text: "➕ Kanal/Guruh qo'shish" }, { text: "📊 Holat va Kanallar" }],
            [{ text: "🔍 Jonli qidiruv (15 daqiqa)" }, { text: "🛑 To'xtatish" }],
            [{ text: "🕒 So'nggi 30 daqiqani izlash" }],
            [{ text: "📅 Butun kunlik arxivni izlash" }]
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

// ==========================================
// GPT-4o-mini BILAN TAHLIL
// ==========================================
async function analyzeLoad(messageText, currentLocation, homeLocation) {
    if (messageText.length < 15) return false;

    try {
        const safeText = messageText.substring(0, 150).replace(/\s+/g, ' ').trim();

        console.log(`\n--- 🤖 GPT-4o-mini (OpenRouter) TAHLIL QILMOQDA ---`);
        console.log(`📍 Qidirilyapti: Qayerdan: ${currentLocation} ➡️ Qayerga: ${homeLocation}`);
        console.log(`📦 E'lon: "${safeText}..."`);

        const prompt = `Sen O'zbekiston telegram yuk e'lonlarini tahlil qiluvchi qat'iy logistika tizimisan.
Haydovchi hozir turgan hudud: "${currentLocation}"
Haydovchi borishga tayyor bo'lgan hududlar: "${homeLocation}"

QAT'IY QOIDALAR:
1. E'lonni o'qi va yuk aniq QAYERDAN olinib, QAYERGA ketyotganini top. O'zingdan shahar nomi to'qima!
2. YUK OLINADIGAN JOY (Eng muhimi!): Yuk FAQAT VA FAQAT "${currentLocation}" viloyatidan (yoki shu viloyatning istalgan tumanidan) olinishi shart! Agar yuk boshqa viloyatdan boshlansa, QAT'IY "MOS_EMAS" deb yoz. "Yo'l ustida" degan bahona o'tmaydi.
3. YUK BORADIGAN JOY: Yuk "${homeLocation}" da ko'rsatilgan viloyatlardan istalgan biriga (yoki ularning tumanlariga) borishi kerak.
4. Javobing FAQAT va FAQAT JSON ko'rinishida bo'lsin. Hech qanday qo'shimcha so'z qo'shma.

E'lon: "${safeText}"

Faqat ushbu JSON formatda javob ber:
{
  "qayerdan": "shahar nomi yoki YO'Q",
  "qayerga": "shahar nomi yoki YO'Q",
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

        console.log(`🧠 AI JAVOBI: ${resultJSON.qayerdan} ➡️ ${resultJSON.qayerga} | Natija: ${resultJSON.natija}`);
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

    // Foydalanuvchini bazaga qo'shish va Admindan ruxsat so'rash
    if (!driver) {
        let initialStatus = (chatId === adminId) ? 'approved' : 'pending';
        await new Promise((resolve) => db.run("INSERT INTO drivers (chatId, status, username) VALUES (?, ?, ?)", [chatId, initialStatus, username], resolve));
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
        bot.sendMessage(chatId, "⏳ Tizim serverlarga ulanmoqda...");
        return;
    }

    // ==========================================
    // ADMIN BUYRUQLARI (Bloklash / Ruxsat / Xabar yuborish)
    // ==========================================
    if (chatId === adminId) {

        // 1. Ommaviy xabar yuborish (Barchaga)
        if (text.startsWith('/sendall ')) {
            const msgToSend = text.substring(9).trim();
            if (!msgToSend) return bot.sendMessage(adminId, "⚠️ Xabar matnini kiriting! Format: /sendall xabar_matni");

            db.all("SELECT chatId FROM drivers WHERE status = 'approved'", async (err, users) => {
                if (err) return bot.sendMessage(adminId, "❌ Baza bilan xatolik yuz berdi.");
                let count = 0;
                bot.sendMessage(adminId, `⏳ Xabar yuborilmoqda...`);

                for (const u of users) {
                    try {
                        await bot.sendMessage(u.chatId, `📢 <b>Admindan e'lon:</b>\n\n${escapeHTML(msgToSend)}`, { parse_mode: 'HTML' });
                        count++;
                        await new Promise(r => setTimeout(r, 300)); // Telegram limitiga tushmaslik uchun pauza
                    } catch (e) {
                        console.log(`Xabar yuborishda xato (${u.chatId}): ${e.message}`);
                    }
                }
                bot.sendMessage(adminId, `✅ Xabar muvaffaqiyatli ${count} ta foydalanuvchiga yuborildi!`);
            });
            return;
        }

        // 2. Bitta aniq odamga xabar yuborish
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

        // 3. Ruxsat berish
        if (text.startsWith('/approve ')) {
            const targetId = text.split(' ')[1];
            if (targetId) {
                await updateDriver(targetId, 'status', 'approved');
                bot.sendMessage(adminId, `✅ <code>${targetId}</code> ID egasi blokdan chiqarildi va ruxsat berildi.`, { parse_mode: 'HTML' });
                bot.sendMessage(targetId, "🎉 Tabriklaymiz, sizga botdan foydalanish uchun ruxsat berildi! /start buyrug'ini bosing.");
            }
            return;
        }

        // 4. Bloklash
        if (text.startsWith('/block ')) {
            const targetId = text.split(' ')[1];
            if (targetId) {
                await updateDriver(targetId, 'status', 'blocked');
                bot.sendMessage(adminId, `🚫 <code>${targetId}</code> ID egasi bloklandi.`, { parse_mode: 'HTML' });
                bot.sendMessage(targetId, "🚫 Sizning botdan foydalanishingiz rad etildi/bloklandi.");
            }
            return;
        }

        // 5. Admin menyusi (Statistika va Yo'riqnoma)
        if (text === '/admin') {
            db.all("SELECT * FROM drivers", (err, users) => {
                if (err) return bot.sendMessage(adminId, "Xatolik yuz berdi.");
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
            });
            return;
        }
    }

    // Agar foydalanuvchi Admin bo'lmasa va ruxsati bo'lmasa, uni to'xtatamiz
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

        let messageText = `📊 <b>SIZNİNG JORIY HOLATINGIZ:</b>\n\n📍 <b>Turgan joy:</b> ${currentText}\n🏁 <b>Boradigan viloyatlar:</b> ${homeText}\n🔍 <b>Qidiruv:</b> ${statusText} ${remainingTime}\n\n📡 <b>KUZATILAYOTGAN KANALLAR (${channels.length} ta):</b>\n`;

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

    if (text === "🔍 Jonli qidiruv (15 daqiqa)") {
        const channels = await getChannelsDetailed(chatId);
        if (!driver.home || !driver.current || channels.length === 0) {
            bot.sendMessage(chatId, "❌ Avval turgan joyingizni, boradigan viloyatlarni va kanal kiriting!");
            return;
        }
        await updateDriver(chatId, 'isSearching', 1);
        await updateDriver(chatId, 'searchEndTime', Date.now() + (15 * 60 * 1000));
        bot.sendMessage(chatId, `✅ <b>Jonli qidiruv boshlandi!</b>\n📍 ${escapeHTML(driver.current)} ➡️ ${escapeHTML(driver.home)}\n⏱ 15 daqiqa davomida guruhlarga kelgan yangi e'lonlarni kuzataman.`, { parse_mode: "HTML" });
        return;
    }

    if (text === "🛑 To'xtatish") {
        await updateDriver(chatId, 'isSearching', 0);
        bot.sendMessage(chatId, "🚫 Qidiruv to'xtatildi.");
        return;
    }

    if (text === "🕒 So'nggi 30 daqiqani izlash") {
        const channels = await getChannelsDetailed(chatId);
        if (!driver.home || !driver.current || channels.length === 0) {
            bot.sendMessage(chatId, "❌ Avval turgan joyni, boradigan joylarni va kanal kiriting!");
            return;
        }
        bot.sendMessage(chatId, "⏳ <b>So'nggi 30 daqiqadagi e'lonlar tekshirilmoqda...</b>", { parse_mode: "HTML" });
        let foundCount = 0;
        const startTimestamp = Math.floor((Date.now() - (30 * 60 * 1000)) / 1000);

        for (const ch of channels) {
            try {
                console.log(`\n📡 Guruh tekshirilmoqda: ${ch.title}`);
                let peer = ch.username ? ch.username : BigInt(ch.channelId);
                const messages = await client.getMessages(peer, { limit: 40 });

                for (const msg of messages) {
                    if (msg.date >= startTimestamp && msg.text && msg.text.length >= 15) {
                        const isMatch = await analyzeLoad(msg.text, driver.current, driver.home);
                        await new Promise(r => setTimeout(r, 1000));

                        if (isMatch) {
                            foundCount++;
                            let cleanId = ch.channelId.replace("-100", "");
                            let link = msg.chat?.username ? `https://t.me/${msg.chat.username}/${msg.id}` : `https://t.me/c/${cleanId}/${msg.id}`;
                            bot.sendMessage(chatId, `🕒 <b>Yarim soatlik arxivdan:</b>\n\n📦 ${escapeHTML(msg.text)}\n\n🔗 <a href="${link}">Xabarga o'tish</a>`, { parse_mode: "HTML", disable_web_page_preview: true });
                        }
                    }
                }
            } catch (err) { console.log(`❌ Guruhni o'qishda XATO:`, err.message); }
        }
        bot.sendMessage(chatId, `✅ <b>Tekshiruv yakunlandi.</b> Topildi: ${foundCount} ta yuk.`, { parse_mode: "HTML" });
        return;
    }

    if (text === "📅 Butun kunlik arxivni izlash") {
        const channels = await getChannelsDetailed(chatId);
        if (!driver.home || !driver.current || channels.length === 0) {
            bot.sendMessage(chatId, "❌ Avval turgan joyni, boradigan joylarni va kanal kiriting!");
            return;
        }
        bot.sendMessage(chatId, "⏳ <b>Bugungi butun e'lonlar tekshirilmoqda...</b> (Kutish vaqti uzayishi mumkin)", { parse_mode: "HTML" });
        let foundCount = 0;
        const startTimestamp = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);

        for (const ch of channels) {
            try {
                console.log(`\n📡 Guruh tekshirilmoqda: ${ch.title}`);
                let peer = ch.username ? ch.username : BigInt(ch.channelId);
                const messages = await client.getMessages(peer, { limit: 100 });

                for (const msg of messages) {
                    if (msg.date >= startTimestamp && msg.text && msg.text.length >= 15) {
                        const isMatch = await analyzeLoad(msg.text, driver.current, driver.home);
                        await new Promise(r => setTimeout(r, 1000));

                        if (isMatch) {
                            foundCount++;
                            let cleanId = ch.channelId.replace("-100", "");
                            let link = msg.chat?.username ? `https://t.me/${msg.chat.username}/${msg.id}` : `https://t.me/c/${cleanId}/${msg.id}`;
                            bot.sendMessage(chatId, `📅 <b>Bugungi arxivdan:</b>\n\n📦 ${escapeHTML(msg.text)}\n\n🔗 <a href="${link}">Xabarga o'tish</a>`, { parse_mode: "HTML", disable_web_page_preview: true });
                        }
                    }
                }
            } catch (err) { console.log(`❌ Guruhni o'qishda XATO:`, err.message); }
        }
        bot.sendMessage(chatId, `✅ <b>Tekshiruv yakunlandi.</b> Topildi: ${foundCount} ta yuk.`, { parse_mode: "HTML" });
        return;
    }

    if (text === "➕ Kanal/Guruh qo'shish") {
        await updateDriver(chatId, 'step', 'add_channel');
        bot.sendMessage(chatId, "Kuzatmoqchi bo'lgan guruh ssilkasini yuboring:\n<i>O'zingiz u guruhga a'zo bo'lishingiz shart!</i>", { parse_mode: "HTML" });
        return;
    }

    // ==========================================
    // AQLLI GURUH QO'SHISH (Yangi tizim)
    // ==========================================
    if (driver.step === 'add_channel') {
        await updateDriver(chatId, 'step', null);
        try {
            const entity = await client.getEntity(text);
            const idStr = entity.id.toString();
            const channels = await getChannelsDetailed(chatId);
            const isExist = channels.find(c => c.channelId.replace('-100', '') === idStr.replace('-100', ''));

            const isNotMember = entity.left === true;

            if (!isExist) {
                db.run("INSERT INTO channels (chatId, channelId, title, username) VALUES (?, ?, ?, ?)", [chatId, idStr, entity.title || "Nomsiz", entity.username || ""]);

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

    // Admin Ruxsat berish/Bloklash
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

    // Foydalanuvchi joriy hududi (bitta tanlanadi)
    if (data.startsWith('cur_')) {
        let region = data.replace('cur_', '');
        await updateDriver(chatId, 'current', region);
        bot.editMessageText(`✅ Turgan joyingiz: <b>${region}</b> etib belgilandi.`, {
            chat_id: chatId, message_id: messageId, parse_mode: "HTML"
        });
    }
    // Boradigan viloyatlar (ko'p tanlanadi)
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
    // Kanal o'chirish
    else if (data.startsWith('del_channel_')) {
        const channelId = data.replace('del_channel_', '');
        await deleteChannel(channelId, chatId);
        
        // Xabarni yangilash
        const updatedChannels = await getChannelsDetailed(chatId);
        let statusText = driver.isSearching ? "🟢 <b>Faol</b>" : "🔴 <b>To'xtatilgan</b>";
        const currentText = driver.current ? escapeHTML(driver.current) : "<i>Tanlanmagan</i> ❌";
        const homeText = driver.home ? escapeHTML(driver.home) : "<i>Tanlanmagan</i> ❌";
        
        let newMessageText = `📊 <b>SIZNİNG JORIY HOLATINGIZ:</b>\n\n📍 <b>Turgan joy:</b> ${currentText}\n🏁 <b>Boradigan viloyatlar:</b> ${homeText}\n🔍 <b>Qidiruv:</b> ${statusText}\n\n📡 <b>KUZATILAYOTGAN KANALLAR (${updatedChannels.length} ta):</b>\n`;
        
        if (updatedChannels.length === 0) {
            newMessageText += "<i>Hali kanal qo'shilmagan.</i>";
        } else {
            updatedChannels.forEach((ch, index) => {
                let link = ch.username ? `@${ch.username}` : "<i>(Yopiq guruh)</i>";
                newMessageText += `${index + 1}. <b>${escapeHTML(ch.title)}</b> — ${link}\n`;
            });
        }
        
        // Yangi inline keyboard yaratish
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
// USERBOT - ORQA FONDA TINGLASH (DIAGNOSTIKA BILAN)
// ==========================================
// ==========================================
// USERBOT - ORQA FONDA TINGLASH (DIAGNOSTIKA BILAN)
// ==========================================
(async () => {
    client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
    await client.start({
        phoneNumber: async () => await input.text("Telefon raqam: "),
        password: async () => await input.text("Parol: "),
        phoneCode: async () => await input.text("Kod: "),
        onError: (err) => console.log(err),
    });
    console.log("✅ Tizim ulandi! Botingiz ishlashga tayyor.");

    console.log("🔄 Guruhlar ro'yxati xotiraga yuklanmoqda (Biroz kuting)...");
    await client.getDialogs();
    console.log("✅ Guruhlar xotiraga muvaffaqiyatli yuklandi!");

    // incoming: true va outgoing: true o'zingiz yozgan test xabarlarni ham ushlashi uchun
    client.addEventHandler(async (event) => {
        try {
            const message = event.message;
            
            // XATO SHU YERDA BO'LISHI MUMKIN: GramJS da matn message.message ichida keladi!
            const text = message?.message || message?.text || ""; 

            // === 1. BARCHA XABARLARNI TERMINALGA CHIQARAMIZ ===
            console.log(`\n🔔 [TIZIM TINGLAYAPTI] Xabar ushlandi! (Uzunligi: ${text.length}). Matn: "${text.substring(0, 30)}..."`);

            if (text.length < 15) {
                console.log(`⚠️ Xabar 15 ta harfdan kam bo'lgani uchun rad etildi.`);
                return;
            }

            const chat = await event.getChat();
            if (!chat || !chat.id) return;
            const chatIdStr = chat.id.toString();

            console.log(`📨 GURUH: "${chat.title || chatIdStr}"`);

            const drivers = await getActiveSearches();
            
            if (drivers.length === 0) {
                console.log(`⚠️ Hech kimda Jonli qidiruv yoqilmagan. O'tkazib yuborildi.`);
                return;
            }

            for (const d of drivers) {
                if (Date.now() >= d.searchEndTime) {
                    await updateDriver(d.chatId, 'isSearching', 0);
                    bot.sendMessage(d.chatId, "⏰ 15 daqiqalik jonli qidiruv yakunlandi. Davom etish uchun yana 'Jonli qidiruv'ni bosing.");
                    continue;
                }
                const channels = await getChannelsDetailed(d.chatId);
                const isMyChannel = channels.find(c => c.channelId.replace('-100', '') === chatIdStr.replace('-100', ''));

                if (!isMyChannel) {
                    console.log(`❌ Bu guruh haydovchining (${d.username}) ro'yxatida yo'q.`);
                } else {
                    // === 2. GURUH MOS KELSA AI GA YUBORAMIZ ===
                    console.log(`✅ Guruh bazada bor! AI tahliliga yuborilyapti...`);
                    
                    const isMatch = await analyzeLoad(text, d.current, d.home);
                    if (isMatch) {
                        console.log(`🎉 YUK MOS KELDI! Botga yuborilmoqda.`);
                        let cleanId = chatIdStr.replace("-100", "");
                        let link = chat.username ? `https://t.me/${chat.username}/${message.id}` : `https://t.me/c/${cleanId}/${message.id}`;
                        bot.sendMessage(d.chatId, `🚨 <b>YANGI MOS YUK!</b>\n\n📦 ${escapeHTML(text)}\n\n🔗 <a href="${link}">Xabarga o'tish</a>\n🏢 ${escapeHTML(chat.title)}`, { parse_mode: "HTML", disable_web_page_preview: true });
                    } else {
                        console.log(`🚫 AI rad etdi (Natija: MOS_EMAS).`);
                    }
                }
            }
        } catch (err) {
            console.error("Userbot event xatosi:", err.message);
        }
    }, new NewMessage({ incoming: true, outgoing: true }));
})();