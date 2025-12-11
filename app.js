const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// ============================
// TELEGRAM BOT SETUP
// ============================
const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error("❌ Please set your TOKEN in .env file");
  process.exit(1);
}

// Polling bot for Railway Worker
const bot = new TelegramBot(TOKEN, { polling: true });

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
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || !text.includes("tiktok.com")) return;

  const sendingMsg = await bot.sendMessage(chatId, "⏳ Downloading TikTok video...");

  try {
    const url = await expandUrl(text);

    // TikWM API (no rate limit, free)
    const apiRes = await axios.get("https://tikwm.com/api/", { params: { url } });
    if (!apiRes.data?.data?.play) throw new Error("Cannot fetch video URL");

    const videoUrl = apiRes.data.data.play;

    // Temporary download folder
    const tempDir = "temp";
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

    const fileName = `tiktok_${Date.now()}.mp4`;
    const filePath = path.join(tempDir, fileName);

    // Download video stream
    const writer = fs.createWriteStream(filePath);
    const videoRes = await axios({ url: videoUrl, method: "GET", responseType: "stream" });
    videoRes.data.pipe(writer);

    writer.on("finish", async () => {
      await bot.deleteMessage(chatId, sendingMsg.message_id);

      await bot.sendVideo(chatId, filePath, { caption: "✅ Video downloaded successfully!" });

      // Delete temp file
      fs.unlinkSync(filePath);
    });

    writer.on("error", async () => {
      await bot.editMessageText("❌ Failed to download video.", {
        chat_id: chatId,
        message_id: sendingMsg.message_id,
      });
    });

  } catch (err) {
    console.error(err);
    await bot.editMessageText("❌ Error processing your link.", {
      chat_id: chatId,
      message_id: sendingMsg.message_id,
    });
  }
});
