# MARKET DNA V1 — TODO

> Durum kodları: `DONE` uygulandı ve gerçek kanıtla doğrulandı · `PARTIAL` kısmen · `BLOCKED` engel var · `TODO` başlanmadı.
> Kanıt dosyaları `audit/` altında, test scriptleri `scripts/` altında tutulur. Hiçbir sonuç kanıt dosyası olmadan "doğrulanmış" sayılmaz.

## ORTAM NOTU (ÖNEMLİ)

- İstenen çalışma alanı `/home/user/dna-lab/` **bu ortamda mevcut DEĞİL** (FAZ 0'da `ls` ile kanıtlandı).
- Denetim dosyaları `btc_single_coin_audit.js` ve `btc_events_trace.jsonl` **BULUNAMADI**. Bu dosyalara dayanan hiçbir önceki test sonucu doğrulanmış kabul EDİLMEDİ ve uydurulmadı.
- Proje, bu ortamda erişilebilir çalışma alanı olan `/home/z/my-project/dna-lab/` altında sıfırdan kuruldu. Yüklenen referans dosya `upload/orderbook-mobile (5).html` olduğu gibi korundu (kopya `reference/`, md5 `b5abd73cd9b34d8979450e90b6a35f8a` — yön motoruna DOKUNULMADI).
- Çalıştırma: `node server.js` (Node ≥ 22, **sıfır npm bağımlılığı**), panel: `http://localhost:3000`.

---

## FAZ 0 — Mevcut Çalışma Alanı Denetimi — **DONE**

- [x] Mevcut dosyaları ve mimariyi incele → `/home/user/dna-lab/` YOK (kanıt: FAZ0_AUDIT.md §1). `upload/orderbook-mobile (5).html` (3466 satır) satır bazında incelendi.
- [x] Canlı denetim kodunu incele → İstenen `btc_single_coin_audit.js` bulunamadı. Yüklü HTML'in gömülü canlı istemcisi denetlendi: Binance fstream combined stream + Bybit failover, localStorage v2 şema, AdaGrad + Platt kalibrasyon, abstain auto-tune, rejim ağırlıkları.
- [x] Ham olay kayıtlarının yapısını doğrula → `btc_events_trace.jsonl` YOK; HTML içi iz kaydı (`wsLog`, `engine.trail`, `pending[]`) incelendi — kalıcı ham olay arşivi YOK.
- [x] Mevcut deney iddialarını hesaplarla karşılaştır → İstemci motorunun İSABET/BRIER pill'leri canlı veriden hesaplanıyor; ancak örtüşen pencereler, seri bağımlılık, çoklu hipotez düzeltmesi YOK; öğrenme tarayıcıda (localStorage) olduğundan süreklilik kırılgan.
- [x] Eksikleri ve riskleri raporla → `audit/FAZ0_AUDIT.md` (10 bulgu + risk tablosu + checksum).

## FAZ 1 — Canlı Veri Katmanı — **DONE**

- [x] Binance Futures adaptörü — **KANIT:** 2026-03-06 URL ayrımı gerçek testle bulundu: eski `/stream` yolu aggTrade/markPrice'ı yaymıyor (0 mesaj), doğru uçlar `/public/stream` (bookTicker+depth20) ve `/market/stream` (aggTrade+markPrice+forceOrder). 3 dk'da 232.199 + 9.336 gerçek mesaj. `audit/live/connectivity-*.md`, `audit/live/liveaudit-*.md`
- [x] Binance Spot adaptörü — 71.678 gerçek mesaj (aggTrade+depth20+bookTicker), lag EWMA 4 ms.
- [x] OKX USDT Swap adaptörü (books + trades, ping/pong) — 12.708 gerçek mesaj, lag EWMA 32 ms. GÖZLEM: `books` kanalı push başına medyan ~25 seviye yayıyor (400 değil) — sınırlama olarak belgelendi.
- [x] Mesaj doğrulama ve zaman damgaları — exchange ts + recv ts, lagMs (EWMA), stale bayrağı, futures depth `U/u/pu` süreklilik denetimi → `depth_seq_gap` RESET.
- [x] Bağlantı kopması ve yeniden senkronizasyon — üstel backoff + staleness watchdog; **GERÇEK kopma testi:** 60. sn'de soket zorla kapatıldı → `reconnects:1` → state `live`, mesaj sayısı devam etti (78.254 → 232.199).
- [x] Tek coin abonelik yönetimi — coin değişimi: aktif zincir kapanır → persist → yeni coin aboneliği; BTC↔ETH kanıtlandı.
- Not: `fapi.binance.com` REST bu ortamda aralıklı 418 (WAF) döndü; tasarım partial-depth snapshot akışlarıyla REST'siz çalışır (zayıflık yaratmaz).

## FAZ 2 — Olay Kodlayıcı — **DONE**

- [x] Atomik olay sözlüğü — WALL_SPAWN/TEST/HOLD/PULL/BREAK, FLOW_BURST/EXHAUST, BOOK_TILT, MICRO_FLIP, VOID_OPEN, SWEEP_REJECT, `<RESET>`, `<SESSION_GAP>`; her olay zarfı: id, olay, taraf, borsa, coin, ts, fiyat, detay, güvenilirlik (lagMs/depthMode/stale).
- [x] Durum geçişleri — başlangıç/bitiş koşulları kodda + FAZ0AUDIT değil `src/config.js` yorumlarında açık.
- [x] Histerezis — tilt giriş 0.45 / çıkış 0.25 (flapping testi PASS), duvar spawn kalıcılık filtresi (spawnPersistMs 600) + pullMinAgeMs 3000 + respawn cooldown 30 sn (canlı gürültü 1798 olay/25 sn → 133 olay/45 sn'ye indi).
- [x] Yeniden test olayları — WALL_TEST/WALL_HOLD/WALL_BREAK/WALL_PULL akışı birim testli (deterministik sentetik, etiketli).
- [x] Veri boşluğu sınırları — `<RESET>`/`<SESSION_GAP>` dizilimi keser; birleştirme YOK (test: 'RESET sonrası dizilimler birleştirilmez').
- [x] Olay izleme kayıtları — `data/memory/<COIN>/events-<gün>.jsonl` + `audit/live/session-<gün>.jsonl`.
- Kanıt: `scripts/unit-tests.js` — **32 PASS / 0 FAIL** (deterministik sentetik girdiler — canlı piyasa kanıtı DEĞİLDİR, etiketli).

## FAZ 3 — DNA Motif Motoru — **DONE**

- [x] Olay dizilimleri — gap-kısıtlı n-gram (n≤4, maxGap 20 sn, pencere 120 sn) keşfi; `chain[-1]` indeksleme kusuru testte yakalanıp düzeltildi.
- [x] Epizot yönetimi — spec §6'daki 12 alan (motif id, coin+borsalar, t0, referans fiyat, zincir, olay-arası süreler, işlem sayı/hacim araları, rejim, bütünlük, ufuklar, sonuçlar, örtüşmeler).
- [x] Örtüşme analizi — aynı motif |t0a−t0b|<maks ufuk → çift yönlü örtüşme kaydı; analiz learner'da kümelemeyle.
- [x] Motif keşfi — minCountDiscovery=3; tekrarlı durum filtresi (deDupMs 800). Canlı: 3 dk'da 276 motif keşfi.
- [x] Alt dizilim karşılaştırması — motif modeli alt dizilim baz oranına karşı değerlendirilmek üzere ayrı tutulur (motif modeli vs baz model Brier karşılaştırması FAZ 4'te).
- [x] Motif budama — üstel yaşlandırma (yarı ömür PARAMETRE, sabitlenmedi) + RETIRED eşiği; QUARANTINED → VALIDATION dönüşü.

## FAZ 4 — Öğrenme ve Doğrulama — **DONE**

- [x] Üç durumlu sonuç etiketleme — bant = max(volK×σ₁ₛ×√H, spreadMult×medyan spread, minBandBps); t0'da hesaplanır, episoda yazılır (testli).
- [x] Çoklu ufuk — 10s / 30s / 120s, ufuk başına ayrı sonuç + bant (testli: UP/FLAT doğrulandı).
- [x] Baz modeller — M0 sabit dönem, M1 kısa (5 dk), M2 uzun (60 dk), M3 ayrıştırılmış; **kazanan önceden ilan edilmedi**; hepsi online skorlanıyor (canlı: n=579, Brier ≈ 0.667 — küçük havuzda üniforma yakın; dürüst sonuç).
- [x] Etkin örneklem — örtüşme kümeleme (greedy) + seri bağımlılık (N/(1+2Σρ)) ADAY formüller; küçük örneklem davranışı testli; ikisinin minimumu alınır.
- [x] Walk-forward doğrulama — tahmin yalnız t0'da bilinen çözülmüş episodlarla; "çözülmemiş episod katılmaz" sızıntı testi PASS.
- [x] Kalibrasyon — multiclass Brier + ECE (5 bin) + kalibrasyon eğrisi.
- [x] Karantina ve mezuniyet — koşullar: N_eff ≥ eşik, eşleştirilmiş küme-bootstrap ile lift CI > 0, BH-FDR q, rejim kapsamı, bütünlük; **canlı 3-4 dk oturumda HİÇBİR motif mezun edilmedi** (DOĞRULANIYOR/KULUÇKADA — doğru davranış, spec §16).

## FAZ 5 — Kalıcı Hafıza — **DONE**

- [x] Coin bazlı disk kayıtları — `data/memory/<SYMBOL>/`: state.json (şema v1 + FNV checksum + .bak), episodes/events günlük JSONL rotasyonu; büyük arşiv tek JSON değil.
- [x] Yeniden başlatma — **GERÇEK test:** süreç kapanıp yeniden açıldı; eventsTotal 1746=1746 birebir korundu, sayaç devamı true.
- [x] Oturum boşlukları — **GERÇEK test:** lastSessionEnd 20 dk geriye alınarak zorlandı → `sessionGaps: 1` üretildi; aktif tahminler geçersiz sayılır.
- [x] Bayatlama — üstel yaşlandırma adayı (yarı ömür 14 gün PARAMETRE); decayWeight hesaplanıp UI'da görünür.
- [x] Yeniden ısınma — yeni oturum warmupMs; olay kodlanır, tahmin warmup bitene dek GÖZLEMDE etiketiyle.
- [x] Kayıt bütünlüğü testleri — atomik yazım (tmp+fsync+rename), checksum uyuşmazlığı → .bak kurtarma, bozuk JSON → kurtarma (testli).

## FAZ 6 — Canlı API ve Mobil Panel — **DONE**

- [x] Backend–frontend iletişimi — REST (/api/state|coin|settings|session/end|memory|coins|audit|health) + SSE (/api/stream); zero-dep node:http. SSE kanal kanıtı: state 27, dnaEvent 253, discovery 18, episode 14, log 22.
- [x] Coin seçici — varsayılan BTC/ETH/SOL + serbest sembol girişi; tarayıcı doğrulandı.
- [x] Canlı DNA olay zinciri — renk kodlu gerçek olay kartları; tarayıcıda 30 öğe canlı akmış.
- [x] Motif yaşam döngüsü ekranı — DISCOVERY→…→RETIRED rozetleri + gerçek metrikler (N_eff, Brier, lift CI, p/q, ECE).
- [x] Tahmin ve geçersizlik kartı — yalnız MEZUN motif görünür (GÖLGE TAHMİN etiketi + iptal bilgisi); kanıt yoksa "Neden sessiz?" kutusu gerçek gerekçe gösterir (örn. "35 episod, etkin örneklem/lift koşulları sağlanmadı").
- [x] Hafıza ve doğrulama ekranı — şema/oturum/sayaç/dosyalar/kurtarma durumu canlı.
- [x] Arka plan kuluçka ayarı — toggle çalışır; tarayıcı kopması kesin algılanamaz → zaman aşımı + açık "OTURUMU SONLANDIR"; arka plan AÇIK iken sunucu tek coini izlemeye devam eder.
- Kanıt: `audit/live/ui-market.png`, `ui-dna.png` (tarayıcı ekran görüntüleri, konsol hatası 0).

## FAZ 7 — Uçtan Uca Canlı Denetim — **DONE**

- [x] Gerçek BTCUSDT bağlantı testi — 4 uç nokta LIVE; 3 dk'da **325.920 gerçek mesaj** (futures public 232.199, futures market 9.336, spot 71.678, okx 12.708).
- [x] Coin değiştirme testi — BTC→ETH→BTC; venue'lar yeniden canlı, hafızalar ayrı.
- [x] WebSocket kopma testi — zorla kapatma → otomatik reconnect (reconnects:1) → akış sürdü.
- [x] Sunucu yeniden başlatma testi — SIGTERM + yeni süreç; state.json + jsonl'lerden devam.
- [x] Hafıza devamlılığı testi — eventsTotal birebir eşleşme (1746=1746), sayaçlar devam etti (1746→1905).
- [x] Veri sızıntısı denetimi — birim testi ("çözülmemiş episodlar tahmine KATILMAZ") + tahmin yalnız t0 verisiyle (makePredictions ep.t0 kullanır).
- [x] İleri doğrulama raporu — `audit/live/liveaudit-2026-10-28T18-48-12-161Z.md|json`: yöntem (t0 gölge tahmin → çok sınıflı Brier → küme-bootstrap + BH-FDR), gerçek sayılar, baz model skorları (n=579).
- [x] Sonuç ve sınırlamalar raporu — aşağıda ve rapor içinde:
  - **Mezun motif: 0.** Birkaç dakikalık veri istatistiksel mezuniyet için YETERSİZDİR; sistemin GÖZLEMDE/KULUÇKADA/DOĞRULANIYOR kalması DOĞRU davranıştır (spec §16).
  - Sınırlamalar: Binance derinlik top-20 partial; OKX books push medyan ~25 seviye; likidasyon akışı nadir (3 dk'da 0 olay); lag ölçümü exchange-local saat kaymasına duyarlı; FLAT bandı parametreleri araştırma parametresidir.

## ÖZET DURUM

| Faz | Durum | Kanıt |
|---|---|---|
| 0 | DONE | audit/FAZ0_AUDIT.md |
| 1 | DONE | audit/live/connectivity-*.json/md + liveaudit (mesaj sayaçları) |
| 2 | DONE | scripts/unit-tests.js 32 PASS + canlı olay dağılımı |
| 3 | DONE | canlı 276 motif keşfi + epizod kayıtları |
| 4 | DONE | walk-forward skorlama n=579 + sızıntı testi + mezuniyet koşulları (0 mezun — doğru) |
| 5 | DONE | restart/gap/kurtarma testleri (birebir sayaç eşleşmesi) |
| 6 | DONE | tarayıcı doğrulaması (5 sekme, 0 konsol hatası) + SSE kanıt |
| 7 | DONE | audit/live/liveaudit-*.md (uçtan uca gerçek kanıt) |

## FAZ 8 — GitHub Dağıtımı — **BLOCKED (dış bağımlılık: kimlik bilgisi)**

- [x] Yerel depo dağıtıma hazır — main branch, 3 commit, 55 dosya izlemeli; çalışma ağacı temiz (commit `7408368` sonrası).
- [x] `.env` VCS'ten çıkarıldı + `.gitignore` genişletildi (`.env`, `upload/`, `db/`, `*.log`) — sır sızıntısı riski kapatıldı.
- [x] `scripts/deploy-github.sh` — tek komut dağıtım: token doğrulama → repo oluşturma (422=zaten var, idempotent) → remote → push → API ile push doğrulama; token maskelenir, git config'e KAYDEDİLMEZ.
- [x] Ağ doğrulaması — github.com erişilebilir (HTTP/2 200, 2026-10-28); api.github.com anonim istekte rate-limit'li (authenticated istekte sorun beklenmiyor).
- [ ] **BLOCKED:** Bu ortamda GitHub kimlik bilgisi YOK (env / gh CLI / credential helper / config taramasıyla kanıtlandı — hiçbiri token içermiyor). GitHub push, geçerli bir Personal Access Token (kapsam: `repo` veya Fine-grained `Contents: read & write`) olmadan imkânsızdır ve bu kanıt disiplinine aykırı biçimde SAHTE bir repo URL'si bildirilmesi reddedilmiştir.
- [ ] Token sağlandığında: `GITHUB_TOKEN=ghp_xxx dna-lab/scripts/deploy-github.sh market-dna-v1 private` → TODO.md bu madde DONE olarak güncellenir.
