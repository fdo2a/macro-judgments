#!/usr/bin/env bash
# 배포 → 비밀값 → 텔레그램 webhook → 알람 시작을 한 번에 한다. 사람이 자기 터미널에서 직접 돌린다.
#   ./setup.sh rehearsal   리허설 Worker(macro-judgments-rehearsal) — rehearsal 가지에 쓴다
#   ./setup.sh main        운영 Worker(macro-judgments) — main 가지에 쓴다
# 리허설을 다른 이름의 Worker 로 띄우는 이유: Durable Object 의 저장 상태(사건 진행·알림 기록·일정 사본)가
# 운영으로 넘어오지 않게. 운영 전환 뒤 `npx wrangler delete --name macro-judgments-rehearsal` 로 지운다.
#
# 직접 입력하는 값(봇 토큰 등)은 화면·파일·명령줄 인자에 남지 않는다.
# 무작위 값 3개(SALT·KICK_SECRET·WEBHOOK_SECRET)만 ~/.config/macro-judgments/<모드>.env (권한 600)에 둔다.
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-}"
case "$MODE" in
  rehearsal) NAME=macro-judgments-rehearsal; BRANCH=rehearsal ;;
  main)      NAME=macro-judgments;           BRANCH=main ;;
  *) echo "사용: ./setup.sh rehearsal | main" >&2; exit 2 ;;
esac

DIR="$HOME/.config/macro-judgments"
umask 077
mkdir -p "$DIR"
GEN="$DIR/$MODE.env"
if [ ! -f "$GEN" ]; then
  printf 'SALT=%s\nKICK_SECRET=%s\nWEBHOOK_SECRET=%s\n' \
    "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > "$GEN"
fi
# shellcheck disable=SC1090
. "$GEN"

[ -d node_modules ] || npm install --no-audit --no-fund

echo "== 1/5 배포: $NAME (기록 가지: $BRANCH)"
npx wrangler deploy --name "$NAME" --var "GITHUB_BRANCH:$BRANCH" 2>&1 | tee "$DIR/$MODE-deploy.log"
URL=$(grep -oE "https://$NAME\.[a-z0-9-]+\.workers\.dev" "$DIR/$MODE-deploy.log" | head -1 || true)
if [ -z "$URL" ]; then echo "배포 주소를 찾지 못했습니다. 위 출력을 확인하세요." >&2; exit 1; fi
echo "$URL" > "$DIR/$MODE.url"

echo "== 2/5 비밀값"
read -rsp "텔레그램 봇 토큰(입력이 화면에 안 보입니다): " BOT; echo
[ -n "$BOT" ] || { echo "봇 토큰이 비었습니다." >&2; exit 1; }
names() {
  npx wrangler secret list --name "$NAME" --format json 2>/dev/null | python3 -c '
import json, sys
try: print(" ".join(s["name"] for s in json.load(sys.stdin)))
except Exception: print("")'
}
put() {  # 실패하면 거기서 멈춘다 — 비밀값 하나가 빠진 채 webhook·알람으로 넘어가지 않게
  printf '%s' "$2" | npx wrangler secret put "$1" --name "$NAME" >/dev/null || { echo "$1 넣기 실패 — 멈춥니다." >&2; exit 1; }
  echo "  $1 넣음"
}
HAVE=$(names)
put TELEGRAM_BOT_TOKEN "$BOT"
for k in SALT KICK_SECRET WEBHOOK_SECRET; do put "$k" "${!k}"; done
for k in OWNER_ID GITHUB_TOKEN ANTHROPIC_API_KEY FRED_API_KEY; do
  case " $HAVE " in
    *" $k "*) echo "  $k 이미 있음 — 건너뜀" ;;
    *) read -rsp "  $k (입력이 화면에 안 보입니다): " V; echo
       [ -n "$V" ] || { echo "$k 가 비었습니다." >&2; exit 1; }
       put "$k" "$V"
       unset V ;;
  esac
done
HAVE=$(names)
for k in TELEGRAM_BOT_TOKEN OWNER_ID GITHUB_TOKEN ANTHROPIC_API_KEY FRED_API_KEY SALT KICK_SECRET WEBHOOK_SECRET; do
  case " $HAVE " in *" $k "*) ;; *) echo "비밀값 $k 가 Worker 에 없습니다 — 멈춥니다." >&2; exit 1 ;; esac
done
echo "  비밀값 8개 확인"

echo "== 3/5 텔레그램 webhook → $URL/telegram"
curl -sS -K - <<EOF | python3 -c 'import json,sys; r=json.load(sys.stdin); ok = r.get("ok"); print("  ok" if ok else "  webhook 실패: " + str(r.get("description")) + " — 멈춥니다."); sys.exit(0 if ok else 1)'
url = "https://api.telegram.org/bot$BOT/setWebhook"
form-string = "url=$URL/telegram"
form-string = "secret_token=$WEBHOOK_SECRET"
form-string = "allowed_updates=[\"message\"]"
EOF
unset BOT

echo "== 4/5 알람 시작(첫 확인은 15분 뒤)"
curl -sS -K - <<EOF; echo
url = "$URL/kick"
request = "POST"
fail
header = "x-kick-secret: $KICK_SECRET"
EOF

echo "== 5/5 상태"
curl -sS "$URL/health"; echo
echo "끝. 주소: $URL"
