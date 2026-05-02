const { computeNextStage, apply } = require('../services/pipelineEngine');
const pg = require('../db/postgres');

describe('computeNextStage', () => {
  test('baru + intent_qualified → tertarik', () => {
    expect(computeNextStage('baru', { type: 'intent_qualified' }, false)).toBe('tertarik');
  });
  test('tertarik + order_url_sent → form_dikirim', () => {
    expect(computeNextStage('tertarik', { type: 'order_url_sent' }, false)).toBe('form_dikirim');
  });
  test('baru + order_url_sent → form_dikirim (skip stage)', () => {
    expect(computeNextStage('baru', { type: 'order_url_sent' }, false)).toBe('form_dikirim');
  });
  test('form_dikirim + order_submitted → order_submitted', () => {
    expect(computeNextStage('form_dikirim', { type: 'order_submitted' }, false)).toBe('order_submitted');
  });
  test('order_submitted + order_paid → paid', () => {
    expect(computeNextStage('order_submitted', { type: 'order_paid' }, false)).toBe('paid');
  });
  test('paid + order_delivered → delivered', () => {
    expect(computeNextStage('paid', { type: 'order_delivered' }, false)).toBe('delivered');
  });

  test('any stage + handover_refund → lost', () => {
    expect(computeNextStage('tertarik', { type: 'handover_refund' }, false)).toBe('lost');
    expect(computeNextStage('paid', { type: 'handover_refund' }, false)).toBe('lost');
  });
  test('any stage + handover_cancel → lost', () => {
    expect(computeNextStage('form_dikirim', { type: 'handover_cancel' }, false)).toBe('lost');
  });
  test('any stage + spam_blocked → lost', () => {
    expect(computeNextStage('baru', { type: 'spam_blocked' }, false)).toBe('lost');
  });
  test('tertarik/form_dikirim + stale_no_reply → lost', () => {
    expect(computeNextStage('tertarik', { type: 'stale_no_reply' }, false)).toBe('lost');
    expect(computeNextStage('form_dikirim', { type: 'stale_no_reply' }, false)).toBe('lost');
  });
  test('paid + stale_no_reply → null (not eligible)', () => {
    expect(computeNextStage('paid', { type: 'stale_no_reply' }, false)).toBeNull();
  });

  test('manual override blocks backward auto-transition', () => {
    expect(computeNextStage('tertarik', { type: 'intent_qualified' }, true)).toBeNull();
  });
  test('manual override does NOT block forward auto-transition', () => {
    expect(computeNextStage('tertarik', { type: 'order_url_sent' }, true)).toBe('form_dikirim');
  });
  test('manual override does not block lost transition', () => {
    expect(computeNextStage('tertarik', { type: 'handover_refund' }, true)).toBe('lost');
  });

  test('same stage event returns null', () => {
    expect(computeNextStage('tertarik', { type: 'intent_qualified' }, false)).toBeNull();
  });
  test('order_paid on stage already paid returns null', () => {
    expect(computeNextStage('paid', { type: 'order_paid' }, false)).toBeNull();
  });

  test('lost + customer_replied → tertarik (reactivate)', () => {
    expect(computeNextStage('lost', { type: 'customer_replied' }, false)).toBe('tertarik');
  });
  test('delivered + customer_replied → null (do NOT reactivate)', () => {
    expect(computeNextStage('delivered', { type: 'customer_replied' }, false)).toBeNull();
  });

  test('baru + operator_claim → tertarik', () => {
    expect(computeNextStage('baru', { type: 'operator_claim' }, false)).toBe('tertarik');
  });
  test('form_dikirim + operator_claim → null', () => {
    expect(computeNextStage('form_dikirim', { type: 'operator_claim' }, false)).toBeNull();
  });

  test('baru + stale_baru_no_reply → lost', () => {
    expect(computeNextStage('baru', { type: 'stale_baru_no_reply' }, false)).toBe('lost');
  });
  test('tertarik + stale_baru_no_reply → null (only baru)', () => {
    expect(computeNextStage('tertarik', { type: 'stale_baru_no_reply' }, false)).toBeNull();
  });

  test('unknown event → null', () => {
    expect(computeNextStage('baru', { type: 'unknown_xyz' }, false)).toBeNull();
  });
});

