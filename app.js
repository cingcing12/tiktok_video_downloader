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
const cors = require("cors");
const youtubedl = require("youtube-dl-exec");
const ffmpegPath = require("ffmpeg-static");
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
// MONGODB CONNECT
// ============================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => {
    console.error("❌ MongoDB error:", err);
    process.exit(1);
  });

// ============================
// USER SCHEMA
// ============================
const userSchema = new mongoose.Schema({
  userId: { type: Number, unique: true },
  firstName: String,
  lastName: String,
  lastActive: { type: Date, default: Date.now },
  joinedAt: { type: Date, default: Date.now }
});

const User = mongoose.model("tiktok_bot_user", userSchema);

// ============================
// EXPRESS SERVER
// ============================
const app = express();
app.use(cors());

app.get("/", (req, res) => res.send("🐰 Bot running"));

app.get("/video/:file", (req, res) => {
  const filePath = "/tmp/" + req.params.file;
  if (fs.existsSync(filePath)) res.sendFile(filePath);
  else res.status(404).send("File expired or deleted.");
});

app.get("/user", async (req, res) => {
  try {
    const users = await User.find().sort({ joinedAt: -1 });
    res.json(users);
  } catch {
    res.status(500).json("Error");
  }
});

app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));

// ============================
// PREVENT SLEEP
// ============================
setInterval(() => {
  axios.get(APP_URL).catch(() => {});
}, 4 * 60 * 1000);

// ============================
// TELEGRAM BOT
// ============================
const bot = new TelegramBot(TOKEN, { polling: true });
const globalQueue = new PQueue({ concurrency: 20 });
const chatQueues = new Map();

function getChatQueue(chatId) {
  if (!chatQueues.has(chatId)) chatQueues.set(chatId, new PQueue({ concurrency: 1 }));
  return chatQueues.get(chatId);
}

// ============================
// COMMANDS
// ============================
bot.onText(/\/start/, async (msg) => {
  const { id, first_name, last_name } = msg.from;
  await saveUser(id, first_name, last_name);
  bot.sendMessage(msg.chat.id, "🐰 Send me a TikTok or YouTube link (Production Ready!)");
});

bot.onText(/\/checkMemory/, (msg) => {
  const chatId = msg.chat.id;
  const memoryUsage = process.memoryUsage();
  const rss = (memoryUsage.rss / 1024 / 1024).toFixed(2);
  bot.sendMessage(chatId, `🧠 <b>Memory:</b> <code>${rss} MB</code>`, { parse_mode: "HTML" });
});

// ============================
// MESSAGE HANDLER
// ============================
bot.on("message", async (msg) => {
  if (!msg.from || !msg.text) return;
  const { id, first_name, last_name } = msg.from;
  await saveUser(id, first_name, last_name);
  const text = msg.text;
  const chatId = msg.chat.id;
  const queue = getChatQueue(chatId);

  if (text.includes("tiktok.com")) {
    queue.add(() => globalQueue.add(() => handleTikTok(chatId, text)));
  } 
  else if (text.includes("youtube.com") || text.includes("youtu.be")) {
    queue.add(() => globalQueue.add(() => handleYouTubeFinal(chatId, text)));
  }
});

// ============================
// HANDLER: TIKTOK
// ============================
async function handleTikTok(chatId, text) {
  const loader = await startLoading(chatId, "Downloading TikTok...");
  try {
    const url = await expandUrl(text);
    const apiRes = await getTikwmVideo(url);
    const videoUrl = apiRes.data.data.play;
    const filePath = await downloadDirectStream(videoUrl, chatId, "tt");
    await processAndSend(chatId, filePath, loader);
  } catch (err) {
    handleError(chatId, loader, err);
  }
}

