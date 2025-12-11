const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const express = require("express");

// =======================
// Telegram Bot
// =======================
const TOKEN = process.env.TOKEN || "YOUR_TOKEN_HERE";
const bot = new TelegramBot(TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "🐰 Send me a TikTok link!");
});

// Expand short links
async function expandUrl(shortUrl) {
  try {
    const res = await axios.get(shortUrl, {
      maxRedirects: 0,
      validateStatus: (code) => code >= 200 && code < 400
    });
    return res.headers.location || shortUrl;
  } catch {
    return shortUrl;
  }
}

bot.on("message", async (msg) => {
  const text = msg.text;
  if (!text || !text.includes("tiktok.com")) return;

  const chatId = msg.chat.id;
  const loadingMsg = await bot.sendMessage(chatId, "⏳ Downloading...");

  try {
    const url = await expandUrl(text);

    const api = await axios.get("https://tiktok-api-video-downloader.onrender.com/tiktok/api.php", {
      params: { url }
    });

    const videoUrl = api.data.video?.[0];
    if (!videoUrl) {
      await bot.editMessageText("❌ Cannot fetch video URL.", {
        chat_id: chatId, message_id: loadingMsg.message_id
      });
      return;
    }

    if (!fs.existsSync("temp")) fs.mkdirSync("temp");

    const fileName = `tiktok_${Date.now()}.mp4`;
    const filePath = path.join("temp", fileName);

    const writer = fs.createWriteStream(filePath);
    const videoStream = await axios({
      url: videoUrl,
      method: "GET",
      responseType: "stream"
    });

    videoStream.data.pipe(writer);

    writer.on("finish", async () => {
      await bot.deleteMessage(chatId, loadingMsg.message_id);
      await bot.sendVideo(chatId, filePath, { caption: "✅ Downloaded!" });
      fs.unlinkSync(filePath);
    });

    writer.on("error", async () => {
      await bot.editMessageText("❌ Download error.", {
        chat_id: chatId, message_id: loadingMsg.message_id
      });
    });

  } catch (err) {
    console.error(err);
    await bot.editMessageText("❌ Error processing TikTok link!", {
      chat_id: chatId, message_id: loadingMsg.message_id
    });
  }
});

// =======================
// EXPRESS SERVER (REQUIRED FOR RENDER FREE TIER)
// =======================
const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("Bot is alive! 🐰");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
