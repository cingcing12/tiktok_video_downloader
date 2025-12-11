const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
require('dotenv').config();

// Your bot token
const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

// /start command
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "🐰 Send me a TikTok link and I will download the video for you!"
  );
});

// Expand short TikTok URLs
async function expandUrl(shortUrl) {
  try {
    const res = await axios.get(shortUrl, {
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400
    });
    return res.headers.location || shortUrl;
  } catch {
    return shortUrl;
  }
}

// Main handler
bot.on("message", async (msg) => {
  const text = msg.text;
  const chatId = msg.chat.id;

  if (!text || !text.includes("tiktok.com")) return;

  const sendingMsg = await bot.sendMessage(chatId, "⏳ Downloading TikTok video...");

  try {
    // Expand short URLs
    const url = await expandUrl(text);

    // 📌 NEW API: TikWM (no rate limit)
    const apiRes = await axios.get("https://tikwm.com/api/", {
      params: { url }
    });

    if (!apiRes.data || !apiRes.data.data) {
      throw new Error("API returned empty result");
    }

    const videoUrl = apiRes.data.data.play;

    if (!videoUrl) {
      await bot.editMessageText("❌ Could not get video URL.", {
        chat_id: chatId,
        message_id: sendingMsg.message_id
      });
      return;
    }

    // Temp folder
    const tempDir = "temp";
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

    const fileName = `tiktok_${Date.now()}.mp4`;
    const filePath = path.join(tempDir, fileName);

    // Download video
    const writer = fs.createWriteStream(filePath);
    const videoRes = await axios({
      url: videoUrl,
      method: "GET",
      responseType: "stream",
    });

    videoRes.data.pipe(writer);

    writer.on("finish", async () => {
      await bot.deleteMessage(chatId, sendingMsg.message_id);

      await bot.sendVideo(chatId, filePath, {
        caption: "✅ Video downloaded successfully!"
      });

      fs.unlinkSync(filePath);
    });

    writer.on("error", async () => {
      await bot.editMessageText("❌ Failed to download video.", {
        chat_id: chatId,
        message_id: sendingMsg.message_id
      });
    });

  } catch (err) {
    console.error(err);
    await bot.editMessageText("❌ Error processing your link.", {
      chat_id: chatId,
      message_id: sendingMsg.message_id
    });
  }
});
