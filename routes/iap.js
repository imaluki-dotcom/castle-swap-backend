import express from 'express';
import admin from 'firebase-admin';
import fetch from 'node-fetch';

const router = express.Router();

const APPLE_SHARED_SECRET = process.env.APPLE_SHARED_SECRET;
const GOOGLE_SERVICE_ACCOUNT = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');

// Init Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(GOOGLE_SERVICE_ACCOUNT)
  });
}
const db = admin.firestore();

router.post('/verify-purchase', async (req, res) => {
  const { receipt, platform, productId, userId } = req.body;

  if (!receipt ||!platform ||!userId ||!productId) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    let isValid = false;
    let expiresAt = null;

    if (platform === 'ios') {
      let appleRes = await fetch('https://buy.itunes.apple.com/verifyReceipt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'receipt-data': receipt, password: APPLE_SHARED_SECRET, 'exclude-old-transactions': true })
      });
      let data = await appleRes.json();

      if (data.status === 21007) {
        appleRes = await fetch('https://sandbox.itunes.apple.com/verifyReceipt', {
          method: 'POST',
          body: JSON.stringify({ 'receipt-data': receipt, password: APPLE_SHARED_SECRET })
        });
        data = await appleRes.json();
      }

      if (data.status === 0) {
        isValid = true;
        const latestReceipt = data.latest_receipt_info?.[0] || data.receipt.in_app[0];
        expiresAt = new Date(parseInt(latestReceipt.expires_date_ms));
      }
    }

    if (!isValid) return res.status(400).json({ error: 'Invalid receipt' });

    const userRef = db.collection('users').doc(userId);

    if (productId === 'power_pack') {
      await userRef.set({
        powerBoosts: admin.firestore.FieldValue.increment(5),
        lastBoostPurchase: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } else {
      await userRef.set({
        tier: productId,
        platform,
        expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
        lastVerified: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    res.json({ success: true, tier: productId, expiresAt });

  } catch (err) {
    console.error('Verification error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

export default router;
