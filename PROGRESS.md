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
