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
const APP_URL = process.env.APP_URL; // Render app URL: https://your-app.onrender.com
const PORT = process.env.PORT || 3000;

if (!TOKEN || !APP_URL) {
  console.error("❌ Please set TOKEN and APP_URL in .env file");
  process.exit(1);
}

// ============================
// EXPRESS SERVER
// ============================
const app = express();
app.use(express.json()); // needed for webhook POST
app.get("/", (req, res) => res.send("🐰 Telegram TikTok Bot is running!"));

// Telegram webhook endpoint
app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Express server listening on port ${PORT}`));

// ============================
// TELEGRAM BOT (Webhook mode)
// ============================
const bot = new TelegramBot(TOKEN, { webHook: { port: PORT } });

// Set webhook
bot.setWebHook(`${APP_URL}/bot${TOKEN}`).then(() => {
  console.log("✅ Webhook set successfully!");
});

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
      validateStatus: (status) => status >= 200 && status < 400,
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

  // Add download task to queue
  queue.add(() => handleDownload(chatId, text));
});

// ============================
// DOWNLOAD HANDLER
// ============================
async function handleDownload(chatId, text) {
  const sendingMsg = await bot.sendMessage(chatId, "⏳ Downloading TikTok video...");

  try {
    const url = await expandUrl(text);

    // TikWM API
    const apiRes = await axios.get("https://tikwm.com/api/", { params: { url } });
    if (!apiRes.data?.data?.play) throw new Error("Cannot fetch video URL");

    const videoUrl = apiRes.data.data.play;

    // Temporary folder
    const tempDir = path.join(__dirname, "temp");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const fileName = `tiktok_${Date.now()}.mp4`;
    const filePath = path.join(tempDir, fileName);

    // Download video
    const writer = fs.createWriteStream(filePath);
    const videoRes = await axios({ url: videoUrl, method: "GET", responseType: "stream" });
    videoRes.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    await bot.deleteMessage(chatId, sendingMsg.message_id);
    await bot.sendVideo(chatId, filePath);

    fs.unlinkSync(filePath); // Cleanup

  } catch (err) {
    console.error(err);
    await bot.editMessageText("❌ Error processing your link.", {
      chat_id: chatId,
      message_id: sendingMsg.message_id,
    });
  }
}
