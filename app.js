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

  // Send "Downloading" message
  const sendingMsg = await bot.sendMessage(chatId, "⏳ Downloading TikTok video...");

  try {
    const url = await expandUrl(text);

    // Call your self-hosted TikTok downloader API with retry
    const apiRes = await fetchWithRetry(
      `https://tiktok-api-video-downloader.onrender.com/tiktok/api.php?url=${encodeURIComponent(url)}`
    );

    const videoUrl = apiRes.data.video?.[0];
    if (!videoUrl) {
      await bot.editMessageText("❌ Could not fetch video URL.", {
        chat_id: chatId,
        message_id: sendingMsg.message_id,
      });
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
      timeout: 60000, // 60s timeout
    });

    videoRes.data.pipe(writer);

    writer.on("finish", async () => {
      try {
        // Delete "Downloading" message
        await bot.deleteMessage(chatId, sendingMsg.message_id);

        // Send video with success caption
        await bot.sendVideo(chatId, filePath);

        // Delete temp file
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error("Error sending video:", err);
      }
    });

    writer.on("error", async (err) => {
      console.error("Error writing video file:", err);
      await bot.editMessageText("❌ Failed to download video.", {
        chat_id: chatId,
        message_id: sendingMsg.message_id,
      });
    });
  } catch (err) {
    console.error("Processing error:", err);
    try {
      await bot.editMessageText("❌ Error processing your TikTok link.", {
        chat_id: chatId,
        message_id: sendingMsg.message_id,
      });
    } catch {}
  }
});
