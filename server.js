const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
app.use(express.json());

// Firebase - will read from env var
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  console.log('FIREBASE_SERVICE_ACCOUNT not set yet');
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const bot = botToken ? new TelegramBot(botToken, {polling: false}) : null;
const PORT = process.env.PORT || 3000;

// Health check endpoint - Render uses this
app.get('/health', (req, res) => {
  res.json({status: 'ok', time: new Date().toISOString(), port: PORT});
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({message: 'Castle Swap API is running', status: 'ok'});
});

// Swap endpoint
app.post('/swap', async (req, res) => {
  try {
    const {amount, token, userId} = req.body;
    console.log('Swap request:', {amount, token, userId});
    res.json({success: true, amount, token, userId});
  } catch (err) {
    console.error(err);
    res.status(500).json({error: err.message});
  }
});

// Telegram webhook endpoint
app.post('/webhook', (req, res) => {
  if (bot) bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Castle Swap API running on port ${PORT}`);
});
import iapRoutes from './routes/iap.js';
app.use('/', iapRoutes);
