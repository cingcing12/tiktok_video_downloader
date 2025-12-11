// ============================
// DEPENDENCIES
// ============================
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const express = require("express");
const PQueue = require("p-queue").default; // FIX: use .default
require("dotenv").config();

// ============================
// EXPRESS SERVER (Optional, prevent Render warnings)
// ============================
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("🐰 Telegram TikTok Bot is running!"));
app.listen(PORT, () => console.log(`Express server listening on port ${PORT}`));

// ============================
// TELEGRAM BOT SETUP
// ============================
const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error("❌ Please set your TOKEN in .env file");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

// ============================
// QUEUE SYSTEM: Limit concurrent downloads
// ============================
const queue = new PQueue({ concurrency: 2 }); // Adjust concurrency if needed

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
    const tempDir = "temp";
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

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
