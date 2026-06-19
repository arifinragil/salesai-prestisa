-- 041_lotus_sales_names.sql
-- Multi-name authorization for Lotus inbox: admin can pin one or more Lotus sales
-- names (assign_to_user_name / cs_name) that this user is allowed to read chats for.
-- - NULL or empty array → fall back to legacy match on staff_users.full_name
-- - Array containing '*' → bypass (see all chats, regardless of role)
-- - Array of names → match those exact names (case-insensitive)
ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS lotus_sales_names text[] DEFAULT NULL;