describe('apply (DB writer)', () => {
  let convId;

  beforeAll(async () => {
    const r = await pg.query(
      `INSERT INTO crm_conversations (phone, status) VALUES ('628999000001', 'open') RETURNING id`
    );
    convId = r.rows[0].id;
  });

  afterAll(async () => {
    await pg.query(`DELETE FROM crm_pipeline_events WHERE conversation_id = $1`, [convId]);
    await pg.query(`DELETE FROM crm_conversations WHERE id = $1`, [convId]);
    await pg.end();
  });

  test('apply intent_qualified on baru → tertarik', async () => {
    await pg.query(
      `UPDATE crm_conversations SET pipeline_stage='baru', manual_stage_override=FALSE,
       pipeline_stage_history='[]'::jsonb WHERE id=$1`,
      [convId]
    );
    const r = await apply(pg, convId, { type: 'intent_qualified' }, { source: 'auto:test' });
    expect(r.applied).toBe(true);
    expect(r.fromStage).toBe('baru');
    expect(r.toStage).toBe('tertarik');

    const c = await pg.query(
      `SELECT pipeline_stage, manual_stage_override, pipeline_stage_history FROM crm_conversations WHERE id=$1`,
      [convId]
    );
    expect(c.rows[0].pipeline_stage).toBe('tertarik');
    expect(c.rows[0].manual_stage_override).toBe(false);
    expect(c.rows[0].pipeline_stage_history).toHaveLength(1);
    expect(c.rows[0].pipeline_stage_history[0].source).toBe('auto:test');
  });

  test('apply same event twice is no-op', async () => {
    const before = await pg.query(
      `SELECT COUNT(*)::int AS n FROM crm_pipeline_events WHERE conversation_id=$1`, [convId]
    );
    const r = await apply(pg, convId, { type: 'intent_qualified' }, { source: 'auto:test' });
    expect(r.applied).toBe(false);
    const after = await pg.query(
      `SELECT COUNT(*)::int AS n FROM crm_pipeline_events WHERE conversation_id=$1`, [convId]
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  test('apply with force=true sets override and forces transition', async () => {
    const r = await apply(pg, convId,
      { type: 'manual_set', targetStage: 'paid' },
      { source: 'manual:operator', force: true }
    );
    expect(r.applied).toBe(true);
    expect(r.toStage).toBe('paid');
    const c = await pg.query(
      `SELECT pipeline_stage, manual_stage_override FROM crm_conversations WHERE id=$1`, [convId]
    );
    expect(c.rows[0].pipeline_stage).toBe('paid');
    expect(c.rows[0].manual_stage_override).toBe(true);
  });

  test('manual override blocks backward but allows forward + clears flag', async () => {
    // Currently paid + override true. order_submitted = backward → no-op.
    const r1 = await apply(pg, convId, { type: 'order_submitted' }, { source: 'auto:funnel' });
    expect(r1.applied).toBe(false);
    // order_delivered from paid → forward → allowed, clears override.
    const r2 = await apply(pg, convId, { type: 'order_delivered' }, { source: 'auto:cron' });
    expect(r2.applied).toBe(true);
    expect(r2.toStage).toBe('delivered');
    const c = await pg.query(
      `SELECT manual_stage_override FROM crm_conversations WHERE id=$1`, [convId]
    );
    expect(c.rows[0].manual_stage_override).toBe(false);
  });
});

const { computeForecastFromRows } = require('../services/pipelineEngine');

describe('computeForecastFromRows', () => {
  test('sums value × probability for non-terminal with value', () => {
    const rows = [
      { pipeline_stage: 'tertarik', deal_value_idr: 500_000 },
      { pipeline_stage: 'form_dikirim', deal_value_idr: 1_000_000 },
      { pipeline_stage: 'order_submitted', deal_value_idr: 2_000_000 },
      { pipeline_stage: 'paid', deal_value_idr: 750_000 },
      { pipeline_stage: 'delivered', deal_value_idr: 800_000 },
      { pipeline_stage: 'lost', deal_value_idr: 600_000 },
      { pipeline_stage: 'baru', deal_value_idr: null },
    ];
    const r = computeForecastFromRows(rows);
    // 75k + 350k + 1.4M + 0 (paid is realized) = 1,825,000
    expect(r.expectedRevenue).toBe(1_825_000);
    // realized = paid + delivered = 1,550,000
    expect(r.realizedRevenue).toBe(1_550_000);
    expect(r.dealCount).toBe(7);
  });

  test('byStage groups count + sum', () => {
    const rows = [
      { pipeline_stage: 'tertarik', deal_value_idr: 100_000 },
      { pipeline_stage: 'tertarik', deal_value_idr: 200_000 },
      { pipeline_stage: 'paid', deal_value_idr: 500_000 },
    ];
    const r = computeForecastFromRows(rows);
    expect(r.byStage.tertarik).toEqual({ count: 2, value: 300_000 });
    expect(r.byStage.paid).toEqual({ count: 1, value: 500_000 });
  });

  test('handles empty rows', () => {
    const r = computeForecastFromRows([]);
    expect(r.expectedRevenue).toBe(0);
    expect(r.dealCount).toBe(0);
  });
});
