// Static FAQ knowledge — short, factual answers Tiara can quote.
// Keep wording neutral; persona prompt will adapt tone.
// Update via PR; future sub-spec will pipeline FAQ refresh from real conversations.

const FAQ = {
  payment: `Pembayaran bisa via transfer bank (BCA / Mandiri / BRI / BNI), QRIS, atau Virtual Account. Setelah transfer, bukti otomatis terverifikasi dalam beberapa menit. Kalau belum kebaca dalam 30 menit, hubungi tim Prestisa.`,

  refund_policy: `Refund bisa diproses kalau order belum mulai diproduksi (sebelum 3-6 jam window pengiriman dimulai) dengan menghubungi tim Prestisa. Setelah masuk produksi, refund tidak bisa dilakukan, tapi bisa diganti tanggal kirim atau revisi alamat (selama belum dikirim).`,

  cancel_policy: `Cancel bisa dilakukan sebelum produksi mulai. Hubungi tim Prestisa secepatnya, sebutkan nomor order. Setelah produksi mulai, cancel tidak bisa dilakukan, tapi penjadwalan ulang masih mungkin.`,

  hours: `Prestisa beroperasi 24/7 untuk pemesanan online. Tim customer service aktif jam 08.00-22.00 WIB setiap hari. Order yang masuk di luar jam ini tetap diproses, tinggal menunggu konfirmasi pembayaran.`,

  lead_time: `Lead time pengiriman 3-6 jam setelah pembayaran terkonfirmasi. Untuk papan bunga di kota besar (Jakarta, Surabaya, Bandung, dll), bisa lebih cepat. Untuk kota kecil atau jam puncak (Valentine, Mother's Day, Hari Raya), bisa lebih lama — tim akan info kalau ada delay.`,

  area_coverage: `Prestisa cover hampir semua kota di Indonesia. Untuk Jabodetabek free ongkir, area lain Rp50.000. Kalau kotanya tidak tercover, sistem akan kasih tahu saat checkout.`,

  shipping_fee: `Free ongkir untuk wilayah Jabodetabek. Area lain Rp50.000 flat. Untuk pulau di luar Jawa atau lokasi remote, tim akan info kalau ada penyesuaian.`,

  product_type: `Prestisa menyediakan: papan bunga (sukacita, dukacita, congratulations, grand opening), bouquet (hand bouquet, standing bouquet), parsel (lebaran, natal, fruit basket), dan cake (ulang tahun, anniversary). Setiap kategori ada banyak desain dan range harga.`,

  how_to_order: `Cara order: kasih tahu jenis (papan/bouquet/parsel/cake), kota tujuan, dan budget. Kami kasih beberapa pilihan desain dengan harga. Setelah pilih, isi form order yang kami kirim — alamat penerima, ucapan kartu, dll. Bayar via VA/transfer/QRIS, dan order langsung diproses.`,

  invoice: `Invoice/faktur otomatis dikirim via email setelah pembayaran terkonfirmasi. Kalau belum sampai, cek folder spam atau hubungi tim untuk dikirim ulang. Untuk faktur pajak/PPN, beritahu sebelum order dikonfirmasi.`,

  about: `Prestisa adalah toko bunga online yang melayani karangan bunga papan, bouquet, parsel, dan cake ke hampir seluruh kota di Indonesia. Berdiri sejak [tahun], kami fokus pada kecepatan pengiriman (3-6 jam) dan kualitas presentasi.`,
};

function listFaqTopics() {
  return Object.keys(FAQ);
}

function getFaqTopic(topic) {
  if (!topic) return null;
  const key = String(topic).toLowerCase().trim();
  return FAQ[key] || null;
}

module.exports = { listFaqTopics, getFaqTopic };
