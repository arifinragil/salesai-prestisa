-- 016_seed_copilot_cases.sql — starter case library for copilot mode
BEGIN;

INSERT INTO crm_reply_templates (shortcut, title, body, enabled, category, case_label, case_pattern, intent_match) VALUES
('greeting_default',
 'Greeting awal',
 'Halo Kak 🌷 terima kasih sudah chat Prestisa. Ada yang bisa Tiara bantu? Mau cari bunga papan, bouquet, parsel, atau cake?',
 TRUE, 'copilot', 'Greeting awal', '\b(halo|hai|hi|assalam|pagi|siang|sore|malam)\b', 'greeting'),

('ask_clarify',
 'Minta detail order',
 'Boleh Kak share detailnya: untuk siapa, kapan dikirim, dan ke kota mana ya? Biar Tiara bisa siapkan rekomendasi yang pas 🙏',
 TRUE, 'copilot', 'Minta detail order', '\b(mau|cari|butuh|order|pesan)\b', 'product_info'),

('escalate_default',
 'Escalate fallback',
 'Sebentar ya Kak, Tiara hubungkan dengan tim spesialis untuk pastikan info lebih detail 🙏',
 TRUE, 'copilot', 'Escalate fallback', NULL, NULL),

('pricing_general',
 'Tanya harga umum',
 'Range harga kami Kak: bunga papan mulai Rp 350rb, bouquet mulai Rp 150rb, parsel mulai Rp 250rb, cake mulai Rp 200rb. Boleh Tiara kirimkan pilihan sesuai budget Kakak?',
 TRUE, 'copilot', 'Tanya harga umum', '\b(harga|berapa|murah|budget|anggaran)\b', 'pricing'),

('shipping_jabodetabek',
 'Tanya ongkir',
 'Untuk area Jabodetabek free ongkir Kak ✨ luar Jabodetabek mulai Rp 50rb tergantung kota. Mau kirim ke kota mana?',
 TRUE, 'copilot', 'Tanya ongkir', '\b(ongkir|ongkos|kirim|delivery|pengiriman)\b', 'shipping'),

('order_status_check',
 'Cek status order',
 'Boleh Tiara bantu cek Kak. Mohon share nomor order atau nomor HP yang dipakai saat order ya 🙏',
 TRUE, 'copilot', 'Cek status order', '\b(status|order|pesanan|sudah sampai|kapan sampai|tracking)\b', 'order_status'),

('closing_cta',
 'Closing CTA',
 'Mau Tiara siapkan link order dengan pilihan tadi Kak? Tinggal isi alamat & jadwal kirim, langsung diproses tim kami ✅',
 TRUE, 'copilot', 'Closing CTA', NULL, 'order_intent'),

('payment_info',
 'Info pembayaran',
 'Setelah submit order, sistem otomatis kasih nomor VA / rekening transfer ya Kak. Pembayaran terkonfirmasi → langsung diproses ✨',
 TRUE, 'copilot', 'Info pembayaran', '\b(bayar|payment|transfer|rekening|VA|virtual account)\b', 'payment'),

('lead_time_default',
 'Lead time produksi',
 'Untuk pengerjaan butuh sekitar 3-6 jam Kak setelah pembayaran terkonfirmasi. Untuk hari spesial seperti besok pagi, sebaiknya order H-1 ya 🙏',
 TRUE, 'copilot', 'Lead time produksi', '\b(jam|kapan jadi|berapa lama|lama proses)\b', 'shipping'),

('out_of_area_polite',
 'Area di luar coverage',
 'Maaf Kak, untuk area itu Tiara cek dulu ketersediaan kurirnya ya. Sebentar 🙏',
 TRUE, 'copilot', 'Area di luar coverage', NULL, 'shipping')

ON CONFLICT (shortcut) DO UPDATE SET
  title = EXCLUDED.title,
  body = EXCLUDED.body,
  case_label = EXCLUDED.case_label,
  case_pattern = EXCLUDED.case_pattern,
  intent_match = EXCLUDED.intent_match;

COMMIT;
