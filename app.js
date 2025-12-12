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
const APP_URL = process.env.APP_URL; // https://your-app.onrender.com
const PORT = process.env.PORT || 3000;

if (!TOKEN || !APP_URL) {
  console.error("❌ Please set TOKEN and APP_URL in .env");
  process.exit(1);
}

// ============================
// EXPRESS SERVER
// ============================
const app = express();

// Serve files from /tmp
app.get("/video/:name", (req, res) => {
  const filePath = path.join("/tmp", req.params.name);
  if (!fs.existsSync(filePath)) return res.status(404).send("File not found");
  res.sendFile(filePath);
});

app.get("/", (req, res) => res.send("🐰 Bot running"));
app.listen(PORT, () => console.log(`Server running on ${PORT}`));

// ============================
// PREVENT SLEEP
// ============================
setInterval(() => axios.get(APP_URL).catch(() => {}), 4 * 60 * 1000);

// ============================
// BOT (POLLING)
// ============================
const bot = new TelegramBot(TOKEN, { polling: true });

// ============================
// QUEUE SYSTEM
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
// /start
// ============================
bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, "🐰 Send me a TikTok link to download!");
});

// ============================
// Expand short link
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
// MAIN HANDLER (NO MORE 50MB)
// ============================
async function handleDownload(chatId, text) {
  const loading = await bot.sendMessage(chatId, "⏳ Fetching video...");

  try {
    const resolvedUrl = await expandUrl(text);

    // 1) CALL TikWM
    const apiRes = await getTikwmVideo(resolvedUrl);
    const videoUrl = apiRes.data.data.play;

    // 2) DOWNLOAD to /tmp
    const filePath = await downloadVideoWithRetry(chatId, videoUrl);

    // 3) Generate link
    const fileName = path.basename(filePath);
    const downloadLink = `${APP_URL}/video/${fileName}`;

    // 4) Edit loading message
    await bot.editMessageText(
      `✅ Your video is ready!\n\n🔗 Download link:\n${downloadLink}\n\n⚠️ Auto-delete in 5 minutes.`,
      { chat_id: chatId, message_id: loading.message_id }
    );

  } catch (err) {
    console.log("❌ ERROR:", err.message);

    try {
      await bot.editMessageText("❌ Failed. Try again.", {
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
      const res = await axios.get("https://tikwm.com/api/", {
        params: { url }
      });
      if (res.data?.data?.play) return res;
    } catch {}
    await wait(400);
  }
  throw new Error("TikWM failed 5 times");
}

// ============================
// DOWNLOAD to /tmp
// ============================
async function downloadVideoWithRetry(chatId, videoUrl) {
  const fileName = `tt_${chatId}_${Date.now()}.mp4`;
  const filePath = path.join("/tmp", fileName);

  for (let i = 0; i < 5; i++) {
    try {
      const response = await axios({
        url: videoUrl,
        method: "GET",
        responseType: "stream"
      });

      const writer = fs.createWriteStream(filePath);
      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      scheduleTemporaryDelete(filePath, 5 * 60 * 1000);
      return filePath;

    } catch {
      await wait(600);
    }
  }

  throw new Error("Download failed after 5 retries");
}

// ============================
// AUTO DELETE
// ============================
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

// ============================
function wait(ms) {
  return new Promise(res => setTimeout(res, ms));
}
