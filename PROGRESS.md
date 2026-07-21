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

### [세션 5 — job 보존/정리(prune) 기능] (2026-07-13, 무인 자율 세션)
- 배경: 최우선 미완 👷 항목("status 실시간 TUI")은 이미 **PR #7**이 구현 중(열림·미병합)이라
  중복 재구현을 피하고, `jobs.json`이 완료/실패 job으로 무한 증가하는 문제를 해결하는 신규
  개선 항목을 발굴해 진행.
- 한 일 (branch `claude/wizardly-pascal-94df3w`): **job 보존/정리(prune)**.
  1. `@agentrelay/core/prune.ts` 신설 — 순수 `selectPrunableJobs(jobs, options)`가 상태
     (기본 종료 상태 completed/failed) · 나이(`olderThanMs`, `updatedAt` 기준) · `keepLast`
     (최근 N개 보존) 규칙으로 삭제/보존을 분리. 활성 job(queued/waiting_for_reset/resuming)은
     기본적으로 절대 삭제 안 함. `parseDuration`(`7d`/`24h`/`30m`/`90s`/`500ms`→ms, 잘못된
     입력은 null) 추가.
  2. `RelayQueue.prune(options)` — 위 선택 결과대로 삭제 후 원자적 flush, 삭제된 job 반환.
     `dryRun: true`면 파일을 건드리지 않고 선택만 계산.
  3. CLI `agentrelay prune --older-than <기간> --status <목록> --keep <n> --dry-run` 추가.
     잘못된 duration/status/keep 입력은 명확한 에러 + exit 1. `pruneJobs` 헬퍼가 dry-run에서도
     "정리 후 남을 개수"를 일관되게 보고.
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) 0경고,
    `pnpm test` **84개 전부 통과**(core 74 + cli 7 + dashboard 3 — prune 10 + CLI prune 2 신규).
    빌드된 실제 CLI e2e(mock 아님): 3개 job(완료/실패/대기) 시드 → `prune --dry-run`이 종료
    상태 2개만 표시하고 스토어 미변경 → `prune --keep 1`이 최신 종료 job 1개만 남기고 삭제,
    활성 job 보존 확인. 잘못된 duration은 exit 1.
