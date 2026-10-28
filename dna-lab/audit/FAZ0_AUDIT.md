# FAZ 0 — Çalışma Alanı Denetim Raporu

- Denetim zamanı: 2026-10-29 (UTC+8), oturum başında
- Denetleyen: Market DNA V1 kurulum denetimi
- Kapsam: istenen çalışma alanı `/home/user/dna-lab/`, yüklenen `orderbook-mobile (5).html`

## 1. İstenen çalışma alanı ve denetim dosyaları

| Beklenen | Durum | Kanıt |
|---|---|---|
| `/home/user/dna-lab/` | **MEVCUT DEĞİL** (`ls: cannot access '/home/user/dna-lab/': No such file or directory`) | bu rapor §1; ortamda yazılabilir tek alan `/home/z/my-project/` |
| `btc_single_coin_audit.js` | **BULUNAMADI** | dosya sistemi araması boş döndü |
| `btc_events_trace.jsonl` | **BULUNAMADI** | dosya sistemi araması boş döndü |

**Sonuç:** Önceki oturumlara ait hiçbir test sonucu doğrulanmış kabul edilmedi. Var olmayan kod/sonuç uydurulmadı. Proje `/home/z/my-project/dna-lab/` altında sıfırdan kuruldu ve tüm kanıtlar bu oturumda gerçek çalıştırmalarla üretilecek.

## 2. Yüklenen dosya: `orderbook-mobile (5).html` (3466 satır)

Tek dosyalık, bağımlılıksız mobil orderbook istemcisi. FAZ 0 denetiminde satır bazında incelendi.

### 2.1 Mimari özet (gerçek, koddan doğrulanmış)

- **Veri:** Binance USDⓈ-M Futures combined stream (`wss://fstream.binance.com/stream?streams=...`): `@aggTrade`, `@depth20@100ms` (partial snapshot), `@bookTicker`; ilk veri `FAILOVER_AFTER_MS=9000` içinde gelmezse **Bybit linear WSS** (`wss://stream.bybit.com/v5/public/linear`) yedeğine geçiş.
- **REST:** `fapi.binance.com` birincil; katalog için `data-api.binance.vision` aynası. Kod içi yorum, canlı testte fstream WSS'nin çalışıp REST'in 451 döndüğünü belgeliyor (coğrafi kısıt kanıtı — bu oturumun FAZ 1 testlerinde bağımsız yeniden doğrulanacak).
- **Yön motoru (Isı Haritası sekmesi):** istemci tarafı çevrimiçi öğrenici — rejim başı (calm/normal/volatile/thin) özellik ağırlıkları, AdaGrad benzeri güncelleme, Platt kalibrasyonu (`calib.a,b`), abstain eşiği auto-tune (`softAccuracy<0.52 → eşik yükselt`), drift adaptasyonu (ağırlıkların öncüllere 0.55/0.45 karışımı), otomatik ufuk (8–60 s, hedef hamle bps / vol hızı), `pending[]` tahmin havuzu ve çözümleme, İSABET/BRIER/ÖRNEK pill'leri, SON 20 iz noktaları.
- **Kalıcılık:** yalnızca `localStorage` (şema `v:2`, coin başına anahtar + `.global` kalibrasyon yedeği).
- **Bağımlılık:** sıfır npm paketi; tüm mantık tek IIFE içinde.

### 2.2 Bu projedeki rolü

Spec gereği **yön motoruna MÜDAHALE EDİLMEDİ ve edilmeyecek**. Market DNA bağımsız backend analiz motoru + kendi paneli olarak geliştirilecek. Değiştirilmemiş kopya `reference/orderbook-mobile (5).html` altında saklandı (md5 aşağıda).

## 3. Bulgular ve riskler

| # | Bulgu | Etki | Market DNA'daki karşılık |
|---|---|---|---|
| 1 | Önceki denetim dosyaları yok | Önceki "test sonuçları" devralınamaz | FAZ 7'de yeni, kanıtlı denetim |
| 2 | Öğrenme tarayıcıda (localStorage) | Tarayıcı değişince hafıza kaybı; sunucu tarafı süreklilik yok | Sunucu tarafı coin başına disk hafızası (FAZ 5) |
| 3 | Tek olay "yön skoru" yaklaşımı; olay DİZİLİMİ keşfi yok | "WALL_SPAWN→FLOW_BURST→..." gibi dizilimler öğrenilemiyor | Olay kodlayıcı + motif motoru (FAZ 2–3) |
| 4 | İSABET/BRIER pill'lerinde örtüşen pencere ve seri bağımlılık düzeltmesi yok; tek test tekrarı | Küçük örneklemde aşırı iyimser istatistik | N_eff + örtüşme kümeleme + BH-FDR (FAZ 4) |
| 5 | Walk-forward doğrulama yok (aynı veri üzerinde online güncelleme + skorlama) | Veri sızıntısı riski | t0'da gölge tahmin, çözülünce skorlama (FAZ 4) |
| 6 | Duvar/spoof mantığı skor içinde ceza olarak var; WALL_PULL gibi olaylar ayrıştırılmamış | Manipülasyon kanıtı sayma riski | WALL_PULL yalnız gözlemsel likidite çekilmesi (spec §3) |
| 7 | Derinlik yalnız top-20 partial | Deeper-void olayları görülmez | Sınırlama olarak belgelenir; OKX 400 seviye kısmen telafi eder |
| 8 | REST 451 coğrafi kısıt kanıtı (kod yorumu) | REST snapshot her ortamda erişilemez | Partial-depth snapshot akışlarıyla REST'siz çalışabilen tasarım + gerçek test |
| 9 | Tek dosya ~3.5k satır | Bakım zorluğu | Modüler src/ ağacı (FAZ kod disiplini §14) |
| 10 | FLAT sınıfı ve uygulanabilir maliyet bandı yok (yön/nötr ikili) | FLAT tanımsız | Üç durumlu sonuç + bant formülü (FAZ 4) |

## 4. FAZ 0 sonuç kararı

- FAZ 0 **DONE**: mevcut işaretli tek denetlenebilir artefakt (yüklü HTML) denetlendi; istenen eski denetim dosyalarının yokluğu açıkça raporlandı.
- Devam kararı: FAZ 1 canlı veri katmanı — önce GERÇEK bağlantı testleri, sonra adaptörler. Test kanıtı olmadan hiçbir adaptör "çalışıyor" işaretlenmeyecek.

## 5. Referans checksum

- `reference/orderbook-mobile (5).html` (değiştirilmemiş kopya) md5: FAZ 1 başında `md5sum` ile kaydedilir (aşağıya işlenir).
