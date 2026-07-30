#!/usr/bin/env bash
#
# AgentRelay — 재현 가능한 엔드투엔드 데모 (self-verifying end-to-end demo)
# ---------------------------------------------------------------------------
# 이 스크립트는 실제 AI 에이전트(claude/codex)나 네트워크 없이도 AgentRelay의
# 전체 수명주기를 결정론적으로 재현한다:
#
#   1. `run`  — 가짜 툴이 rate-limit 메시지를 뱉으면 잡이 큐에 잡히는 것을 확인
#   2. 관찰   — status / next / projects / patterns / health / stats / metrics
#   3. `tick` — 리셋 시각이 지나면 스케줄러가 같은 명령을 자동 재개(성공 종료)
#
# 실제 claude를 부르지 않으므로 CI/샌드박스/오프라인에서 그대로 돌아가며,
# 각 단계의 결과를 assert 하므로 통과=exit 0, 어긋나면 exit 1 (스모크 테스트 겸용).
#
# 사용법:  scripts/demo.sh            # 빌드된 CLI를 자동 탐지(없으면 pnpm build 안내)
#          AGENTRELAY_CLI="node ..." scripts/demo.sh   # CLI 실행 커맨드 직접 지정
#
# 격리: 임시 AGENTRELAY_STORE + 임시 디렉터리를 쓰고 종료 시 정리하므로 실제
# ~/.agentrelay 를 절대 건드리지 않는다.
set -euo pipefail

# ---------------------------------------------------------------------------
# 색상 (터미널이 아니거나 NO_COLOR 설정 시 비활성)
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; RED=$'\033[31m'
  CYAN=$'\033[36m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; GREEN=''; RED=''; CYAN=''; YELLOW=''; RESET=''
fi

step() { printf '\n%s\n' "${BOLD}${CYAN}▶ $*${RESET}"; }
run_cmd() { printf '%s$ %s%s\n' "$DIM" "$*" "$RESET"; }
ok()   { printf '%s  ✓ %s%s\n' "$GREEN" "$*" "$RESET"; }
fail() { printf '%s  ✗ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 리포 루트 & CLI 탐지
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -n "${AGENTRELAY_CLI:-}" ]; then
  CLI="$AGENTRELAY_CLI"
elif [ -f "$REPO_ROOT/packages/cli/dist/bin.js" ]; then
  CLI="node $REPO_ROOT/packages/cli/dist/bin.js"
else
  fail "빌드된 CLI가 없습니다. 먼저 'pnpm build'를 실행하거나 AGENTRELAY_CLI 를 지정하세요."
fi

# ---------------------------------------------------------------------------
# 격리된 작업 공간 + 정리 트랩
# ---------------------------------------------------------------------------
DEMO_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentrelay-demo.XXXXXX")"
export AGENTRELAY_STORE="$DEMO_DIR/jobs.json"
COUNT_FILE="$DEMO_DIR/attempts"
cleanup() { rm -rf "$DEMO_DIR"; }
trap cleanup EXIT

printf '%s\n' "${BOLD}AgentRelay 데모${RESET} — 격리 스토어: ${DIM}$AGENTRELAY_STORE${RESET}"
printf '%s\n' "${DIM}(실제 에이전트 호출 없이 가짜 툴로 rate-limit → 자동 재개 전 과정을 재현)${RESET}"

# 잡이 JSON에서 특정 status 개수를 갖는지 확인하는 헬퍼
assert_status_count() {
  local status="$1" want="$2" got
  got="$($CLI status --json | grep -c "\"status\": \"$status\"" || true)"
  [ "$got" = "$want" ] || fail "status '$status' 기대 $want, 실제 $got"
}

# ---------------------------------------------------------------------------
# 1) run — 가짜 툴이 rate-limit 을 뱉고, 잡이 큐에 잡힌다
# ---------------------------------------------------------------------------
# 가짜 codex 툴: 첫 실행은 "몇 초 뒤 재시도" rate-limit(exit 1), 재개 시엔 성공(exit 0).
# 시도 횟수를 파일로 세어 재개가 실제로 두 번째 실행을 일으켰는지 증명한다.
FAKE_TOOL="n=\$(cat '$COUNT_FILE' 2>/dev/null || echo 0); n=\$((n+1)); echo \$n > '$COUNT_FILE'; \
if [ \"\$n\" -eq 1 ]; then echo 'stream error: rate limited, please try again in 2s'; exit 1; \
else echo 'DEMO-RESUMED-OK'; exit 0; fi"

