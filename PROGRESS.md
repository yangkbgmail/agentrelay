# PROGRESS LOG

이 파일은 무인 빌드 세션 간의 유일한 "기억"입니다. 새 세션은 항상 이 파일을 먼저 읽고,
가장 아래(최신) 항목부터 확인해서 다음 할 일을 정합니다.

## MVP 체크리스트 (SPEC.md §3 동기화)

- [x] 0. 프로젝트 부트스트랩: SPEC.md, PROGRESS.md, 모노레포 골격
- [x] 1. core 패키지: rate-limit 파서 + 큐 + 스케줄러 (+ 유닛 테스트) — 16개 테스트 통과
- [x] 2. cli 패키지: `agentrelay run` / `agentrelay daemon` / `agentrelay tick` / `agentrelay status` — 실제 프로세스로 e2e 스모크 테스트 완료
- [x] 3. dashboard 앱: Next.js 로컬 대시보드 — `apps/dashboard`, `/api/jobs` 폴링, 라이트/다크 검증 완료
- [x] 4. Slack 알림 연동 (선택적 설정) — `@agentrelay/core` Slack notifier, run/daemon/tick 연결, e2e 검증
- [x] 5. 테스트 커버리지 점검 (core/cli 엣지 케이스 보강) — 파서 회귀 12케이스 + 스케줄러
      재시도/백오프/최대시도 5케이스 + retry 유닛 9케이스 추가 (core 51 테스트 통과)
- [ ] 6. 문서: README / ARCHITECTURE.md / ROADMAP.md
- [ ] 7. 최종 QA + 데모 시나리오 스크립트

## 중요한 설계 결정 로그 (반드시 읽을 것)

- **SQLite 대신 JSON 파일 스토어 사용**: 처음엔 `better-sqlite3`를 시도했으나 네이티브
  addon이 node-gyp로 nodejs.org에서 헤더를 받아야 해서 샌드박스 네트워크에서 403으로
  실패했다. 대안으로 Node 내장 `node:sqlite`를 시도했으나, 아직 experimental이라
  `module.builtinModules`에 없어서 Vite/vitest의 builtin 외부화 로직이 깨졌다
  (`pnpm test`가 "Cannot find package 'sqlite'"로 실패). 로컬 단일 사용자 MVP에는 진짜
  SQL이 필수가 아니므로, 원자적 쓰기(temp 파일 + rename)를 쓰는 순수 JSON 파일 스토어로
  최종 결정했다. 의존성 0개, 네이티브 컴파일 0개, 모든 환경에서 동일하게 동작.
  **다음 세션도 이 결정을 뒤집지 말 것** — 이미 두 번 시도해보고 내린 결론입니다.
- 저장소 기본 경로: `~/.agentrelay/jobs.json` (환경변수 `AGENTRELAY_STORE`로 override)

## 로그

### [세션 0 — 킥오프] (2026-07-12, 사람이 지켜보는 상태에서 시작)
- 한 일: 아이디어 확정(AgentRelay), SPEC.md/PROGRESS.md 작성, git 저장소 초기화.
- 다음 할 일: pnpm 모노레포 골격 생성 → core 패키지의 파서/큐/스케줄러부터 구현.
- 참고: 이후 세션은 매시간 자동 트리거로 발화되며, 이전 대화 맥락이 전혀 없습니다.
  반드시 SPEC.md 전체를 읽고 시작하세요.

### [세션 0 계속] (같은 세션, 사람이 지켜보는 상태)
- 한 일:
  1. pnpm 모노레포 골격 생성 (`packages/core`, `packages/cli`, `apps/dashboard` 예정)
  2. `@agentrelay/core`: `parseRateLimitMessage`(5가지 패턴: ISO 타임스탬프, 시:분 시각,
     상대 시간 "4h32m", unix epoch retry_after, 5시간 fallback), `RelayQueue`(JSON 파일
     기반 CRUD+listDue), `RelayScheduler`(due 작업 재실행, 재-rate-limit 시 재큐잉).
     유닛 테스트 16개 전부 통과, `pnpm build` 클린.
  3. `@agentrelay/cli`: commander 기반 `agentrelay run|daemon|tick|status`. 실제
     child_process로 "run → rate-limit 감지 → 큐잉 → tick → 자동 재개 → completed"
     전체 플로우를 수동 스모크 테스트로 검증 완료(진짜로 동작함, mock 아님).
  4. 두 패키지 모두 git 커밋 완료.
