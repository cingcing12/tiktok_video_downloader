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
app.get("/", (req, res) => res.send("🐰 Telegram TikTok Downloader Bot Running!"));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ============================
// POLLING BOT
// ============================
const bot = new TelegramBot(TOKEN, { polling: true });
console.log("🤖 Bot started in polling mode!");

// ============================
// SELF PING (STOP BOT SLEEP)
// ============================
setInterval(() => {
  axios.get(APP_URL).catch(() => {});
}, 4 * 60 * 1000);

// ============================
// QUEUE (SUPPORT 100+ USERS)
// ============================
const queue = new PQueue({ concurrency: 5 });

// ============================
// /start COMMAND
// ============================
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "🐰 Send me any TikTok link and I will download the video for you!"
  );
});

// ============================
// EXPAND SHORT URL
// ============================
async function expandUrl(shortUrl) {
  try {
    const res = await axios.get(shortUrl, {
      maxRedirects: 0,
      validateStatus: s => s >= 200 && s < 400
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
// DOWNLOAD HANDLER (OPTIMIZED)
// ============================
async function handleDownload(chatId, text) {
  const statusMsg = await bot.sendMessage(chatId, "⏳ Downloading... Please wait...");

  try {
    const url = await expandUrl(text);

    // ================================
    // API RETRY SYSTEM
    // ================================
    let apiRes;
    for (let i = 0; i < 3; i++) {
      try {
        apiRes = await axios.get("https://tikwm.com/api/", { params: { url } });
        if (apiRes.data?.data?.play) break;
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }

    if (!apiRes?.data?.data?.play) throw new Error("API failed");

    const videoUrl = apiRes.data.data.play;

    // ================================
    // TEMP USER FOLDER
    // ================================
    const tempDir = path.join(__dirname, "temp", String(chatId));
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const fileName = `tiktok_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`;
    const filePath = path.join(tempDir, fileName);

    // ================================
    // DOWNLOAD VIDEO STREAM
    // ================================
    const videoStream = await axios({
      url: videoUrl,
      method: "GET",
      responseType: "stream"
    });

    const writer = fs.createWriteStream(filePath);
    videoStream.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    // ================================
    // DELETE MESSAGE FAST → SEND VIDEO
    // ================================
    try { await bot.deleteMessage(chatId, statusMsg.message_id); } catch {}

    // SEND VIDEO with retry 2 times
    for (let i = 0; i < 3; i++) {
      try {
        await bot.sendVideo(chatId, filePath, {
          supports_streaming: true
        });
        break;
      } catch (err) {
        if (i === 2) throw err;
        await new Promise(r => setTimeout(r, 800));
      }
    }

    // ================================
    // CLEAN UP
    // ================================
    fs.unlinkSync(filePath);

  } catch (err) {
    console.error("❌ ERROR:", err.message);

    try {
      await bot.editMessageText("❌ Failed to download video. Please try again later.", {
        chat_id: chatId,
        message_id: statusMsg.message_id
      });
    } catch {}
  }
}
