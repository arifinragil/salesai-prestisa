# Bug Report — `POST /api/save-hsm-message` HTTP 500

**To:** Tim Dev Lotus
**From:** Tim Salesai CRM (Prestisa)
**Date:** 2026-06-10
**Severity:** High — block integrasi salesai → Lotus outbound message recording

---

## Ringkasan

Endpoint webhook `https://lotus.prestisa.id/lavenger-backend/public/api/save-hsm-message` mengembalikan **HTTP 500** untuk **semua** payload yang dikirim — baik dari aplikasi kami (salesai CRM) maupun dari `curl` direct test. Error PHP-nya identik dan terjadi sebelum controller parse field apapun.

## Detail Error

```
Exception: ErrorException
Message:   Trying to get property 'token' of non-object
File:      app/Http/Controllers/API/ChatController.php
Line:      14606
Method:    saveHsmMessage
```

Trace mengarah ke `App\Http\Controllers\API\ChatController::saveHsmMessage`.

## Diagnosis Kami

Error `"Trying to get property 'token' of non-object"` di PHP biasanya muncul kalau code akses property dari variabel yang sebenarnya `null`. Pola yang sering muncul di Laravel:

```php
// Salah — return null kalau body bukan JSON valid / belum di-decode
$data  = $request->payload;
$token = $data->token;   // ← Error di sini
```

Perbaikan yang biasanya berhasil:

```php
$token = $request->input('token');
// atau
$token = $request->json('token');
// atau
$data = $request->all();
$token = $data['token'] ?? null;
```

## Reproduksi

Request payload **persis sesuai spec** yang kalian kirim:

```bash
curl -X POST "https://lotus.prestisa.id/lavenger-backend/public/api/save-hsm-message" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "from": "6281231828249",
    "to": "62895335195837",
    "messageId": "8b96065e-07f2-11f1-919e-0a58a9feac02",
    "messageText": "Halo Mitra, ...",
    "contactName": "Customer",
    "hsmName": "notifikasi_foto_hasil_4",
    "token": "07d0b91e771752005d94ceb5c5efdc0a",
    "fileName": "contoh-attachment.jpg",
    "fileUrl": "https://lavender.prestisa.id/assets/images/hsm/14.jpg",
    "source": "PRESTISA_CRM"
  }'
```

**Response:** HTTP 500 + JSON error trace seperti di atas.

## Yang Sudah Kami Coba

| Variasi request | Hasil |
|---|---|
| `Content-Type: application/json` (sesuai spec) | 500 — same error |
| `Content-Type: application/x-www-form-urlencoded` | 500 — same error |
| `Content-Type: multipart/form-data` (`-F` curl) | 500 — same error |
| Wrap dalam `{ "data": { ... } }` | 500 — same error |
| Pakai header `Authorization: Bearer <token>` | 500 — same error |
| Tambah `X-Requested-With: XMLHttpRequest` | 500 — same error |
| Payload persis copy-paste dari spec kalian | 500 — same error |

Semua format request menghasilkan error PHP yang **identik** — artinya error terjadi sebelum controller berhasil baca request body, bukan masalah dari struktur payload kami.

## Konteks Integrasi

- Kami integrate webhook ini dari **salesai-crm** (`https://salesai.prestisa.net/lotus-inbox`) supaya outbound message yang dikirim sales (freetext, HSM, media) otomatis tercatat juga di Lotus.
- Untuk freetext (non-HSM), kami pakai `hsmName: "free text"` sesuai diskusi sebelumnya.
- Saat ini integrasi sudah live dan setiap reply di `lotus-inbox` memanggil webhook ini (non-blocking) — kalau endpoint sudah di-fix, otomatis langsung jalan tanpa perubahan kode di sisi kami.

## Yang Perlu Di-fix

Mohon cek `ChatController::saveHsmMessage` line 14606 — kemungkinan besar `$request->payload->token` (atau pattern serupa). Ganti ke `$request->input('token')` atau `$request->json('token')` yang sudah handle JSON body dengan benar.

## Verifikasi Setelah Fix

Kalau sudah di-fix, tolong kabarin — saya akan re-test dengan payload yang sama dan konfirmasi message-nya benar masuk ke DB Lotus.

---

**Contact balik:** Arifin / Finance Prestisa (`finance.parselia@gmail.com`)
