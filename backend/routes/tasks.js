const express = require('express');
const pg = require('../db/postgres');
const { requireStaff } = require('../middleware/auth');
const tasksSvc = require('../services/tasksService');
const notif = require('../services/notificationsService');

const router = express.Router();
router.use(requireStaff);

router.get('/', async (req, res) => {
  const owner = req.query.owner_id ? parseInt(req.query.owner_id) : req.staff.staff_id;
  const opts = {};
  if (req.query.status) opts.status = req.query.status.split(',');
  if (req.query.due_before) opts.due_before = req.query.due_before;
  if (req.query.due_after) opts.due_after = req.query.due_after;
  if (req.query.limit) opts.limit = parseInt(req.query.limit);
  const items = await tasksSvc.listForOwner(pg, owner, opts);
  res.json({ success: true, items });
});

router.post('/', async (req, res) => {
  const { title, body, conversation_id, owner_id, due_at, priority } = req.body || {};
  if (!title) return res.status(400).json({ success: false, message: 'title required' });
  try {
    const t = await tasksSvc.create(pg, {
      title, body, conversation_id,
      owner_id: owner_id || req.staff.staff_id,
      created_by: req.staff.staff_id,
      due_at, priority,
    });
    // Notify owner if != creator
    if (t.owner_id !== req.staff.staff_id) {
      await notif.notify(t.owner_id, 'task_assigned', `Task baru: ${title}`,
        { body: body?.slice(0, 200), link: `/tasks?focus=${t.id}`, payload: { task_id: t.id } });
    }
    res.json({ success: true, task: t });
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

router.get('/:id', async (req, res) => {
  const t = await tasksSvc.get(pg, parseInt(req.params.id));
  if (!t) return res.status(404).json({ success: false, message: 'not found' });
  res.json({ success: true, task: t });
});

router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const t = await tasksSvc.get(pg, id);
  if (!t) return res.status(404).json({ success: false, message: 'not found' });
  if (t.owner_id !== req.staff.staff_id && t.created_by !== req.staff.staff_id && req.staff.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'forbidden' });
  }
  const updated = await tasksSvc.update(pg, id, req.body || {});
  // If owner changed, notify new owner
  if (updated.owner_id !== t.owner_id) {
    await notif.notify(updated.owner_id, 'task_assigned', `Task di-assign ke kamu: ${updated.title}`,
      { link: `/tasks?focus=${id}`, payload: { task_id: id } });
  }
  res.json({ success: true, task: updated });
});

router.post('/:id/status', async (req, res) => {
  const id = parseInt(req.params.id);
  const { status, cancel_reason } = req.body || {};
  try {
    const t = await tasksSvc.setStatus(pg, id, status, { cancel_reason });
    res.json({ success: true, task: t });
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

router.post('/:id/snooze', async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const t = await tasksSvc.snooze(pg, id, req.body?.hours);
    res.json({ success: true, task: t });
  } catch (err) { res.status(400).json({ success: false, message: err.message }); }
});

router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const t = await tasksSvc.get(pg, id);
  if (!t) return res.status(404).json({ success: false, message: 'not found' });
  if (t.created_by !== req.staff.staff_id && req.staff.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'forbidden' });
  }
  await tasksSvc.destroy(pg, id);
  res.json({ success: true });
});

// Tasks per conv (used by chat detail panel)
router.get('/conv/:convId', async (req, res) => {
  const items = await tasksSvc.listForConv(pg, parseInt(req.params.convId));
  res.json({ success: true, items });
});

module.exports = router;
