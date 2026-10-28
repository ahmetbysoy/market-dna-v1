#!/usr/bin/env bash
# ============================================================================
# deploy-github.sh — Market DNA V1 → GitHub tek komut dağıtımı
# Kullanım:
#   GITHUB_TOKEN=ghp_xxx ./deploy-github.sh [repo-adı] [public|private]
# Veya:
#   ./deploy-github.sh ghp_xxx market-dna-v1 private
# Notlar:
#   - Token asla ekrana yazılmaz, git config'e KAYDEDİLMEZ (yalnız push URL'sinde geçici).
#   - private varsayılan (güvenli). public istersen açıkça belirt.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$REPO_DIR" ] || REPO_DIR="$SCRIPT_DIR/.."
REPO_DIR="$(cd "$REPO_DIR" && pwd)"
# Token öncelik sırası: GITHUB_TOKEN env → $1 (token formatlıysa, sonra shift edilir)
TOKEN="${GITHUB_TOKEN:-}"
if [ -z "$TOKEN" ] && [[ "${1:-}" =~ ^(ghp_|github_pat_|gho_) ]]; then TOKEN="$1"; shift; fi
REPO_NAME="${1:-market-dna-v1}"
VISIBILITY="${2:-private}"
[ -n "$TOKEN" ] || { echo "HATA: GITHUB_TOKEN verilmedi. Kullanım: GITHUB_TOKEN=ghp_xxx $0 [repo-adı] [public|private]"; exit 1; }
case "$TOKEN" in ghp_*|github_pat_*|gho_*) :;; *) echo "HATA: token geçersiz formatta (ghp_/github_pat_ ile başlamalı)"; exit 1;; esac
[ "$VISIBILITY" = "public" ] || [ "$VISIBILITY" = "private" ] || { echo "HATA: görünürlük 'public' veya 'private' olmalı"; exit 1; }

API="https://api.github.com"
AUTH="Authorization: Bearer $TOKEN"
mask() { sed 's/[A-Za-z0-9_-]\{20,\}/***MASKED***/g'; }

echo "── [1/5] Token doğrulanıyor…"
USER_JSON=$(curl -sf --max-time 15 -H "$AUTH" "$API/user") || { echo "HATA: token geçersiz veya ağ erişimi yok"; exit 1; }
GH_USER=$(printf '%s' "$USER_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).login))")
echo "  → GitHub kullanıcısı: $GH_USER"

echo "── [2/5] Repo oluşturuluyor: $GH_USER/$REPO_NAME ($VISIBILITY)…"
CREATE_CODE=$(curl -s -o /tmp/gh-create.json -w '%{http_code}' --max-time 20 \
  -H "$AUTH" -H "Accept: application/vnd.github+json" \
  -d "{\"name\":\"$REPO_NAME\",\"description\":\"Market DNA V1 — gerçek zamanlı olay-dizilimi piyasa mikro-yapısı araştırma ajanı (kanıt temelli)\",\"$VISIBILITY\":true,\"has_issues\":true}" \
  "$API/user/repos")
if [ "$CREATE_CODE" = "201" ]; then echo "  → repo oluşturuldu";
elif [ "$CREATE_CODE" = "422" ]; then echo "  → repo zaten VAR, mevcut depoya push edilecek";
else echo "HATA: repo oluşturulamadı (HTTP $CREATE_CODE):"; cat /tmp/gh-create.json | mask; exit 1; fi

cd "$REPO_DIR"
echo "── [3/5] Remote ayarlanıyor…"
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$GH_USER/$REPO_NAME.git"

echo "── [4/5] main push ediliyor…"
PUSH_URL="https://x-access-token:${TOKEN}@github.com/$GH_USER/$REPO_NAME.git"
if git push "$PUSH_URL" main:main 2>&1 | mask; then :; else echo "HATA: push başarısız (token kapsamı 'repo' veya 'Contents: read&write' olmalı)"; git remote remove origin; exit 1; fi

echo "── [5/5] Push doğrulanıyor…"
BRANCH_OK=$(curl -sf --max-time 15 -H "$AUTH" "$API/repos/$GH_USER/$REPO_NAME/branches/main" >/dev/null && echo "EVET" || echo "HAYIR")
echo ""
echo "════════════════════════════════════════════════════════"
if [ "$BRANCH_OK" = "EVET" ]; then
  echo "DAĞITIM BAŞARILI ✅  https://github.com/$GH_USER/$REPO_NAME"
  echo "  branch: main · commit: $(git rev-parse --short HEAD) · dosya: $(git ls-files | wc -l)"
else
  echo "UYARI: push sonrası doğrulama yapılamadı — repoyu elle kontrol et."
fi
echo "════════════════════════════════════════════════════════"