- 다음 할 일: README(🧭), `agentrelay status` 실시간 TUI(👷, PR #7 리뷰/병합),
  자동 prune(스케줄러/데몬이 주기적으로 오래된 job 정리)도 후보.

### [세션 8 — 쌓인 PR 통합(#18·#16·#7 병합) + status TUI] (2026-07-13, 무인 자율 세션)
- 배경: 세션 시작 시 CI 초록인 열린 PR 3개(#18 cancel/retry, #16 prune, #7 status TUI)가
  서로 다른 기능인데도 모두 미병합으로 쌓여 있었다. main 브랜치 보호로 병합이 밀리면
  매시간 무기억 세션이 같은 항목을 반복 구현하는 **중복 루프**가 재발할 위험 → COLLAB.md
  병합 정책("CI 초록이면 클로드 코드가 병합 가능")에 따라 **셋 다 main에 통합**했다.
- 한 일:
  1. **#18(수동 job 제어 cancel/retry)** — base가 최신 main이라 그대로 병합.
  2. **#16(prune)** — #18 이후 충돌 → `claude/wizardly-pascal-94df3w`를 최신 main 위로
     리베이스(cli.ts/commands.ts/test 충돌 수동 해소: cancel/retry·prune 명령을 공존시키고
     `ALL_JOB_STATUSES`에 `cancelled` 포함), build+test 통과 확인 후 force-push → 병합.
  3. **#7(status 실시간 TUI --watch/--json)** — `claude/wizardly-pascal-mnrfk8`를 최신 main
     위로 리베이스. `status.ts`의 `Record<JobStatus, …>`(STATUS_COLOR)·`ALL_STATUSES`와
     테스트의 `emptyCounts`에 `cancelled` 상태를 추가해 #18의 신규 상태와 타입 정합.
     BACKLOG/PROGRESS 충돌은 최신(HEAD) 문서를 유지.
  - 검증: 각 통합 후 `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) 0경고,
    `pnpm test` 전부 통과. 최종 main에는 cancel/retry·prune·status TUI가 모두 들어감.
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), 자동 prune(스케줄러 주기 정리, 👷),
  status TUI에 필터/정렬 옵션 등 개선(👷).

### [세션 8 계속 — 자동 prune(daemon 주기 정리)] (2026-07-13, 무인 자율 세션)
- 배경: #16 병합으로 수동 `agentrelay prune`이 main에 들어온 뒤, 별도 cron 없이 데몬이
  스스로 스토어를 정리하도록 하는 **자동 prune**을 신규 👷 항목으로 발굴·구현했다.
- 한 일 (branch `claude/wizardly-pascal-09q0tw`):
  1. `@agentrelay/core/prune.ts`에 `autoPruneOptionsFromEnv(env)` — `AGENTRELAY_AUTOPRUNE`
     opt-in 플래그(1/true/yes/on)가 켜졌을 때만 활성. `AGENTRELAY_AUTOPRUNE_AFTER`(나이
     임계값, 기본 `7d`=`DEFAULT_AUTOPRUNE_AFTER_MS`, `0s`=나이 무시하고 종료 job 전부),
     `AGENTRELAY_AUTOPRUNE_KEEP`(최근 N개 보존). 미설정·falsy·AFTER만 준 경우는 `null`(off).
     불명확한 AFTER는 기본값으로 폴백(opt-in은 유지).
  2. `RelayScheduler`에 `autoPrune?: PruneOptions | null`·`onPrune?` 옵션 추가 → 매 `tick()`
     종료 후 `runAutoPrune`가 종료 상태(completed/failed) job만 정리하고 활성 job은 불변.
     정리 실패는 삼켜 릴레이 루프를 절대 깨지 않음. tick의 referenceTime을 나이 컷오프의
     `now`로 재사용해 결정적.
  3. CLI `daemon`/`tick`이 `autoPruneOptionsFromEnv()`를 배선, 데몬 배너에 "(auto-prune on)",
     정리 시 `[agentrelay] auto-pruned N finished job(s)` 로그.
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) 0경고,
    `pnpm test` **131개 전부 통과**(core 105 + cli 23 + dashboard 3 — env 6 + scheduler 3 신규).
    **실제 빌드된 CLI e2e**(mock 아님): 완료/실패/대기 3개 job 시드 → autoprune off인 `tick`은
    3개 유지 → `AGENTRELAY_AUTOPRUNE=1 AGENTRELAY_AUTOPRUNE_AFTER=0s tick`이 종료 job 2개만
    정리하고 활성 job 보존(status 1행) → 데몬 배너 "(auto-prune on)" 출력 확인.
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), status TUI 필터/정렬 옵션(👷),
  자동 prune 주기를 tick마다가 아닌 N tick·시간 간격으로 스로틀하는 옵션(👷 후보).


### [세션 9 — status 필터/정렬 옵션] (2026-07-13, 무인 자율 세션)
- 배경: 세션 8 말미에 "다음 할 일"로 남긴 👷 항목(status TUI 필터/정렬)을 구현했다.
  큐가 커지면 `agentrelay status`가 전체를 최신순으로만 보여줘 원하는 job을 찾기 어려웠다.
- 한 일 (branch `claude/wizardly-pascal-v1gjni`):
  1. `packages/cli/src/status.ts`에 순수 함수 `selectJobs(jobs, selection)` 신설.
     `selection = { statuses?, sort?, reverse? }`. 상태 필터는 Set 기반, 정렬은 6개 필드
     (`created`/`updated`/`reset`/`project`/`status`/`attempts`)를 안정 정렬(원본 인덱스
     tiebreak)로 처리. `reset`은 null resetAt을 뒤로 보내고, `status`는 lifecycle 순서
     (queued→…→cancelled)로 정렬. 입력을 절대 변형하지 않고 항상 새 배열 반환.
     `SORT_FIELDS`/`SortField`/`JobSelection`/`NO_MATCH_MESSAGE` export.
  2. CLI `status`에 `-s,--status <statuses>`·`--sort <field>`·`-r,--reverse` 추가.
     일회성 테이블·`--json`·`--watch(runWatch)` 세 뷰 모두 동일 `selection`을 적용.
     잘못된 status/sort 값은 stderr 안내 후 exit 1. 필터가 스토어 전체를 걸러내면
     온보딩 문구가 아니라 `NO_MATCH_MESSAGE`("No jobs match the current filter.")를 출력.
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) 0경고,
    `pnpm test` **141개 전부 통과**(status.test.ts에 selectJobs 10케이스 신규 → cli 33).
    **빌드된 CLI e2e**(mock 아님): completed/waiting/failed 3-job 스토어 시드 →
    default 최신순, `--status failed,completed` 2행, `--sort attempts` 1·3·5,
    `--sort attempts --reverse` 5·3·1, `--sort project` api·cli·web,
    `--status queued`는 NO_MATCH 문구, `--json --status failed`는 cli 1건(total 1) 확인.
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), 자동 prune 주기 스로틀 옵션(👷 후보),
  status 정렬 필드별 기본 방향(시간 필드는 최신 우선 등) 튜닝 검토(👷 후보).

### [세션 10 — 자동 prune 스로틀 옵션 + 누적 PR #20 병합] (2026-07-13, 무인 자율 세션)
- **먼저: CI 병합 게이트 오판을 바로잡았다.** 이전 세션들이 `pull_request_read(get_status)`가
  `total_count:0`을 반환하는 걸 "CI 미확인"으로 읽어 초록 PR을 못 병합하고 쌓아 왔는데,
  이는 레거시 commit-status API라 GitHub **Actions check-run**을 못 잡은 것뿐이었다.
  `actions_list(list_workflow_runs)`로 확인하니 CI는 정상 동작·성공하고 있었다. COLLAB 병합
  정책(CI 초록이면 클로드 코드 병합 가능)에 따라 초록·`mergeable_state:clean`인 **PR #20
  (status 필터/정렬)을 main에 병합**해 중복 PR 누적 루프를 끊었다.
- 배경: 남은 👷 후보였던 **자동 prune 스로틀**을 신규 구현했다. 기존 자동 prune은 매 tick
  스토어를 재기록해, 몇 초마다 폴링하는 데몬에서 불필요한 파일 쓰기가 잦았다.
- 한 일 (branch `claude/wizardly-pascal-ikh508`):
  1. `@agentrelay/core/prune.ts`에 순수 `shouldAutoPrune(lastRunMs, nowMs, everyMs?)` 추가 —
     스로틀 없음(`everyMs` 미설정/≤0)이면 항상 실행, 첫 패스(`lastRunMs===null`)도 항상 실행
     (데몬 시작 시 한 주기 지연 없음), 그 외에는 `everyMs` 경과 후에만 실행. `autoPruneEveryMsFromEnv`
     (`AGENTRELAY_AUTOPRUNE_EVERY` 기간 파싱; 미설정·파싱불가·비양수는 `null`=스로틀 없음 →
     오타가 정리를 조용히 끄지 않고 매 tick으로 폴백) 추가.
  2. `RelayScheduler`에 `autoPruneEveryMs` 옵션 + 인메모리 `lastPruneAtMs` 마커. `runAutoPrune`가
     `shouldAutoPrune`로 게이트하고, 패스가 **실제 실행될 때만** 마커를 전진(정리 결과 무관).
     tick의 `referenceTime`을 `now`로 재사용해 결정적.
  3. CLI `daemon`이 `autoPruneEveryMsFromEnv()`를 배선, 배너에 "(auto-prune on, every Ns)".
     one-shot `tick`은 프로세스마다 마커가 없어 스로틀 무효(코드 주석·BACKLOG에 명시).
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) 0경고,
    `pnpm test` **138개 전부 통과**(core 112 + cli 23 + dashboard 3 — prune env/predicate 7 +
    scheduler throttle 1 신규). **실제 빌드된 CLI e2e**(mock 아님): 데몬 배너가
    `AGENTRELAY_AUTOPRUNE_EVERY=1h`일 때 "(auto-prune on, every 3600s)", 미설정 시 "(auto-prune on)"
    출력 확인. 스로틀 억제 자체는 결정적 스케줄러 유닛 테스트(윈도우 내 tick은 정리 스킵, 경과 후 정리)로 검증.
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), auto-prune 스로틀을 시간뿐 아니라 tick-count
  기준으로도 지정하는 옵션(👷 후보). 앞으로 CI 초록 판정은 `get_status`가 아니라
  `actions_list`로 확인할 것(위 오판 재발 방지).

### [세션 11 — 자동 prune tick-count 스로틀] (2026-07-13, 무인 자율 세션)
- 배경: 세션 시작 시 열린 PR 0개(누적/중복 없음), main=현재 브랜치 동일. 세션 10이 "다음 할 일"로
  남긴 👷 후보(auto-prune 스로틀을 tick-count 기준으로도 지정)를 신규 구현했다. 기존 스로틀은
  wall-clock 시간(`AGENTRELAY_AUTOPRUNE_EVERY`)만 지원했는데, 데몬 poll 주기 자체를 기준으로
  생각하는 경우("100 polls마다 정리")를 위해 tick 횟수 축을 추가.
- 한 일 (branch `claude/wizardly-pascal-adfx5s`):
  1. `@agentrelay/core/prune.ts`에 순수 `shouldAutoPruneByTicks(tickIndex, everyTicks?)` — 스로틀
     없음(`everyTicks` 미설정/≤0)이면 항상 실행, 그 외 `tickIndex % everyTicks === 0`(0-based 카운터
     기준 첫 tick[index 0]과 이후 매 N tick 실행 → 시간 스로틀의 "첫 패스 항상 실행"과 대칭).
     `autoPruneEveryTicksFromEnv`(`AGENTRELAY_AUTOPRUNE_EVERY_TICKS` 양의 정수; 미설정·비숫자·비양수는
     `null`=스로틀 없음 → 오타가 정리를 조용히 끄지 않고 매 tick 폴백, 소수는 floor) 추가.
  2. `RelayScheduler`에 `autoPruneEveryTicks` 옵션 + 인메모리 `pruneTickCounter`(매 tick 전진).
     `runAutoPrune`가 tick 게이트(`shouldAutoPruneByTicks`)와 시간 게이트(`shouldAutoPrune`)를
     **AND**로 결합 — 둘 다 설정 시 양쪽이 모두 허용할 때만 정리. tick 카운터는 매 tick 전진(스로틀
     cadence 유지), 시간 마커는 패스가 실제 실행될 때만 전진.
  3. CLI `daemon`이 `autoPruneEveryTicksFromEnv()`를 배선. 배너 문구를 `autoPruneBanner` 헬퍼로
     리팩터해 시간·tick 스로틀을 각각/함께 표기("every Ns", "every N tick(s)", 둘 다면 " + "로 결합).
     one-shot `tick`은 프로세스마다 카운터가 리셋돼 스로틀 무효(코드 주석·BACKLOG에 명시).
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **157개 전부 통과**(core 121 + cli 33 + dashboard 3 — prune env/predicate 9 +
    scheduler tick/AND 스로틀 2 신규). **실제 빌드된 CLI e2e**(mock 아님): 데몬 배너가 both →
    "every 3600s + every 100 tick(s)", ticks-only → "every 50 tick(s)", time-only → "every 1800s",
    무-스로틀 → "(auto-prune on)", 오타(`_EVERY_TICKS=abc`) → 매 tick 폴백("(auto-prune on)") 확인.
    스로틀 억제 자체는 결정적 스케줄러 유닛 테스트(tick 창 안은 스킵, 경과 후 정리; 시간+tick AND
    양쪽 게이트 독립 차단)로 검증.
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), auto-prune 스로틀 tick+time을 OR로도 선택 가능한
  모드(👷 후보), status TUI 정렬 필드별 기본 방향 튜닝(👷 후보).

### [세션 12 — `agentrelay stats` 큐 통계 요약] (2026-07-13, 무인 자율 세션)
- 배경: 세션 시작 시 열린 PR 0개, main=현재 브랜치 동일(중복/누적 없음). 남은 👷 후보는
  소소한 튜닝뿐이라 CLAUDE.md 지침대로 **새 개선 항목을 발굴**했다 — 사용자가 릴레이 효과
  (얼마나 재개됐고 성공률/재시도/툴·프로젝트 분포가 어떤지)를 한눈에 보는 통계 커맨드가 없었다.
- 한 일 (branch `claude/wizardly-pascal-iiom6v`):
  1. `@agentrelay/core/stats.ts` 신설 — 순수 `computeStats(jobs)` + `RelayStats`. active
     (queued+waiting_for_reset+resuming)/terminal(completed+failed+cancelled) 분리, `successRate`
     (completed/(completed+failed) — cancelled는 사용자 취소라 제외, 미해결 시 `null`로 오해성 0%
     방지), `totalAttempts`·`retriedJobs`(attempts>1=실제 릴레이됨), `byTool`(고정 툴셋 zero-fill,
     미지 툴은 total만 세고 키는 안 만듦), `projects`(count desc·이름 asc 랭킹). `byStatus`·
     `nextResetAt`은 `summarizeJobs` 재사용해 status/dashboard와 드리프트 방지. index.ts export.
  2. CLI `packages/cli/src/stats.ts` 신설 — 순수 `renderStats`(사람용 다중행 블록, color 게이트)·
     `renderStatsJson`(--json, {storePath,generatedAt,stats})·`formatSuccessRate`. `agentrelay stats
     [--json]` 커맨드를 cli.ts에 배선(빈 스토어는 온보딩 문구).
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **172개 전부 통과**(core 130 + cli 39 + dashboard 3 — stats.test 9 + CLI stats 6 신규).
    **실제 빌드된 CLI e2e**(mock 아님): completed/failed/waiting/cancelled 4-job 스토어 시드 →
    `stats`가 "4 job(s) tracked / active:1 terminal:3 / success rate 50% (1/2) / total attempts 9
    retried 2 / by tool·status·top projects(api·web 동률→이름순)" 렌더, `--json`은 successRate 0.5·
    totalAttempts 9·byTool·projects 랭킹까지 정확히 출력 확인.
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), status TUI 정렬 기본 방향 튜닝(👷 후보),
  auto-prune 스로틀 OR 모드(👷 후보), stats에 평균 대기시간/시간대별 추이 등 확장(👷 후보).

### [세션 13 — 설정 파일 지원(`agentrelay.config.json`)] (2026-07-13, 무인 자율 세션)
- 배경: 세션 시작 시 열린 PR 0개, main=현재 브랜치 동일(중복/누적 없음). 남은 👷 후보는
  소소한 튜닝뿐이라 CLAUDE.md 지침대로 **새 개선 항목을 발굴**했다 — 지금까지 store 경로·
  알림·재시도·auto-prune이 전부 `AGENTRELAY_*` env var로만 설정 가능해 매 쉘마다 다시
  export해야 했다. SPEC §8 "DX 개선(설정 파일 지원)" 항목.
- 한 일 (branch `claude/wizardly-pascal-ohoon1`): **설정 파일 지원**.
  1. `@agentrelay/core/config.ts` 신설 — `AgentRelayConfig`(store / notify{slackWebhook,webhookUrl,
     webhookAuth} / retry{maxAttempts,baseDelayMs,factor,maxDelayMs} / autoPrune{enabled,after,keep,
     every,everyTicks} — 전부 optional 그룹). 순수 `configToEnv(config)`가 각 필드를 기존
     `AGENTRELAY_*` env var로 **1:1 투영**(유일 매핑 지점; enabled→"1"/"0", maxAttempts:0 같은
     falsy 유효값도 유지). `parseConfig(value, source)`는 구조 검증 — 비객체 root·필드 타입 오류는
     경로 표기 에러(`cfg.retry.maxAttempts must be a finite number`)로 throw, 미지 키는 무시(전방호환).
     `resolveConfigPath`(명시 path/`AGENTRELAY_CONFIG`→`<cwd>/agentrelay.config.json`→
     `~/.agentrelay/config.json`, HOME은 env override 존중해 테스트 결정적), `loadConfigFile`(없으면
     null, 명시했는데 없거나 JSON 깨지면 명확 에러). `applyConfigToEnv`는 **이미 설정된 env는 절대
     안 덮음** → 우선순위 **env/CLI > 설정파일 > 기본값**.
  2. CLI 배선 — `packages/cli/src/config.ts`에 `configPathFromArgv`(commander 파싱 전 `--config`
     선-스캔)·`bootstrapConfig`. `bin.ts`가 buildCli **전에** `bootstrapConfig()`로 설정을
     process.env에 채워, 기존 `*FromEnv` 헬퍼들이 그대로 설정값을 픽업(코드 변경 최소). cli.ts
     프로그램에 `--config <path>` 옵션 문서화. 잘못된 설정은 bin.ts에서 exit 1.
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **185개 전부 통과**(core 143 + cli 39 + dashboard 3 — config.test 13 신규).
    **실제 빌드된 CLI e2e**(mock 아님): cwd에 `agentrelay.config.json`(store→시드 스토어+
    autoPrune.enabled+every:1h) 두고 → `status --json`이 config의 store를 읽어 시드 job 1건 표시 →
    `--store`/`AGENTRELAY_STORE` 명시 시 config store를 이김(env 우선순위 확인) → daemon 배너가
    config의 auto-prune을 "(auto-prune on, every 3600s)"로 반영 → 깨진 `--config` JSON은 "Invalid
    JSON in AgentRelay config …" + exit 1.
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), 대시보드가 설정 파일도 읽게 확장(👷 후보),
  `agentrelay config init`으로 샘플 설정 파일 생성(👷 후보), stats 시간대별 추이(👷 후보).

### [세션 14 — 손상된 스토어 파일 보존/복구] (2026-07-18, 무인 자율 세션)
- 배경: 세션 시작 시 열린 PR 4개(#32 stats 해결시간, #33·#34·#35 config init 3중복)와 최근 닫힌
  PR들(logs·doctor·export·combine mode)이 점유·시도한 항목을 피해, CLAUDE.md 지침대로 **새 개선
  항목을 발굴**했다. 코드를 읽던 중 `RelayQueue.load()`에서 **실제 데이터 유실 버그**를 발견했다:
  손상된 `jobs.json`을 만나면 주석은 "파일을 그대로 남겨 사람이 검사하도록"이라 적혀 있지만,
  빈 맵으로 시작한 뒤 이어지는 어떤 쓰기(enqueue/status의 close→flush)든 **손상 파일을 덮어써
  복구 불가능하게 파괴**하고 있었다. 로컬 우선 도구에서 유일한 데이터가 이 파일이므로 치명적.
- 한 일 (branch `claude/wizardly-pascal-2gm0z9`): **손상 스토어 보존/복구**.
  1. `@agentrelay/core/queue.ts`에 순수 `corruptBackupPath(filePath, now)` 추가 — 파일시스템-safe
     타임스탬프 접미사(`jobs.json.corrupt-2026-07-18T13-38-10-351Z`, ISO의 `:`/`.`→`-`), 테스트
     결정성을 위해 `now` 주입.
  2. `RelayQueue.load()` 재작성 — (a) 읽기 실패(IO/권한)는 파일 손대지 않고 빈 큐, (b) 빈/공백
     파일은 정상 "빈 큐"(백업 안 함), (c) 파싱 불가 또는 **비배열 JSON 루트**는 손상으로 판정해
     `flush()`가 덮어쓰기 **전에** 먼저 백업 경로로 `rename`해 원본 보존 후 빈 큐로 계속 진행.
     rename 실패는 삼켜 릴레이 루프를 절대 깨지 않음(`backupPath: null`로 보고).
  3. `RelayQueue`에 `onCorrupt(info)` 콜백 옵션(`CorruptStoreInfo`: path/backupPath/error) 추가.
     CLI `commands.ts`에 공용 `openQueue(storePath)` 헬퍼 신설 → 7개 커맨드 진입점을 전부 이걸로
     통일, 손상 감지 시 stderr에 "store file … was unreadable; moved it aside to … and started with
     an empty queue." 경고 출력.
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **189개 전부 통과**(core 147 + cli 39 + dashboard 3 — queue corrupt-recovery 4케이스
    신규: 손상 파일 보존+빈 큐 시작+원본 바이트 유지+재쓰기가 백업 미파괴+단일 백업, 비배열 루트=손상,
    빈/공백=정상, `corruptBackupPath` 결정성). **실제 빌드된 CLI e2e**(mock 아님): 손상 `jobs.json`을
    두고 `status --store`가 stderr 경고 + `jobs.json.corrupt-<ts>` 백업(원본 바이트 그대로) + 온보딩
    문구 출력, 원본 경로는 이후 빈 `[]`로 안전 재기록 확인.
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), 대시보드도 `onCorrupt` 배선해 손상 경고 노출(👷 후보),
  stats 시간대별 추이(👷 후보), 스토어 자동 백업 로테이션(👷 후보).
### [세션 15 — `agentrelay stats` 해결 시간(resolution time) 지표] (2026-07-18, 무인 자율 세션)
- 배경: 세션 시작 시 열린 PR 7개(#23·#24·#27~#31)가 config init·logs·doctor·export·combine mode를
  이미 점유(일부 #27/#31은 config init 중복). 중복을 피해 CLAUDE.md 지침대로 **세션 12/13이 "다음
  할 일 👷 후보"로 남긴 stats 타이밍 확장**을 골라 구현했다 — 어떤 열린 PR과도 겹치지 않는 항목.
- 한 일 (branch `claude/wizardly-pascal-qb3468`): **stats 해결 시간 지표**.
  1. `@agentrelay/core/stats.ts`에 `TimingStats`(resolvedCount·avgResolutionMs·minResolutionMs·
     maxResolutionMs) + `RelayStats.timing` 추가. 순수 `resolutionMs(job)`가 라이프사이클 span
     (`updatedAt-createdAt`)을 계산 — completed+failed(릴레이가 자연 종료로 몬 잡)만 집계, cancelled
     (사용자 취소)·비종료 잡은 제외(successRate와 동일 정책). 타임스탬프 파싱 불가·음수 span(클럭
     스큐)은 클램프 대신 스킵해 지표를 왜곡하지 않음. resolved 0건이면 전부 null.
  2. CLI `packages/cli/src/stats.ts`에 순수 `formatDurationMs(ms)`(초~일 범위, 2단위 "4h 12m"/
     "3d 2h"/"45m 30s"/"8s", 음수·비유한은 "-", 1초 미만은 "<1s"). `renderStats`가 resolved 잡이
     있을 때만 "resolution time (completed + failed)" 블록(avg/min/max + over N job(s))을 렌더,
     `--json`은 `stats.timing`을 그대로 전달(스크립트/jq용).
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **194개 전부 통과**(core 147 + cli 44 + dashboard 3 — core timing 4 + CLI
    formatDurationMs 3·renderStats 2·json 1 신규). **실제 빌드된 CLI e2e**(mock 아님): completed(1h)/
    failed(3h)/waiting/cancelled(9h) 4-job 스토어 시드 → `stats`가 "resolution time … avg 2h 0m
    min 1h 0m max 3h 0m over 2 job(s)" 렌더(cancelled·waiting 제외 확인), `--json` timing이
    avg/min/max ms를 정확히 출력.
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), 누적 중복 PR(#27/#31 config init) 정리 후보,
  stats 시간대별 추이/평균 대기시간(대기→재개 지연) 확장(👷 후보), 대시보드에 timing 노출(👷 후보).
### [세션 14b — `agentrelay config init` + 스토어 경로 `~` 확장] (2026-07-18, 무인 자율 세션)
- 배경: 세션 시작 시 열린 👷 PR 0개, main=현재 브랜치 동일(중복/누적 없음). BACKLOG의
  👷 항목은 전부 완료 상태라, 세션 13이 "다음 할 일"로 남긴 👷 후보 중 **`agentrelay config
  init`(샘플 설정 파일 생성)** 을 골랐다. 설정 파일 지원(세션 13)은 있으나 사용자가 파일을
  손으로 작성해야 했던 갭을 메운다.
- 한 일 (branch `claude/config-init`):
  1. `@agentrelay/core/config.ts`에 순수 `sampleConfig()`(모든 그룹을 기본값으로 채운
     문서용 예시 — JSON엔 주석이 없으니 "모든 필드가 존재하는 것"이 곧 문서) +
     `sampleConfigJson()`(2-스페이스 pretty JSON + 개행, `parseConfig` 왕복 무손실) 추가.
     autoPrune.enabled는 기본 false로 두어 신규 사용자가 실수로 파괴적 정리를 켜지 않게 함.
  2. `packages/cli/src/commands.ts`에 `initConfig({path,cwd,force})` 추가 — 기본
     `<cwd>/agentrelay.config.json`에 샘플을 쓰되, 기존 파일은 `--force` 없이 덮지 않음
     (ok:false→exit 1), 부모 디렉터리 자동 생성, 상대경로는 cwd 기준 해소. cli.ts에
     `agentrelay config init [path] [-f/--force]` 서브커맨드 배선.
  3. **footgun 수정** — 샘플 store가 `~/.agentrelay/jobs.json`(리터럴 틸드)인데 스토어
     레이어가 확장하지 않아 `~` 디렉터리가 생길 수 있었다. `paths.ts`에 순수 `expandTilde`
     추가하고 `defaultStorePath`가 `AGENTRELAY_STORE`(=설정파일 store)의 선행 `~`/`~/…`를
     홈으로 확장하도록 함(쉘을 안 거치는 설정 파일 경로도 기대대로 동작). `~user`는 해소 불가라 보존.
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **199개 전부 통과**(core 153 + cli 43 + dashboard 3 — config sample 3 +
    paths 7 + CLI initConfig 4 신규). **실제 빌드된 CLI e2e**(mock 아님): `config init <path>`가
    샘플 작성 → 재실행 시 "already exists" + exit 1 → `--force`로 "Overwrote" → `--config`로
    그 파일을 읽어 `status --json`의 storePath가 `~`를 홈(`/root/.agentrelay/jobs.json`)으로
    확장해 표시하는 것까지 확인.
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), 대시보드가 설정 파일도 읽게 확장(👷 후보),
  stats 시간대별 추이/평균 대기시간(👷 후보), `config validate`로 설정 파일 검증(👷 후보).

### [세션 16 — 누적 중복 PR 통합(#36·#32·#37) + 5중 config-init 정리] (2026-07-18, 무인 자율 세션)
- **핵심: 다시 재발한 중복 PR 루프를 끊었다.** 세션 시작 시 열린 PR이 7개(#32~#38)였는데,
  그중 **5개(#33·#34·#35·#37·#38)가 전부 `agentrelay config init` 동일 기능의 중복 구현**이었다.
  main 브랜치 보호로 병합이 밀리면 매시간 무기억 세션이 같은 최우선 후보를 반복 구현하는
  고질적 패턴(세션 3·8·10에서도 발생). COLLAB.md 병합 정책("CI 초록이면 클로드 코드가 병합
  가능")에 근거해 통합했다.
- 한 일 (branch `claude/wizardly-pascal-ndais8`): 고유한 3개 PR의 커밋을 **cherry-pick으로
  내 브랜치에 통합**(다른 브랜치엔 push 안 함)하고 문서/코드 충돌을 union-merge로 해소:
  1. **#36(손상 스토어 보존/복구)** — 실제 데이터 유실 버그 수정. `RelayQueue.load()`가 손상
     `jobs.json`을 조용히 덮어써 파괴하던 버그를 백업 rename으로 고침. 가장 가치 높은 픽스라 최우선.
  2. **#32(stats 해결시간 지표)** — completed/failed 잡의 라이프사이클 span avg/min/max.
  3. **#37(config init)** — 5중 중복 중 가장 완성도 높은 버전(테스트 199, `expandTilde`
     footgun 수정 포함)을 대표로 채택.
  - 정리: 나머지 config-init 중복 4개(#33·#34·#35·#38)는 사유 코멘트와 함께 **닫음**.
    통합 원본 PR(#36·#32·#37)도 이 브랜치에 흡수됐으므로 닫음.
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **212개 전부 통과**(core 161 + cli 48 + dashboard 3). **실제 빌드된 CLI e2e**
    (mock 아님): `config init`이 4-그룹 샘플 생성 → 손상 `jobs.json`에 `status`가 백업+경고+빈 큐
    → `stats`가 정상 렌더까지 세 기능 동시 동작 확인.
- 다음 할 일: README/ARCHITECTURE(🧭 코워크). 앞으로 무기억 세션은 **작업 시작 전 열린 PR을
  먼저 확인**해 중복 구현 대신 통합을 우선할 것(config-init은 이제 main에 있음).

### [세션 17 — `agentrelay config validate`] (2026-07-18, 무인 자율 세션)
- 배경: 세션 시작 시 열린 PR 0개, main=현재 브랜치 동일(중복/누적 없음). 세션 13/14b가 "다음
  할 일 👷 후보"로 남긴 `config validate`(설정 파일 검증)를 골랐다. 설정 파일 지원(세션 13)·
  `config init`(세션 14b)은 있으나, `parseConfig`가 **타입만** 검증해 음수·파싱불가 duration 등
  "타입은 맞지만 무의미한" 값이 런타임까지 조용히 흘러가는 갭이 있었다.
- 한 일 (branch `claude/wizardly-pascal-kgd08a`):
  1. `@agentrelay/core/config.ts`에 순수 `validateConfig(config): ConfigIssue[]` +
     `ConfigIssue`/`ConfigIssueLevel` + `hasConfigErrors` 추가. 의미 검증 규칙:
     음수/비정수 `retry.maxAttempts`·`baseDelayMs`·`maxDelayMs`·`autoPrune.keep`·`everyTicks`
     (error), 1 미만 `retry.factor`(백오프가 매 시도 줄어듦, error), `parseDuration`로 파싱
     불가한 `autoPrune.after`/`every`(error), http(s) 아닌 `notify.webhookUrl`(error), URL 아닌
     `slackWebhook`(warning), 빈 store(warning), maxDelayMs<baseDelayMs(warning). `prune.ts`의
     `parseDuration` 재사용(순환참조 없음 — prune는 types만 import).
  2. CLI `packages/cli/src/commands.ts`에 `validateConfigFile({path,cwd,env})` — 파일 해소
     (`resolveConfigPath`)→읽기→`JSON.parse`→`parseConfig`(구조)→`validateConfig`(의미)를 **throw
     없이** 통합, 각 실패를 `ConfigIssue`로 변환해 한 번에 리포트. `ok`는 error-level 이슈가
     없을 때만 true(warning은 통과). `agentrelay config validate [path]` 서브커맨드 배선(error는
     stderr+exit 1, warning만이면 exit 0).
  3. **부수 수정** — bin.ts의 startup `bootstrapConfig`는 깨진 설정에 throw해 프로그램을 조기
     종료시키는데, 그러면 바로 그 깨진 파일을 진단하려는 `config validate`가 실행되지 못한다.
     `isConfigValidateInvocation(argv)`를 추가해 이 커맨드일 때만 bootstrap을 건너뛰도록 함.
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **230개 전부 통과**(core 173 + cli 54 + dashboard 3 — core validateConfig 12 +
    CLI validateConfigFile 6 신규). **실제 빌드된 CLI e2e**(mock 아님): `config init`으로 만든
    샘플은 "is valid" exit 0 → 음수 maxAttempts·factor 0.5·잘못된 duration·ftp 웹훅은 4개 error
    각각 리포트+exit 1 → 잘못된 타입은 "structure" error+exit 1 → **깨진 JSON도 startup 크래시
    없이** "invalid JSON" error+exit 1(bootstrap-skip 확인) → URL 아닌 slackWebhook은 warning만+
    exit 0까지 확인.
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), 대시보드가 timing/설정 파일 노출(👷 후보),
  stats 평균 대기시간(대기→재개 지연) 확장(👷 후보), 스토어 자동 백업 로테이션(👷 후보).

### [세션 18 — `agentrelay stats` 해결 시간 백분위수(median/p90)] (2026-07-18, 무인 자율 세션)
- 배경: 세션 시작 시 열린 PR 0개, main=현재 브랜치 동일(중복/누적 없음). 세션 16/17이 남긴
  timing 관련 👷 후보를 이어받아, resolution time을 avg/min/max만 보여주던 것을 백분위수로
  확장했다. 평균은 오래 돌본 잡 하나에 쉽게 왜곡되고, min/max는 극단만 보여줘 "전형적인
  케이스"와 "꼬리(near-worst-case)"가 안 보이는 갭이 있었다.
- 한 일 (branch `claude/wizardly-pascal-yfv19e`):
  1. `@agentrelay/core/stats.ts`의 `TimingStats`에 `medianResolutionMs`(p50)·`p90ResolutionMs`
     추가. 순수 `percentile(sortedAsc, p)` 헬퍼 신설 — 선형보간(NumPy 기본/"type 7":
     rank=p·(n−1), 두 표본 사이 보간, ms 반올림). `computeStats`가 resolution 스팬을 한 번만
     오름차순 정렬해 min/max는 양끝, median/p90은 `percentile`로 계산(중복 정렬 제거).
     resolved 잡 0개면 median/p90도 null(기존 avg/min/max와 동일 정책).
  2. CLI `packages/cli/src/stats.ts`의 resolution-time 블록에 `median … p90 …` 라인 추가
     (`formatDurationMs` 재사용). `--json`은 timing 그대로 전달하므로 새 필드가 자동 노출.
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **233개 전부 통과**(core 176 + cli 54 + dashboard 3 — core에 홀수/짝수/단일
    잡 percentile 3케이스 신규, cli render는 기존 테스트에 median/p90 단언 보강, 기존 empty-shape
    단언 2곳 갱신). **실제 빌드된 CLI e2e**(mock 아님): 스팬 {1h,2h,6h} 스토어로 `stats`가
    `median 2h 0m   p90 5h 12m`(rank=1.8→2h+0.8·4h=5.2h) 출력, `--json`이 `medianResolutionMs`
    7200000·`p90ResolutionMs` 18720000을 정확히 전달함을 확인.
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), 대시보드가 timing(백분위수 포함)/설정 파일 노출
  (👷 후보), stats 평균 대기시간(대기→재개 지연) 확장(👷 후보), 스토어 자동 백업 로테이션(👷 후보).

### [세션 19 — 스토어 백업 + 로테이션(`agentrelay backup`)] (2026-07-18, 무인 자율 세션)
- 배경: 세션 시작 시 열린 PR 0개, main=현재 브랜치 동일(중복/누적 없음). BACKLOG의 명시적 👷
  항목은 전부 완료라, 세션 14/17/18이 반복 남긴 "다음 할 일 👷 후보" 중 **스토어 자동 백업
  로테이션**을 골랐다. 세션 14(손상 스토어 보존/복구)의 안전 테마를 잇는 항목 — 로컬 우선 도구의
  유일한 데이터인 `jobs.json`을 위험한 작업(대량 prune·수동 편집·업그레이드) 전에 시점 스냅샷으로
  지키고, 무한 증가는 로테이션으로 막는다.
- 한 일 (branch `claude/wizardly-pascal-283n3i`):
  1. `@agentrelay/core/backup.ts` 신설(순수 헬퍼만) — `backupFilePath`(fs-safe·정렬가능 ISO
     타임스탬프 `jobs.json.backup-<ts>`, ISO 8601이 고정폭 zero-pad라 사전순==시간순),
     `backupStamp`(이 스토어의 `.backup-*`만 스탬프 추출 — `.corrupt-`/`.tmp-`/원본은 null로 배제),
     `listBackups`(최신순 desc 정렬), `selectRotatableBackups`(newest `keepLast` 보존, 나머지 삭제
     대상 반환; `keepLast≤0`은 전부, 소수 floor). `BackupResult`/`BACKUP_INFIX`/`DEFAULT_BACKUP_KEEP`(10).
  2. `RelayQueue.backup({keepLast,now})` — 현재 온-디스크 상태를 **원자적**(`.tmp-backup-*` temp+rename)
     으로 `.backup-<ts>`에 스냅샷(빈 스토어도 유효한 `[]`) 후 `selectRotatableBackups`로 이 스토어의
     `.backup-*`만 로테이션. **원본/`.corrupt-`/`.tmp-`는 절대 안 건드림**(distinct infix), 방금 만든
     스냅샷은 `full===dest` 가드로 `keepLast:0`에서도 보존, unlink 실패는 삼켜 릴레이 루프 보호.
  3. CLI `packages/cli/src/commands.ts`에 `backupStore`(래퍼)·`listStoreBackups`(디렉터리 스캔→최신순,
     읽기 실패는 빈 배열). `cli.ts`에 `agentrelay backup [--keep N] [--list]` — `--list`는 생성 대신
     기존 스냅샷 나열, `--keep`은 비음수 정수 검증(exit 1), 생성 시 job 수·로테이션 수 보고.
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **244개 전부 통과**(core 185 + cli 56 + dashboard 3 — core backup 9[순수 4 + queue 5] +
    CLI backupStore/listStoreBackups 2 신규). **실제 빌드된 CLI e2e**(mock 아님): rate-limit 잡 1개
    큐잉 → `backup --list`가 "No snapshots" → `backup`이 1-job 스냅샷 작성 → `backup --keep 1`이 2번째
    작성 + 이전 1개 로테이션 → `--list`가 최신 1개만 표시 → `--keep -3`은 error+exit 1 → 디스크에
    원본 `jobs.json` + 최신 백업 1개만 잔존 확인.
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), `agentrelay restore <snapshot>`으로 스냅샷 복원(👷 후보),
  대시보드가 timing/설정 파일 노출(👷 후보), stats 평균 대기시간(대기→재개 지연) 확장(👷 후보).

### [세션 20 — `agentrelay export` (CSV/JSON 내보내기)] (2026-07-18, 무인 자율 세션)
- 배경: 세션 시작 시 열린 PR 0개, main=현재 브랜치 동일(중복/누적 없음). BACKLOG §8의 👷
  항목이 모두 완료 상태여서, CLAUDE.md 지침대로 새 개선 항목을 발굴했다. `stats`(집계)·
  대시보드(실시간)는 있었지만 잡별 원본 이력을 스프레드시트/BI/`jq`로 빼낼 방법이 없었다 —
  잡 1건당 1행(row)의 평면 export가 그 갭을 메운다.
- 한 일 (branch `claude/wizardly-pascal-cjcfb7`):
  1. `@agentrelay/core/export.ts` 신설(순수, 파일시스템 미접촉): RFC 4180 `escapeCsvField`
     (콤마/쌍따옴표/개행 포함 시 인용·내부 따옴표 이중화), `JOB_CSV_COLUMNS`(사람이 실제로
     필터/정렬하는 필드 순서), `jobCsvValue`(command는 가독성 위해 공백 조인, null은 빈 문자열),
     `jobsToCsv`(헤더+행, 빈 스토어도 헤더 유지, LF·trailing newline 없음), `jobsToJson`
     (2-스페이스 pretty, command 배열까지 무손실 왕복), `EXPORT_FORMATS`/`exportJobs` 디스패처.
     CSV=평면·가독, JSON=정확·무손실로 역할 분리. index.ts에 재노출.
  2. CLI: `commands.ts`에 `exportStore`(스토어 읽기+선택적 파일 쓰기만 담당, 나머지는 core
     순수 함수 위임; 파일 쓰기는 POSIX 관례로 trailing newline 부착, 반환 content는 그대로).
     `cli.ts`에 `agentrelay export` 커맨드 배선: `-f/--format csv|json`, `-o/--out <file>`,
     `-s/--status`·`--sort`·`-r/--reverse`(status 커맨드의 `selectJobs` 재사용). 파일 출력 시
     상태 메시지는 stderr로(리다이렉트용 stdout 청정 유지), 잘못된 format/status/sort는 exit 1.
  - 검증: `pnpm build` 클린, `pnpm ci:lint`(Biome) **0 경고/0 에러**, `pnpm test`
    **256개 전부 통과**(core 194 + cli 59 + dashboard 3 — core에 export 순수함수 22케이스,
    cli에 exportStore 5케이스 신규). **실제 빌드된 CLI e2e**(mock 아님): `alpha,inc`·
    `refactor, please` 시드 잡으로 CSV가 두 필드를 정확히 인용부호 처리, `-f json`이 command
    배열 보존, `-o out/report.csv`가 2 job(s) 리포트 + 파일 생성, `-f xml`은 exit 1 확인.
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), 대시보드가 timing(백분위수 포함)/설정 파일 노출
  (👷 후보), stats 평균 대기시간(대기→재개 지연) 확장(👷 후보), 스토어 자동 백업 로테이션(👷 후보).

### [세션 21 — `agentrelay show <id>`] (2026-07-18, 무인 자율 세션)
- 배경: 세션 시작 시 내 브랜치=main(PR #40 병합 완료, 누적 없음), 열린 👷 PR 0개. BACKLOG의
  👷 항목이 전부 [완료]라 CLAUDE.md 지침대로 신규 개선 항목을 스스로 발굴. `status` 테이블은
  큐 전체를 8자 id·잘린 project로 **요약**만 해, 실패한 job의 전체 명령어·cwd·에러 메시지·
  출력 tail을 확인할 방법이 없는 갭을 골랐다.
- 한 일 (branch `claude/wizardly-pascal-y5jh3b`):
  1. `packages/cli/src/show.ts` 신설 — 순수 `renderJobDetail(job, {now,color})`: 전체 id·
     project·tool·status(색상)·읽기 좋은 command 라인·cwd·created/updated(라이프사이클 span
     주석)·resets in(카운트다운+절대시각)·attempts를 라벨 정렬 블록으로, `lastError`/
     `lastOutputTail`은 값이 있을 때만 별도 섹션으로 렌더. `formatCommand`는 공백·따옴표·빈
     인자를 안전 인용(복붙 가능한 에코, 재실행용 아님). `renderJobDetailJson`은 --json 스냅샷.
     기존 `formatCountdown`(status)·`formatDurationMs`(stats) 재사용.
  2. `commands.ts`에 read-only `showJob(idOrPrefix, store)` — `resolveJobId` 재사용으로 짧은
     prefix·모호/미존재를 cancel/retry와 동일하게 처리, 스토어를 전혀 변경하지 않음.
  3. CLI `agentrelay show <id> [--json]` 배선(cli.ts). 미존재/모호 id는 stderr+exit 1.
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **244개 전부 통과**(core 173 + cli 68 + dashboard 3 — show.test 12 + showJob 2
    신규). **실제 빌드된 CLI e2e**(mock 아님): `run`으로 rate-limit job을 큐잉 → `show <8자
    prefix>`가 전체 상세(따옴표 포함 command 라인·카운트다운) 렌더 → `--json`이 기계 판독
    스냅샷 → 미존재 id는 "no job matches" + exit 1까지 확인.
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), stats 대기시간(대기→재개 지연) 지표(👷 후보),
  대시보드가 job 상세/설정 파일 노출(👷 후보), 스토어 자동 백업 로테이션(👷 후보).

### [세션 22 — 누적 중복 PR 통합(#45·#44·#41) + 백업 중복 #43 정리] (2026-07-18, 무인 자율 세션)
- **핵심: 다시 쌓인 열린 PR 5개를 통합·정리해 중복 루프를 끊었다.** 세션 시작 시 열린 PR이
  #41·#43·#44·#45 4건이었는데, 그중 **#43·#45가 둘 다 `agentrelay backup`(스토어 스냅샷+
  로테이션) 동일 기능의 중복 구현**이었다. main 브랜치 보호로 병합이 밀리면 매시간 무기억
  세션이 같은 후보를 반복 구현하는 고질적 패턴(세션 3·8·10·16에서도 발생). COLLAB.md 병합
  정책("CI 초록이면 클로드 코드가 통합 가능")에 근거해 정리했다.
- 한 일 (branch `claude/wizardly-pascal-v4vb19`): 고유한 3개 기능의 커밋을 **cherry-pick(-x)으로
  내 브랜치에 통합**(다른 브랜치엔 push 안 함)하고 cli.ts/commands.ts/PROGRESS.md 충돌을 해소:
  1. **#45(스토어 백업+로테이션 `agentrelay backup`)** — 백업 중복 2건 중 더 완성도 높은 버전을
     채택. `@agentrelay/core/backup.ts`(순수 헬퍼) + `RelayQueue.backup()`(원자적 스냅샷+newest-N
     로테이션, 원본/`.corrupt-`/`.tmp-` 미접촉) + `backup [--keep N] [--list]`. #43(`.bak-` infix,
     CLI 레벨 구현)은 동일 기능 중복이라 채택 안 함.
  2. **#44(`agentrelay export` CSV/JSON)** — 잡 이력을 스프레드시트/BI/jq로 빼내는 평면 export.
     `@agentrelay/core/export.ts`(RFC 4180) + `export [-f csv|json] [-o file] [-s/--sort/-r]`.
  3. **#41(`agentrelay show <id>`)** — 단일 job 전체 상세(command·cwd·에러·출력 tail·카운트다운).
     `packages/cli/src/show.ts` + read-only `showJob`(resolveJobId 재사용).
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **281개 전부 통과**(core 203 + cli 75 + dashboard 3). **실제 빌드된 CLI e2e**
    (mock 아님): 시드 스토어로 `show <prefix>`가 인용 command·span 주석·출력 섹션 렌더 →
    `export -f csv`가 `alpha,inc`·`refactor, please`를 RFC 4180 인용 → `export -f json`이 command
    배열 무손실 왕복 → `backup` 후 `backup --keep 1`이 스냅샷 2개를 1개로 로테이션 확인.
  - 정리: 통합 흡수된 #45·#44·#41과 백업 중복 #43은 사유 코멘트와 함께 닫는다(이 PR로 대체).
- 다음 할 일: README/ARCHITECTURE(🧭 코워크). 앞으로 무기억 세션은 **작업 시작 전 열린 PR을
  먼저 확인**해 중복 구현 대신 통합을 우선할 것(backup·export·show는 이제 이 브랜치에 있음).

### [세션 23 — `agentrelay config show` 유효 설정/출처 표시] (2026-07-19, 무인 자율 세션)
- 배경: 세션 시작 시 지정 브랜치가 origin에서 삭제됨(PR #42 머지 완료) → 지침대로 최신 main에서
  동일 이름 브랜치를 새로 파 후속 작업을 진행. 설정 시스템은 `config init`(샘플 생성)·`config
  validate`(검증)까지 있었지만, "지금 실제로 어떤 값이 적용되고 그게 env/파일/기본값 중
  어디서 왔는가"를 보여주는 수단이 없었다. env > 설정파일 > 기본값 우선순위는 코드로만
  존재해 디버깅 시 추측에 의존하는 갭.
- 한 일 (branch `claude/wizardly-pascal-dgs7go`):
  1. `@agentrelay/core/config.ts`에 순수 `resolveEffectiveConfig(fileConfig, env)` + 타입
     `EffectiveConfigEntry`(key·group·value·source·secret)·`ConfigValueSource`(env/config-file/
     default)·`ConfigGroup` 신설. 각 `AGENTRELAY_*` 키를 env>파일>기본값 순으로 해소해 출처를
     귀속(`applyConfigToEnv`의 읽기 전용 미러). 키 목록 `CONFIG_ENV_KEYS`는 `configToEnv`가
     방출하는 키와 정확히 동기화(테스트로 드리프트 방지), 웹훅 URL/토큰은 `secret` 플래그.
  2. CLI `commands.ts`에 `showConfig({path,cwd,env})` — 설정파일을 직접 로드(손상 파일은 throw
     대신 `loadError`로 보고하고 env/기본값 해소는 계속). `config.ts`에 순수 렌더
     `renderEffectiveConfig`(그룹별 정렬 표, 시크릿 마스킹 + `--show-secrets` 해제)·
     `renderEffectiveConfigJson`(`--json`). `agentrelay config show` 서브커맨드 배선.
  3. 부수 버그 수정: bin.ts의 startup `bootstrapConfig`가 설정파일 값을 `process.env`에 먼저
     주입하면 `config show`가 파일 출처를 전부 `[env]`로 오표기하는 문제 발견. `config validate`가
     쓰던 startup-skip 가드를 `isConfigDiagnosticInvocation`으로 일반화(validate+show 모두 skip).
     또한 기존 argv 파서가 `--config <path>` 뒤 **경로 값**을 커맨드명으로 오인하던 잠복 버그를
     `subcommandTokens`(값 받는 옵션 스킵)로 교정 — `--config x.json config show`도 정상 인식.
     `isConfigValidateInvocation`은 하위호환 alias로 유지.
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **247개 전부 통과**(core 182 + cli 62 + dashboard 3 — core에 resolveEffectiveConfig
    6케이스[전부 기본값/파일귀속/env우선/불리언 1·0 투영/시크릿 플래그/configToEnv 동기화]
    신규, cli에 showConfig 5케이스 + isConfigDiagnosticInvocation 3케이스 신규). **실제 빌드된
    CLI e2e**(mock 아님): store·webhookUrl·webhookAuth·maxAttempts·autoPrune를 담은 설정파일 +
    `AGENTRELAY_MAX_ATTEMPTS=2`로 실행 → `AGENTRELAY_STORE …[config-file]`,
    `AGENTRELAY_MAX_ATTEMPTS 2 [env]`(파일 8 무시), 시크릿 마스킹(`…cret`/`…-xyz`), `--show-secrets`로
    전체 노출, `--json` 구조·손상파일 exit 1을 모두 확인.
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), 대시보드가 timing/설정 파일(config show 결과) 노출
  (👷 후보), stats 평균 대기시간(대기→재개 지연) 확장(👷 후보), 스토어 자동 백업 로테이션(👷 후보).

### [세션 24 — 누적 PR 통합(#46 병합·#47 정리·#48 흡수) + `agentrelay restore`] (2026-07-19, 무인 자율 세션)
- **먼저: 다시 쌓인 열린 PR 3개를 정리해 중복 루프를 끊었다.** 세션 시작 시 CI 초록인 열린 PR이
  #46(backup+export+show 통합)·#47(export, #46의 부분집합)·#48(config show) 3건이었다. main 브랜치
  보호로 병합이 밀리면 매시간 무기억 세션이 같은 후보를 반복 구현하는 고질적 패턴(세션 3·8·10·16·22).
  COLLAB.md 병합 정책("CI 초록이면 클로드 코드가 병합 가능", `actions_list`로 초록 확인)에 근거해:
  1. **#46을 main에 병합**(backup·export·show 세 기능이 한 번에 main에 들어옴, 63f8b73).
  2. **#47(export)은 #46에 이미 포함**되어 닫음(사유 코멘트).
  3. **#48(config show)은 #46 병합으로 dirty가 됨** → 단일 커밋을 내 브랜치에 `cherry-pick -x`로
     흡수하고 cli.ts/commands.ts/test/PROGRESS 충돌을 해소(다른 브랜치엔 push 안 함).
- 한 일 (branch `claude/wizardly-pascal-5bxk7l`): **`agentrelay restore <snapshot>`** — 방금 main에
  들어온 `backup`의 자연스러운 짝(세션 19가 "다음 할 일 👷 후보"로 남긴 항목). 스키마 변경 없이
  JSON 스토어 모델 안에서 완결.
  1. `@agentrelay/core/backup.ts`에 순수 `resolveBackup(fileNames, storeFileName, selector)` +
     `RestoreResult` 추가. selector는 `latest`(또는 빈 문자열)→최신, 스냅샷 basename, 정렬가능 stamp를
     매칭; 미매칭·타 스토어 스냅샷·백업 없음은 null.
  2. `RelayQueue.restore({from, backupCurrent, now})` — 스냅샷을 **먼저 읽고 검증**(JSON 배열이
     아니면 throw → 라이브 스토어를 절대 파괴하지 않음)한 뒤, 기본적으로 현재 스토어를 `.backup-<ts>`로
     스냅샷(복원 자체를 되돌릴 수 있게)하고 인메모리 맵을 교체해 원자적 flush. `backupCurrent:false`면
     안전 백업 생략.
  3. CLI `commands.ts`에 `restoreStore`(래퍼) + `resolveRestoreSource`(직접 파일 경로가 있으면 우선,
     아니면 이 스토어의 `.backup-*`를 selector로 해소, 미매칭은 명확한 에러로 오복원 방지).
     `cli.ts`에 `agentrelay restore [snapshot] [--no-backup]` 배선(미매칭 selector는 stderr+exit 1).
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **302개 전부 통과**(core 213 + cli 86 + dashboard 3 — core resolveBackup 1 +
    RelayQueue.restore 3 + CLI restoreStore 3 신규). **실제 빌드된 CLI e2e**(mock 아님): 1-job
    스토어를 `backup` → 2-job으로 키운 뒤 `restore`가 최신 스냅샷으로 1-job 복원 + 이전 상태를
    안전 백업(`backup --list`에 2개), stamp 지정 복원, `--no-backup`이 안전 백업 생략, 미매칭
    selector는 "No snapshot matches" + exit 1까지 확인.
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), 대시보드가 timing/설정 파일 노출(👷 후보),
  stats 평균 대기시간(대기→재개 지연) 확장(👷 후보), `restore --dry-run`(복원 전 미리보기, 👷 후보).

### [세션 25 — `agentrelay stats` 스코프 필터(--status/--tool/--project) + 큐 정렬 flaky 수정] (2026-07-19, 무인 자율 세션)
- 한 일: `stats`는 지금까지 큐 전체 지표만 냈다. 이제 부분집합(특정 프로젝트·툴·상태)에 대해서만
  성공률·재시도·해결시간을 볼 수 있다. 구현 중 pre-existing한 큐 정렬 flaky 버그도 발견해 고쳤다.
  1. `@agentrelay/core/stats.ts`에 순수 `scopeJobs(jobs, {statuses,tools,projects})` +
     `isJobScopeActive` 추가. 차원 간 AND·차원 내 OR, 미지정 차원은 필터 안 함, 항상 새 배열 반환
     (스토어 앨리어싱 방지). tool은 원시 문자열로 매칭해 미지 tool도 정확히 필터.
  2. CLI `stats`에 `-s/--status`·`-t/--tool`·`-p/--project` 배선. 공용 `splitList` 헬퍼로 콤마 분리,
     잘못된 status/tool은 명확한 에러 + exit 1. `renderStats`에 `scopeNote` 옵션 → 활성 시 "scope: …"
     헤더 라인, 스코프가 스토어 전체를 걸러내면 온보딩 문구 대신 `NO_SCOPE_MATCH_MESSAGE`.
     `renderStatsJson`은 활성 스코프를 `scope` 필드로 에코(스크립트/jq용).
  3. **부수 버그 수정(pre-existing flaky)**: `queue.ts`의 리스트 정렬 comparator
     `a.createdAt < b.createdAt ? 1 : -1`가 same-ms 타이에서 0을 안 돌려주는 비대칭 비교였다.
     두 job이 같은 ms에 생성되면 정렬 결과가 엔진 내부에 의존 → 병렬 부하에서 export 테스트가
     간헐 실패(clean main에서도 5회 중 ~2회 실패 재현). `compareJobsNewestFirst`(createdAt desc,
     id asc 타이브레이크)로 결정론화하고, export 테스트의 인덱스 의존 단언을 순서 무관(set 비교)으로 교체.
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **313개 전부 통과**(core 221 + cli 89 + dashboard 3 — core scopeJobs/isJobScopeActive
    7 + cli renderStats/Json 스코프 3 신규). flaky 재현 후 수정 검증: cli 테스트 6연속·core 3연속
    전부 green. **실제 빌드된 CLI e2e**(mock 아님): 3-job(web/api × claude/codex) 스토어로
    `stats`(전체 67%)·`--project web`(50%)·`--tool claude-code`(100%)·`--status failed`(0%)·
    `--project nope`(No match)·`--tool bogus`(exit 1)·`--json --project web`(scope 에코) 확인.
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), `stats --project`를 상위 프로젝트 랭킹과 연동한
  드릴다운(👷 후보), `status`에도 `--tool`/`--project` 필터 확장(👷 후보), 대시보드가 스코프 필터
  UI 노출(👷 후보).

### [세션 25b — `agentrelay doctor` 셋업 건강 진단] (2026-07-19, 무인 자율 세션)
- 배경: BACKLOG의 👷 항목이 전부 [완료] 상태 → CLAUDE.md "다 소진되면 스스로 새 개선 항목을
  발굴" 지침대로 신규 항목을 발굴해 구현. 로컬 우선 CLI에서 "왜 릴레이가 안 도나?"를 한 번에
  진단하는 `doctor`가 없어 사용자가 Node 버전·스토어·설정·알림을 따로 확인해야 했다.
- 한 일: `agentrelay doctor [--json]` 신설.
  1. `@agentrelay/core/doctor.ts` — 순수 판정 계층 `runDiagnostics(input)`: 파일시스템/env/시계를
     만지지 않고 이미 수집된 사실만 ok/warning/error로 판정(단위 테스트 가능). 네 검사 —
     node(`>=22.5` engines 하한, `parseNodeVersion`/`isSupportedNode`), store(corrupt=error·부재=OK·
     활성 잡 수), config(loadError=error·`validateConfig` 결과 전달), notify(채널 0개=warning·공백 무시).
     `DiagnosticReport`(checks·ok·counts) + `countActiveJobs` 헬퍼. index.ts 재노출.
  2. CLI `commands.ts`의 `runDoctor` — 파일시스템+env 절반. 스토어 존재 여부를 큐 오픈 **전**에
     캡처(corrupt가 부재로 오인되지 않게), config는 loadConfigFile+validateConfig, notify는 env에서
     수집. 절대 throw 안 함(깨진 설정도 error 검사로 보고). `packages/cli/src/doctor.ts`에 순수
     `renderDoctor`(색상 체크리스트+힌트+요약)·`renderDoctorJson`. `cli.ts`에 커맨드 배선, 실패 시 exit 1.
  3. 부수: 타이밍 의존 flaky였던 export.test.ts의 순서 단언을 순서 무관으로 안정화(listAll이
     createdAt 내림차순이라 같은 ms 삽입 시에만 통과하던 케이스).
- 검증: `pnpm build` 클린, `pnpm ci:lint`(Biome) 0 경고/0 에러, `pnpm test` **342개 전부 통과**
  (core doctor 25 + cli doctor 15 신규). **실제 빌드된 CLI e2e**: 정상 셋업(3 ok+notify warning,
  exit 0), 손상 스토어(store error, exit 1), `--json` 출력, 알림 채널 설정 시 "notifications on via
  Slack"까지 확인.
- 다음 할 일: `doctor`에 검사 추가 후보(디스크 쓰기 권한·데몬 실행 여부·어댑터 바이너리 PATH 확인),
  README/ARCHITECTURE(🧭 코워크), stats 평균 대기시간 확장(👷 후보).

### [세션 26 — 누적 PR 통합(#50 병합·#51 흡수) + `agentrelay restore --dry-run`] (2026-07-19, 무인 자율 세션)
- **먼저: 다시 쌓인 열린 PR 2개를 통합해 중복 루프를 끊었다.** 세션 시작 시 CI 초록(`actions_list`로
  확인)·`mergeable_state:clean`인 열린 PR이 #50(stats 스코프 필터)·#51(doctor) 2건이었다. main 브랜치
  보호로 병합이 밀리면 매시간 무기억 세션이 같은 후보를 반복 구현하는 고질적 패턴(세션 3·8·10·16·22·24).
  COLLAB.md 병합 정책("CI 초록이면 클로드 코드가 통합 가능")에 근거해:
  1. **#50을 main에 병합**(stats `-s/--status`·`-t/--tool`·`-p/--project` 스코프 필터 + `queue.ts`의
     same-ms 타이 비대칭 comparator를 `compareJobsNewestFirst`로 결정론화한 pre-existing flaky 근본 수정).
     실제 버그 수정을 담고 있어 먼저 병합, 8f2ffab.
  2. **#51(doctor)은 #50 병합으로 dirty가 됨** → 단일 커밋을 내 브랜치에 `cherry-pick -x`로 흡수하고
     BACKLOG/PROGRESS/export.test.ts 충돌을 해소(export의 flaky 픽스는 #50의 comparator 근본 수정을
     채택, #51은 코멘트만 달랐음; 다른 브랜치엔 push 안 함).
- 한 일 (branch `claude/wizardly-pascal-atytw7`): **`agentrelay restore --dry-run`** — 세션 24가 "다음
  할 일 👷 후보"로 남긴 항목. `restore`는 스토어를 통째로 교체하는 파괴적 연산인데, 실행 전 "무엇이
  바뀔지"를 안전하게 확인할 수단이 없었다.
  1. `@agentrelay/core/backup.ts`에 `RestorePreview`(from·jobCount·currentJobCount·wouldBackUp) 타입 추가.
     `RelayQueue.previewRestore({from,backupCurrent})`가 실제 `restore`와 **동일한 검증**(스냅샷 읽기+
     JSON 배열 체크 → 깨진 스냅샷은 미리보기에서도 throw)을 거치되, 라이브 스토어는 읽기만(대체될 현재
     job 수 집계) 하고 절대 쓰지 않음(안전 백업도 안 함).
  2. CLI `commands.ts`에 read-only `previewRestoreStore`(선택자 해소는 `restoreStore`와 공유해 미매칭은
     동일하게 에러). `cli.ts` `restore`에 `--dry-run` 플래그 배선 — 복원될 job 수·대체될 현재 job 수·
     안전 백업 여부를 리포트하고 "No changes made (--dry-run)"으로 종료. 미매칭 selector는 exit 1.
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **359개 전부 통과**(core 250 + cli 106 + dashboard 3 — core previewRestore 3 +
    cli previewRestoreStore 3 신규). **실제 빌드된 CLI e2e**(mock 아님): 1-job 스냅샷을 뜬 뒤 스토어를
    2-job으로 키우고 → `restore --dry-run`이 "would restore 1 job, replacing 2 / would be backed up first
    / No changes made" 렌더 → dry-run 후 스토어 여전히 2-job·백업 개수 불변(미변경 확인) →
    `--dry-run --no-backup`은 "would NOT be backed up" → 미존재 selector는 "No snapshot matches" + exit 1.
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), 대시보드가 timing/설정 파일 노출(👷 후보),
  stats 평균 대기시간(대기→재개 지연) 확장(👷 후보), `doctor`에 검사 추가(디스크 쓰기 권한 등, 👷 후보).

### [세션 26 — `agentrelay status` 스코프 필터(--tool/--project)] (2026-07-19, 무인 자율 세션)
- 배경: 세션 시작 시 지정 브랜치=최신 main(0 커밋 diff, 중복/누적 없음), BACKLOG의 👷 항목은
  전부 완료. CLAUDE.md 지침대로 세션 25가 "다음 할 일 👷 후보"로 남긴 항목 중 **status 스코프
  필터**를 골랐다 — `stats`는 세션 25에서 `--status/--tool/--project` 부분집합 필터를 얻었지만
  `status` 테이블은 여전히 `--status`만 지원해, 큰 큐에서 특정 툴·프로젝트 job만 보려면 방법이
  없던 비대칭을 메운다.
- 한 일 (branch `claude/wizardly-pascal-6st1ab`):
  1. `packages/cli/src/status.ts`의 `JobSelection`에 `tools?: string[]`·`projects?: string[]` 추가.
     `selectJobs`가 status·tool·project 세 필터를 **차원 간 AND·차원 내 OR**로 적용(항상 새 배열
     반환, 정렬/역순 전에 필터). tool은 `stats`의 `scopeJobs`와 동일하게 **원시 문자열 매칭**이라
     미지 tool 문자열도 정확히 걸러냄. 순수 `isSelectionFiltering(selection)`(core `isJobScopeActive`의
     status 버전) export.
  2. CLI `status`에 `-t/--tool`·`-p/--project` 옵션 배선. 공용 `splitList` 헬퍼 재사용(기존 인라인
     split 대체), tool은 `ALL_TOOLS` 검증(잘못된 tool은 exit 1), status 검증도 `splitList`로 통일.
     일회성 테이블·`--json`·`--watch(runWatch)` 세 뷰 모두 동일 `selection`을 적용. 필터가 스토어
     전체를 걸러내면 온보딩 문구 대신 `NO_MATCH_MESSAGE`.
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **320개 전부 통과**(core 221 + cli 96 + dashboard 3 — status.test에 selectJobs
    tool/project/AND 5 + isSelectionFiltering 2 신규). **실제 빌드된 CLI e2e**(mock 아님): 3-job
    (web×claude / api×codex / web×codex) 스토어로 `status`(3행)·`--tool codex-cli`(2행)·`--project web`
    (2행)·`--tool codex-cli --project web`(1행, AND)·`--project nope`(No match)·`--tool bogus`(exit 1)·
    `--json --tool claude-code`(total 1) 확인.
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), 대시보드가 스코프 필터(tool/project) UI 노출(👷 후보),
  stats 평균 대기시간(대기→재개 지연) 확장(👷 후보), `restore --dry-run`(👷 후보).

### [세션 26 — `agentrelay stats --since/--until` 시간 창 필터] (2026-07-19, 무인 자율 세션)
- 배경: 이전 PR(#50) 병합으로 브랜치가 main과 동일. BACKLOG의 순수 👷 항목은 모두 완료 →
  세션 25의 스코프 필터(status/tool/project)에 **시간 차원**을 더하는 자연스러운 후속을 발굴·구현.
- 한 일:
  1. `@agentrelay/core` `stats.ts`: `JobScope`에 `createdFrom`/`createdTo`(epoch ms, 양끝 포함)
     추가. 클럭/기간이 아닌 명시 타임스탬프라 `scopeJobs`가 순수·클럭 미접촉·테스트 가능 유지.
     `scopeJobs`가 `createdAt`을 파싱해 창 안의 잡만 남기고, 파싱 불가/누락 `createdAt`은 시간
     창 활성 시 제외(타임라인에 놓을 수 없으므로). `isJobScopeActive`가 시간 경계도 활성으로 인식
     (`createdFrom: 0` 같은 falsy epoch도 `!== undefined`로 정확히 감지).
  2. CLI `stats`에 `--since <기간>`(now−기간=createdFrom)·`--until <기간>`(now−기간=createdTo,
     창의 오래된 쪽 경계) 배선. 기존 `parseDuration`(prune.ts) 재사용, 잘못된 기간/빈 범위
     (since<until)는 명확한 에러 + exit 1, scope note에 `since=…`/`until=…`, `--json`은 scope에
     createdFrom/createdTo 에코.
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 에러**, `pnpm test`
    **319개 전부 통과**(core 227 + cli 89 + dashboard 3 — core scopeJobs/isJobScopeActive 6 신규).
    **실제 빌드된 CLI e2e**(mock 아님): 최근2h/어제30h/10일전 3-job 스토어로 `stats`(전체 67%)·
    `--since 24h`(최근1개 100%)·`--since 7d --until 24h`(어제1개 0%)·`--since 7d --json`(scope
    에코, total 2)·`--since bogus`(exit 1)·`--since 1d --until 7d`(빈 범위 exit 1) 확인.
- 다음 할 일: `export`/`status`에도 `--since/--until` 확장(👷 후보), 대시보드 시간 창 필터 UI
  (👷 후보), README/ARCHITECTURE(🧭 코워크).

### [세션 27 — 누적 PR 통합(#52 병합·#55·#53 흡수·#54 중복 정리)] (2026-07-19, 무인 자율 세션)
- **오늘의 초점: 다시 쌓인 열린 PR 4개를 정리해 고질적 중복 루프를 끊었다.** 세션 시작 시 CI
  초록(`actions_list`로 확인)인 열린 PR이 #52(restore --dry-run + doctor)·#53(stats --since/--until)·
  #54·#55(둘 다 status --tool/--project로 **상호 중복**) 4건이었다. main 브랜치 보호로 병합이 밀리면
  매시간 무기억 세션이 같은 후보를 반복 구현하는 패턴(세션 3·8·10·16·22·24·26)이 재발한다.
  COLLAB.md 병합 정책("CI 초록이면 클로드 코드가 통합 가능")에 근거해:
  1. **#52를 main에 병합**(restore --dry-run + doctor 셋업 진단이 한 번에 main으로, a88ec8d).
  2. **#55(status --tool/--project 스코프 필터)를 내 브랜치에 `cherry-pick -x`로 흡수** — #52 병합으로
     충돌(BACKLOG/PROGRESS/cli.ts)이 났고 코드는 자동 병합, 문서 로그는 양쪽 보존으로 해소.
  3. **#53(stats --since/--until 시간 창 필터)도 `cherry-pick -x`로 흡수** — 마찬가지로 문서 충돌만
     해소(코드 자동 병합). 다른 브랜치엔 push하지 않음("지정 브랜치 외 push 금지" 원칙 준수).
  4. **#54는 #55와 완전 동일 기능(status 스코프 필터)**이라 중복으로 판단 → 이 통합 PR로 대체하며 닫음.
- 결과: main에 `restore --dry-run`·`doctor`가 들어갔고, 이 브랜치가 `status --tool/--project`와
  `stats --since/--until`을 함께 담아 나머지 세 PR(#53·#54·#55)을 대체한다.
  - 검증: `pnpm install`→`pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **372개 전부 통과**(core 256 + cli 113 + dashboard 3). **실제 빌드된 CLI e2e**(mock
    아님): 3-job(web×claude / api×codex / web×codex) 스토어로 두 흡수 기능이 함께 동작 확인 —
    `status`(3행)·`--tool codex-cli`(2행)·`--project web --tool codex-cli`(AND 1행)·`--tool bogus`
    (exit 1); `stats`(전체 50%)·`--since 24h`(최근 completed만 100%, scope 에코)·`--since 7d --until 24h`
    (어제 failed만 0%)·`--since 1d --until 7d`(빈 범위 exit 1).
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), `export`/`status`에도 `--since/--until` 확장(👷 후보),
  대시보드가 스코프/시간 창 필터 UI 노출(👷 후보), stats 평균 대기시간(대기→재개 지연) 확장(👷 후보).

### [세션 28 — 누적 PR #56 병합 + `doctor` 어댑터 바이너리 PATH 검사] (2026-07-19, 무인 자율 세션)
- **먼저: 다시 쌓인 열린 PR #56을 병합해 중복 루프를 끊었다.** 세션 시작 시 CI 초록(`actions_list`로
  확인, head `9d939d4` success)·`mergeable_state:clean`인 열린 PR이 #56(status `--tool/--project` +
  stats `--since/--until` 통합, #53·#54·#55 흡수) 1건이었다. main 브랜치 보호로 병합이 밀리면 매시간
  무기억 세션이 같은 후보를 반복 구현하는 고질적 패턴(세션 3·8·10·16·22·24·26·27) → COLLAB.md 병합
  정책("CI 초록이면 클로드 코드가 통합 가능")에 근거해 **#56을 main에 병합**(8a2e161).
