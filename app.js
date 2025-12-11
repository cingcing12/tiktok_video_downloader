const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");
require("dotenv").config();

// Bot setup (webhook mode ONLY)
const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, { webHook: true });

// Express server
const app = express();
app.use(express.json()); // Important for webhooks!

// Ping route
app.get("/", (req, res) => res.send("🐰 Bot is alive!"));

// Webhook endpoint (CRITICAL FIX)
app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Start express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Web server running on port ${PORT}`));

// Set the webhook (VERY IMPORTANT)
const WEBHOOK_URL = `https://tiktok-video-downloader-vlrj.onrender.com/bot${TOKEN}`;
bot.setWebHook(WEBHOOK_URL);

// /start command
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "🐰 Send me any TikTok link and I will download the video for you!"
  );
});

// Expand short TikTok URLs
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

// Retry wrapper
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

// MAIN video downloader
bot.on("message", async (msg) => {
  const text = msg.text;
  const chatId = msg.chat.id;

  if (!text || !text.includes("tiktok.com")) return;

  let loadingMsg = await bot.sendMessage(chatId, "⏳ Downloading video...");

  try {
    const expandedUrl = await expandUrl(text);

    // Call your API
    const apiRes = await fetchWithRetry(
      `https://tiktok-api-video-downloader.onrender.com/tiktok/api.php?url=${encodeURIComponent(
        expandedUrl
      )}`
    );

    const videoUrl = apiRes.data.video?.[0];
    if (!videoUrl) {
      await bot.sendMessage(chatId, "❌ Cannot fetch video.");
      return;
    }

    // Download video (stream)
    const videoStream = await axios({
      url: videoUrl,
      method: "GET",
      responseType: "stream",
      timeout: 60000,
    });

    await bot.sendVideo(chatId, videoStream.data, {
      filename: `tiktok_${Date.now()}.mp4`,
    });

    await bot.deleteMessage(chatId, loadingMsg.message_id);
  } catch (err) {
    console.error("❌ Error:", err.message);

    await bot.sendMessage(chatId, "❌ Error downloading video. Try again.");

    try {
      await bot.deleteMessage(chatId, loadingMsg.message_id);
    } catch {}
  }
});
