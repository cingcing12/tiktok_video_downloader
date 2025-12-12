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

app.get("/video/:file", (req, res) => {
  const filePath = "/tmp/" + req.params.file;
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send("File expired or deleted.");
  }
});

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
// /start command
// ============================
bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, "🐰 Send me a TikTok link to download!");
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
// MESSAGE HANDLER
// ============================
bot.on("message", msg => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || !text.includes("tiktok.com")) return;

  const queue = getChatQueue(chatId);

  queue.add(() =>
    globalQueue.add(() =>
      handleDownload(chatId, text)
    )
  );
});

// ============================
// MAIN HANDLER
// ============================
async function handleDownload(chatId, text) {
  const loading = await bot.sendMessage(chatId, "⏳ Downloading...");

  try {
    const url = await expandUrl(text);

    const apiRes = await getTikwmVideo(url);
    const videoUrl = apiRes.data.data.play;

    const filePath = await downloadVideoWithRetry(chatId, videoUrl);

    // Check file size
    const sizeMB = fs.statSync(filePath).size / (1024 * 1024);

    // Delete loading msg
    try { await bot.deleteMessage(chatId, loading.message_id); } catch {}

    if (sizeMB < 50) {
      // Send directly
      await bot.sendVideo(chatId, filePath, { supports_streaming: true });

      // Delete file instantly since <50MB
      fs.unlinkSync(filePath);
      console.log("🗑️ Deleted small file:", filePath);

    } else {
      // Large video → send download link
      const fileName = path.basename(filePath);
      const downloadUrl = `${APP_URL}/video/${fileName}`;

      await bot.sendMessage(
        chatId,
        `📥 Your video is ready!\n\n🔗 Download (auto delete in 5 min):\n${downloadUrl}`
      );
    }

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

// ============================
// TikWM RETRY
// ============================
async function getTikwmVideo(url) {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await axios.get("https://tikwm.com/api/", { params: { url } });
      if (res.data?.data?.play) return res;
    } catch {}
    await wait(500 + Math.random() * 600);
  }
  throw new Error("TikWM failed after 5 tries");
}

// ============================
// DOWNLOAD to /tmp
// ============================
async function downloadVideoWithRetry(chatId, videoUrl) {
  const filePath = `/tmp/tt_${chatId}_${Date.now()}.mp4`;

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

      // Auto delete after 5 minutes (only large files will still exist)
      scheduleTemporaryDelete(filePath, 5 * 60 * 1000);

      return filePath;
    } catch {}
    await wait(800);
  }

  throw new Error("Download retry failed");
}

// ============================
// AUTO DELETE FILE
// ============================
function scheduleTemporaryDelete(filePath, delay) {
  setTimeout(() => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log("🗑️ Auto-deleted:", filePath);
      }
    } catch (err) {
      console.error("Delete error:", err);
    }
  }, delay);
}

// ============================
function wait(ms) {
  return new Promise(res => setTimeout(res, ms));
}