// ============================
// HANDLER: YOUTUBE (SYSTEM BINARY FIX ✅)
// ============================
async function handleYouTubeFinal(chatId, text) {
  const loader = await startLoading(chatId, "Fetching Best Quality...");
  
  const uniqueId = `yt_${Date.now()}`;
  
  try {
    console.log("🎬 Starting yt-dlp...");

    await youtubedl(text, {
      output: `${uniqueId}.%(ext)s`,
      format: 'bestvideo+bestaudio/best',
      mergeOutputFormat: 'mp4',
      ffmpegLocation: ffmpegPath,
      noPlaylist: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      addHeader: [
        'referer:youtube.com',
        'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      ]
    }, {
      cwd: '/tmp',
      execPath: 'yt-dlp' // ✅ THIS IS THE FIX: Uses the Python installed version
    });

    console.log("✅ Download process finished. Scanning for file...");

    // Find the file
    const files = fs.readdirSync('/tmp');
    const downloadedFile = files.find(file => file.startsWith(uniqueId));

    if (!downloadedFile) {
      throw new Error("File missing after download.");
    }

    const fullPath = path.join('/tmp', downloadedFile);
    console.log(`🔎 Found file: ${fullPath}`);

    await processAndSend(chatId, fullPath, loader);

  } catch (err) {
    handleError(chatId, loader, err);
  }
}

// ============================
// SHARED: SENDING LOGIC
// ============================
async function processAndSend(chatId, filePath, loader) {
  if (!fs.existsSync(filePath)) throw new Error("File missing during send.");

  const stats = fs.statSync(filePath);
  const sizeMB = stats.size / (1024 * 1024);

  console.log(`💾 Processing: ${sizeMB.toFixed(2)} MB`);
  
  clearInterval(loader.interval);
  await bot.deleteMessage(chatId, loader.msg.message_id).catch(() => {});

  if (sizeMB < 50) {
    const fileStream = fs.createReadStream(filePath);
    await bot.sendVideo(chatId, fileStream, { supports_streaming: true });
    setTimeout(() => { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }, 5000);
  } else {
    const fileName = path.basename(filePath);
    await bot.sendMessage(
      chatId, 
      `🎬 <b>High Quality Video Ready!</b>\n📦 Size: <code>${sizeMB.toFixed(2)} MB</code>\n\n🔗 <a href="${APP_URL}/video/${fileName}">Click Here to Download</a>\n\n<i>(Link expires in 15 mins)</i>`,
      { parse_mode: "HTML" }
    );
    setTimeout(() => { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }, 15 * 60 * 1000);
  }
}

// ============================
// UTILITIES
// ============================
async function saveUser(userId, firstName, lastName) {
  await User.findOneAndUpdate(
    { userId },
    { userId, firstName, lastName: lastName || "", lastActive: new Date() },
    { upsert: true }
  );
}

async function startLoading(chatId, text) {
  const frames = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"];
  let i = 0;
  const msg = await bot.sendMessage(chatId, `🌑 ${text}`);
  const interval = setInterval(() => {
    bot.editMessageText(`${frames[i % frames.length]} ${text}`, { 
      chat_id: chatId, message_id: msg.message_id 
    }).catch(() => {});
    i++;
  }, 500);
  return { msg, interval };
}

function handleError(chatId, loader, err) {
  console.error("❌ Error:", err.message || err);
  clearInterval(loader.interval);
  bot.editMessageText(`❌ Error: Could not download.`, {
    chat_id: chatId, message_id: loader.msg.message_id
  }).catch(() => {});
}

async function downloadDirectStream(url, chatId, prefix) {
  const filePath = `/tmp/${prefix}_${chatId}_${Date.now()}.mp4`;
  const stream = await axios({ url, responseType: "stream" });
  const writer = fs.createWriteStream(filePath);
  stream.data.pipe(writer);
  await new Promise((res, rej) => {
    writer.on("finish", res);
    writer.on("error", rej);
  });
  return filePath;
}

async function getTikwmVideo(url) {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await axios.get("https://tikwm.com/api/", { params: { url } });
      if (res.data?.data?.play) return res;
    } catch {}
    await wait(600);
  }
  throw new Error("TikWM failed");
}

async function expandUrl(url) {
  return axios.get(url, { maxRedirects: 0, validateStatus: s => s >= 200 && s < 400 })
    .then(r => r.headers.location || url).catch(() => url);
}

function wait(ms) {
  return new Promise(res => setTimeout(res, ms));
}