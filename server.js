const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_MESSAGE_LENGTH = 280;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MESSAGES_FILE = path.join(__dirname, "data", "messages.json");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Ensure data directory exists
fs.mkdirSync(path.dirname(MESSAGES_FILE), { recursive: true });

// Initialize messages file if it doesn't exist
if (!fs.existsSync(MESSAGES_FILE)) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify([], null, 2));
}

function readMessages() {
  const data = fs.readFileSync(MESSAGES_FILE, "utf-8");
  return JSON.parse(data);
}

function writeMessages(messages) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
}

async function sendTelegramNotification(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("Telegram notification skipped: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set");
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("Telegram API error:", err);
    }
  } catch (err) {
    console.error("Failed to send Telegram notification:", err.message);
  }
}

// Get all messages
app.get("/api/messages", (req, res) => {
  const messages = readMessages();
  res.json(messages);
});

// Add a new message
app.post("/api/messages", (req, res) => {
  const { message } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "Message is required" });
  }

  const trimmed = message.trim();

  if (trimmed.length === 0) {
    return res.status(400).json({ error: "Message cannot be empty" });
  }

  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    return res
      .status(400)
      .json({ error: `Message must be ${MAX_MESSAGE_LENGTH} characters or less` });
  }

  const messages = readMessages();
  const entry = {
    id: Date.now(),
    message: trimmed,
    timestamp: new Date().toISOString(),
  };
  messages.push(entry);
  writeMessages(messages);

  sendTelegramNotification(`New message on Message Board:\n\n${trimmed}`);

  res.status(201).json(entry);
});

// Telegram webhook - receives messages sent to the bot
app.post("/api/telegram-webhook", (req, res) => {
  const update = req.body;
  const text = update?.message?.text;

  if (!text) {
    return res.sendStatus(200);
  }

  const from = update.message.from;
  const sender = from.username
    ? `@${from.username}`
    : [from.first_name, from.last_name].filter(Boolean).join(" ");

  const messages = readMessages();
  const entry = {
    id: Date.now(),
    message: text,
    timestamp: new Date().toISOString(),
    source: "telegram",
    sender,
  };
  messages.push(entry);
  writeMessages(messages);

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
