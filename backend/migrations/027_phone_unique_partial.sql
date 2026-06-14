-- 027_phone_unique_partial.sql
-- The existing UNIQUE(phone) constraint was added under the assumption of one
-- WAHA conversation per phone. Lotus contacts can have multiple conversations
-- per phone (different business_numbers / sender), so the constraint blocks
-- the Lotus mirror.
--
-- Replace with a partial unique on WAHA convs only. Lotus convs are still
-- uniquely identified by lotus_id (UNIQUE partial index, migration 026).

ALTER TABLE crm_conversations DROP CONSTRAINT IF EXISTS crm_conversations_phone_key;

CREATE UNIQUE INDEX IF NOT EXISTS crm_conv_phone_waha_uidx
  ON crm_conversations(phone)
  WHERE source = 'waha';

-- Widen phone & real_phone to fit longer Lotus cust_numbers (max observed: 49).
ALTER TABLE crm_conversations
  ALTER COLUMN phone       TYPE VARCHAR(64),
  ALTER COLUMN real_phone  TYPE VARCHAR(64);
