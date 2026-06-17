// backend/services/stuckGroup.js
// Pure taxonomy helper: root_cause_tag → stuck_group → stuck_bucket.
// No DB access, no side effects — safe to require in tests and routes.

const GROUP_MAP = {
  harga_terlalu_mahal: 'customer', window_shopping: 'customer', kompetitor: 'customer', ragu_kredibilitas: 'customer',
  respon_lambat: 'sales', info_produk_kurang: 'sales',
  barang_tidak_tersedia: 'offer', ekspektasi_design: 'offer', area_pengiriman: 'offer', timing_pengiriman: 'offer',
};

const BUCKET = { customer: 'A', sales: 'B', offer: 'C', proses: 'D' };

/** Returns the stuck_group for a root_cause_tag. Falls back to 'proses'. */
function STUCK_GROUP_OF(rc) { return GROUP_MAP[rc] || 'proses'; }

/** Returns the stuck_bucket letter for a group. Returns null for unknown groups. */
function bucketOfGroup(g) { return BUCKET[g] || null; }

module.exports = { STUCK_GROUP_OF, bucketOfGroup, GROUP_MAP, BUCKET };