- 배경: BACKLOG의 👷 항목이 전부 [완료] 상태 → CLAUDE.md "다 소진되면 스스로 새 개선 항목을 발굴"
  지침대로, 여러 세션이 "다음 할 일 👷 후보"로 남긴 **`doctor` 어댑터 바이너리 PATH 검사**를 골라
  구현했다. 스케줄러는 재개 시 `job.command[0]`을 spawn하는데, 그 바이너리가 PATH에 없으면 모든
  재개가 조용히 실패한다 — 실제 #1 실패 모드인데 `doctor`가 이를 잡지 못했다.
- 한 일 (branch `claude/wizardly-pascal-66cnzs`): **`agentrelay doctor` 어댑터 PATH 검사**.
  1. `@agentrelay/core/doctor.ts` — `BinaryFact`(binary·found·resolvedPath·neededBy)·`AdapterFacts`
     타입 + `DiagnosticInput.adapters` 추가. 순수 `distinctActiveBinaries(jobs)`(활성 잡의 distinct
     `command[0]`+카운트, 종료 잡·빈 command 제외, 첫 등장 순서 보존) 신설. `runDiagnostics`에
     `adapterCheck` 추가(순서 node→store→**adapters**→config→notify): 대기 잡 없으면 OK(점검 대상
     없음), 전부 PATH에 있으면 OK(해석 경로 표시), 하나라도 없으면 error("M of N … not on PATH" +
     `which <bin>` 힌트). 여전히 순수(파일시스템/env/시계 미접촉) 유지.
  2. CLI `commands.ts` — `which`식 `resolveOnPath(binary, env)`(PATH 스캔, Windows PATHEXT 대응,
     경로 포함 바이너리는 직접 확인) + `isExecutableFile`(statSync isFile + accessSync X_OK) 신설.
     `runDoctor`가 `distinctActiveBinaries`로 활성 잡 바이너리를 뽑아 각각 PATH 해석해 `AdapterFacts`
     구성 후 `runDiagnostics`에 전달. 절대 throw 안 함, 검사 실패 시 exit 1(CI/pre-flight 게이트).
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **381개 전부 통과**(core 262 + cli 116 + dashboard 3 — core adapterCheck 3 +
    distinctActiveBinaries 3 + cli runDoctor adapter e2e 3 신규). **실제 빌드된 CLI e2e**(mock 아님):
    대기 잡 2개(`myagent`[PATH에 있음]·`missing-cli`[없음]) 시드 → `doctor`가 "1 of 2 … not on PATH:
    missing-cli" error + exit 1 → `missing-cli` 심링크로 PATH에 추가하면 "all 2 … resolve on PATH"
    (해석 절대경로 표시) + exit 0, 대기 잡 없으면 "no queued jobs … no agent binary to check" OK.
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), `doctor`에 디스크 쓰기 권한·데몬 실행 여부 검사 추가(👷
  후보), 대시보드가 timing/설정 파일 노출(👷 후보), stats 평균 대기시간(대기→재개 지연) 확장(👷 후보).

