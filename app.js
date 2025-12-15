// ============================
// DEPENDENCIES
// ============================
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const express = require("express");
const PQueue = require("p-queue").default;
const mongoose = require("mongoose");
require("dotenv").config();

// ============================
// CONFIG
// ============================
const TOKEN = process.env.TOKEN;
const APP_URL = process.env.APP_URL;
const PORT = process.env.PORT || 3000;

if (!TOKEN || !APP_URL || !process.env.MONGO_URI) {
  console.error("❌ Missing env variables");
  process.exit(1);
}

// ============================
// MONGODB CONNECT (Mongoose v7+)
// ============================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => {
    console.error("❌ MongoDB error:", err);
    process.exit(1);
  });

// ============================
// USER SCHEMA (SILENT STORAGE)
// ============================
const userSchema = new mongoose.Schema({
  userId: { type: Number, unique: true },
  lastActive: { type: Date, default: Date.now },
  joinedAt: { type: Date, default: Date.now }
});

const User = mongoose.model("tiktok_bot_user", userSchema);

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

app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));

// ============================
// PREVENT SLEEP (Render.com)
// ============================
setInterval(() => {
  axios.get(APP_URL).catch(() => {});
}, 4 * 60 * 1000);

// ============================
// TELEGRAM BOT (POLLING)
// ============================
const bot = new TelegramBot(TOKEN, { polling: true });

// ============================
// QUEUES
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
// /start HANDLER (STORE USER)
// ============================
bot.onText(/\/start/, async (msg) => {
  await User.findOneAndUpdate(
    { userId: msg.from.id },
    { lastActive: new Date() },
    { upsert: true }
  );

  bot.sendMessage(msg.chat.id, "🐰 Send me a TikTok link to download!");
});

// ============================
// MESSAGE HANDLER
// ============================
bot.on("message", async (msg) => {
  if (!msg.from) return;

  // silently update activity
  await User.updateOne(
    { userId: msg.from.id },
    { lastActive: new Date() },
    { upsert: true }
  );

  const text = msg.text;
  if (!text || !text.includes("tiktok.com")) return;

  const chatId = msg.chat.id;
  const queue = getChatQueue(chatId);

  queue.add(() => globalQueue.add(() => handleDownload(chatId, text)));
});

// ============================
// COOL LOADING ANIMATION
// ============================
async function startLoading(chatId) {
  const frames = ["⏳ Downloading", "⏳ Downloading.", "⏳ Downloading..", "⏳ Downloading..."];
  let i = 0;

  const msg = await bot.sendMessage(chatId, frames[0]);

  const interval = setInterval(() => {
    bot.editMessageText(frames[i % frames.length], {
      chat_id: chatId,
      message_id: msg.message_id
    }).catch(() => {});
    i++;
  }, 600);

  return { msg, interval };
}

// ============================
// MAIN DOWNLOAD HANDLER
// ============================
async function handleDownload(chatId, text) {
  const loader = await startLoading(chatId);

  try {
    const url = await expandUrl(text);
    const apiRes = await getTikwmVideo(url);
    const videoUrl = apiRes.data.data.play;

    const filePath = await downloadVideo(videoUrl, chatId);
    const sizeMB = fs.statSync(filePath).size / (1024 * 1024);

    clearInterval(loader.interval);
    await bot.deleteMessage(chatId, loader.msg.message_id).catch(() => {});

    if (sizeMB < 50) {
      await bot.sendVideo(chatId, filePath, { supports_streaming: true });
      fs.unlinkSync(filePath);
    } else {
      const fileName = path.basename(filePath);
      const downloadUrl = `${APP_URL}/video/${fileName}`;

      await bot.sendMessage(
        chatId,
        `📥 Video ready!\n\n🔗 Download (auto delete in 5 min):\n${downloadUrl}`
      );
    }

  } catch (err) {
    clearInterval(loader.interval);
    await bot.editMessageText("❌ Failed to download. Try again.", {
      chat_id: chatId,
      message_id: loader.msg.message_id
    }).catch(() => {});
  }
}

// ============================
// TIKWM API
// ============================
async function getTikwmVideo(url) {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await axios.get("https://tikwm.com/api/", {
        params: { url }
      });
      if (res.data?.data?.play) return res;
    } catch {}
    await wait(600);
  }
  throw new Error("TikWM failed");
}

// ============================
// DOWNLOAD VIDEO
// ============================
async function downloadVideo(videoUrl, chatId) {
  const filePath = `/tmp/tt_${chatId}_${Date.now()}.mp4`;

  const stream = await axios({
    url: videoUrl,
    method: "GET",
    responseType: "stream"
  });

  const writer = fs.createWriteStream(filePath);
  stream.data.pipe(writer);

  await new Promise((res, rej) => {
    writer.on("finish", res);
    writer.on("error", rej);
  });

  // auto delete after 5 min
  setTimeout(() => {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }, 5 * 60 * 1000);

  return filePath;
}

// ============================
function expandUrl(url) {
  return axios.get(url, {
    maxRedirects: 0,
    validateStatus: s => s >= 200 && s < 400
  }).then(r => r.headers.location || url).catch(() => url);
}

function wait(ms) {
  return new Promise(res => setTimeout(res, ms));
}
