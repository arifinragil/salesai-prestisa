-- 007_productivity_tables.sql — operator productivity + AI quality loop tables
BEGIN;

-- Conversation notes + tags (notes inline, tags many-to-many)
ALTER TABLE crm_conversations ADD COLUMN IF NOT EXISTS notes TEXT;

CREATE TABLE IF NOT EXISTS crm_tags (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(48) NOT NULL UNIQUE,
  color       VARCHAR(16) NOT NULL DEFAULT 'slate',
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm_conversation_tags (
  conversation_id INTEGER NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  tag_id          INTEGER NOT NULL REFERENCES crm_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, tag_id)
);
CREATE INDEX IF NOT EXISTS crm_conv_tags_tag_idx ON crm_conversation_tags(tag_id);

-- AI feedback per message (operator 👍/👎 to seed eval set)
ALTER TABLE crm_messages ADD COLUMN IF NOT EXISTS feedback SMALLINT;
ALTER TABLE crm_messages ADD COLUMN IF NOT EXISTS feedback_by INTEGER;
ALTER TABLE crm_messages ADD COLUMN IF NOT EXISTS feedback_at TIMESTAMPTZ;

-- Reply templates (canned responses)
CREATE TABLE IF NOT EXISTS crm_reply_templates (
  id          SERIAL PRIMARY KEY,
  shortcut    VARCHAR(32) NOT NULL UNIQUE,
  title       VARCHAR(120) NOT NULL,
  body        TEXT NOT NULL,
  category    VARCHAR(48),
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  INTEGER,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_reply_tpl_enabled_idx ON crm_reply_templates(enabled);

-- KB topics (replaces static aiKnowledge.js)
CREATE TABLE IF NOT EXISTS crm_kb_topics (
  id          SERIAL PRIMARY KEY,
  topic       VARCHAR(64) NOT NULL UNIQUE,
  body        TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  updated_by  INTEGER
);

-- Seed KB from static (idempotent insert)
INSERT INTO crm_kb_topics (topic, body) VALUES
('payment', 'Pembayaran bisa via transfer bank (BCA / Mandiri / BRI / BNI), QRIS, atau Virtual Account. Setelah transfer, bukti otomatis terverifikasi dalam beberapa menit. Kalau belum kebaca dalam 30 menit, hubungi tim Prestisa.'),
('refund_policy', 'Refund bisa diproses kalau order belum mulai diproduksi (sebelum 3-6 jam window pengiriman dimulai) dengan menghubungi tim Prestisa. Setelah masuk produksi, refund tidak bisa dilakukan, tapi bisa diganti tanggal kirim atau revisi alamat (selama belum dikirim).'),
('cancel_policy', 'Cancel bisa dilakukan sebelum produksi mulai. Hubungi tim Prestisa secepatnya, sebutkan nomor order. Setelah produksi mulai, cancel tidak bisa dilakukan, tapi penjadwalan ulang masih mungkin.'),
('hours', 'Prestisa beroperasi 24/7 untuk pemesanan online. Tim customer service aktif jam 08.00-22.00 WIB setiap hari. Order yang masuk di luar jam ini tetap diproses, tinggal menunggu konfirmasi pembayaran.'),
('lead_time', 'Lead time pengiriman 3-6 jam setelah pembayaran terkonfirmasi. Untuk papan bunga di kota besar (Jakarta, Surabaya, Bandung, dll), bisa lebih cepat. Untuk kota kecil atau jam puncak (Valentine, Mother''s Day, Hari Raya), bisa lebih lama — tim akan info kalau ada delay.'),
('area_coverage', 'Prestisa cover hampir semua kota di Indonesia. Untuk Jabodetabek free ongkir, area lain Rp50.000. Kalau kotanya tidak tercover, sistem akan kasih tahu saat checkout.'),
('shipping_fee', 'Free ongkir untuk wilayah Jabodetabek. Area lain Rp50.000 flat. Untuk pulau di luar Jawa atau lokasi remote, tim akan info kalau ada penyesuaian.'),
('product_type', 'Prestisa menyediakan: papan bunga (sukacita, dukacita, congratulations, grand opening), bouquet (hand bouquet, standing bouquet), parsel (lebaran, natal, fruit basket), dan cake (ulang tahun, anniversary). Setiap kategori ada banyak desain dan range harga.'),
('how_to_order', 'Cara order: kasih tahu jenis (papan/bouquet/parsel/cake), kota tujuan, dan budget. Kami kasih beberapa pilihan desain dengan harga. Setelah pilih, isi form order yang kami kirim — alamat penerima, ucapan kartu, dll. Bayar via VA/transfer/QRIS, dan order langsung diproses.'),
('invoice', 'Invoice/faktur otomatis dikirim via email setelah pembayaran terkonfirmasi. Kalau belum sampai, cek folder spam atau hubungi tim untuk dikirim ulang. Untuk faktur pajak/PPN, beritahu sebelum order dikonfirmasi.'),
('about', 'Prestisa adalah toko bunga online yang melayani karangan bunga papan, bouquet, parsel, dan cake ke hampir seluruh kota di Indonesia. Berdiri sejak [tahun], kami fokus pada kecepatan pengiriman (3-6 jam) dan kualitas presentasi.')
ON CONFLICT (topic) DO NOTHING;

-- CSAT (Customer Satisfaction) — collected post-resolution
CREATE TABLE IF NOT EXISTS crm_csat (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES crm_conversations(id) ON DELETE CASCADE,
  score           SMALLINT NOT NULL CHECK (score >= 1 AND score <= 5),
  comment         TEXT,
  collected_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_csat_conv_idx ON crm_csat(conversation_id);
CREATE INDEX IF NOT EXISTS crm_csat_collected_idx ON crm_csat(collected_at DESC);

-- A/B persona experiment (split active personas)
CREATE TABLE IF NOT EXISTS crm_persona_experiments (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(64) NOT NULL,
  variant_a       INTEGER NOT NULL REFERENCES crm_persona_prompts(id),
  variant_b       INTEGER NOT NULL REFERENCES crm_persona_prompts(id),
  split_pct       SMALLINT NOT NULL DEFAULT 50,
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT now(),
  CHECK (split_pct BETWEEN 1 AND 99),
  CHECK (variant_a <> variant_b)
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_persona_exp_active_idx
  ON crm_persona_experiments(enabled) WHERE enabled = TRUE;

ALTER TABLE crm_conversations
  ADD COLUMN IF NOT EXISTS experiment_variant CHAR(1);

-- Eval result history
CREATE TABLE IF NOT EXISTS crm_eval_runs (
  id          SERIAL PRIMARY KEY,
  ran_at      TIMESTAMPTZ DEFAULT now(),
  ran_by      INTEGER,
  total       INTEGER NOT NULL,
  passed      INTEGER NOT NULL,
  pass_rate   NUMERIC(5,2) NOT NULL,
  details     JSONB
);
CREATE INDEX IF NOT EXISTS crm_eval_runs_at_idx ON crm_eval_runs(ran_at DESC);

COMMIT;
