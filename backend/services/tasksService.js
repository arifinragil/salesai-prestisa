// Tasks domain logic. Pure data access + transition guards.
const VALID_STATUSES = ['open', 'in_progress', 'done', 'cancelled'];
const VALID_PRIORITIES = ['low', 'normal', 'high'];

// Allowed transitions table. Returns true if transition allowed.
function isValidTransition(from, to) {
  if (!VALID_STATUSES.includes(to)) return false;
  if (from === to) return false;
  // any → cancelled (creator/owner can cancel anytime non-done)
  if (to === 'cancelled' && from !== 'done') return true;
  // open ↔ in_progress, open → done, in_progress → done, done → open (re-open)
  const map = {
    open: ['in_progress', 'done'],
    in_progress: ['open', 'done'],
    done: ['open'],
    cancelled: [],
  };
  return map[from]?.includes(to) || false;
}

async function create(client, data) {
  if (!data.title || !data.owner_id || !data.created_by) {
    throw new Error('title + owner_id + created_by required');
  }
  if (data.priority && !VALID_PRIORITIES.includes(data.priority)) {
    throw new Error(`priority must be: ${VALID_PRIORITIES.join('|')}`);
  }
  const { rows } = await client.query(
    `INSERT INTO crm_tasks (title, body, conversation_id, owner_id, created_by, priority, due_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6,'normal'), $7)
     RETURNING *`,
    [data.title, data.body || null, data.conversation_id || null,
     data.owner_id, data.created_by, data.priority || null, data.due_at || null]
  );
  return rows[0];
}

async function get(client, id) {
  const { rows } = await client.query(`SELECT * FROM crm_tasks WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function update(client, id, data) {
  const sets = [];
  const params = [id];
  for (const k of ['title', 'body', 'priority', 'due_at', 'owner_id']) {
    if (data[k] !== undefined) {
      params.push(data[k]);
      sets.push(`${k} = $${params.length}`);
    }
  }
  if (!sets.length) return get(client, id);
  sets.push('updated_at = now()');
  // Reset reminder if due_at changed
  if (data.due_at !== undefined) sets.push('reminder_sent_at = NULL', 'overdue_sent_at = NULL');
  const { rows } = await client.query(
    `UPDATE crm_tasks SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params
  );
  return rows[0];
}

async function setStatus(client, id, newStatus, opts = {}) {
  const current = await get(client, id);
  if (!current) throw new Error('task_not_found');
  if (!isValidTransition(current.status, newStatus)) {
    throw new Error(`invalid transition: ${current.status} → ${newStatus}`);
  }
  const sets = ['status = $2', 'updated_at = now()'];
  const params = [id, newStatus];
  if (newStatus === 'done') sets.push('completed_at = now()');
  else if (newStatus === 'cancelled') {
    sets.push('cancelled_at = now()');
    if (opts.cancel_reason) {
      params.push(opts.cancel_reason);
      sets.push(`cancel_reason = $${params.length}`);
    }
  } else if (newStatus === 'open' && current.status === 'done') {
    sets.push('completed_at = NULL');
  }
  const { rows } = await client.query(
    `UPDATE crm_tasks SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params
  );
  return rows[0];
}

async function snooze(client, id, hours) {
  const h = parseInt(hours);
  if (!Number.isFinite(h) || h < 1 || h > 720) throw new Error('hours 1-720 required');
  const { rows } = await client.query(
    `UPDATE crm_tasks
       SET due_at = COALESCE(due_at, now()) + ($2 || ' hours')::interval,
           reminder_sent_at = NULL,
           overdue_sent_at = NULL,
           updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, String(h)]
  );
  return rows[0];
}

async function listForOwner(client, ownerId, opts = {}) {
  const where = ['owner_id = $1'];
  const params = [ownerId];
  if (opts.status) {
    if (Array.isArray(opts.status)) {
      params.push(opts.status);
      where.push(`status = ANY($${params.length}::varchar[])`);
    } else {
      params.push(opts.status);
      where.push(`status = $${params.length}`);
    }
  }
  if (opts.due_before) { params.push(opts.due_before); where.push(`due_at <= $${params.length}`); }
  if (opts.due_after) { params.push(opts.due_after); where.push(`due_at >= $${params.length}`); }
  const limit = Math.min(opts.limit || 200, 500);
  const { rows } = await client.query(
    `SELECT * FROM crm_tasks WHERE ${where.join(' AND ')} ORDER BY due_at NULLS LAST, id DESC LIMIT ${limit}`,
    params
  );
  return rows;
}

async function listForConv(client, convId) {
  const { rows } = await client.query(
    `SELECT * FROM crm_tasks WHERE conversation_id = $1 AND status NOT IN ('done','cancelled')
     ORDER BY due_at NULLS LAST, id`,
    [convId]
  );
  return rows;
}

async function destroy(client, id) {
  await client.query(`DELETE FROM crm_tasks WHERE id = $1`, [id]);
}

module.exports = {
  create, get, update, setStatus, snooze, listForOwner, listForConv, destroy,
  isValidTransition, VALID_STATUSES, VALID_PRIORITIES,
};