### [세션 28 — export 스코프 필터 확장(`--tool`/`--project`/`--since`/`--until`)] (2026-07-19, 무인 자율 세션)
- **먼저 열린 PR #57 통합으로 중복 루프 차단.** 세션 시작 시 CI 초록·`mergeable_state:clean`이던
  #57(doctor 어댑터 바이너리 PATH 검사)을 COLLAB 병합 정책("CI 초록이면 클로드 코드가 병합 가능")에
  따라 main에 병합(1e4a4c8). 그 위 최신 main에서 브랜치를 리셋해 작업.
- **한 일: `agentrelay export`에 stats·status와 동일한 스코프/시간 창 필터를 확장.**
  기존 export는 `--status`/`--sort`/`--reverse`만 지원해, 특정 툴·프로젝트·기간의 잡 부분집합만
  CSV/JSON으로 내보낼 수 없었다. CLI `cli.ts`의 export 액션에:
  1. `-t/--tool`·`-p/--project` — 공용 `splitList` + `selectJobs`의 tools/projects 재사용
     (잘못된 tool은 `ALL_TOOLS` 검증 후 exit 1).
  2. `--since`/`--until` — `now−기간`으로 `createdFrom`/`createdTo` 산출(기존 `parseDuration` 재사용),
     빈 범위(since<until)·파싱 불가 기간은 exit 1.
  필터 적용 순서는 **시간 창(core `scopeJobs`) → status/tool/project/sort/reverse(`selectJobs`)**로,
  stats의 "창→선택" 의미와 정확히 일치. 새 core 코드는 0줄 — 전부 기존에 검증된 순수 함수 재사용.
  - 검증: `pnpm install`→`pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 에러**,
    `pnpm test` **383개 전부 통과**(core 262 + cli 118 + dashboard 3 — export.test.ts에 조합
    파이프라인 회귀 2케이스 추가: `--tool`만 / `--since`+`--tool` 창→선택). **실제 빌드된 CLI e2e**
    (mock 아님): 3-job(web×claude / api×codex / web×codex) 스토어로 `export`(3행)·`--tool codex-cli`
    (2행)·`--project web --tool codex-cli`(AND 1행)·`--since 24h`(최근 web만)·`--since bogus`(exit 1)·
    `--tool bogus`(exit 1)·`--since 1d --until 7d`(빈 범위 exit 1) 확인.
- 다음 할 일: 대시보드가 스코프/시간 창 필터 UI 노출(👷 후보), stats 대기시간(대기→재개 지연) 지표
  (👷 후보 — 단 현재 RelayJob에 중간 타임스탬프가 없어 스키마 확장 필요), README/ARCHITECTURE(🧭 코워크).

### [세션 28b — `agentrelay doctor` 스토어 디렉터리 쓰기 권한 검사] (2026-07-19, 무인 자율 세션, branch `claude/wizardly-pascal-nbitfy`)

- 배경: `doctor`는 스토어 파일이 **읽히는지**만 봤는데(store 검사), 진짜 릴레이가 상태를 지속하려면
  매 `flush()`가 파일을 **써야** 한다. 스토어 디렉터리가 쓰기 불가(권한·read-only 마운트·풀 디스크)면
  잡 상태 변경이 조용히 유실된다 — PATH 부재 다음으로 흔한 "재개 조용히 실패" 원인인데 `doctor`가
  이를 잡지 못했다.
- 한 일: **`agentrelay doctor` 스토어 디렉터리 쓰기 권한 검사**.
  1. `@agentrelay/core/doctor.ts` — `WritableFacts`(dir·writable·willCreate·error) + `DiagnosticInput.writable`
     추가. 순수 `writableCheck`(검사 순서 node→store→**store-writable**→adapters→config→notify):
     쓰기 가능=OK(dir 미존재면 "부모 쓰기 가능, 첫 실행 시 생성"), 쓰기 불가=error(OS 에러 텍스트 +
     `AGENTRELAY_STORE` 재지정 힌트). 여전히 순수(파일시스템/env/시계 미접촉).
  2. CLI `commands.ts` — `probeStoreWritable`(실제 throwaway 파일 write+rm으로 권한 비트뿐 아니라
     read-only 마운트·풀 디스크까지 정직하게 검증, dir 미존재 시 `nearestExistingDir`로 가장 가까운
     존재 조상을 프로브, 절대 throw 안 함) 신설. `runDoctor`가 **큐 오픈 전** 프로브(RelayQueue 생성자가
     dir을 mkdir하므로 순서 중요). 부수 견고화: RelayQueue 생성이 dir 생성 불가로 throw할 때 크래시하던
     것을 try/catch로 감싸 store-writable error로 진단(doctor "절대 throw 안 함" 계약 유지).
  - 검증: `pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**, `pnpm test`
    **387개 통과 + 1 skip**(core 265 + cli 119 + dashboard 3 — core writable 5 + cli writable 4[root는
    권한 비트 우회로 1 skip] 신규). **실제 빌드 CLI e2e**: 쓰기 가능→ok, 스토어 dir 미존재→"will be
    created", 부모가 파일(ENOTDIR)→store-writable error + exit 1(크래시 없음).