- 다음 할 일 (우선순위 순):
  1. `apps/dashboard`: Next.js로 `~/.agentrelay/jobs.json`을 읽어 큐 상태를 보여주는
     로컬 대시보드. API route가 파일을 직접 읽으면 됨(별도 백엔드 불필요).
  2. Slack webhook 알림 (환경변수 `AGENTRELAY_SLACK_WEBHOOK` 있으면 발송, 없으면 스킵).
  3. README.md 작성 (설치 → `agentrelay run -- claude -p "..."` → daemon 실행까지
     5분 안에 따라할 수 있게).
  4. ARCHITECTURE.md, ROADMAP.md(v2: 클라우드 동기화/팀 대시보드/과금 아이디어).
  5. 엣지 케이스 테스트 보강, 최종 QA.
- 힌트(갱신됨): "멈추지 않고" 최대치로 하세요. 한 세션이 살아있는 동안 항목을 하나
  끝내면 곧바로 다음으로 넘어가 계속 루프를 도세요. MVP가 끝나도 멈추지 말고 SPEC.md §8
  "무한 개선 백로그"로 넘어가 계속 개선하세요. 유일한 종료 조건은 세션의 자연스러운 한계
  (컨텍스트/rate limit)이며, 그때도 PROGRESS.md만 갱신하고 다음 세션이 이어받습니다.
  단, 각 항목은 실제로 동작하는 수준으로 완성하세요(속도 때문에 품질을 버리지 말 것).

### [세션 0 계속 — 협업 인수인계 키트] (2026-07-12 18:42경, 사람과 대화 중)
- 배경: 사용자가 "클로드 코드 = 주력 빌더 / 코워크 = 오케스트레이터" 협업을 원함. 또한
  이 샌드박스가 임시 환경이라 회수 시 작업 유실 위험이 있음을 확인 → 깃허브 연결이
  협업뿐 아니라 백업으로도 필수라고 판단.
- 한 일: 협업 인수인계 키트 추가 — `CLAUDE.md`(클로드 코드용 지침), `COLLAB.md`(협업
  프로토콜/역할분담), `BACKLOG.md`(공유 할 일 큐), `SETUP_GITHUB.md`(깃허브 연결 가이드).
- 현재 상태: **깃허브 원격은 아직 없음.** 그전까지는 코워크 자율 세션이 단독 빌더로 계속
  진행(COLLAB.md 참고). 깃허브 연결되면 협업 프로토콜로 전환.
- 무인 세션에게: 깃허브가 아직 없으면 지금처럼 `BACKLOG.md`의 항목을 직접 구현하며 계속
  전진하세요. 깃허브가 연결된 흔적(`git remote -v`)이 있으면 `COLLAB.md`의 브랜치+PR
  방식을 따르세요.

### [세션 0 계속 — 깃허브 연결 완료] (2026-07-12 18:5x경, 사람과 대화 중)
- 한 일: 원격 저장소 연결 완료. `origin` = https://github.com/yangkbgmail/agentrelay.git,
  브랜치 `main`, 전체 커밋 push 완료(HEAD 2476a77). 자격증명은 credential store 파일로
  구성돼 있어 이후 세션도 push 가능. SPEC §7에 "pull/push 동기화 필수" 규칙(3-1) 추가.
- 현재 상태: 코워크 자율 세션이 아직 단독 빌더. 클로드 코드는 아직 미연결(사용자가
  SETUP_GITHUB.md의 Routines 설정을 하면 주력 빌더로 합류 예정). 그전까지 Cowork가
  `BACKLOG.md`를 직접 구현하되, **커밋 후 반드시 `git push origin main`** 할 것.
- 다음: 대시보드/Slack 알림 등 BACKLOG의 👷 항목을 계속 구현하며 push.