step "1. rate-limit 감지 → 잡 큐잉 (agentrelay run)"
run_cmd "agentrelay run --tool codex-cli -- <fake codex, 2초 뒤 재시도>"
RUN_OUT="$($CLI run --tool codex-cli --project demo -- bash -c "$FAKE_TOOL" 2>&1 || true)"
printf '%s\n' "$DIM$RUN_OUT$RESET"
echo "$RUN_OUT" | grep -q "Rate limit detected" || fail "rate-limit 감지 메시지가 없습니다"
echo "$RUN_OUT" | grep -q "codex-relative-seconds" || fail "codex 초 단위 패턴이 매칭되지 않았습니다"
assert_status_count "waiting_for_reset" 1
ok "잡 1건이 waiting_for_reset 상태로 큐에 등록됨 (초 단위 리셋 시각 파싱)"

# ---------------------------------------------------------------------------
# 2) 관찰 커맨드들이 잡을 일관되게 보여준다
# ---------------------------------------------------------------------------
step "2. 관찰 — status / next / projects / patterns / health"

run_cmd "agentrelay status"
$CLI status | sed 's/^/    /'

run_cmd "agentrelay next"
NEXT_OUT="$($CLI next 2>&1)"
printf '%s\n' "$NEXT_OUT" | sed 's/^/    /'
echo "$NEXT_OUT" | grep -qi "demo" || fail "next 가 demo 프로젝트 잡을 가리키지 않습니다"
ok "next 가 다음 재개 대상(1건)을 카운트다운과 함께 표시"

run_cmd "agentrelay projects"
PROJ_OUT="$($CLI projects 2>&1)"
printf '%s\n' "$PROJ_OUT" | sed 's/^/    /'
echo "$PROJ_OUT" | grep -qi "demo" || fail "projects 가 demo 프로젝트 라벨을 보여주지 않습니다"
ok "projects 가 프로젝트별 대기 잡 집계(demo 1건)를 표시"

run_cmd "agentrelay patterns"
PAT_OUT="$($CLI patterns 2>&1)"
printf '%s\n' "$PAT_OUT" | sed 's/^/    /'
echo "$PAT_OUT" | grep -q "codex-relative-seconds" || fail "patterns 가 발화한 패턴을 보여주지 않습니다"
ok "patterns 가 실제로 발화한 감지 패턴(provenance)을 표시"

run_cmd "agentrelay health"
# 대기 잡은 있지만 재개 루프(daemon/tick)가 안 돌고 있으므로 정상적으로 UNHEALTHY 가능.
HEALTH_OUT="$($CLI health 2>&1 || true)"
printf '%s\n' "$HEALTH_OUT" | sed 's/^/    /'
ok "health 프로브 실행됨 (재개 루프 생존 여부를 exit code 로 답함)"

# ---------------------------------------------------------------------------
# 3) tick — 리셋 시각이 지나면 자동 재개되어 성공 종료
# ---------------------------------------------------------------------------
step "3. 자동 재개 — 리셋 시각 경과 후 tick 한 번 (cron/daemon 이 하는 일)"
printf '%s\n' "${YELLOW}    리셋(약 2초)이 지나길 기다리는 중...${RESET}"
sleep 3
run_cmd "agentrelay tick"
TICK_OUT="$($CLI tick 2>&1)"
printf '%s\n' "$TICK_OUT" | sed 's/^/    /'
echo "$TICK_OUT" | grep -q "completed" || fail "tick 이 잡을 재개/완료시키지 못했습니다"

# 재개가 정말로 두 번째 실행을 일으켰는지(=시도 2회) 증명
ATTEMPTS="$(cat "$COUNT_FILE")"
[ "$ATTEMPTS" = "2" ] || fail "가짜 툴이 정확히 2회(최초+재개) 실행되어야 하는데 ${ATTEMPTS}회 실행됨"
assert_status_count "completed" 1
ok "잡이 자동 재개되어 completed (가짜 툴 2회 실행 확인 — 최초 rate-limit + 재개 성공)"

# ---------------------------------------------------------------------------
# 4) 완료 후 집계
# ---------------------------------------------------------------------------
step "4. 완료 후 집계 — stats / metrics"
run_cmd "agentrelay stats"
$CLI stats | sed 's/^/    /'
run_cmd "agentrelay metrics  (Prometheus 노출 형식)"
$CLI metrics | grep -E '^agentrelay_' | head -n 6 | sed 's/^/    /'

printf '\n%s\n' "${BOLD}${GREEN}✓ 데모 통과 — rate-limit 감지부터 자동 재개까지 전 과정이 재현되었습니다.${RESET}"
