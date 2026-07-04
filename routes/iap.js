import express from 'express';
import admin from 'firebase-admin';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const APPLE_SHARED_SECRET = process.env.APPLE_SHARED_SECRET; // get from App Store Connect
const GOOGLE_SERVICE_ACCOUNT = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

admin.initializeApp({ credential: admin.credential.cert(GOOGLE_SERVICE_ACCOUNT) });
const db = admin.firestore();

// POST /verify-purchase - frontend sends receipt here after IAP success
app.post('/verify-purchase', async (req, res) => {
  const { receipt, platform, productId, userId } = req.body;

  if (!receipt ||!platform ||!userId) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    let isValid = false;
    let expiresAt = null;
    let tier = productId;

    if (platform === 'ios') {
      // 1. Verify with Apple
      const appleRes = await fetch('https://buy.itunes.apple.com/verifyReceipt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'receipt-data': receipt, password: APPLE_SHARED_SECRET, 'exclude-old-transactions': true })
      });
      const data = await appleRes.json();

      // Sandbox fallback if production fails
      if (data.status === 21007) {
        const sandboxRes = await fetch('https://sandbox.itunes.apple.com/verifyReceipt', {
          method: 'POST',
          body: JSON.stringify({ 'receipt-data': receipt, password: APPLE_SHARED_SECRET })
        });
        Object.assign(data, await sandboxRes.json());
      }

      if (data.status === 0) {
        isValid = true;
        const latestReceipt = data.latest_receipt_info?.[0] || data.receipt.in_app[0];
        expiresAt = new Date(parseInt(latestReceipt.expires_date_ms));
      }
    }

    if (platform === 'android') {
      // 2. Verify with Google Play Developer API
      const auth = new admin.google.auth.GoogleAuth({
        credentials: GOOGLE_SERVICE_ACCOUNT,
        scopes: ['https://www.googleapis.com/auth/androidpublisher']
      });
      const client = await auth.getClient();

      const [response] = await client.request({
        url: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.castleswap.app/purchases/products/${productId}/tokens/${receipt}`
      });

      if (response.data.purchaseState === 0) {
        isValid = true;
        expiresAt = new Date(parseInt(response.data.expiryTimeMillis));
      }
    }

    if (!isValid) return res.status(400).json({ error: 'Invalid receipt' });

    // 3. Save to Firebase - backend is source of truth
    const userRef = db.collection('users').doc(userId);

    if (productId === 'power_pack') {
      // Consumable: add 5 boosts
      await userRef.set({
        powerBoosts: admin.firestore.FieldValue.increment(5),
        lastBoostPurchase: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } else {
      // Subscription: set tier + expiry
      await userRef.set({
        tier,
        platform,
        expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
        lastVerified: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    res.json({ success: true, tier, expiresAt });

  } catch (err) {
    console.error('Verification error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Middleware to check if user is Pro on every swap
app.use('/swap', async (req, res, next) => {
  const { userId } = req.body;
  const userDoc = await db.collection('users').doc(userId).get();
  const user = userDoc.data() || {};

  const now = new Date();
  const isPro = user.tier && user.expiresAt?.toDate() > now;

  req.userTier = isPro? user.tier : 'free';
  next();
});
