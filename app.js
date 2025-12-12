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
app.get("/", (req, res) => res.send("🐰 Bot running"));
app.listen(PORT, () => console.log(`Server on port ${PORT}`));

// ============================
// POLLING BOT
// ============================
const bot = new TelegramBot(TOKEN, { polling: true });

// ============================
// SELF-PING
// ============================
setInterval(() => axios.get(APP_URL).catch(() => {}), 4 * 60 * 1000);

// ============================
// QUEUE (GLOBAL)
// ============================
// many users → no problem
const globalQueue = new PQueue({ concurrency: 20 });

// PER CHAT QUEUE — MOST IMPORTANT FIX
const chatQueues = new Map();
function getChatQueue(chatId) {
  if (!chatQueues.has(chatId)) {
    chatQueues.set(chatId, new PQueue({ concurrency: 1 })); // <<< FIX
  }
  return chatQueues.get(chatId);
}

// ============================
// START
// ============================
bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, "🐰 Send me TikTok links!");
});

// ============================
// EXPAND SHORT LINK
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
// ON MESSAGE
// ============================
bot.on("message", msg => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || !text.includes("tiktok.com")) return;

  const chatQueue = getChatQueue(chatId);

  // Queue per user, not global → prevents fail
  chatQueue.add(() =>
    globalQueue.add(() =>
      handleDownload(chatId, text)
    )
  );
});

// ============================
// HANDLE DOWNLOAD (RATE LIMIT SAFE)
// ============================
async function handleDownload(chatId, text) {
  const loading = await bot.sendMessage(chatId, "⏳ Downloading...");

  try {
    const url = await expandUrl(text);

    // Get video URL (TikWM retry + delay)
    const apiRes = await getTikwmVideo(url);

    const videoUrl = apiRes.data.data.play;

    const filePath = await downloadVideoWithRetry(chatId, videoUrl);

    // delete message fast
    try { await bot.deleteMessage(chatId, loading.message_id); } catch {}

    await sendVideoWithRetry(chatId, filePath);

    fs.unlinkSync(filePath);

  } catch (err) {
    console.log("❌ ERROR", err);

    try {
      await bot.editMessageText("❌ Failed to download. Try again.", {
        chat_id: chatId,
        message_id: loading.message_id
      });
    } catch {}
  }
}

// ------------------------------
// FIX: TikWM RETRY FUNCTION
// ------------------------------
async function getTikwmVideo(url) {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await axios.get("https://tikwm.com/api/", {
        params: { url }
      });
      if (res.data?.data?.play) return res;
    } catch {}
    await wait(600 + Math.random() * 400); // random delay
  }
  throw new Error("TikWM API Failed");
}

// ------------------------------
// FIX: DOWNLOAD VIDEO RETRY
// ------------------------------
async function downloadVideoWithRetry(chatId, videoUrl) {

  const tempDir = path.join(__dirname, "temp", String(chatId));
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const filePath = path.join(tempDir, `tt_${Date.now()}.mp4`);

  for (let i = 0; i < 5; i++) {
    try {
      const stream = await axios({ url: videoUrl, method: "GET", responseType: "stream" });
      const writer = fs.createWriteStream(filePath);
      stream.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      return filePath;
    } catch {}
    await wait(800);
  }

  throw new Error("Video download failed");
}

// ------------------------------
// FIX: SEND VIDEO RETRY
// ------------------------------
async function sendVideoWithRetry(chatId, filePath) {
  for (let i = 0; i < 5; i++) {
    try {
      await bot.sendVideo(chatId, filePath, { supports_streaming: true });
      return;
    } catch (err) {
      if (i === 4) throw err;
      await wait(800);
    }
  }
}

function wait(ms) {
  return new Promise(res => setTimeout(res, ms));
}
