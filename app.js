const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");
require("dotenv").config();

// Bot setup (webhook mode)
const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN); // no polling

// Express server
const app = express();
app.use(express.json()); // parse JSON

// Ping route for UptimeRobot
app.get("/", (req, res) => res.send("🐰 Bot is alive!"));

// Telegram webhook endpoint
app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

// Set webhook
bot.setWebHook(`https://tiktok-video-downloader-vlrj.onrender.com/bot${TOKEN}`); // replace with your Render/Railway URL

// /start command
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "🐰 Send me a TikTok link and I will download the video for you!"
  );
});

// Helper: expand short TikTok URLs
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

// Helper: fetch API with retry
async function fetchWithRetry(url, retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.get(url);
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

// Main handler
bot.on("message", async (msg) => {
  const text = msg.text;
  const chatId = msg.chat.id;
  if (!text || !text.includes("tiktok.com")) return;

  // Send "Downloading..." message
  let progressMsg;
  try {
    progressMsg = await bot.sendMessage(chatId, "⏳ Downloading video in progress...");
  } catch (err) {
    console.error("Error sending progress message:", err);
  }

  try {
    const url = await expandUrl(text);

    // Call your TikTok downloader API with retry
    let apiRes;
    try {
      apiRes = await fetchWithRetry(
        `https://tiktok-api-video-downloader.onrender.com/tiktok/api.php?url=${encodeURIComponent(url)}`
      );
    } catch {
      await bot.sendMessage(
        chatId,
        "⏳ Server is waking up, please wait a few seconds and try again."
      );
      return;
    }

    const videoUrl = apiRes.data.video?.[0];
    if (!videoUrl) {
      await bot.sendMessage(chatId, "❌ Could not fetch video URL.");
      return;
    }

    // Stream video directly to Telegram
    const videoRes = await axios({
      url: videoUrl,
      method: "GET",
      responseType: "stream",
      timeout: 60000,
    });

    await bot.sendVideo(chatId, videoRes.data, {
      filename: `tiktok_${Date.now()}.mp4`,
    });

    // Delete "Downloading..." message
    if (progressMsg) await bot.deleteMessage(chatId, progressMsg.message_id);

  } catch (err) {
    console.error("Processing error:", err);
    await bot.sendMessage(chatId, "❌ Error processing your TikTok link.");
    if (progressMsg) await bot.deleteMessage(chatId, progressMsg.message_id);
  }
});
