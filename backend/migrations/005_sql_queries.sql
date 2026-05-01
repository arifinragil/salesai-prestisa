-- 005_sql_queries.sql — admin-defined SQL templates that AI can run via run_named_query tool
BEGIN;

CREATE TABLE IF NOT EXISTS crm_sql_queries (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(64) NOT NULL UNIQUE,
  description TEXT NOT NULL,
  params      JSONB NOT NULL DEFAULT '[]'::jsonb,
  sql_text    TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  row_limit   INTEGER NOT NULL DEFAULT 20,
  created_by  INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_sql_queries_enabled_idx
  ON crm_sql_queries(enabled, name);

-- Seed one example so admins see the format right away
INSERT INTO crm_sql_queries (name, description, params, sql_text, row_limit)
SELECT 'top_seller_per_kota',
       'Top 10 produk terlaris di kota tertentu (berdasarkan jumlah order_items.bought).',
       '[{"name":"kota","type":"string","required":true,"description":"Nama kota tujuan, contoh: Bekasi, Jakarta"}]'::jsonb,
$sql$SELECT p.id, p.name AS produk, p.price AS harga, g.name AS kota,
       COUNT(oi.id) AS total_terjual
FROM products p
JOIN geo g ON g.id = p.city
LEFT JOIN order_items oi ON oi.product_id = p.id
  AND oi.bought > 0 AND oi.deleted_at IS NULL
WHERE p.deleted_at IS NULL AND p.price > 0
  AND g.name LIKE CONCAT('%', :kota, '%')
GROUP BY p.id, p.name, p.price, g.name
ORDER BY total_terjual DESC, p.id DESC
LIMIT 10$sql$,
       10
WHERE NOT EXISTS (SELECT 1 FROM crm_sql_queries WHERE name = 'top_seller_per_kota');

COMMIT;
