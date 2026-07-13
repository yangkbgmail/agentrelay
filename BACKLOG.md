# BACKLOG — 공유 할 일 큐

> 클로드 코드와 코워크가 여기서 할 일을 가져간다. 소유자(👷 클로드 코드 / 🧭 코워크)를
> 표기하고, 작업 시작 시 상태를 `[진행중]`, 끝나면 `[완료]`로 바꾼다. 브랜치명도 적어두면 좋다.

## MVP 남은 항목 (SPEC §3)

- [x] 👷 `apps/dashboard`: Next.js 로컬 대시보드. `~/.agentrelay/jobs.json`을 읽어 큐 상태·
      리셋 카운트다운·로그·사용량을 보여줌. API route가 파일을 직접 읽으면 됨(별도 백엔드 X).
      (완료 — `apps/dashboard`, `/api/jobs` 폴링, 라이트/다크 검증. branch `claude/magical-knuth-18lx94`)
- [x] 👷 Slack webhook 알림. `AGENTRELAY_SLACK_WEBHOOK` 있으면 발송, 없으면 조용히 스킵.
      (완료 — `@agentrelay/core`의 `createSlackNotifier`/`slackNotifierFromEnv`, run/daemon/tick에 연결)
- [ ] 🧭 README.md: 설치 → `agentrelay run -- claude -p "..."` → daemon까지 5분 튜토리얼.
- [ ] 🧭 ARCHITECTURE.md + ROADMAP.md(v2: 클라우드 동기화/팀 대시보드/과금).
- [x] 👷 엣지 케이스 테스트 보강(다양한 rate-limit 메시지 포맷 회귀 케이스).
      (완료 — `parser.test.ts`에 12케이스 회귀 추가: 빈 문자열/시간없는 rate-limit/24h 시계/
      12am·12pm/타임존 오프셋 ISO/잘못된 ISO fallthrough/시간단위만/JSON `retry_after`/멀티라인.
      파서도 `"retry_after": N` JSON 형식 인식하도록 개선. branch `claude/keen-allen-u5qt1l`)
- [ ] 👷🧭 최종 QA + 재현 가능한 데모 스크립트.

## 무한 개선 백로그 (SPEC §8 — MVP 이후에도 계속)

- [x] 👷 Codex CLI 등 다른 에이전트 툴 어댑터.
      (완료 — `@agentrelay/core`에 `adapters.ts` 신설: `AgentAdapter` 인터페이스 +
      `CLAUDE_CODE_ADAPTER`/`CODEX_CLI_ADAPTER`/`GENERIC_ADAPTER` + `ADAPTERS` 레지스트리.
      `inferToolFromCommand`(argv0 바이너리명으로 툴 추론)·`resolveAdapter`(명시 tool→추론→generic).
      파서에 `extraPatterns` 훅 추가 → 어댑터가 툴별 패턴 주입. Codex 어댑터는 OpenAI식
      초 단위 대기(`try again in 20s`, `1.5s`)를 인식(generic 파서엔 초 패턴 없음).
      `run`이 tool 추론·`--tool` 플래그, 스케줄러가 resume 시 job.tool 어댑터 사용.
      branch `claude/wizardly-pascal-v7euys`)
- [x] 👷 job 재시도 정책 / 지수 백오프 / 최대 시도 횟수.
      (완료 — `@agentrelay/core`에 `RetryPolicy`/`DEFAULT_RETRY_POLICY`/`computeBackoffMs`/
      `isRetryExhausted`/`retryPolicyFromEnv` 추가. 스케줄러가 non-zero 종료·spawn 에러를
      지수 백오프로 재큐잉하고, rate-limit·실패 모두 `maxAttempts` 초과 시 `failed` 처리.
      `RelayScheduler`에 `retryPolicy` 옵션, CLI daemon/tick이 env(`AGENTRELAY_MAX_ATTEMPTS` 등)로
      설정. branch `claude/keen-allen-u5qt1l`)