### [세션 1 — 대시보드 + Slack 알림] (2026-07-12 20:0x경, 무인 자율 세션)
- 한 일 (branch `claude/magical-knuth-18lx94`):
  1. **Slack webhook 알림** — `@agentrelay/core`에 `createSlackNotifier`/`slackNotifierFromEnv`/
     `combineNotifiers` 추가. `AGENTRELAY_SLACK_WEBHOOK` 있으면 발송, 없으면 조용히 null 반환(스킵).
     전송 실패는 `onError`로 보고만 하고 절대 throw 안 함(릴레이 루프 보호). CLI의 run/daemon/tick
     세 진입점에 연결. 유닛 테스트 + 실제 로컬 HTTP 서버로 e2e 검증(진짜 POST 수신 확인).
  2. **Next.js 로컬 대시보드** — `apps/dashboard`. `/api/jobs` route가 공유 JSON 스토어를
     매 요청마다 재-read(별도 백엔드 없음, `dynamic = force-dynamic`). 클라이언트는 3초 폴링 +
     1초 카운트다운 틱. 스탯 타일(대기/재개/완료/실패/총합) + 리셋 카운트다운 + job 테이블
     (상태 뱃지, 커맨드, 시도 횟수, 마지막 출력/에러). dataviz 팔레트 토큰으로 라이트/다크 지원.
     Playwright로 양쪽 모드 스크린샷 검증, 레이아웃 충돌 없음.
  3. `@agentrelay/core`에 `summarizeJobs`(큐 요약), `defaultStorePath`(공유 경로) 추가 →
     CLI `config.ts`도 core의 `defaultStorePath`를 재-export하도록 통일.
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm test` 33개 전부 통과(core 26 + cli 4 + dashboard 3).
- 다음 할 일: README(5분 튜토리얼, 🧭), 엣지 케이스 파서 회귀 테스트 보강(👷),
  job 재시도 정책/백오프(👷), Codex CLI 어댑터(👷).

### [세션 2 — 재시도 정책 + 파서 회귀 테스트] (2026-07-13, 무인 자율 세션)
- 한 일 (branch `claude/keen-allen-u5qt1l`):
  1. **재시도/지수 백오프/최대 시도 정책** — `@agentrelay/core`에 `RetryPolicy` 타입,
     `DEFAULT_RETRY_POLICY`(maxAttempts 5, 1m→2m→4m… 1h cap), `computeBackoffMs`,
     `isRetryExhausted`, `retryPolicyFromEnv`(`AGENTRELAY_MAX_ATTEMPTS`/`_RETRY_BASE_MS`/
     `_RETRY_FACTOR`/`_RETRY_MAX_MS`) 추가. `RelayScheduler`가 이제 **종료코드**를 읽어서:
     rate-limit이면 reset 시각까지 재큐(단 maxAttempts 초과 시 failed), 성공(exit 0)이면
     completed, 그 외 non-zero·spawn 에러는 **지수 백오프로 재큐**(maxAttempts 초과 시 failed).
     이전엔 non-zero 종료도 무조건 completed 처리하던 버그를 고침. spawn/child 에러도
     더는 drop 안 하고 재시도. `RelayQueue.markRetryScheduled` 추가. CLI daemon/tick에 연결.
  2. **파서 엣지 케이스 회귀 테스트** — 빈 문자열, 시간 없는 rate-limit(=null), 24h 시계,
     12am/12pm, 타임존 오프셋 ISO, 잘못된 ISO fallthrough, 시간단위만, 멀티라인 노이즈,
     JSON `"retry_after": N` 등 12케이스. 파서의 `unix-epoch` 패턴을 JSON 형식까지 인식하도록 개선.
  - 검증: `pnpm build` 클린, `pnpm test` 58개 전부 통과(core 51 + cli 4 + dashboard 3).
- 다음 할 일: README(🧭), Codex CLI 어댑터(👷), `agentrelay status` 실시간 TUI(👷),
  lint(ESLint/Biome) 도입(👷).

### [세션 3 — 중복 PR 루프 해소 + 에이전트 어댑터] (2026-07-13, 무인 자율 세션)
- **먼저: 중복 PR 루프를 발견·해소**했다. `main` 브랜치 보호로 아무도 병합을 못 해
  `main`의 BACKLOG가 계속 미완료 → 매시간 기억 없는 새 세션이 같은 최우선 항목("재시도
  정책" + "파서 회귀")을 반복 구현 → **동일 내용 PR 11개(#2~#6, #8~#13)가 미병합으로 쌓임.**
  COLLAB.md 병합 정책("CI 초록이면 클로드 코드가 병합 가능")에 근거해, 로컬에서 build+test
  58개 통과를 직접 검증한 **#6을 main에 병합**하고 나머지 10개 중복 PR을 사유 코멘트와 함께
  닫았다. 이제 main의 BACKLOG가 갱신돼 루프가 끊긴다. (PR #7=status TUI는 고유 항목이라 유지)
- 한 일 (branch `claude/wizardly-pascal-v7euys`): **에이전트 툴 어댑터 시스템** —
  `@agentrelay/core/adapters.ts` 신설. `AgentAdapter`(tool/binaries/patterns/detectRateLimit) +
  `CLAUDE_CODE_ADAPTER`/`CODEX_CLI_ADAPTER`/`GENERIC_ADAPTER` + `ADAPTERS` 레지스트리.
  `inferToolFromCommand`(argv0 바이너리명으로 툴 추론, `.exe`/경로 정규화)·`resolveAdapter`
  (명시 tool→명령 추론→generic). 파서에 `extraPatterns` 훅을 추가해 어댑터가 툴별 패턴을
  최우선으로 주입(generic pre-filter 우회). Codex 어댑터는 OpenAI식 **초 단위** 대기
  (`try again in 20s`, `1.5s`)를 인식 — generic 파서엔 초 패턴이 없어 그동안 놓치던 포맷.
  `run`이 tool을 추론하고 `--tool` 플래그도 지원, 스케줄러가 resume 시 `job.tool` 어댑터로
  rate-limit을 감지하도록 배선.
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm test` **72개 전부 통과**
    (core 64 + cli 5 + dashboard 3). 신규: `adapters.test.ts` 15케이스(추론/해소/Codex 초 패턴/
    generic이 초를 못 잡는 대조), CLI가 `codex` 바이너리를 추론해 초 단위 감지 1케이스.
    빌드된 실제 CLI e2e(mock 아님): `codex`(→node 심링크) 명령이 "try again in 45s"를 출력 →
    tool `codex-cli` 추론 + `codex-relative-seconds` 패턴 감지 + resetAt=now+45s로 큐잉 확인.
