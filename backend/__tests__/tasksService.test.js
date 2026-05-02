const tasks = require('../services/tasksService');
const pg = require('../db/postgres');

describe('isValidTransition', () => {
  test('open → in_progress allowed', () => expect(tasks.isValidTransition('open','in_progress')).toBe(true));
  test('open → done allowed', () => expect(tasks.isValidTransition('open','done')).toBe(true));
  test('in_progress → done allowed', () => expect(tasks.isValidTransition('in_progress','done')).toBe(true));
  test('done → open allowed (re-open)', () => expect(tasks.isValidTransition('done','open')).toBe(true));
  test('any non-done → cancelled allowed', () => {
    expect(tasks.isValidTransition('open','cancelled')).toBe(true);
    expect(tasks.isValidTransition('in_progress','cancelled')).toBe(true);
  });
  test('done → cancelled NOT allowed', () => expect(tasks.isValidTransition('done','cancelled')).toBe(false));
  test('cancelled → anything NOT allowed', () => {
    expect(tasks.isValidTransition('cancelled','open')).toBe(false);
    expect(tasks.isValidTransition('cancelled','done')).toBe(false);
  });
  test('same → same NOT allowed', () => expect(tasks.isValidTransition('open','open')).toBe(false));
  test('invalid status NOT allowed', () => expect(tasks.isValidTransition('open','xyz')).toBe(false));
});

describe('CRUD + setStatus + snooze', () => {
  let staffId;
  let createdId;

  beforeAll(async () => {
    const r = await pg.query(`SELECT id FROM staff_users WHERE active = TRUE LIMIT 1`);
    staffId = r.rows[0].id;
  });

  afterAll(async () => {
    if (createdId) await pg.query(`DELETE FROM crm_tasks WHERE id = $1`, [createdId]);
    await pg.end();
  });

  test('create + get', async () => {
    const t = await tasks.create(pg, {
      title: 'Test task', body: 'body', owner_id: staffId, created_by: staffId,
      due_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    createdId = t.id;
    expect(t.title).toBe('Test task');
    expect(t.status).toBe('open');
    const g = await tasks.get(pg, t.id);
    expect(g.id).toBe(t.id);
  });

  test('setStatus open → in_progress → done', async () => {
    let t = await tasks.setStatus(pg, createdId, 'in_progress');
    expect(t.status).toBe('in_progress');
    t = await tasks.setStatus(pg, createdId, 'done');
    expect(t.status).toBe('done');
    expect(t.completed_at).toBeTruthy();
  });

  test('setStatus invalid throws', async () => {
    await expect(tasks.setStatus(pg, createdId, 'cancelled')).rejects.toThrow(/invalid transition/);
  });

  test('snooze pushes due_at + clears reminder flags', async () => {
    // re-open first
    await tasks.setStatus(pg, createdId, 'open');
    await pg.query(`UPDATE crm_tasks SET reminder_sent_at = now() WHERE id = $1`, [createdId]);
    const t = await tasks.snooze(pg, createdId, 4);
    expect(t.reminder_sent_at).toBeNull();
    expect(new Date(t.due_at).getTime()).toBeGreaterThan(Date.now() + 3 * 3600_000);
  });

  test('listForOwner filter active', async () => {
    const list = await tasks.listForOwner(pg, staffId, { status: ['open','in_progress'] });
    expect(list.some((x) => x.id === createdId)).toBe(true);
  });
});
