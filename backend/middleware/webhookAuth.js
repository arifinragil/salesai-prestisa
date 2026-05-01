function verifyWebhookSecret(req, res, next) {
  const provided = req.header('X-Webhook-Secret');
  const expected = process.env.WAHA_WEBHOOK_SECRET;
  if (!expected) return res.status(500).json({ success: false, message: 'Webhook secret not configured' });
  if (!provided || provided !== expected) {
    return res.status(401).json({ success: false, message: 'Invalid webhook secret' });
  }
  next();
}

module.exports = { verifyWebhookSecret };
