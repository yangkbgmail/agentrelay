#!/usr/bin/env bash
#
# demo.sh — AgentRelay의 핵심 가치(사용량 제한 감지 → 리셋 시점 자동 재개)를
# 처음부터 끝까지 **재현 가능하게** 보여주는 엔드투엔드 데모.
#
# 실제 클라우드/에이전트 없이, "가짜 에이전트"(fake-agent) 스크립트로 rate-limit
# 상황을 시뮬레이션한다:
#   1) `agentrelay run`이 가짜 에이전트를 실행 → 출력에서 "try again in Ns"를
#      감지해 잡을 큐에 넣고 리셋 시각까지 대기(waiting_for_reset).
#   2) 리셋 시각이 지나면 `agentrelay tick`이 잡을 자동 재개 → 이번엔 가짜
#      에이전트가 성공 → 잡이 completed로 마감.
# 그 사이 status/next/stats로 큐 상태를 관찰한다.
#
# 격리: 전용 임시 디렉터리를 AGENTRELAY_STORE로 써서 사용자의 실제 큐를 절대
# 건드리지 않고, 종료 시 정리한다. 외부로의 실제 발송/네트워크 요청은 없다.
#
# 사용법:
#   pnpm build            # 먼저 CLI를 빌드해야 한다(dist/bin.js 필요)
#   bash scripts/demo.sh  # 또는 `pnpm demo`
#
# 환경변수:
#   AGENTRELAY_DEMO_RESET_SECONDS  시뮬레이션 리셋까지의 초(기본 3). 테스트는 짧게.
#   NO_COLOR                       설정 시 색상 출력 비활성(표준 존중).
set -euo pipefail

# --- 위치 해소: 저장소 루트와 빌드된 CLI ------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLI_JS="${REPO_ROOT}/packages/cli/dist/bin.js"

if [[ ! -f "${CLI_JS}" ]]; then
  echo "error: 빌드된 CLI를 찾을 수 없습니다: ${CLI_JS}" >&2
  echo "       먼저 저장소 루트에서 'pnpm build'를 실행하세요." >&2
  exit 1
fi

# 색상(표준 NO_COLOR 존중, 비-TTY에서도 데모 가독성을 위해 켬).
if [[ -n "${NO_COLOR:-}" ]]; then
  BOLD="" ; DIM="" ; GREEN="" ; CYAN="" ; YELLOW="" ; RESET=""
else
  BOLD=$'\033[1m' ; DIM=$'\033[2m' ; GREEN=$'\033[32m' ; CYAN=$'\033[36m'
  YELLOW=$'\033[33m' ; RESET=$'\033[0m'
fi

RESET_SECONDS="${AGENTRELAY_DEMO_RESET_SECONDS:-3}"

# CLI 래퍼: 항상 격리된 스토어로 빌드된 bin을 부른다.
cli() { node "${CLI_JS}" "$@"; }

step() { echo ; echo "${BOLD}${CYAN}▶ $*${RESET}"; }
note() { echo "${DIM}$*${RESET}"; }
ok()   { echo "${GREEN}✓ $*${RESET}"; }

# --- 격리된 작업 공간 --------------------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/agentrelay-demo.XXXXXX")"
cleanup() { rm -rf "${WORK}"; }
trap cleanup EXIT

export AGENTRELAY_STORE="${WORK}/jobs.json"
# 데모가 실제 외부 알림을 보내지 않도록 알림 채널 env를 비운다(안전).
unset AGENTRELAY_SLACK_WEBHOOK AGENTRELAY_WEBHOOK_URL 2>/dev/null || true

# --- 가짜 에이전트 ----------------------------------------------------------
# 첫 호출: rate-limit 메시지를 뱉고 실패(마커 생성). 이후 호출: 성공.
# 마커/횟수 파일은 절대 경로로 두어 cwd에 무관하게 동작한다.
FAKE_AGENT="${WORK}/fake-agent.sh"
MARKER="${WORK}/.first-call-done"
cat > "${FAKE_AGENT}" <<AGENT
#!/usr/bin/env bash
set -euo pipefail
if [[ ! -f "${MARKER}" ]]; then
  # 첫 실행: 사용량 제한에 걸린 것처럼 행동한다.
  : > "${MARKER}"
  echo "[fake-agent] 작업 시작..."
  echo "Rate limit reached for gpt-5-codex. Please try again in ${RESET_SECONDS}s."
  exit 1
