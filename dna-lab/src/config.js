'use strict';
/*
 * Market DNA V1 — Merkezî yapılandırma.
 * ÖNEMLİ: Aşağıdaki sayısal eşikler BAŞLANGIÇ ARAŞTIRMA PARAMETRELERİDİR.
 * Kanıtlanmış sabitler olarak sunulmazlar; deneylerle yeniden kalibre edilmeleri gerekir.
 * Spec gereği mezuniyet eşikleri "kanıtsız sabit" değil, açıklanabilir operasyon parametreleridir
 * ve veri yetersizken sistem KULUÇKADA kalır.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');

module.exports = {
  root: ROOT,
  server: {
    port: Number(process.env.PORT) || 3000,
    host: '0.0.0.0',
    staticDir: path.join(ROOT, 'public'),
  },
  dataDir: path.join(ROOT, 'data'),
  auditDir: path.join(ROOT, 'audit'),

  // Kullanıcının örneklediği coinler; katalog REST exchangeInfo'dan genişletilir.
  defaultCoins: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  symbolFormat: { okx: (s) => s.replace(/USDT$/, '-USDT-SWAP') },

  session: {
    backgroundIncubationDefault: true,     // Arka plan kuluçka varsayılanı (Ayarlar'dan değiştirilir)
    disconnectGraceMs: 20_000,             // Tüm istemciler koparsa analiz bu süre sonra duraklatılır (arka plan kapalıysa)
    sessionGapMs: 10 * 60_000,             // Son oturum bitişinden sonra bu kadar boşluk => <SESSION_GAP>
    warmupMs: 5_000,                       // Yeni oturum veri ısınma süresi (olay üretilir, tahmin üretilmez)
    persistIntervalMs: 20_000,             // state.json periyodik atomik yazım
  },

  sources: {
    binanceFutures: {
      enabled: true,
      publicUrl: (s) => `wss://fstream.binance.com/public/stream?streams=${s.toLowerCase()}@bookTicker/${s.toLowerCase()}@depth20@100ms`,
      marketUrl: (s) => `wss://fstream.binance.com/market/stream?streams=${s.toLowerCase()}@aggTrade/${s.toLowerCase()}@markPrice@1s/${s.toLowerCase()}@forceOrder`,
      restBase: 'https://fapi.binance.com',
      depthMode: 'top20',                  // partial depth kanalı: her mesaj top-20 TAM anlık görüntü
      staleMs: 8_000,
    },
    binanceSpot: {
      enabled: true,
      url: (s) => `wss://stream.binance.com:9443/stream?streams=${s.toLowerCase()}@aggTrade/${s.toLowerCase()}@depth20@100ms/${s.toLowerCase()}@bookTicker`,
      restBase: 'https://data-api.binance.vision',  // fapi 451/418 WAF kısıtına karşı ayna
      depthMode: 'top20',
      staleMs: 8_000,
    },
    okxSwap: {
      enabled: true,
      url: 'wss://ws.okx.com:8443/ws/v5/public',
      restBase: 'https://www.okx.com',
      depthMode: 'top400',                 // OKX "books" kanalı: her push tam anlık görüntü
                                           // GÖZLEM: BTC-USDT-SWAP'ta push başına medyan ~25 seviye yayılıyor
                                           // (audit kanıtı: 8 sn'de 78 push, medyan bid 24 / ask 26 seviye)
      staleMs: 15_000,
      pingMs: 15_000,
    },
    reconnect: { baseMs: 1_000, maxMs: 30_000 },
  },

  events: {
    // --- Duvar (WALL_*) ---
    walls: {
      searchLevels: 20,          // duvar araması her iki tarafta ilk N seviyede
      kMedian: 8,                // duvar eşiği = max(absFloorNotional, kMedian × medyan seviye notional)
      absFloorNotional: 150_000, // USDT — medyan çok inceyse duvar tanımı bozulmasın diye taban
      goneFactor: 0.35,          // notional bu çarpanın altına düşerse duvar yok sayılır
      pullFactor: 0.55,          // tepe notional'a göre bu orana düşerse WALL_PULL (gözlemsel likidite çekilmesi)
      testBandBps: 1.5,          // en iyi fiyat duvara bu yakınlıkta ise "test" sayılır
      holdMs: 4_000,             // test altında bu süre dayanınca WALL_HOLD
      respawnCooldownMs: 30_000, // aynı (taraf, fiyat) için yeniden SPAWN bekleme süresi
      spawnPersistMs: 600,       // KARARLILIK FİLTRESİ: seviye eşiği bu süre aşmadan aşamazsa SPAWN yok (gürültü önleme)
      pullMinAgeMs: 3_000,       // bu yaştan genç duvar PULL üretmez; kaybolursa sessizce silinir
    },
    // --- Akış (FLOW_*) ---
    flow: {
      burstWindowMs: 1_000,      // agresif işlem notional'ı bu pencerede ölçülür
      baselineWindowMs: 60_000,  // z-score taban çizgisi
      baselineMinSamples: 20,
      zEnter: 2.5,
      absFloorNotional: 40_000,  // z yüksek ama mutlak hacim küçükse olay üretme
      refractoryMs: 5_000,       // aynı taraf için tekrar BURST bekleme
      exhaustRatio: 0.4,         // taban × bu orana inmişse tükenme
      exhaustSearchMs: 20_000,   // BURST sonrası bu süre içinde aranır
      exhaustMinMs: 3_000,       // tükenme için düşük rejim süresi
    },
    // --- Kitap (BOOK_TILT / MICRO_FLIP / VOID_OPEN) ---
    book: {
      tiltLevels: 10,
      tiltEnter: 0.45,           // |imbalance| eşiği giriş
      tiltExit: 0.25,            // histerezis çıkışı
      flipWindowMs: 5_000,       // iki yönlü sıfır geçişi bu pencerede MICRO_FLIP sayılır
      voidDropFactor: 0.4,       // top-N notional 2s içinde bu orana düşerse boşluk açıldı
      voidWindowMs: 2_000,
      voidPersistMs: 1_000,
      voidRefractoryMs: 15_000,
    },
    // --- Fiyat tepkisi (SWEEP_REJECT) ---
    sweep: {
      lookbackMs: 10_000,        // recent ekstrem referansı
      minSweepBps: 1.0,          // önceki ekstremi en az bu kadar geçmeli
      rejectMaxMs: 5_000,        // geri dönüş bu süre içinde olmalı
      refractoryMs: 8_000,
    },
  },

  motifs: {
    windowMs: 120_000,           // keşif penceresi
    maxGapMs: 20_000,            // ardışık olaylar arası maksimum boşluk (dizilim bütünlüğü)
    maxLen: 4,                   // keşfedilen motif uzunluğu üst sınırı
    minCountDiscovery: 3,        // DISCOVERY için pencere içinde minimum görülme (başlangıç parametresi)
    deDupMs: 800,                // aynı tip+taraf ardışık olay bu süreden kısaysa dizilimde tekrar sayılmaz
    mineEveryMs: 2_000,
    maxOccurrencesKept: 400,
  },

  outcomes: {
    horizonsSec: [10, 30, 120],
    volLookbackMs: 300_000,      // FLAT bandı için 1s getiri volatilitesi penceresi (yalnız t0 öncesi veri)
    volK: 1.0,                   // band = max(volK × σ1s × √H, spreadMult × medyan spread, minBandBps)
    spreadMult: 2.0,
    minBandBps: 1.0,
    primaryVenue: 'binance_futures', // referans fiyat kaynağı; yoksa ilk canlı venue
  },

  learner: {
    // TÜM eşikler başlangıç araştırma parametreleridir; "kanıtlanmış sabit" değildir.
    incubationMinEpisodes: 25,       // VALIDATION'a geçmek için en az çözülmüş epizot
    validationForwardBlock: 10,      // her yeni blokta ileri doğrulama metrikleri tazelenir
    nEffMin: 15,                     // mezuniyet için etkin örneklem alt sınırı (aday değer)
    brierLiftMin: 0.005,             // en iyi baz modele göre minimum Brier iyileşmesi (mutlak)
    bootstrapResamples: 400,
    confidence: 0.90,                // bootstrap CI seviyesi; CI sıfırın altına inmemeli
    bhQ: 0.20,                       // Benjamini-Hochberg FDR seviyesi (motif ailesi üzerinden)
    calibrationBins: 5,
    minRegimeCoverage: 2,            // en az 2 rejimde negatif olmayan lift
    quarantineWindow: 20,            // son N çözülmüş epizotta
    quarantineBrierSlack: -0.01,     // baz modelden bu kadar kötüyse karantina
    quarantineIntegrityRatio: 0.25,  // bütünlük bozuk epizot oranı eşiği
    retireHalfLifeDays: 14,          // ÜSTEL YAŞLANDIRMA ADAYI — yarı ömür deneysel doğrulama olmadan sabitlenmez
    retireWeightFloor: 0.15,         // bu ağırlığın altına düşen motif RETIRED adayı
    invalidators: ['WALL_PULL', 'FLOW_BURST', 'MICRO_FLIP', 'BOOK_TILT'], // spec §11 adayları; kesin kural değil, empirik öğrenilir
  },

  logging: {
    eventsJsonl: true,
    episodesJsonl: true,
    rotateDay: true,
  },
};