- 다음 할 일: README/ARCHITECTURE(🧭 코워크), `doctor` 데몬 실행 여부 검사(👷 후보), 대시보드가
  timing/설정 파일 노출(👷 후보), stats 평균 대기시간(대기→재개 지연) 확장(👷 후보).

### [세션 29 — 누적 PR #58·#59 통합 + `status --since/--until` 시간 창 필터] (2026-07-19, 무인 자율 세션)
- **먼저: 다시 쌓인 열린 PR 2개를 통합해 중복 루프를 끊었다.** 세션 시작 시 CI 초록(`actions_list`로
  확인)인 열린 PR이 #58(export 스코프/시간 창 필터)·#59(doctor 스토어 디렉터리 쓰기 권한 검사) 2건.
  main 브랜치 보호로 병합이 밀리면 매시간 무기억 세션이 같은 후보를 반복 구현하는 고질적 패턴(세션
  3·8·10·16·22·24·26·27·28)이 재발한다. COLLAB.md 병합 정책("CI 초록이면 클로드 코드가 통합 가능")에
  근거해: (1) **#58을 main에 병합**(4a33970 — export에 `--tool`/`--project`/`--since`/`--until` 확장).
  (2) #58 병합으로 문서 충돌(dirty)이 된 **#59를 내 브랜치에 `cherry-pick -x`로 흡수**(BACKLOG/PROGRESS
  충돌은 양쪽 로그 보존으로 해소, 코드는 자동 병합 — 다른 브랜치엔 push 안 함).
