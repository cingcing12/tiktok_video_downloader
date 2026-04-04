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
const os = require("os");
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
bot.on("message", (msg) => {
 if (msg.text) console.log(`📩 MSG from ${msg.chat.id}: ${msg.text.substring(0, 20)}...`);
});

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
// /start COMMAND
// ============================
bot.onText(/\/start/, async (msg) => {
 const { id, first_name, last_name } = msg.from;

 await User.findOneAndUpdate(
  { userId: id },
  {
   userId: id,
   firstName: first_name || "",
   lastName: last_name || "",
   lastActive: new Date()
  },
  { upsert: true }
 );

 bot.sendMessage(msg.chat.id, "🐰 Send me a TikTok link to download!");
});

// ============================
// /checkMemory COMMAND (NEW ✅)
// ============================
bot.onText(/\/checkMemory/, (msg) => {
 const chatId = msg.chat.id;
 const memoryUsage = process.memoryUsage();

 // RSS: Total memory allocated for the process
 const rss = (memoryUsage.rss / 1024 / 1024).toFixed(2);
 // Heap Used: Actual variables/objects
 const heapUsed = (memoryUsage.heapUsed / 1024 / 1024).toFixed(2);
 // OS Free: Approximate free memory on server
 const osFree = (os.freemem() / 1024 / 1024).toFixed(2);

 const stats = `
📊 <b>Server Memory Status</b>

🧠 <b>RSS (Total):</b> <code>${rss} MB</code>
📉 <b>Heap (Active):</b> <code>${heapUsed} MB</code>
🆓 <b>OS Free:</b> <code>${osFree} MB</code>

<i>Note: If RSS > 500MB, Render might restart the bot.</i>
 `;

 bot.sendMessage(chatId, stats, { parse_mode: "HTML" });
});

// ============================
// MESSAGE HANDLER (AUTO STORE USER)
// ============================
bot.on("message", async (msg) => {
 if (!msg.from) return;

 const userId = msg.from.id;
 const firstName = msg.from.first_name || "";
 const lastName = msg.from.last_name || "";

 await User.findOneAndUpdate(
  { userId },
  {
   userId,
   firstName,
   lastName,
   lastActive: new Date()
  },
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
 const frames = [
  "🌑 [░░░░░░░░░░] Downloading",
  "🌒 [█░░░░░░░░░] Downloading",
  "🌓 [██░░░░░░░░] Downloading",
  "🌔 [███░░░░░░░] Downloading",
  "🌕 [████░░░░░░] Downloading",
  "🌖 [█████░░░░░] Downloading",
  "🌗 [██████░░░░] Downloading",
  "🌘 [███████░░░] Downloading",
  "🌑 [████████░░] Downloading",
  "🌒 [█████████░] Downloading",
  "🌓 [██████████] Downloading"
 ];

 let i = 0;
 const msg = await bot.sendMessage(chatId, frames[0]);

 const interval = setInterval(() => {
  bot.editMessageText(frames[i % frames.length], {
   chat_id: chatId,
   message_id: msg.message_id
  }).catch(() => {});
  i++;
 }, 500);

 return { msg, interval };
}

// ============================
// DOWNLOAD HANDLER (UPDATED WITH STREAMS & CAPTION ✅)
// ============================
async function handleDownload(chatId, text) {
  const loader = await startLoading(chatId);

  try {
    const url = await expandUrl(text);
    const apiRes = await getTikwmVideo(url);
    const videoUrl = apiRes.data.data.play;

    const filePath = await downloadVideo(videoUrl, chatId);
    const sizeMB = fs.statSync(filePath).size / (1024 * 1024);
    
    console.log(`💾 Downloaded: ${sizeMB.toFixed(2)} MB | File: ${filePath}`);

    clearInterval(loader.interval);
    await bot.deleteMessage(chatId, loader.msg.message_id).catch(() => {});

    if (sizeMB < 50) {
      // ✅ MEMORY FIX: Use Stream instead of File Path
      const fileStream = fs.createReadStream(filePath);
      
      // ✅ ADDED CAPTION HERE
      await bot.sendVideo(chatId, fileStream, { 
        supports_streaming: true,
        caption: `🔗 Original Link:\n${text}` // Sends the link under the video
      });
      
      // Delete file after sending (using timeout to be safe with stream lock)
      setTimeout(() => {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }, 1000); 

    } else {
      const fileName = path.basename(filePath);
      // ✅ ADDED ORIGINAL LINK TO LARGE FILE MESSAGE
      await bot.sendMessage(
        chatId,
        `📥 Video ready!\n🔗 Original: ${text}\n\n⬇️ Download (auto delete in 5 min):\n${APP_URL}/video/${fileName}`
      );
    }
  } catch (err) {
    console.error("❌ Download Error:", err.message);
    clearInterval(loader.interval);
    bot.editMessageText("❌ Download failed. Try again.", {
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
   const res = await axios.get("https://tikwm.com/api/", { params: { url } });
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

 const stream = await axios({ url: videoUrl, responseType: "stream" });
 const writer = fs.createWriteStream(filePath);
 stream.data.pipe(writer);

 await new Promise((res, rej) => {
  writer.on("finish", res);
  writer.on("error", rej);
 });

 // Backup delete timer (5 mins)
 setTimeout(() => fs.existsSync(filePath) && fs.unlinkSync(filePath), 5 * 60 * 1000);
 return filePath;
}

// ============================
// UTILS
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
