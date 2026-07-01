const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
app.use(cors());

// 1. FIREBASE SETUP
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// 2. TELEGRAM BOT
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const ADMIN_ID = parseInt(process.env.ADMIN_ID); // Your Telegram ID

// 3. GLOBAL FLAGS
let EMERGENCY_STOP = false;
const EMERGENCY_KEY = process.env.EMERGENCY_KEY || 'STOP2026NBO';
let tournamentActive = false;

// 4. HEALTH + KILL SWITCH
app.get('/health', (req, res) => res.json({status: 'ok', users: db ? 'connected' : 'down'}));
app.get('/emergency-stop', (req, res) => {
  if (req.query.key !== EMERGENCY_KEY) return res.status(403).send('Invalid');
  EMERGENCY_STOP = !EMERGENCY_STOP;
  bot.sendMessage(ADMIN_ID, EMERGENCY_STOP ? '🚨 GAME FROZEN' : '✅ GAME LIVE');
  res.json({emergency: EMERGENCY_STOP});
function checkEmergency() { if (EMERGENCY_STOP) throw new Error('PAUSED'); }

// 5. M-PESA STK PUSH
app.post('/stk', async (req, res) => {
  try {
    checkEmergency();
    const {phone, amount, userId} = req.body;
    const token = await getMpesaToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0,14);
    const password = Buffer.from(process.env.MPESA_SHORTCODE + process.env.MPESA_PASSKEY + timestamp).toString('base64');
    
    const payload = {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: process.env.MPESA_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: process.env.BACKEND_URL + '/mpesa-callback',
      AccountReference: userId,
      TransactionDesc: 'Castle Swap +10s'
    };
    
    await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', payload, {
      headers: {Authorization: 'Bearer ' + token}
    });
    res.json({ok: true});
  } catch(e) { res.status(500).json({error: e.message}); }
});

async function getMpesaToken() {
  const auth = Buffer.from(process.env.MPESA_CONSUMER_KEY + ':' + process.env.MPESA_CONSUMER_SECRET).toString('base64');
  const r = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
    headers: {Authorization: 'Bearer ' + auth}
  });
  return r.data.access_token;
}

// 6. M-PESA CALLBACK
app.post('/mpesa-callback', async (req, res) => {
  const data = req.body.Body.stkCallback;
  if (data.ResultCode === 0) {
    const userId = data.CallbackMetadata.Item.find(i => i.Name === 'AccountReference').Value;
    await db.collection('players').doc(userId).update({
      timeBoost: admin.firestore.FieldValue.increment(10),
      coins: admin.firestore.FieldValue.increment(10)
    });
  }
  res.json({ResultCode: 0, ResultDesc: 'OK'});
});

// 7. TOURNAMENT SUBMIT
app.post('/submit-score', async (req, res) => {
  try {
    checkEmergency();
    if (!tournamentActive) return res.status(403).json({error: 'Tournament ended'});
    const {userId, score, clan} = req.body;
    await db.collection('tournament').doc(userId).set({
      score, clan, time: new Date()
    }, {merge: true});
    res.json({ok: true});
  } catch(e) { res.status(503).json({error: 'Paused'}); }
});

// 8. ADMIN ENDPOINTS
app.get('/admin', async (req, res) => {
  const users = await db.collection('players').get();
  const revenue = await db.collection('mpesa').get();
  res.json({
    totalUsers: users.size,
    totalRevenue: revenue.docs.reduce((s,d) => s + d.data().amount, 0)
  });
});

app.post('/toggle-tournament', (req, res) => {
  tournamentActive = !tournamentActive;
  res.json({active: tournamentActive});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on ' + PORT));