- **한 일: `agentrelay status --since/--until` 시간 창 필터.** `stats`(세션 26)·`export`(세션 28)에는
  시간 차원이 있는데 `status`만 빠져 있던 비대칭을 메웠다. CLI `cli.ts`의 status 액션에 `--since`/`--until`
  (now−기간=createdFrom/createdTo, 기존 `parseDuration` 재사용)을 배선하고, 시간 창을 core `scopeJobs`로
  **먼저** 필터한 뒤 `selectJobs`(status/tool/project/sort/reverse)를 적용(창→선택 순서로 stats·export와
  동일 의미). 일회성·`--json`·`--watch` 세 뷰 모두에 동일 적용 — `runWatch`에 optional `window`를 추가해
  매 프레임 재적용(경계는 시작 시 고정된 절대 epoch-ms). 창이 전체를 걸러내면 `NO_MATCH_MESSAGE`, 파싱
  불가 기간·빈 범위(since<until)는 exit 1. **새 core 코드 0줄** — 기존 검증된 순수 함수 재사용.
  - 검증: `pnpm install`→`pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **392개 통과 + 1 skip**(core 265 + cli 124[+1 skip] + dashboard 3 — status.test.ts에
    window→select 파이프라인 3케이스 신규). **실제 빌드된 CLI e2e**(mock 아님): 30일전/3일전/1시간전
    3-job 스토어로 `status`(3행)·`--since 24h`(최근 gamma 1행)·`--since 7d --until 1d`(밴드 beta 1행)·
    `--since 24h --tool codex-cli`(AND gamma 1행)·`--since 30m`(NO_MATCH 문구)·`--json --since 24h`
    (total 1, gamma)·`--since bogus`(exit 1)·`--since 1d --until 7d`(빈 범위 exit 1) 확인.
- 다음 할 일: 대시보드가 스코프/시간 창 필터 UI 노출(👷 후보), stats 평균 대기시간(대기→재개 지연) 확장
  (👷 후보 — RelayJob에 중간 타임스탬프 추가 필요), `doctor` 데몬 실행 여부 검사(👷 후보),
  README/ARCHITECTURE(🧭 코워크).

### [세션 30 — `doctor` 재개 루프(daemon/tick) 생존 검사 + 하트비트 인프라] (2026-07-19, 무인 자율 세션, branch `claude/wizardly-pascal-hb7k2m`)
- **한 일: AgentRelay 최다 무음 실패("job은 큐에 있는데 아무것도 재개 안 됨")를 `doctor`가 잡게 했다.**
  기존 `doctor`는 node/store/writable/adapters/config/notify는 봤지만 **재개 루프가 실제로 살아있는지**는
  볼 수 없었다. job을 `waiting_for_reset`로 큐잉해도 데몬/cron `tick`이 안 돌면 리셋 시각이 지나도 아무도
  안 집어가 영원히 대기 — 이게 이 도구의 #1 혼란 지점.
  1. `@agentrelay/core/heartbeat.ts` 신설(순수): `DaemonHeartbeat`(pid·mode`daemon`/`tick`·startedAt·
     lastTickAt·pollIntervalMs) + `daemonHeartbeatPath`(스토어 옆 `daemon.json`) +
     `serialize/parseDaemonHeartbeat`(불량 JSON·배열/원시값·잘못된 필드는 null, mode 없으면
     pollIntervalMs>0→daemon/else→tick 추론=전방호환) + `heartbeatStaleAfterMs`(daemon=poll×3, 60s 하한
     / tick=15m 고정창 — cron 간격을 모르니 관대하게, 거짓 "안 돎"이 늦은 경고보다 나쁨).
  2. `doctor.ts`에 `HeartbeatFacts` + `daemon` 체크: **대기 job 수(`store.activeCount`)와 교차 판정** —
     대기 job 있는데 생존 루프 없음(부재/stale)=warning(그게 이 체크의 존재 이유), 생존 루프 있으면 ok,
     대기 job 없으면 부재=ok·stale=약한 warning. 순수 유지(시계·파일 미접촉) — CLI가 age/staleAfter 주입.
  3. `RelayScheduler`에 `onTick(referenceTime)` 콜백(매 tick 끝에서 autoprune 후 호출, 던진 에러는 삼켜
     릴레이 루프 보호). 파일 I/O는 스케줄러에 안 넣고 콜백으로 — "core 순수, CLI가 I/O" 컨벤션 유지.
  4. CLI `commands.ts`: `writeDaemonHeartbeat`(tmp+rename 원자적 → doctor가 반쯤 쓴 파일 안 읽음)·
     `removeDaemonHeartbeat`·`readHeartbeatFacts`(파싱→age/staleAfter 판정, 절대 throw 안 함). `startDaemon`이
     start시 1회 + `onTick` 매 tick 하트비트 쓰고 SIGINT/SIGTERM에 제거(크래시는 stale로 감지), one-shot
     `tick`은 tick-mode 하트비트 기록(cron 사용자도 생존 신호). `runDoctor`에 `nowMs` 주입(테스트 결정성).
  - 검증: `pnpm install`→`pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **420개 통과 + 1 skip**(core 286[+21: heartbeat 13·doctor daemon 6·scheduler onTick 2] +
    cli 131[+7: 하트비트 helper·doctor daemon 통합][+1 skip] + dashboard 3). **실제 빌드 CLI e2e**(mock 아님):
    대기 job+루프 없음→warning "no resume loop"·`tick` 후→"alive: tick"·`daemon --interval 1000` 후→
    "alive: daemon"·SIGTERM 클린 종료→`daemon.json` 제거 확인·stale 하트비트(10분 전)→"looks stopped" 경고·
    `--json` daemon 체크 형태 확인.
