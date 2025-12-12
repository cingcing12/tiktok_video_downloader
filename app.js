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
app.use("/temp", express.static(path.join(__dirname, "temp"))); // serve large files
app.listen(PORT, () => console.log(`Server on port ${PORT}`));

// ============================
// POLLING BOT
// ============================
const bot = new TelegramBot(TOKEN, { polling: true });
console.log("🤖 Bot started in polling mode!");

// ============================
// SELF-PING
// ============================
setInterval(() => axios.get(APP_URL).catch(() => {}), 4 * 60 * 1000);

// ============================
// QUEUE (GLOBAL)
// ============================
const globalQueue = new PQueue({ concurrency: 10 }); // global concurrency
const chatQueues = new Map(); // per-user queue

function getChatQueue(chatId) {
  if (!chatQueues.has(chatId)) {
    chatQueues.set(chatId, new PQueue({ concurrency: 1 })); // process 1 request at a time per user
  }
  return chatQueues.get(chatId);
}

// ============================
// /start COMMAND
// ============================
bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, "🐰 Send me TikTok links to download!");
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
  chatQueue.add(() =>
    globalQueue.add(() => handleDownload(chatId, text))
  );
});

// ============================
// HANDLE DOWNLOAD (SAFE FOR LONG/HD VIDEOS)
// ============================
async function handleDownload(chatId, text) {
  const statusMsg = await bot.sendMessage(chatId, "⏳ Downloading... Please wait...");

  try {
    const url = await expandUrl(text);
    const apiRes = await getTikwmVideo(url);
    const videoUrl = apiRes.data.data.play;

    const filePath = await downloadVideoWithRetry(chatId, videoUrl);

    // delete status message
    try { await bot.deleteMessage(chatId, statusMsg.message_id); } catch {}

    // Check file size
    const stats = fs.statSync(filePath);
    const fileSizeMB = stats.size / (1024 * 1024);

    if (fileSizeMB > 50) {
      // Telegram limit exceeded → send download link
      const downloadLink = `${APP_URL}/temp/${path.basename(filePath)}`;
      await bot.sendMessage(chatId, `⚠️ Video too large to send. Download here:\n${downloadLink}`);
    } else {
      await sendVideoWithRetry(chatId, filePath);
    }

    fs.unlinkSync(filePath); // cleanup after sending
  } catch (err) {
    console.error("❌ ERROR", err.message);

    try {
      await bot.editMessageText("❌ Failed to download. Please try again later.", {
        chat_id: chatId,
        message_id: statusMsg.message_id
      });
    } catch {}
  }
}

// ============================
// GET VIDEO URL (TikWM RETRY)
// ============================
async function getTikwmVideo(url) {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await axios.get("https://tikwm.com/api/", { params: { url } });
      if (res.data?.data?.play) return res;
    } catch {}
    await wait(600 + Math.random() * 400);
  }
  throw new Error("TikWM API Failed");
}

// ============================
// DOWNLOAD VIDEO (RETRY + LONG TIME)
// ============================
async function downloadVideoWithRetry(chatId, videoUrl) {
  const tempDir = path.join(__dirname, "temp", String(chatId));
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const filePath = path.join(tempDir, `tt_${Date.now()}.mp4`);

  for (let i = 0; i < 5; i++) {
    try {
      const stream = await axios({
        url: videoUrl,
        method: "GET",
        responseType: "stream",
        timeout: 0,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });
      const writer = fs.createWriteStream(filePath);
      stream.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });
      return filePath;
    } catch (err) {
      console.log(`Retry ${i+1}: ${err.message}`);
      await wait(2000);
    }
  }

  throw new Error("Video download failed");
}

// ============================
// SEND VIDEO (RETRY)
// ============================
async function sendVideoWithRetry(chatId, filePath) {
  for (let i = 0; i < 5; i++) {
    try {
      await bot.sendVideo(chatId, filePath, { supports_streaming: true });
      return;
    } catch (err) {
      console.log(`Send retry ${i+1}: ${err.message}`);
      if (i === 4) throw err;
      await wait(800);
    }
  }
}

// ============================
// UTILS
// ============================
function wait(ms) {
  return new Promise(res => setTimeout(res, ms));
}
