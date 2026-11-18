# model-router

Mod Claude Code yang otomatis memilih model sesuai tingkat kesulitan tugas, supaya tidak semua request memakai Opus.

## Cara kerja

1. **Prompt utama** — setiap prompt dinilai dulu oleh Haiku (`$.model.classify`, sangat murah) ke salah satu tingkat:
   | Tingkat | Model | Contoh |
   |---|---|---|
   | `ringan` | haiku | pertanyaan singkat, penjelasan, edit/rename kecil, perintah shell |
   | `sedang` | sonnet | fitur kecil-menengah, bug yang jelas, menulis tes, refactor satu file |
   | `berat` | opus | arsitektur, debugging sulit, refactor banyak file, desain sistem, keamanan |

   Lalu hook `turn.step` mengarahkan setiap request model di giliran itu ke model tersebut.
   Model sesi (`/model`) tidak diubah — router hanya menimpa per request.
2. **Subagent** — hook `agent.spawn` menilai prompt subagent dan memilih modelnya, kecuali
   pemanggil sudah menentukan `model` sendiri, atau subagent itu fork (fork mewarisi model induk).
3. Balasan pendek seperti `ok`, `lanjut`, `ya` tidak dinilai ulang — tetap di tingkat sebelumnya
   supaya model tidak berganti di tengah pekerjaan.
4. **Lengket ke atas**: naik tingkat langsung, tapi turun tingkat baru setelah 2 prompt lebih rendah
   berturut-turut (`DOWNGRADE_AFTER`), supaya prompt cache tidak sering terbuang.
5. **Effort per tingkat**: ringan → `low`, sedang → `medium`, berat → effort sesi apa adanya
   (konstanta `EFFORT`). Token thinking ditagih sebagai output, jadi ini memotong biaya terbesar.

## Pasang

Di prompt Claude Code (2.1.275 atau lebih baru):

```
/plugin install model-router --marketplace adriyansyah-mf/claude-mods
```

Jawab `y` untuk menambahkan marketplace, pilih scope (`user` = semua project), lalu restart Claude Code.
Dari shell:

```bash
claude plugin install model-router --marketplace adriyansyah-mf/claude-mods
```

Update ke versi terbaru: `/plugin marketplace update wonka-mods`, lalu restart.

Coba tanpa instal (dari hasil clone):

```bash
claude --plugin-dir ./claude-mods
```

## Pakai

Ketik `/router` untuk status. Pengaturan yang diubah lewat `/router` disimpan dan berlaku di sesi berikutnya
(kecuali `pin`/`unpin`, yang hanya untuk sesi itu).

```
/router                      status (termasuk perkiraan biaya sesi)
/router on | off             nyalakan / matikan semua routing
/router main on|off          routing prompt utama
/router agents on|off        routing subagent
/router agents-max sedang    batas atas model subagent (default sedang = sonnet)
/router pin berat | unpin    paksa satu tingkat untuk sesi ini / kembali otomatis
/router effort on|off        atur effort per tingkat
/router compact 5|on|off     auto compact tiap N prompt
/router compact-min 50k      lewati compact kalau konteks masih kecil (0 = selalu)
/router trim 12k|off         pangkas output Bash di atas N karakter
/router cost on|off          tampilkan model, effort, dan biaya per giliran di status line
/router reset                kembalikan semua pengaturan ke default
/router log                  30 keputusan terakhir
```

## Fitur penghematan

- **Effort per tingkat**: ringan → `low`, sedang → `medium`, berat → effort sesi.
- **Lengket**: turun tingkat baru setelah 2 prompt lebih rendah berturut-turut.
- **Sadar cache**: di atas 100k token konteks, router tidak turun tingkat (ganti model = tulis ulang cache).
- **Eskalasi**: kalau Anda mengeluh ("salah", "masih error", "ga jalan", ...), giliran berakhir error API,
  atau ada ≥3 error tool dalam satu giliran, prompt berikutnya minimal naik satu tingkat.
- **Heuristik**: prompt ≤25 karakter langsung ringan; kata seperti "arsitektur", "migrasi",
  "race condition", "root cause" langsung berat — tanpa panggilan Haiku.
- **Subagent dibatasi** maksimal Sonnet kecuali pemanggil meminta model tertentu.
- **Pangkas output Bash** di atas 12k karakter (awal + akhir disimpan). Tambahkan `# notrim` di
  perintah untuk melewati. Output yang sangat besar (±30k+) sudah ditangani Bash bawaan
  (disimpan ke file + pratinjau), jadi fitur ini terutama berguna untuk output 12k–30k.
- **Status biaya**: setelah tiap giliran, status line menampilkan `model·effort · giliran ~$x · sesi ~$y`
  (perkiraan dari klien, bukan tagihan resmi).

## Auto compact

Setiap 5 prompt Anda (tidak termasuk slash command), percakapan di-compact otomatis sesaat setelah
giliran selesai, dengan instruksi untuk mempertahankan tujuan tugas, keputusan, file yang diubah,
error yang belum selesai, dan langkah berikutnya. Hitungan di-reset setiap kali ada compact,
termasuk `/compact` manual dan auto-compact bawaan Claude Code. Kalau konteks masih di bawah
`compact-min` (default 50k token), compact dilewati dan hitungan diulang dari nol.

- Sesi interaktif: memakai `$.session.compact`, dicoba lagi tiap 5 detik kalau giliran baru sudah mulai.
- Sesi headless (`-p` / SDK): `$.session.compact` belum didukung di sana, jadi mod menjalankan `/compact`.
- Compact sendiri memanggil model untuk meringkas. Di sesi pendek, compact tiap 5 prompt bisa
  lebih mahal daripada yang dihemat; naikkan angkanya (`/router compact 10`) kalau perlu.

Status line menampilkan `router: <tingkat> → <model>`, lalu setelah giliran selesai `model·effort · giliran ~$x · sesi ~$y`.

## Catatan biaya

- Setiap prompt dan spawn subagent menambah satu panggilan Haiku kecil (~$0.0001).
- Prompt cache disimpan per model. Berpindah model berarti konteks harus di-cache ulang
  di model tujuan, jadi bolak-balik terlalu sering bisa mengurangi penghematan pada sesi
  yang konteksnya panjang.
- Ubah mapping di konstanta `TIERS` dan kriteria di `RUBRIC` dalam `hooks/register.ts`.