- 다음 할 일: 대시보드가 재개-루프 생존 상태 노출(👷 후보), stats 평균 대기시간(대기→재개 지연) 확장
  (👷 후보 — RelayJob에 중간 타임스탬프 추가 필요), README/ARCHITECTURE(🧭 코워크).

### [세션 31 — 대시보드에 재개-루프(하트비트) 생존 상태 노출] (2026-07-20, 무인 자율 세션, branch `claude/wizardly-pascal-2ksc89`)
- **한 일: 세션 30에서 `doctor`가 잡던 #1 무음 실패("job은 대기 중인데 아무도 재개 안 함")를 이제
  대시보드에서도 한눈에 보이게 했다.** 그동안 대시보드는 큐/카운트다운만 보여주고, 정작 재개 루프가
  살아있는지는 CLI `doctor`를 따로 돌려야만 알 수 있었다. 데몬이 죽었는데 대시보드는 "waiting_for_reset
  1"만 태연히 표시하는 게 최악의 함정.
  1. `@agentrelay/core/heartbeat.ts`에 순수 `evaluateHeartbeat(heartbeat|null, {nowMs, waitingJobs})` +
     `HeartbeatStatus`/`HeartbeatLiveness`(`alive`/`stale`/`absent`) 신설. `doctor`의 alive/stale 규칙
     (`ageMs <= staleAfterMs`)을 그대로 미러링해 두 표면이 판정에서 어긋나지 않게 하되, 메시지/힌트
     대신 UI가 자유롭게 렌더할 **구조화 데이터**를 반환. `concerning`(대기 job 있는데 루프 비생존)로
     "지금 문제인가"를 한 필드로 노출. 파싱 불가 `lastTickAt`은 stale(살아있단 증거 아님), 음수 대기수는
     0으로 floor. 순수 유지 — 시계·파일 미접촉(호출자가 nowMs·waitingJobs 주입).
  2. 대시보드 `lib/jobs.ts`: 스토어 옆 `daemon.json`을 읽어(core `daemonHeartbeatPath`·
     `parseDaemonHeartbeat`) `countActiveJobs`로 대기수를 세고 `evaluateHeartbeat`로 판정,
     `JobsSnapshot.heartbeat`에 실어 API가 매 폴링마다 반환. 파일 없음/깨짐/못 읽음은 모두 absent로
     흡수(절대 throw 안 함 — 첫 실행에도 렌더돼야 함). `generatedAt`과 하트비트 판정이 같은 `nowMs`를 씀.
  3. 대시보드 클라이언트: 에러 배너 아래 `ResumeLoopCard` — 상태별 색점(alive=good/stale=warning/
     absent=muted)+라벨, mode(daemon/tick)·pid·last tick age 디테일, `concerning`이면 좌측 경고 보더 +
     `agentrelay daemon`/`tick` 시작 힌트. `formatAge`(초~일). `globals.css`에 `.resume-loop*` 토큰
     기반 스타일(라이트/다크 자동).
  - 검증: `pnpm install`→`pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **432개 통과 + 1 skip**(core 294[+8: evaluateHeartbeat] + cli 131[+1 skip] +
    dashboard 7[+4: absent/concerning/alive/corrupt]). **실제 빌드 대시보드 e2e**(mock 아님):
    `next start` + `AGENTRELAY_STORE` 임시 스토어로 `/api/jobs` curl → 신선한 daemon 하트비트+대기 job 1개
    →`{state:alive, mode:daemon, pid, concerning:false}`, 하트비트 삭제→`{state:absent, waitingJobs:1,
    concerning:true}` 확인.
- 다음 할 일: stats 평균 대기시간(대기→재개 지연) 확장(👷 후보 — RelayJob에 중간 타임스탬프 필요),
  대시보드 자동 새로고침 표시/일시정지(👷 후보), README/ARCHITECTURE(🧭 코워크).

### [세션 32 — 누적 PR 대량 통합 + 중복 정리(20→소수)] (2026-07-20, 무인 자율 세션, branch `claude/wizardly-pascal-yak0ld`)
- **배경: 열린 PR이 20개까지 쌓이고 상당수가 서로 중복이었다.** main 브랜치 보호로 병합이 밀리면
  매시간 무기억 세션이 같은 후보를 반복 구현하는 이 저장소의 고질 패턴(세션 3·8·10·16·22·24·26~30)이
  최악으로 재발한 상태 — stats `--group-by` 5개(#80/#85/#86/#88/#91), 대시보드 재개-루프 4개
  (#72/#74/#76/#89), stats `--trend` 2개(#81/#90)가 각각 동일 기능. 새 21번째 PR을 더하는 것보다
  **CI 초록 PR을 통합하고 중복을 닫아 큐를 정리**하는 것이 압도적으로 높은 가치라 판단.
- **한 일:**
  1. **대시보드 재개-루프(하트비트) 생존 상태 노출 — #72를 main에 병합**(3a8a1b7). 세션 30의 하트비트
     인프라 후속으로, 대시보드가 `daemon.json`을 읽어 `evaluateHeartbeat`로 alive/stale/absent + concerning
     판정을 `ResumeLoopCard`로 노출. `mergeable_state:clean`·CI 초록 확인 후 병합(COLLAB 정책).
  2. **중복 PR 8건을 사유 코멘트와 함께 닫음** — 대시보드 그룹 #74/#76/#89(대표 #72 유지),
     stats `--group-by` 그룹 #85/#86/#88/#91(대표 #80 유지), stats `--trend` 그룹 #90(대표 #81 유지).
  3. **distinct한 CI-초록 PR 8건을 내 브랜치에 cherry-pick으로 통합**(문서 충돌은 통합 항목으로 일괄 정리):
     #80 stats `--group-by`, #73 status `--limit`, #79 `parse`, #82 cancel/retry `--all`, #83 `completion`,
     #84 config `set/unset`, #87 export `--format md`, #77 `notify test`. cli.ts import 충돌 3건(completion·
     config·notify)은 union으로 수동 해소, Biome organize-imports로 정렬 정규화.
  - 남겨둔 distinct PR(다음 세션): #81 stats `--trend`, #75 stats 재개 지연(둘 다 stats.ts를 #80과 겹쳐
     이번엔 대표 #80만 착지). #78은 코워크 roundup(사람/코워크 소관).
  - 검증: `pnpm install`→`pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
    `pnpm test` **543 통과 + 1 skip**(core 358 + cli 178[+1 skip] + dashboard 7). **실제 빌드된 CLI e2e**
    (mock 아님): `status --limit 2`(2행+"1 more not shown"), `stats --group-by tool`(claude-code 50%·
    codex-cli n/a), `export --format md`(마크다운 테이블), `config set/unset`(파일 갱신·기본값 복귀),
    `cancel --all --status waiting_for_reset --dry-run`(1건 스코프·미변경), `notify test`(채널 미설정 안내),
    `completion bash`(스크립트 출력) 확인.
