# Market DNA V1

Gerçek zamanlı, **olay dizilimi keşfeden** ve **istatistiksel olarak öğrenen** piyasa mikro-yapısı analiz ajanı.

> Market DNA her an yön tahmin eden bir indikatör DEĞİLDİR. Gerçek piyasa olaylarının sıralamasını öğrenen, keşfettiği örüntüleri ileriye dönük doğrulayan, kanıtı olmayan yerde susan ve kanıtı bozulan yerde kendi tahminini geri çeken bağımsız bir araştırma ajanıdır.

## Çalıştırma

```bash
node server.js          # Node >= 22 — SIFIR npm bağımlılığı
# Panel: http://localhost:3000
```

- Backend: `server.js` + `src/` (WebSocket kaynak yönetimi, olay kodlama, motif keşfi, öğrenme, kalıcı hafıza — hepsi sunucuda). REST: `/api/state|coins|settings|memory/<COIN>|audit` + SSE: `/api/stream` (node:http, bağımlılıksız).
- Frontend: `public/` (mobil öncelikli, saf HTML/CSS/JS; yalnızca gerçek sistem durumunu gösterir).
- `orderbook-mobile (5).html` yön motoruna dokunulmadı; Market DNA bağımsız motordur.

## Dağıtım (Vercel dahil gerçeği)

**Vercel bu sistemin BACKEND'İNİ ÇALIŞTIRAMAZ.** Market DNA kalıcı bir süreçtir: Binance WebSocket akışlarına saatlerce bağlı kalır, `listen()` ile port tutar, SSE ile push yapar. Vercel serverless'tır: fonksiyon başına saniyeler sınırı, kalıcı süreç yok, kalıcı WebSocket yok. Bu mimari kısımdır, kod hatası değildir.

| Hedef | Çözüm |
|---|---|
| **Tam sistem** (backend + panel) | Railway / Render / Fly.io / VPS / Docker — repo `dna-lab/` klasörü, start: `node server.js`, health: `/health` |
| **Yalnız statik panel** (Vercel) | Repo kökündeki `vercel.json` paneli yayımlar; `?api=https://BACKEND-URL` ile uzak backend'e bağlanır (CORS desteği eklendi, `DNA_ALLOW_ORIGIN` ile kısıtlanabilir) |
| **Her yerde çalışır konteyner** | `dna-lab/Dockerfile` (node:22-alpine, health-check'li) |

- Railway: yeni proje → GitHub repo → Settings → **Root Directory = `dna-lab`** → otomatik `railway.json`.
- Render: repo kökündeki `render.yaml` (`rootDir: dna-lab`) → free plan 15 dk boşta uyur, kalıcı oturum için ücretli plan.
- Fly.io: `cd dna-lab && fly launch`; `fly.toml` auto_stop KAPALI (WS akışı kesintisiz olmalı).
- **Kalıcı hafıza:** PaaS diskleri geçicidir — `data/` için volume bağlayın (Fly: `fly volumes create dna-data --size 1`, mount `/app/data`); yoksa her yeniden dağıtımda öğrenme sıfırlanır.

## Mimari

```
src/sources/   Binance Futures (/public + /market ayrımı), Binance Spot, OKX Swap adaptörleri
src/core/      book.js L2 kitap · walls.js duvar durum makinesi · flow.js agresif akış
               encoder.js olay kodlayıcı · motif.js dizilim/epizot motoru
               stats.js N_eff+bootstrap+BH · basemodel.js M0-M3 · learner.js yaşam döngüsü
src/memory/    coin başına kalıcı hafıza (atomik + checksum + .bak + JSONL rotasyon)
src/session/   tek-coin oturum yöneticisi + arka plan kuluçka
src/api/       REST + SSE (node:http, bağımlılıksız)
scripts/       test-connectivity.js · unit-tests.js (32 test) · live-audit.js (uçtan uca)
audit/         FAZ0_AUDIT.md + audit/live/ gerçek kanıtlar (bağlantı, denetim, ekran görüntüleri)
```

## Olay sözlüğü (gözlemsel — yön anlamı YÜKLENMEZ)

`WALL_SPAWN → WALL_TEST → WALL_HOLD | WALL_PULL | WALL_BREAK`, `FLOW_BURST → FLOW_EXHAUST`,
`BOOK_TILT`, `MICRO_FLIP`, `VOID_OPEN`, `SWEEP_REJECT`, `<RESET>`, `<SESSION_GAP>`

- `WALL_PULL` yalnız GÖZLENEN likidite çekilmesidir; manipülasyon kanıtı SAYILMAZ.
- Motif yaşam döngüsü: DISCOVERY → INCUBATION → VALIDATION → GRADUATED / QUARANTINED / RETIRED.
- Mezuniyet: N_eff (örtüşme kümeleme ∩ seri bağımlılık) + baz modele göre Brier lift (küme-bootstrap CI) + BH-FDR + rejim kapsamı + bütünlük. **Kanıt yoksa sistem susar ve panelde gerekçesini gösterir.**

## Önemli bulgu (bu ortamda gerçek testle)

Binance USDT-M Futures 2026-03-06 WebSocket URL ayrımına geçti: yüksek frekanslı akışlar `/public/stream`'e, aggTrade/markPrice/forceOrder `/market/stream`'e taşındı. Eski `/stream` yolu aggTrade/markPrice'ı yaymiyor (0 mesaj — kanıt: `audit/live/`). Bu proje doğru uçları kullanır.

## Kanıt disiplini

- Mock piyasa verisi, rastgele başarı oranı, uydurma motif YOK.
- Birim testlerindeki sentetik girdiler deterministiktir ve "TEST VERİSİDİR — canlı piyasa kanıtı değildir" diye etiketlidir.
- Her canlı iddia `audit/live/` altındaki JSON/MD kanıt dosyalarına dayanır.