- [x] 👷 `agentrelay status`를 실시간 TUI로.
      (완료 — `packages/cli/src/status.ts` 신설: 순수 렌더 함수 `renderStatusTable`(요약 푸터)·
      `formatCountdown`(분/시/일·`due now`)·`renderStatusJson`(대시보드 스냅샷 형태)·`renderWatchFrame`.
      `agentrelay status --watch [초]`가 화면을 지우고 N초마다 재렌더하는 라이브 카운트다운 TUI,
      `--json`은 스크립트/`jq`용 기계 판독 출력. branch `claude/wizardly-pascal-mnrfk8`)
- [x] 👷 job 보존/정리(prune) — `jobs.json` 무한 증가 방지.
      (완료 — `@agentrelay/core`에 `prune.ts` 신설: 순수 `selectPrunableJobs`(상태/나이/keepLast
      규칙으로 삭제 대상 분리) + `parseDuration`(`7d`/`24h`/`30m`/`90s`/`500ms`→ms). `RelayQueue.prune`
      은 기본적으로 종료 상태(completed/failed)만 제거하고 활성 job은 보존, `dryRun`이면 비파괴.
      CLI `agentrelay prune --older-than/--status/--keep/--dry-run` 추가. branch
      `claude/wizardly-pascal-94df3w`)
- [x] 👷 lint(ESLint/Biome) + CI 워크플로 도입.
      (완료 — Biome 채택. 루트 `biome.json`(recommended lint + formatter, 더블쿼트·2스페이스·
      lineWidth 120, `packages/**`·`apps/**` src·test 스코프, dist/.next 제외, test 파일은
      `noExplicitAny`/`noNonNullAssertion` off override). 루트 스크립트 `lint`/`lint:fix`/
      `format`/`ci:lint` 추가. CI 워크플로에 `pnpm ci:lint`(`biome ci`) 단계를 install↔build
      사이에 삽입. 전체 코드베이스 포맷·import 정렬 정규화, scheduler의 non-null 단언 3곳은
      방어적 `reload()` 헬퍼로 대체. `biome ci` 0 경고. branch `claude/wizardly-pascal-38649m`)
- [x] 👷 범용 웹훅 알림자(generic webhook notifier) — Slack 전용을 넘어 임의 HTTP 엔드포인트로 이벤트 전송.
      (완료 — `@agentrelay/core/notify.ts`에 `createWebhookNotifier`/`webhookNotifierFromEnv`/
      `notifiersFromEnv` 추가. `AGENTRELAY_WEBHOOK_URL` 있으면 구조화된 `NotifyPayload`(+`text`)를
      JSON POST, `AGENTRELAY_WEBHOOK_AUTH`는 `Authorization` 헤더로. `formatBody` 훅으로 Discord
      `{content}` 등 서비스별 스키마 커스터마이즈 가능. `notifiersFromEnv`가 Slack+웹훅을 fan-out.
      CLI run/daemon/tick이 Slack 전용 대신 `notifiersFromEnv`를 쓰도록 배선. 전송 실패는 절대 throw
      안 함(릴레이 루프 보호). branch `claude/wizardly-pascal-vxi6k3`)
- [x] 👷 수동 job 제어(`agentrelay cancel <id>` / `agentrelay retry <id>`).
      (완료 — `@agentrelay/core/control.ts` 신설: `canCancel`/`canRequeue`(상태 가드) +
      `resolveJobId`(전체 UUID·짧은 prefix→유일 job 해소, 모호/미존재는 에러). `JobStatus`에
      종료 상태 `cancelled` 추가(summary·대시보드 STATUS_META 반영). `RelayQueue.markCancelled`
      (resetAt도 정리)·`requeueNow`(즉시 due + attempts 0 리셋 + lastError 클리어). CLI `cancel`은
      대기 중(queued/waiting_for_reset/resuming) job만 취소, `retry`는 resuming 외 모든 job을
      지금 재개 큐로. 짧은 id prefix 지원, 실패 시 exit 1. branch `claude/wizardly-pascal-sg1ont`)
- [ ] 🧭 경쟁 도구(claude-auto-retry 등) 심층 조사 → 차별화 포인트 문서화.
- [ ] 🧭 실제 rate-limit 메시지 샘플 수집 → 파서 패턴 보강 제안.
- [ ] 🧭 성능/효율화 분석(파일 I/O, 대량 job) → 최적화 항목 도출.

## 코워크가 발굴한 신규 항목 (수시 추가)

- (아직 없음)
