const express = require('express');
const { requireStaff } = require('../middleware/auth');
const notif = require('../services/notificationsService');

const router = express.Router();
router.use(requireStaff);

router.get('/', async (req, res) => {
  const items = await notif.list(req.staff.staff_id, {
    limit: parseInt(req.query.limit) || 20,
    unreadOnly: req.query.unread_only === 'true',
  });
  res.json({ success: true, items });
});

router.get('/unread-count', async (req, res) => {
  const n = await notif.unreadCount(req.staff.staff_id);
  res.json({ success: true, count: n });
});

router.post('/:id/read', async (req, res) => {
  await notif.markRead(parseInt(req.params.id), req.staff.staff_id);
  res.json({ success: true });
});

router.post('/read-all', async (req, res) => {
  const n = await notif.markAllRead(req.staff.staff_id);
  res.json({ success: true, marked: n });
});

module.exports = router;