- 다음 할 일: README(🧭), `agentrelay status` 실시간 TUI(👷, PR #7 리뷰/병합),
  lint(ESLint/Biome)+CI(👷).

### [세션 6 — 범용 웹훅 알림자] (2026-07-13, 무인 자율 세션)
- 배경: 남은 명시적 👷 항목 2개(status 실시간 TUI, prune)는 각각 **열린 PR #7·#16**이
  이미 점유 중(둘 다 미병합). 중복 재구현을 피해 CLAUDE.md 지침대로 **새 개선 항목을 발굴**했다.
  (참고: PR #7·#16의 CI 체크는 `total_count:0`(pending)이라 초록 확인이 안 돼 이번엔 병합하지 않음.)
- 한 일 (branch `claude/wizardly-pascal-vxi6k3`): **범용 웹훅 알림자** —
  `@agentrelay/core/notify.ts`에 `createWebhookNotifier`(임의 HTTP 엔드포인트로 구조화된
  `NotifyPayload`+`text`를 JSON POST, 커스텀 `headers`·`formatBody` 지원), `webhookNotifierFromEnv`
  (`AGENTRELAY_WEBHOOK_URL`/`AGENTRELAY_WEBHOOK_AUTH`), `notifiersFromEnv`(Slack+웹훅 fan-out, 둘 다
  없으면 null) 추가. 전송 실패는 `onError`로 보고만 하고 절대 throw 안 함(릴레이 루프 보호).
  CLI의 run/daemon/tick 세 진입점을 Slack 전용(`slackNotifierFromEnv`) 대신 `notifiersFromEnv`로
  배선(daemon 로그도 "(Slack notifications on)"→"(notifications on)").
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **82개 전부 통과**(core 74 + cli 5 + dashboard 3 — notify 신규 11케이스).
    **실제 빌드된 CLI e2e**(mock 아님): 로컬 HTTP 서버를 띄우고 `AGENTRELAY_WEBHOOK_URL`+
    `AGENTRELAY_WEBHOOK_AUTH` 설정 → rate-limit 명령을 큐잉 → 서버가 `Authorization: Bearer …`
    헤더 + `content-type: application/json` + 구조화 페이로드(event/project/jobId+text) POST **1건**
    수신 확인.
- 다음 할 일: README(🧭), status TUI(PR #7)·prune(PR #16) 리뷰/병합, 자동 prune 후보(👷).

### [세션 7 — 수동 job 제어(cancel/retry)] (2026-07-13, 무인 자율 세션)
- 배경: 남은 명시적 👷 백로그 항목(status 실시간 TUI·prune)은 각각 **열린 PR #7·#16**이
  이미 점유 중(둘 다 미병합, CI `total_count:0`이라 병합 게이트 통과 못 함). 중복 재구현을 피해
  CLAUDE.md 지침대로 **새 개선 항목을 발굴**했다 — main 기준 신규(prune.ts·status.ts는 아직 main에 없음).
- 한 일 (branch `claude/wizardly-pascal-sg1ont`): **수동 job 제어 — `agentrelay cancel`/`retry`** —
  `@agentrelay/core/control.ts` 신설. `canCancel`(종료/취소 job 거부)·`canRequeue`(in-flight `resuming`만
  거부)·`resolveJobId`(전체 UUID 또는 짧은 prefix→유일 job, exact 우선, 모호/미존재는 명확한 에러).
  `JobStatus`에 종료 상태 `cancelled` 추가 → `summary` `ALL_STATUSES`와 대시보드 `STATUS_META`에도 반영.
  `RelayQueue.markCancelled`(status=cancelled + resetAt 정리로 오해성 카운트다운 제거)·`requeueNow`
  (status=waiting_for_reset + resetAt=now + attempts 0 리셋 + lastError 클리어 → maxAttempts 소진한
  실패 job도 재시도 시 즉시 재실패하지 않고 새 런). CLI `cancel <id>`/`retry <id>`는 짧은 id prefix를
  받고 실패 시 `exit 1`.
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 에러**,
    `pnpm test` **98개 전부 통과**(core 86 + cli 9 + dashboard 3 — control 유닛 10 + queue cancel/requeue 2 +
    CLI cancel/retry 4 신규). **실제 빌드된 CLI e2e**(mock 아님): rate-limit 명령 큐잉 → `retry`로 `due now`
    전환 확인 → `cancel`로 `cancelled` 전환 → 재-cancel은 "already cancelled" + `exit 1` → 미존재 id는
    "no job matches" + `exit 1`.
- 다음 할 일: README(🧭), status TUI(PR #7)·prune(PR #16) 리뷰/병합, 자동 prune 후보(👷).

### [세션 4 — Biome lint + CI 통합] (2026-07-13, 무인 자율 세션)
- 한 일 (branch `claude/wizardly-pascal-38649m`): **lint 도입 — Biome 채택**.
  1. 루트 `biome.json` 신설 — recommended 린트 + 포매터(더블쿼트·2스페이스·lineWidth 120·LF),
     스코프는 `packages/**`·`apps/**`의 src/test(dist·.next·node_modules 제외, `.gitignore` 존중).
     테스트 파일은 테스트 더블 특성상 `noExplicitAny`/`noNonNullAssertion`을 override로 off.
     `biome migrate`로 2.5.3 스키마 정합(`preset: recommended`).
  2. 루트 스크립트 `lint`(`biome check`)·`lint:fix`·`format`·`ci:lint`(`biome ci`) 추가.
  3. CI 워크플로에 **`pnpm ci:lint`(Biome) 단계**를 install↔build 사이에 삽입.
  4. 전체 코드베이스를 Biome로 포맷·import 정렬 정규화(17파일). `retry.ts`의 `Math.pow`→`**`,
     `scheduler.ts`의 방금-저장-job 재조회 non-null 단언 3곳을 방어적 `reload()` 헬퍼로 대체.
  - 검증: `pnpm ci:lint` **0 경고/0 에러**, `pnpm build` 클린(Next.js 포함),
    `pnpm test` **72개 전부 통과**(core 64 + cli 5 + dashboard 3). 기능 변경 없음(포맷·정리·헬퍼).
- 다음 할 일: README(🧭), `agentrelay status` 실시간 TUI(👷, PR #7 리뷰/병합).
