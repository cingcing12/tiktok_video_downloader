const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// Your bot token
const TOKEN = "8304962337:AAEsuzE33xUviufaySlDD_I-KxZKH4Mqq-Y";
const bot = new TelegramBot(TOKEN, { polling: true });

// /start command
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "🐰 Send me a TikTok link and I will download the video for you!"
  );
});

// Helper function: expand short TikTok URLs
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

// Main message handler
bot.on("message", async (msg) => {
  const text = msg.text;
  const chatId = msg.chat.id;

  if (!text || !text.includes("tiktok.com")) return;

  // Send "Downloading" message and save message ID
  const sendingMsg = await bot.sendMessage(chatId, "⏳ Downloading TikTok video...");

  try {
    // Expand short URLs
    const url = await expandUrl(text);

    // Call your self-hosted TikTok downloader API
    const apiRes = await axios.get("https://tiktok-api-video-downloader.onrender.com/tiktok/api.php", {
      params: { url }
    });

    const videoUrl = apiRes.data.video[0];
    if (!videoUrl) {
      await bot.editMessageText("❌ Could not fetch video URL.", {
        chat_id: chatId,
        message_id: sendingMsg.message_id
      });
      return;
    }

    // Prepare temp file path
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
      // Delete "Downloading" message
      await bot.deleteMessage(chatId, sendingMsg.message_id);

      // Send video with caption alert
      await bot.sendVideo(chatId, filePath, {
        caption: "✅ Video downloaded successfully!"
      });

      // Delete temp file
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
    await bot.editMessageText("❌ Error processing your TikTok link.", {
      chat_id: chatId,
      message_id: sendingMsg.message_id
    });
  }
});
