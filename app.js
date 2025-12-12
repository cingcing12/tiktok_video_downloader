// ============================
// DEPENDENCIES
// ============================
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const express = require("express");
const PQueue = require("p-queue").default;
require("dotenv").config();

// ============================
// CONFIG
// ============================
const TOKEN = process.env.TOKEN;
const APP_URL = process.env.APP_URL; 
const PORT = process.env.PORT || 3000;

if (!TOKEN || !APP_URL) {
  console.error("❌ Please set TOKEN and APP_URL in .env file");
  process.exit(1);
}

// ============================
// EXPRESS SERVER
// ============================
const app = express();
app.use(express.json());
app.get("/", (req, res) => res.send("🐰 Telegram TikTok Bot is running!"));
app.listen(PORT, () => console.log(`Express server listening on port ${PORT}`));

// ============================
// TELEGRAM BOT (Polling mode)
// ============================
const bot = new TelegramBot(TOKEN, { polling: true });
console.log("✅ Bot started in polling mode!");

// ============================
// SELF-PING SYSTEM
// ============================
setInterval(() => {
  axios.get(APP_URL)
    .then(() => console.log("🔁 Self-ping successful"))
    .catch(err => console.log("❌ Self-ping failed:", err.message));
}, 4 * 60 * 1000); // 4 minutes

// ============================
// QUEUE SYSTEM
// ============================
const queue = new PQueue({ concurrency: 2 });

// ============================
// /start COMMAND
// ============================
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "🐰 Send me a TikTok link and I will download the video for you!"
  );
});

// ============================
// HELPER: Expand short TikTok URLs
// ============================
async function expandUrl(shortUrl) {
  try {
    const res = await axios.get(shortUrl, {
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 400
    });
    return res.headers.location || shortUrl;
  } catch {
    return shortUrl;
  }
}

// ============================
// MAIN HANDLER
// ============================
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || !text.includes("tiktok.com")) return;

  queue.add(() => handleDownload(chatId, text));
});

// ============================
// DOWNLOAD HANDLER (FIXED)
// ============================
async function handleDownload(chatId, text) {
  const sendingMsg = await bot.sendMessage(chatId, "⏳ Downloading TikTok video...");

  try {
    const url = await expandUrl(text);

    // ================================
    // API RETRY (fix failing for 2 users)
    // ================================
    let apiRes;
    for (let i = 0; i < 3; i++) {
      try {
        apiRes = await axios.get("https://tikwm.com/api/", { params: { url } });
        if (apiRes.data?.data?.play) break;
      } catch (err) {
        if (i === 2) throw new Error("TikWM failed 3 times");
      }
      await new Promise(res => setTimeout(res, 800));
    }

    const videoUrl = apiRes.data.data.play;

    // ================================
    // UNIQUE TEMP FOLDER PER USER
    // ================================
    const tempDir = path.join(__dirname, "temp", String(chatId));
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const fileName = `tiktok_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`;
    const filePath = path.join(tempDir, fileName);

    // ================================
    // DOWNLOAD VIDEO SAFELY
    // ================================
    const writer = fs.createWriteStream(filePath);
    const videoRes = await axios({ url: videoUrl, method: "GET", responseType: "stream" });
    videoRes.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    // SAFE deleteMessage
    try {
      await bot.deleteMessage(chatId, sendingMsg.message_id);
    } catch {}

    await bot.sendVideo(chatId, filePath);

    // CLEAN UP
    fs.unlinkSync(filePath);

  } catch (err) {
    console.error(err);

    try {
      await bot.editMessageText("❌ Error processing your link. Please try again later.", {
        chat_id: chatId,
        message_id: sendingMsg.message_id
      });
    } catch {}
  }
}
