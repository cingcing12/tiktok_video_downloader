const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const express = require("express");
require("dotenv").config();

// Bot setup
const TOKEN = process.env.TOKEN;
const bot = new TelegramBot(TOKEN, {
  polling: {
    interval: 300,
    autoStart: true,
    params: { timeout: 10 },
  },
});

console.log("Telegram bot is running...");

// Minimal Express server for UptimeRobot
const app = express();
app.get("/", (req, res) => res.send("🐰 Bot is alive!"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

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

    // Call your self-hosted TikTok downloader API with retry
    let apiRes;
    try {
      apiRes = await fetchWithRetry(
        `https://tiktok-api-video-downloader.onrender.com/tiktok/api.php?url=${encodeURIComponent(url)}`
      );
    } catch {
      await bot.sendMessage(chatId, "⏳ Server is waking up, please wait a few seconds and try again.");
      return;
    }

    const videoUrl = apiRes.data.video?.[0];
    if (!videoUrl) {
      await bot.sendMessage(chatId, "❌ Could not fetch video URL.");
      return;
    }

    // Prepare temp folder
    const tempDir = "temp";
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
    const fileName = `tiktok_${Date.now()}.mp4`;
    const filePath = path.join(tempDir, fileName);

    // Download video stream
    const writer = fs.createWriteStream(filePath);
    const videoRes = await axios({
      url: videoUrl,
      method: "GET",
      responseType: "stream",
      timeout: 60000,
    });

    videoRes.data.pipe(writer);

    writer.on("finish", async () => {
      try {
        // Send video directly
        await bot.sendVideo(chatId, filePath);

        // Delete "Downloading..." message
        if (progressMsg) {
          await bot.deleteMessage(chatId, progressMsg.message_id);
        }

        // Delete temp file
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error("Error sending video:", err);
        await bot.sendMessage(chatId, "❌ Failed to send video.");
      }
    });

    writer.on("error", async (err) => {
      console.error("Error writing video file:", err);
      await bot.sendMessage(chatId, "❌ Failed to download video.");
      if (progressMsg) {
        await bot.deleteMessage(chatId, progressMsg.message_id);
      }
    });
  } catch (err) {
    console.error("Processing error:", err);
    await bot.sendMessage(chatId, "❌ Error processing your TikTok link.");
    if (progressMsg) {
      await bot.deleteMessage(chatId, progressMsg.message_id);
    }
  }
});