- 다음 할 일: 남은 distinct PR(#81 trend, #75 latency) 통합, stats 평균 대기시간(RelayJob 중간 타임스탬프
  필요), README/ARCHITECTURE(🧭 코워크).

### [세션 32b — 2차 누적 PR 통합(ndjson/next/trend) + 잔여 중복 정리] (2026-07-20, 무인 자율 세션, branch `claude/wizardly-pascal-yak0ld`)
- **배경: 첫 PR 목록이 20개로 잘려 있어 못 봤던 더 오래된 열린 PR(#61~#71)에 2차 중복 무리가 있었다.**
  #66/#68(stats group-by 중복), #67(대시보드 재개-루프 중복), #65(notify test 중복), #63(stats trend 중복),
  #71(export ndjson 중복 — #70과) → 사유 코멘트와 함께 닫아 큐를 추가로 줄임.
- **한 일: distinct 신규 기능 3건을 내 브랜치에 cherry-pick으로 통합(2차)** — #70 export `--format ndjson`,
  #64 `agentrelay next`, #81 stats `--trend [days]`. 충돌 해소:
  - export.ts: 이미 통합된 #87(export md)의 `EXPORT_FORMATS`/디스패처와 ndjson을 union(`["csv","json","md","ndjson"]`).
  - cli.ts: import union 및 `stats` 명령이 `--group-by`와 `--trend`를 **공존**(group-by 지정 시 우선 반환, 그 외 stats+trend).
  - stats.ts(cli): `renderGroupedStats`와 `renderTrend` 두 함수를 각각 완결 형태로 재구성(충돌 마커가 공유 헬퍼를 뒤엉키게 한 것을 정리).
  - 테스트 파일(core/cli stats.test): 양쪽 describe 블록 모두 보존.
  - stats.ts core(`computeDailyTrend`)는 group-by와 다른 함수라 깔끔히 적용.
- **이번 세션 통합 제외(다음 세션)**: #61(doctor 큐 진행 검사)·#69(데몬 이중실행 가드)는 구버전 base라 세션 30의
  doctor/heartbeat 변경과 충돌 영역이 커 잘못 해소 시 회귀 위험 → 전용 세션에서 신중히 리베이스 권장. #75(stats
  resume latency)는 `RelayJob` 스키마 변경 포함이라 별도.
- 검증: `pnpm install`→`pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
  `pnpm test` **575 통과 + 1 skip**(core 375 + cli 193[+1 skip] + dashboard 7). **실제 빌드된 CLI e2e**(mock 아님):
  `next`(다음 재개 잡 한 줄)·`next --json`·`export --format ndjson`(줄단위 JSON)·`stats --trend 5`(UTC 일별 막대)·
  `stats --group-by tool`(공존 확인)·`stats --trend 999`(범위 밖 에러) 확인.
- 다음 할 일: #61(doctor 큐 진행)·#69(데몬 이중실행 가드)·#75(resume latency, 스키마) 통합, README/ARCHITECTURE(🧭 코워크).

### [세션 34 — 파서: 요일 기반 리셋 창(주간 사용량 한도) 인식] (2026-07-21, 무인 자율 세션, branch `claude/wizardly-pascal-tcu7ud`)
- **배경: 세션 시작 시 열린 PR 다수(#94~#100, #75, #69, #61)가 completion fish·stats `--by-hour`·
  export html·`wait`·config get·import·resume latency·데몬 가드·doctor 큐 진행을 이미 점유** 중이라,
  이들과 겹치지 않는 신규 개선 항목을 발굴했다. 코드를 읽던 중 **핵심 파서의 실제 갭**을 찾았다:
  기존 `clock-time` 패턴은 `"reset at <time>"`(요일 없이 바로 시각)만 매칭해, Claude Code의 **주간
  사용량 한도** 메시지에서 흔한 `"resets on Monday at 9am"`·`"resets Thursday 14:30"`·`"resets
  Wednesday"` 같은 **요일(day-of-week) 기반 리셋**을 전부 놓치고 있었다. 이 잡은 조용히 5시간
  fallback으로 잘못 큐잉되거나 아예 감지 실패했다. 파서는 이 제품의 심장이면서 어떤 열린 PR도 안
  건드리는 격리된 파일이라 최적의 대상.
- **한 일** (`packages/core/src/parser.ts`, 순수):
  1. `resolveWeekday(weekday, hour?, minute?, meridiem?, now)` + `WEEKDAY_INDEX` 신설 — 요일을 다음
     발생일로 해소(오늘이 그 요일이고 시각이 이미 지났으면 다음 주로 롤), 범위 밖 시각(hour>23/
     minute>59)·미지 요일은 클램프 대신 **null 반환**(malformed ISO와 동일 정책, fallthrough).
     시각대는 기존 `clock-time`과 동일하게 로컬 해석(문서화된 한계).
  2. **additive 패턴 2개**를 기존 패턴 뒤에 삽입 → 기존 매칭엔 **회귀 0**, 지금까지 null이던
     문자열만 새로 잡는다:
     - `weekday-clock`: `reset[s] (on)? <weekday> (at)? <h[:mm]> (am|pm)?` — 12/24h, `on`·`at` 옵션.
     - `weekday-only`: `reset[s] (on)? <weekday>` — 시각 없이 자정 폴백. `weekday-clock` **뒤에** 둬
       시각이 있으면 clock이 우선. 범위 밖 시각인 weekday-clock이 null이면 여기서 요일만이라도 건짐.
  3. 사전 필터 `LOOKS_LIKE_RATE_LIMIT`에 `resets?\s+(on|<weekday>)` 분기 추가 → `"usage limit"`
     문구가 근처에 없는 bare 요일 메시지(`"resets Monday at 9am"`)도 패턴 루프에 도달.
- 검증: `pnpm install`→`pnpm build` 클린(Next.js 포함), `pnpm ci:lint`(Biome) **0 경고/0 에러**,
  `pnpm test` **583 통과 + 1 skip**(core 383[+9: parser weekday] + cli 193[+1 skip] + dashboard 7).
  **실제 빌드된 CLI `parse` e2e**(mock 아님, 오늘=2026-07-21 화):
  `"Resets on Monday at 9am"`→weekday-clock·2026-07-27T09:00Z, `"resets Thursday"`→weekday-only·
  2026-07-23T00:00Z, `"resets Wednesday at 4pm"` `--json`→weekday-clock·2026-07-22T16:00Z,
  `"The standup meeting is on Monday."`→미감지(정상 종료) 확인.
- 다음 할 일: 요일+시각대(TZ) 인식 확장(현재 로컬 해석, 👷 후보), `"resets in N days"` 일 단위
  상대 기간(👷 후보), 누적 열린 PR(#94~#100 등) 통합(👷), README/ARCHITECTURE(🧭 코워크).