fi
# 재개된 실행: 정상적으로 완료한다.
echo "[fake-agent] 리셋 후 재개됨 — 작업을 정상 완료했습니다."
exit 0
AGENT
chmod +x "${FAKE_AGENT}"

echo "${BOLD}AgentRelay 엔드투엔드 데모${RESET}"
note "격리 스토어: ${AGENTRELAY_STORE}"
note "시뮬레이션 리셋: ${RESET_SECONDS}초 뒤"

# --- 1) run: rate-limit 감지 → 큐잉 -----------------------------------------
step "1. agentrelay run — 에이전트를 실행하고 사용량 제한을 감지"
note "\$ agentrelay run --tool codex-cli --project demo -- ./fake-agent.sh"
# run은 감지된 rate-limit이 있으면 잡을 큐잉한다. 가짜 에이전트가 exit 1로
# 끝나므로 run도 그 코드를 그대로 물려주지만(||true로 흡수), 큐잉은 이미 됐다.
cli run --tool codex-cli --project demo -- "${FAKE_AGENT}" || true

# 큐잉된 잡의 id를 status --json에서 뽑는다(첫 잡).
cli status --json > "${WORK}/status1.json"
JOB_ID="$(node -e '
  const fs = require("node:fs");
  const snap = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const job = (snap.jobs || [])[0];
  process.stdout.write(job ? job.id : "");
' "${WORK}/status1.json")"

if [[ -z "${JOB_ID}" ]]; then
  echo "error: 잡이 큐잉되지 않았습니다(rate-limit 감지 실패)." >&2
  exit 1
fi
ok "잡 ${JOB_ID:0:8} 이 큐에 들어갔습니다."

# --- 2) status / next: 대기 중인 잡 관찰 -------------------------------------
step "2. agentrelay status — 리셋을 기다리는 잡"
cli status

step "   agentrelay next — 다음에 재개될 잡과 카운트다운"
cli next || true

# --- 3) 리셋까지 대기 --------------------------------------------------------
step "3. 시뮬레이션 리셋 시각까지 대기 (${RESET_SECONDS}s + 여유)"
# 리셋 시각이 확실히 지나도록 1초 여유를 둔다.
sleep "$((RESET_SECONDS + 1))"
ok "리셋 시각 경과 — 이제 재개 대상입니다."

# --- 4) tick: 자동 재개 → 완료 ----------------------------------------------
step "4. agentrelay tick — 준비된 잡을 재개(데몬의 1회분)"
note "\$ agentrelay tick"
cli tick || true

# --- 5) 결과 검증 ------------------------------------------------------------
step "5. agentrelay status / stats — 최종 상태"
cli status
echo
cli stats || true

cli status --json > "${WORK}/status2.json"
FINAL_STATUS="$(node -e '
  const fs = require("node:fs");
  const snap = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const id = process.argv[2];
  const job = (snap.jobs || []).find((j) => j.id === id);
  process.stdout.write(job ? job.status : "missing");
' "${WORK}/status2.json" "${JOB_ID}")"

echo
if [[ "${FINAL_STATUS}" == "completed" ]]; then
  ok "잡 ${JOB_ID:0:8} 이 리셋 후 자동 재개되어 ${GREEN}completed${RESET}${GREEN} 되었습니다.${RESET}"
  echo "${BOLD}${GREEN}✅ Demo complete — DEMO_RESULT=ok${RESET}"
  exit 0
else
  echo "${YELLOW}✗ 예상과 다른 최종 상태: ${FINAL_STATUS} (기대: completed)${RESET}" >&2
  echo "DEMO_RESULT=fail" >&2
  exit 1
fi
