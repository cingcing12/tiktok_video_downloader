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
  console.error("❌ Please set TOKEN and APP_URL in .env");
  process.exit(1);
}

// ============================
// EXPRESS SERVER
// ============================
const app = express();
app.get("/", (req, res) => res.send("🐰 Bot running"));
app.listen(PORT, () => console.log(`Server running on ${PORT}`));

// ============================
// PREVENT SLEEP — SELF-PING
// ============================
setInterval(() => axios.get(APP_URL).catch(() => {}), 4 * 60 * 1000);

// ============================
// BOT (POLLING)
// ============================
const bot = new TelegramBot(TOKEN, { polling: true });

// ============================
// CONCURRENCY QUEUE
// ============================
const globalQueue = new PQueue({ concurrency: 20 });

const chatQueues = new Map();
function getChatQueue(chatId) {
  if (!chatQueues.has(chatId)) {
    chatQueues.set(chatId, new PQueue({ concurrency: 1 }));
  }
  return chatQueues.get(chatId);
}

// ============================
// COMMAND /start
// ============================
bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, "🐰 Send me a TikTok link to download!");
});

// ============================
// EXPAND SHORT LINKS
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

  chatQueue.add(() =>
    globalQueue.add(() =>
      handleDownload(chatId, text)
    )
  );
});

// ============================
// MAIN DOWNLOAD HANDLER
// ============================
async function handleDownload(chatId, text) {
  const loading = await bot.sendMessage(chatId, "⏳ Downloading...");

  try {
    const url = await expandUrl(text);

    // TikWM API
    const apiRes = await getTikwmVideo(url);

    const videoUrl = apiRes.data.data.play;

    const filePath = await downloadVideoWithRetry(chatId, videoUrl);

    // Clean the message
    try {
      await bot.deleteMessage(chatId, loading.message_id);
    } catch {}

    // Send to Telegram
    await sendVideoWithRetry(chatId, filePath);

  } catch (err) {
    console.log("❌ ERROR:", err.message);

    try {
      await bot.editMessageText("❌ Failed to download. Try again.", {
        chat_id: chatId,
        message_id: loading.message_id
      });
    } catch {}
  }
}

// ------------------------------
// TikWM RETRY
// ------------------------------
async function getTikwmVideo(url) {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await axios.get("https://tikwm.com/api/", {
        params: { url }
      });
      if (res.data?.data?.play) return res;
    } catch {}
    await wait(500 + Math.random() * 600);
  }
  throw new Error("TikWM failed after 5 tries");
}

// ------------------------------
// DOWNLOAD → Render-safe (/tmp)
// ------------------------------
async function downloadVideoWithRetry(chatId, videoUrl) {
  const tempDir = "/tmp";
  const filePath = path.join(tempDir, `tt_${chatId}_${Date.now()}.mp4`);

  for (let i = 0; i < 5; i++) {
    try {
      const stream = await axios({
        url: videoUrl,
        method: "GET",
        responseType: "stream"
      });

      const writer = fs.createWriteStream(filePath);
      stream.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      // auto-delete after 5 min
      scheduleTemporaryDelete(filePath, 5 * 60 * 1000);

      return filePath;
    } catch {}
    await wait(800);
  }

  throw new Error("Download retry failed");
}

// ------------------------------
// TELEGRAM SEND RETRY
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

// ------------------------------
// AUTO DELETE FILE
// ------------------------------
function scheduleTemporaryDelete(filePath, delay) {
  setTimeout(() => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log("🗑️ Deleted:", filePath);
      }
    } catch (err) {
      console.error("Delete error:", err);
    }
  }, delay);
}

// ------------------------------
function wait(ms) {
  return new Promise(res => setTimeout(res, ms));
}
