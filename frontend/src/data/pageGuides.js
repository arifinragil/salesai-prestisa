/**
 * pageGuides.js — Panduan per halaman untuk Tiara CRM
 * Key = pathname Next.js (string exact atau prefix tanpa trailing slash)
 */
const pageGuides = {
  '/lotus-inbox': {
    title: 'Inbox Lotus',
    summary:
      'Inbox WhatsApp Lotus dengan 7 tab smart-filter untuk membantu kamu fokus pada lead yang paling perlu ditindak. Ada kartu "Tugas kamu hari ini" dan banner FU overdue.',
    tips: [
      'Gunakan tab (Urgent, Hot ASAP, Mau Closing, dll.) untuk fokus pada lead yang perlu segera ditindak.',
      'Filter "Tim / Saya" di pojok kanan atas untuk melihat semua agent atau hanya milikmu.',
      'Klik lead untuk membuka chat lengkap; tekan ikon Manager View untuk lihat ringkasan analisa.',
      'Banner FU overdue di atas = reminder lead yang belum di-follow-up tepat waktu — selesaikan lebih dulu.',
    ],
  },

  '/supervisor-control': {
    title: 'Supervisor Control Panel',
    summary:
      'Panel admin untuk memantau dan menangani lead bermasalah. Menampilkan Priority Lead Queue (P1/P2/P3) dan grup risiko: Sales Response Risk, Follow Up, Lead Stuck (A/B/C/D).',
    tips: [
      'Selesaikan P1 terlebih dahulu — ini lead dengan risiko hilang tertinggi.',
      'Klik baris lead untuk expand: lihat AI Diagnosis dan pilih aksi (Ack, Resolve, Minta FU, Revisi Analisa, Assign).',
      '"Revisi Analisa AI" mengoreksi diagnosa AI sekaligus melatih model untuk kedepannya.',
      'Toggle "Tim / Saya" untuk scope tampilan per-agent atau seluruh tim.',
    ],
  },

  '/qna': {
    title: 'Q&A AI',
    summary:
      'Basis data pasangan pertanyaan–jawaban yang dipakai AI sebagai referensi saat memberi saran balasan kepada sales. Semakin banyak Q&A berkualitas, semakin akurat saran AI.',
    tips: [
      'Tulis jawaban yang benar, sopan, dan sesuai SOP Prestisa — AI akan meniru gaya jawaban ini.',
      'Klik "Embed pending" setelah menambah banyak Q&A agar data baru langsung aktif dipakai AI.',
      'Nonaktifkan Q&A yang sudah usang atau tidak relevan agar tidak menyesatkan AI.',
      'Gunakan Q&A untuk kasus-kasus yang sering muncul: pengiriman, pembatalan, harga khusus.',
    ],
  },

  '/ai-settings': {
    title: 'Pengaturan AI — Persona Tiara',
    summary:
      'Halaman untuk mengatur persona AI "Tiara": nada bicara, sapaan default, aturan eskalasi, model LLM yang dipakai, dan prompt sistem.',
    tips: [
      'Ubah nada dan sapaan di bagian Persona agar sesuai brand Prestisa.',
      'Atur ambang confidence — nilai lebih rendah berarti AI lebih sering eskalasi ke manusia (lebih aman).',
      'Setelah mengubah prompt sistem, simpan dan uji dengan pesan percobaan sebelum live.',
      'Ganti model LLM hanya jika memang perlu; perubahan ini berdampak ke seluruh agent.',
    ],
  },

  '/knowledge': {
    title: 'Knowledge Base',
    summary:
      'Basis pengetahuan berisi topik-topik yang dipakai AI untuk menjawab pertanyaan customer: produk, pengiriman, kebijakan toko, dan lain-lain.',
    tips: [
      'Tambah topik baru untuk setiap FAQ atau kebijakan yang sering ditanyakan customer.',
      'Draft yang masuk dari AI perlu di-approve terlebih dahulu sebelum aktif dipakai.',
      'Hapus topik yang sudah tidak relevan agar AI tidak salah kutip informasi lama.',
      'Judul topik yang jelas membantu AI menemukan referensi yang tepat saat menjawab.',
    ],
  },

  '/reply-templates': {
    title: 'Template Balasan',
    summary:
      'Pustaka template balasan cepat (canned replies) yang bisa dipakai sales untuk membalas pesan customer tanpa mengetik ulang dari nol.',
    tips: [
      'Buat template untuk skenario yang paling sering: konfirmasi pesanan, info pengiriman, penolakan sopan.',
      'Gunakan variabel (mis. {{nama_customer}}) agar template tetap personal saat dikirim.',
      'Tandai template favorit agar mudah ditemukan saat sedang membalas chat.',
      'Review secara berkala dan nonaktifkan template yang sudah tidak sesuai promo atau kebijakan.',
    ],
  },

  '/pipeline': {
    title: 'Pipeline Penjualan',
    summary:
      'Tampilan Kanban tahapan funnel lead, dari kontak pertama hingga closing. Pantau progress setiap lead dan identifikasi yang macet di satu tahap terlalu lama.',
    tips: [
      'Seret kartu lead antar kolom untuk memperbarui tahap funnel-nya.',
      'Lead yang terlalu lama di satu kolom biasanya perlu di-follow-up atau di-eskalasi.',
      'Gunakan filter per-sales untuk melihat pipeline masing-masing agent.',
      'Panel Forecast di kanan menampilkan estimasi revenue dari lead aktif.',
    ],
  },

  '/tasks': {
    title: 'Tugas',
    summary:
      'Daftar tugas harian yang dikelompokkan berdasarkan due date: Overdue, Hari ini, Besok, dan Nanti. Prioritas tinggi ditandai merah.',
    tips: [
      'Selesaikan tugas Overdue terlebih dahulu agar tidak terus menumpuk.',
      'Tambah tugas baru dengan tombol "+ Tugas" dan tentukan due date serta prioritas.',
      'Klik tugas untuk membuka detail, update status, atau menambah catatan.',
      'Tugas yang terhubung ke lead akan otomatis muncul di inbox lead terkait.',
    ],
  },

  '/customer': {
    title: 'Tiket Customer',
    summary:
      'Daftar isu dan permintaan dari customer yang perlu diselesaikan: komplain, pengembalian, pertanyaan khusus. Setiap isu bisa dilacak statusnya.',
    tips: [
      'Filter berdasarkan status (Open/In Progress/Resolved) untuk fokus pada yang belum selesai.',
      'Assign tiket ke agent yang tepat agar tidak ada yang jatuh tanpa pemilik.',
      'Tambah catatan internal untuk komunikasi antar tim tanpa terlihat customer.',
      'Selesaikan tiket komplain dengan cepat — waktu respons mempengaruhi skor kepuasan.',
    ],
  },

  '/tax-requests': {
    title: 'Permintaan Faktur Pajak',
    summary:
      'Halaman untuk mengelola permintaan faktur pajak dari customer B2B. Tampilkan, validasi, dan kirimkan faktur sesuai data pesanan.',
    tips: [
      'Periksa kelengkapan data NPWP dan nama perusahaan sebelum memproses faktur.',
      'Tandai permintaan sebagai "Selesai" setelah faktur dikirimkan ke customer.',
      'Gunakan filter tanggal untuk mencari permintaan dari periode tertentu.',
      'Faktur yang sudah dikirim tetap tersimpan di sini sebagai arsip.',
    ],
  },

  '/supervisor': {
    title: 'Performa Sales',
    summary:
      'Dashboard performa per-sales (admin): skor, red flag, tren mingguan, dan rekomendasi coaching. Bantu identifikasi agent yang butuh dukungan lebih.',
    tips: [
      'Perhatikan agent dengan red flag — biasanya ada pola respons lambat atau banyak lead macet.',
      'Klik nama agent untuk melihat detail aktivitas dan history percakapan.',
      'Gunakan data skor mingguan untuk sesi coaching yang berbasis fakta.',
      'Red flag bisa muncul karena response time, eskalasi berulang, atau lead terlewat.',
    ],
  },

  '/lead-distribution': {
    title: 'Distribusi Lead',
    summary:
      'Aturan otomatis untuk mendistribusikan lead masuk ke agent yang tepat berdasarkan kriteria yang ditentukan admin.',
    tips: [
      'Atur rule distribusi berdasarkan tag, channel, atau shift kerja agent.',
      'Pastikan setiap agent memiliki kapasitas yang wajar agar tidak kelebihan beban.',
      'Uji rule baru di mode preview sebelum diaktifkan agar tidak salah assign.',
      'Review distribusi secara berkala jika ada perubahan tim atau jam operasional.',
    ],
  },

  '/retention': {
    title: 'Otomasi Retention',
    summary:
      'Pengaturan otomasi follow-up untuk mempertahankan customer yang sudah pernah beli agar kembali lagi.',
    tips: [
      'Buat sekuens follow-up berdasarkan hari setelah pembelian terakhir.',
      'Pastikan pesan retention terasa personal, bukan spam promosi generik.',
      'Monitor tingkat respons setiap otomasi — matikan yang engagement-nya rendah.',
      'Segmentasikan berdasarkan nilai transaksi agar pesan lebih relevan.',
    ],
  },

  '/b2b-outreach': {
    title: 'Kampanye B2B',
    summary:
      'Panel admin untuk mengelola kampanye outreach ke calon customer korporat: buat, jadwalkan, dan pantau performa blast WhatsApp B2B.',
    tips: [
      'Segmentasikan target berdasarkan industri atau ukuran perusahaan untuk relevansi lebih tinggi.',
      'Gunakan HSM template yang sudah disetujui Meta agar pesan tidak ditolak.',
      'Pantau open rate dan respons untuk mengevaluasi efektivitas copy pesan.',
      'Jadwalkan blast di jam kerja (Senin–Jumat, 09.00–17.00 WIB) untuk respons terbaik.',
    ],
  },

  '/ai-monitor': {
    title: 'Monitor AI',
    summary:
      'Pantau performa AI Tiara secara real-time: tingkat confidence, eskalasi, respons yang dikirim, dan anomali. Pastikan AI berjalan sesuai ekspektasi.',
    tips: [
      'Confidence rendah yang konsisten di topik tertentu = perlu tambah Q&A atau Knowledge Base.',
      'Lonjakan eskalasi mendadak bisa menandakan perubahan pola pesan customer — investigasi segera.',
      'Gunakan log percakapan untuk audit respons AI yang mencurigakan.',
      'Set alert threshold agar tim langsung tahu jika tingkat eskalasi melampaui batas normal.',
    ],
  },

  '/tags': {
    title: 'Kelola Tag',
    summary:
      'Buat dan kelola tag yang digunakan untuk mengkategorikan lead dan percakapan di inbox.',
    tips: [
      'Buat tag yang konsisten dan mudah dipahami semua agent.',
      'Gunakan warna berbeda untuk kategori tag yang berbeda (e.g., merah = komplain, hijau = closing).',
      'Hapus tag yang sudah tidak dipakai agar dropdown tidak terlalu panjang.',
      'Tag yang tepat membantu filter di inbox dan laporan performa.',
    ],
  },

  '/promos': {
    title: 'Kelola Promo',
    summary:
      'Halaman untuk membuat dan mengatur promo aktif yang bisa direferensikan AI saat menjawab pertanyaan harga atau penawaran.',
    tips: [
      'Selalu isi tanggal mulai dan berakhir promo agar AI tidak menyebut promo yang sudah habis.',
      'Deskripsikan syarat promo secara jelas agar AI bisa menjelaskan ke customer dengan benar.',
      'Nonaktifkan promo yang sudah berakhir — jangan hapus, agar histori tetap ada.',
      'Promo baru perlu beberapa menit sebelum aktif dipakai AI (tergantung cache refresh).',
    ],
  },

  '/sql-queries': {
    title: 'Konsol SQL',
    summary:
      'Konsol SQL untuk admin yang perlu menjalankan query langsung ke database CRM. Gunakan dengan hati-hati.',
    tips: [
      'Gunakan SELECT saja untuk eksplorasi data — hindari UPDATE/DELETE tanpa backup.',
      'Tambahkan LIMIT pada query besar agar tidak membebani server.',
      'Simpan query yang sering dipakai sebagai snippet agar bisa digunakan ulang.',
      'Akses halaman ini hanya jika kamu memahami SQL dan implikasinya ke data produksi.',
    ],
  },

  '/users': {
    title: 'Kelola User',
    summary:
      'Daftar user yang terdaftar di Tiara CRM. Role user (admin/sales) mengikuti grup Authentik (SSO) — perubahan role dilakukan di panel Authentik, bukan di sini.',
    tips: [
      'Untuk mengubah role user, lakukan di panel Authentik (SSO) — perubahan akan sinkron otomatis.',
      'Halaman ini cocok untuk melihat siapa saja yang aktif dan kapan terakhir login.',
      'User yang tidak aktif lama bisa dinonaktifkan dari Authentik untuk keamanan.',
    ],
  },

  '/snippets': {
    title: 'Pustaka Snippet',
    summary:
      'Kumpulan teks snippet yang bisa disisipkan cepat saat menulis balasan di chat, seperti alamat toko, rekening, atau kalimat baku.',
    tips: [
      'Buat snippet untuk informasi yang sering dicopy-paste: rekening, alamat, jam operasional.',
      'Beri nama snippet yang singkat dan mudah diingat untuk pencarian cepat.',
      'Snippet berbeda dari template — snippet biasanya bagian kecil teks, bukan balasan lengkap.',
    ],
  },

  '/channel-settings': {
    title: 'Pengaturan Channel',
    summary:
      'Konfigurasi channel WhatsApp yang terhubung ke Tiara CRM: sesi WAHA, nomor aktif, webhook, dan status koneksi.',
    tips: [
      'Pastikan status sesi WAHA selalu "Connected" — jika putus, scan ulang QR dari halaman WAHA Sessions.',
      'Jangan ubah pengaturan webhook saat traffic sedang tinggi untuk menghindari pesan terlewat.',
      'Setiap nomor WhatsApp memerlukan sesi WAHA tersendiri.',
      'Catat perubahan konfigurasi di log internal tim agar mudah di-rollback jika ada masalah.',
    ],
  },

  '/inbox': {
    title: 'Inbox WAHA (Lama)',
    summary:
      'Inbox WhatsApp berbasis WAHA (versi lama). Untuk penggunaan harian, disarankan beralih ke Lotus Inbox yang memiliki fitur lebih lengkap.',
    tips: [
      'Inbox ini masih aktif tetapi tidak mendapatkan fitur baru.',
      'Untuk filter smart dan analisa lead, gunakan /lotus-inbox.',
      'Pesan yang masuk di sini tetap tercatat dan bisa diakses dari Lotus Inbox.',
    ],
  },
};

export default pageGuides;
