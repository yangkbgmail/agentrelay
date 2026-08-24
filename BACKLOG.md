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
- [x] 👷 최종 QA + 재현 가능한 데모 스크립트.
      (완료 — `scripts/demo.mjs` 신설: 실제 rate-limit을 기다리지 않고 전 경로
      run→감지→큐→`tick`→재개→`completed`를 로컬 몇 초 만에 재현하는 엔드투엔드 데모.
      스케줄러가 잡 `command`를 그대로 재실행하는 사실 위에서, 첫 실행만 `resets at <ISO>`로
      rate-limit을 흉내 내고(exit 1) 재개 실행은 성공하는(exit 0) 상태 기반 가짜 에이전트를
      격리 임시 스토어에 심는다. 단계별 내레이션 + `--reset/--keep/--quiet` 플래그, 마지막에
      최종 상태(잡 1개 completed)를 검증해 어긋나면 exit 1 → 스모크 QA/CI 프리플라이트 게이트
      겸용. `pnpm demo` 별칭 + `scripts/README.md`. 실제 실행으로 그린 확인(core 575·cli 313/1skip·
      dashboard 9 전 테스트 통과 유지). branch `claude/wizardly-pascal-demo-qa`)

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
- [x] 👷 자동 prune(daemon 주기 정리) — 별도 cron 없이 데몬이 매 tick 종료 job 정리.
      (완료 — `@agentrelay/core/prune.ts`에 `autoPruneOptionsFromEnv`(`AGENTRELAY_AUTOPRUNE` opt-in +
      `_AUTOPRUNE_AFTER` 나이 임계값[기본 7d, `0s`=전부] + `_AUTOPRUNE_KEEP` 최근 N개 보존)와
      `DEFAULT_AUTOPRUNE_AFTER_MS`(7d) 추가. `RelayScheduler`에 `autoPrune`/`onPrune` 옵션 →
      매 tick 종료 후 종료 상태 job만 정리(활성 job 불변), 실패는 삼켜 릴레이 루프 보호.
      CLI daemon/tick이 env로 배선, 데몬 배너에 "(auto-prune on)". branch `claude/wizardly-pascal-09q0tw`)
- [x] 👷 `agentrelay status` 필터/정렬 옵션 — 큰 큐에서 원하는 job만 보기.
      (완료 — `packages/cli/src/status.ts`에 순수 `selectJobs(jobs, {statuses, sort, reverse})`
      신설: 상태 필터(Set), 6개 정렬 필드(`created`/`updated`/`reset`/`project`/`status`/`attempts`)
      안정 정렬(원본 순서 tiebreak), null resetAt은 뒤로. CLI `status`에 `-s,--status`·`--sort`·
      `-r,--reverse` 플래그 추가, 일회성·`--json`·`--watch` 세 뷰 모두에 동일 적용. 잘못된
      status/sort는 exit 1, 필터가 스토어 전체를 걸러내면 온보딩 문구 대신 `NO_MATCH_MESSAGE`.
      status.test.ts에 selectJobs 10케이스 추가, 빌드된 CLI e2e로 3-job 스토어 검증.
      branch `claude/wizardly-pascal-v1gjni`)
- [x] 👷 자동 prune 스로틀 — 매 tick이 아닌 지정한 시간 간격마다만 정리.
      (완료 — `@agentrelay/core/prune.ts`에 순수 `shouldAutoPrune(lastRunMs, nowMs, everyMs?)`
      (스로틀 없음/첫 패스는 즉시 실행, 그 외 `everyMs` 경과 후에만) + `autoPruneEveryMsFromEnv`
      (`AGENTRELAY_AUTOPRUNE_EVERY` 기간 파싱, 미설정/파싱불가/비양수는 null=스로틀 없음 → 오타가
      정리를 조용히 끄지 않음) 추가. `RelayScheduler`에 `autoPruneEveryMs` 옵션 + 인메모리
      `lastPruneAtMs` 마커(패스가 실제 실행될 때만 전진, 정리 결과 무관). fast-poll 데몬이 매 tick
      스토어를 재기록하지 않음. CLI daemon이 env로 배선, 배너에 "(auto-prune on, every Ns)".
      one-shot `tick`은 프로세스마다 마커가 없어 스로틀 무효(문서화). branch
      `claude/wizardly-pascal-ikh508`)
- [x] 👷 자동 prune tick-count 스로틀 — 시간뿐 아니라 tick 횟수 기준으로도 정리 간격 지정.
      (완료 — `@agentrelay/core/prune.ts`에 순수 `shouldAutoPruneByTicks(tickIndex, everyTicks?)`
      (스로틀 없음/`≤0`이면 항상 실행, 그 외 `tickIndex % everyTicks === 0` → 첫 tick[index 0]과
      이후 매 N tick) + `autoPruneEveryTicksFromEnv`(`AGENTRELAY_AUTOPRUNE_EVERY_TICKS` 양의
      정수 파싱; 미설정·비숫자·비양수는 null=스로틀 없음 → 오타가 정리를 조용히 끄지 않음, 소수는
      floor) 추가. `RelayScheduler`에 `autoPruneEveryTicks` 옵션 + 인메모리 `pruneTickCounter`
      (매 tick 전진). 시간 스로틀(`autoPruneEveryMs`)과 **AND** 결합 — 둘 다 설정 시 양쪽 게이트가
      모두 허용할 때만 정리. 시간 마커는 실제 패스 실행 때만, tick 카운터는 매 tick 전진.
      CLI daemon이 env로 배선, 배너에 "every N tick(s)"(+시간과 함께면 " + "로 결합). one-shot
      `tick`은 프로세스마다 카운터가 리셋돼 스로틀 무효(문서화). branch `claude/wizardly-pascal-adfx5s`)
- [x] 👷 `agentrelay stats` — 큐 통계 요약(릴레이 효과 한눈에 보기).
      (완료 — `@agentrelay/core/stats.ts`에 순수 `computeStats(jobs)` + `RelayStats` 신설:
      active(queued+waiting+resuming)/terminal(completed+failed+cancelled) 분리, successRate
      (completed/(completed+failed), cancelled 제외, 미해결 시 null), totalAttempts·retriedJobs
      (attempts>1), byTool(고정 툴셋 zero-fill, 미지 툴은 키 안 만듦), byStatus·nextResetAt은
      `summarizeJobs` 재사용, projects(count desc·이름 asc 랭킹). CLI `packages/cli/src/stats.ts`에
      순수 `renderStats`(사람용 블록)·`renderStatsJson`(--json)·`formatSuccessRate`, `agentrelay stats
      [--json]` 커맨드 배선. branch `claude/wizardly-pascal-iiom6v`)
- [x] 👷 설정 파일 지원(`agentrelay.config.json`) — 매번 env var 재설정 없이 기본값 영속화.
      (완료 — `@agentrelay/core/config.ts` 신설: `AgentRelayConfig`(store/notify/retry/autoPrune 그룹,
      전부 optional) + `parseConfig`(구조 검증, 잘못된 타입은 경로 표기 에러 throw, 미지 키는 무시=전방호환) +
      `configToEnv`(모든 필드를 기존 `AGENTRELAY_*` env var로 1:1 투영 — 유일 매핑 지점) +
      `resolveConfigPath`(명시 path/`AGENTRELAY_CONFIG`→`./agentrelay.config.json`→`~/.agentrelay/config.json`) +
      `loadConfigFile`(없으면 null, 명시했는데 없거나 JSON 깨지면 명확한 에러) + `applyConfigToEnv`(이미
      설정된 env는 덮지 않음 → **env/CLI > 설정파일 > 기본값** 우선순위). 기존 `*FromEnv` 헬퍼를 전부
      재사용 — CLI `bin.ts`가 buildCli 전에 `bootstrapConfig()`로 설정을 process.env에 채우고, 프로그램에
      `--config <path>` 옵션 추가. branch `claude/wizardly-pascal-ohoon1`)
- [x] 👷 손상된 스토어 파일 보존/복구 — `jobs.json`이 깨졌을 때 조용히 덮어써 유실하지 않고
      백업으로 보존.
      (완료 — 기존 `RelayQueue.load()`는 손상 파일을 만나면 빈 맵으로 시작하며 "파일을 그대로
      남긴다"고 주석에 적었지만, 실제로는 다음 `flush()`가 손상 파일을 **덮어써 영구 파괴**하는
      버그가 있었다. `queue.ts`에 순수 `corruptBackupPath(filePath, now)`(파일시스템-safe 타임스탬프
      접미사) 추가 + `load()`가 파싱 불가 파일을 **먼저** `jobs.json.corrupt-<타임스탬프>`로 rename해
      보존한 뒤 빈 큐로 계속 진행. 비배열 JSON 루트도 손상으로 취급, 빈/공백 파일은 정상 "빈 큐"로
      구분(백업 안 함). `RelayQueue`에 `onCorrupt` 콜백 옵션 추가 → CLI가 공용 `openQueue` 헬퍼로
      모든 커맨드에서 stderr 경고 출력. rename 실패(권한/크로스디바이스)는 삼켜 릴레이 루프 보호.
      branch `claude/wizardly-pascal-2gm0z9`)
- [x] 👷 `agentrelay stats` 해결 시간(resolution time) 지표 — 릴레이가 잡을 얼마나 오래 돌봤는지.
      (완료 — `@agentrelay/core/stats.ts`에 `TimingStats`(resolvedCount·avg/min/maxResolutionMs) 추가.
      completed+failed 잡의 라이프사이클 span(`updatedAt-createdAt`)을 집계 — cancelled(사용자 취소)와
      비종료 잡은 제외(successRate와 동일 정책), 타임스탬프 파싱 불가·음수 span(클럭 스큐)은 클램프
      대신 스킵. CLI `stats.ts`에 순수 `formatDurationMs`(초~일, 2단위 "4h 12m"/"3d 2h") + `renderStats`가
      resolved 잡이 있을 때만 "resolution time" 블록 렌더, `--json`은 timing 그대로 전달.
      branch `claude/wizardly-pascal-qb3468`)
- [x] 👷 `agentrelay config init` — 문서화된 샘플 설정 파일 생성(빈 파일 손 작성 갭 메움).
      (완료 — `@agentrelay/core`에 순수 `sampleConfig()`(모든 그룹을 기본값으로 채운 예시,
      autoPrune.enabled=false로 안전) + `sampleConfigJson()`(2-스페이스 pretty JSON, `parseConfig`
      왕복 무손실). CLI `initConfig({path,cwd,force})` — 기본 `<cwd>/agentrelay.config.json`에
      쓰되 기존 파일은 `--force` 없이 안 덮음(exit 1), 부모 디렉터리 자동 생성. `agentrelay config
      init [path] [-f]` 서브커맨드. 부수 수정: `paths.ts`에 `expandTilde` 추가 →
      `defaultStorePath`가 설정파일 store의 선행 `~`를 홈으로 확장(쉘 미경유 경로 footgun 제거).
      branch `claude/config-init`)
- [x] 👷 `agentrelay config validate` — 설정 파일 검증(구조+의미). 잘못된 값을 실행 전에 잡음.
      (완료 — `@agentrelay/core/config.ts`에 순수 `validateConfig(config)` + `ConfigIssue`/
      `ConfigIssueLevel` + `hasConfigErrors` 추가. `parseConfig`는 타입만 보는데, 이 함수는 타입은
      맞지만 무의미한 값을 잡는다: 음수/비정수 `maxAttempts`·`baseDelayMs`·`maxDelayMs`·`keep`·
      `everyTicks`(error), 1 미만 `factor`(백오프가 줄어듦, error), 파싱 불가 `after`/`every`
      duration(error), http(s) 아닌 `webhookUrl`(error), URL 아닌 `slackWebhook`(warning),
      빈 store(warning), maxDelayMs<baseDelayMs(warning). CLI `validateConfigFile({path,cwd,env})`가
      파일 해소→읽기→JSON.parse→parseConfig→validateConfig를 throw 없이 통합해 모든 문제를 한 번에
      리포트, error 있으면 exit 1(warning만이면 exit 0). `agentrelay config validate [path]` 서브커맨드.
      부수: bin.ts가 `config validate` 호출 시 startup `bootstrapConfig`(깨진 설정에 throw)를 건너뛰어,
      바로 그 깨진 파일을 진단할 수 있게 함. branch `claude/wizardly-pascal-kgd08a`)
- [x] 👷 `agentrelay show <id>` — 단일 job 전체 상세(명령어·cwd·타임스탬프·에러·출력 tail).
      (완료 — `status` 테이블은 큐 전체를 요약하느라 8자 id·잘린 project만 보여줘 개별 job을
      깊게 들여다볼 방법이 없었다. `packages/cli/src/show.ts` 신설: 순수 `renderJobDetail(job,
      {now,color})`(전체 id·project·tool·status[색상]·읽기 좋은 command 라인·cwd·created/updated
      [라이프사이클 span 주석]·resets in[카운트다운+절대시각]·attempts, lastError/lastOutputTail은
      있을 때만 블록 렌더) + `formatCommand`(공백·따옴표·빈 인자 안전 인용, 복붙 가능한 에코) +
      `renderJobDetailJson`(--json). `commands.ts`에 read-only `showJob(idOrPrefix, store)` —
      `resolveJobId` 재사용(짧은 prefix·모호/미존재 처리 cancel/retry와 동일), 스토어 불변.
      CLI `agentrelay show <id> [--json]` 배선, 미존재/모호 id는 exit 1. show.test.ts 12케이스 +
      commands.test.ts showJob 2케이스. branch `claude/wizardly-pascal-y5jh3b`)
- [x] 👷 `doctor` 재개 루프(daemon/tick) 생존 검사 — "job은 큐에 있는데 아무것도 재개 안 됨"
      최다 무음 실패를 잡음.
      (완료 — `@agentrelay/core/heartbeat.ts` 신설(순수): `DaemonHeartbeat`(pid·mode·startedAt·
      lastTickAt·pollIntervalMs) + `daemonHeartbeatPath`(스토어 옆 `daemon.json`) +
      `serialize/parseDaemonHeartbeat`(불량 JSON·잘못된 필드는 null, mode 없으면 pollIntervalMs로
      daemon/tick 추론) + `heartbeatStaleAfterMs`(daemon=poll×3, 60s 하한 / tick=15m 고정창).
      `doctor.ts`에 `HeartbeatFacts` + `daemon` 체크 추가: **대기 job 수와 교차 판정** — 대기 job이
      있는데 생존 루프 없음(부재/stale)=warning, 생존 루프 있으면 ok, 대기 job 없으면 부재도 ok.
      `RelayScheduler`에 `onTick(referenceTime)` 콜백(매 tick 끝, 에러 삼킴). CLI `commands.ts`에
      `writeDaemonHeartbeat`(tmp+rename 원자적)·`removeDaemonHeartbeat`·`readHeartbeatFacts`. daemon은
      start+매 tick 하트비트 쓰고 SIGINT/SIGTERM에 제거(크래시는 stale로 감지), one-shot `tick`은
      tick-mode 하트비트 기록(cron 사용자도 생존 신호). `runDoctor`가 `nowMs` 주입 가능(테스트용).
      heartbeat.test.ts 13 + doctor daemon 6 + scheduler onTick 2 + CLI 7케이스, 실제 빌드 CLI로
      before/after·daemon 수명주기·stale 경고 e2e 검증. branch `claude/wizardly-pascal-hb7k2m`)
- [ ] 🧭 경쟁 도구(claude-auto-retry 등) 심층 조사 → 차별화 포인트 문서화.
- [ ] 🧭 실제 rate-limit 메시지 샘플 수집 → 파서 패턴 보강 제안.
- [ ] 🧭 성능/효율화 분석(파일 I/O, 대량 job) → 최적화 항목 도출.

- [x] 👷 `agentrelay stats` 해결 시간 백분위수(median/p90) — avg/min/max만으론 안 보이는
      전형 케이스와 꼬리 지연 노출.
      (완료 — `@agentrelay/core/stats.ts`의 `TimingStats`에 `medianResolutionMs`(p50)·
      `p90ResolutionMs` 추가. 순수 `percentile(sortedAsc,p)`(선형보간, NumPy 기본/"type 7":
      rank=p·(n−1), 두 표본 보간, ms 반올림). `computeStats`가 resolution 스팬을 한 번만
      오름차순 정렬 → min/max는 양끝, median/p90은 `percentile`. resolved 0개면 둘 다 null.
      CLI `stats.ts` resolution-time 블록에 `median … p90 …` 라인, `--json`은 자동 노출.
      branch `claude/wizardly-pascal-yfv19e`)
- [x] 👷 `agentrelay export` — 잡 이력을 CSV/JSON으로 내보내 스프레드시트/BI/`jq` 분석.
      (완료 — `@agentrelay/core/export.ts` 신설(순수·파일시스템 미접촉): RFC 4180
      `escapeCsvField`(콤마/쌍따옴표/개행 인용·따옴표 이중화), `JOB_CSV_COLUMNS`(필터·정렬용
      필드 순서), `jobCsvValue`(command 공백 조인·null은 빈칸), `jobsToCsv`(빈 스토어도 헤더
      유지, LF), `jobsToJson`(2-스페이스 pretty·command 배열까지 무손실 왕복), `EXPORT_FORMATS`/
      `exportJobs` 디스패처. CSV=평면·가독, JSON=정확·무손실 역할 분리. CLI `commands.ts`
      `exportStore`(스토어 읽기+선택적 파일 쓰기[trailing newline 부착]만, 나머지는 core 위임),
      `cli.ts` `agentrelay export` 커맨드: `-f/--format csv|json`·`-o/--out`·`-s/--status`·
      `--sort`·`-r/--reverse`(status의 `selectJobs` 재사용). 파일 출력 시 상태는 stderr(stdout
      청정), 잘못된 format/status/sort는 exit 1. branch `claude/wizardly-pascal-cjcfb7`)

- [x] 👷 스토어 백업 + 로테이션(`agentrelay backup`) — 유일한 데이터(`jobs.json`)의 시점 스냅샷.
      (완료 — `@agentrelay/core/backup.ts` 신설: 순수 `backupFilePath`(fs-safe·정렬가능 ISO 타임스탬프
      `jobs.json.backup-<ts>`)·`backupStamp`(이 스토어의 백업만 스탬프 추출, `.corrupt-`/`.tmp-`/원본
      제외)·`listBackups`(최신순 정렬)·`selectRotatableBackups`(newest N 보존, 나머지 삭제 대상; keepLast≤0은
      전부, 소수 floor) + `BackupResult`. `RelayQueue.backup({keepLast,now})`가 현재 온-디스크 상태를
      원자적(temp+rename)으로 `.backup-<ts>`에 스냅샷(빈 스토어도 유효한 `[]`) 후 `.backup-*`만 로테이션 —
      원본/`.corrupt-`/`.tmp-`는 절대 안 건드리고 방금 만든 스냅샷은 keepLast:0에서도 보존, 삭제 실패는
      삼켜 릴레이 보호. CLI `agentrelay backup [--keep N] [--list]` + `backupStore`/`listStoreBackups`.
      branch `claude/wizardly-pascal-283n3i`)

- [x] 👷 `agentrelay config show` — 유효 설정과 각 값의 출처(env/설정파일/기본값) 표시.
      (완료 — `@agentrelay/core/config.ts`에 순수 `resolveEffectiveConfig(fileConfig, env)` +
      `EffectiveConfigEntry`/`ConfigValueSource`/`ConfigGroup` + `CONFIG_ENV_KEYS`(configToEnv와
      동기화, 테스트로 드리프트 방지, 웹훅 URL/토큰은 secret 플래그) 신설: 각 `AGENTRELAY_*`를
      env>파일>기본값으로 해소해 출처 귀속(applyConfigToEnv의 읽기 전용 미러). CLI `showConfig`
      (손상 파일은 throw 대신 loadError로 보고, env/기본값 해소는 계속) + 순수 `renderEffectiveConfig`
      (그룹별 정렬 표, 시크릿 마스킹 + `--show-secrets`)·`renderEffectiveConfigJson`(`--json`).
      `agentrelay config show` 서브커맨드. 부수 버그 수정: startup bootstrap이 파일 값을
      process.env에 주입해 출처를 [env]로 오표기하던 문제 → `isConfigDiagnosticInvocation`으로
      validate+show 모두 startup-skip, `--config <path>` 뒤 경로 값을 커맨드로 오인하던 argv
      파서 버그도 `subcommandTokens`로 교정. branch `claude/wizardly-pascal-dgs7go`)

- [x] 👷 `agentrelay restore <snapshot>` — 스냅샷에서 스토어 복원(`backup`의 역연산).
      (완료 — `@agentrelay/core/backup.ts`에 순수 `resolveBackup(fileNames, storeFileName, selector)`
      (`latest`/빈 문자열→최신, 스냅샷 basename, 정렬가능 stamp 매칭; 미매칭·타 스토어·백업 없음은 null) +
      `RestoreResult` 추가. `RelayQueue.restore({from,backupCurrent,now})`가 스냅샷을 **먼저 검증**
      (JSON 배열이 아니면 throw — 라이브 스토어 미변경)한 뒤, 기본적으로 현재 스토어를 `.backup-<ts>`로
      스냅샷(복원 자체를 되돌릴 수 있게)하고 원자적으로 교체. CLI `restoreStore`/`resolveRestoreSource`
      (직접 파일 경로 우선, 아니면 이 스토어의 `.backup-*`를 selector로 해소, 미매칭은 명확한 에러) +
      `agentrelay restore [snapshot] [--no-backup]` 서브커맨드(미매칭 selector는 exit 1). branch
      `claude/wizardly-pascal-5bxk7l`)

- [x] 👷 `agentrelay stats` 필터/스코프 옵션(`--status`/`--tool`/`--project`) — 큐 전체가 아닌
      특정 프로젝트·툴·상태 부분집합의 지표만 보기.
      (완료 — `@agentrelay/core/stats.ts`에 순수 `scopeJobs(jobs, {statuses,tools,projects})`
      (차원 간 AND·차원 내 OR, 미지정 차원은 필터 안 함, 항상 새 배열 반환) + `isJobScopeActive`
      추가. tool은 원시 문자열로 매칭(미지 tool 문자열도 정확히 필터). CLI `stats`에 `-s/--status`·
      `-t/--tool`·`-p/--project` 배선(공용 `splitList` 헬퍼로 콤마 분리), 잘못된 status/tool은
      exit 1. `renderStats`에 `scopeNote` 옵션(활성 시 "scope: …" 라인 + 스코프가 스토어 전체를
      걸러내면 온보딩 문구 대신 `NO_SCOPE_MATCH_MESSAGE`), `renderStatsJson`은 활성 스코프를
      `scope` 필드로 에코. 부수 버그 수정: `queue.ts`의 리스트 정렬 comparator가 동시각(same-ms)
      타이에서 0을 안 돌려주는 비대칭 비교였음 → 부하에 따라 export 테스트가 간헐 실패(pre-existing
      flaky). `compareJobsNewestFirst`(createdAt desc, id asc 타이브레이크)로 결정론화 + export
      테스트의 인덱스 의존 단언을 순서 무관으로 교체. branch `claude/wizardly-pascal-ru3nmz`)

- [x] 👷 `agentrelay doctor` — 셋업 건강 진단(Node 버전·잡 스토어·설정 파일·알림 채널을 한 번에 점검).
      (완료 — `@agentrelay/core/doctor.ts` 신설: 순수 판정 계층 `runDiagnostics(input)` +
      `DiagnosticReport`/`DiagnosticCheck`(ok/warning/error·fix 힌트)·`counts`·`ok`. 파일시스템/env를
      만지지 않고 이미 수집된 사실(nodeVersion·store·config·notify)만 판정 — 네 검사: node(engines
      `>=22.5` 하한, `parseNodeVersion`/`isSupportedNode`·`MIN_NODE_*`), store(corrupt=error·부재=OK
      "첫 실행 시 생성"·활성 잡 수 표기), config(loadError=error·validateConfig error/warning 전달·
      파일 없음=OK), notify(채널 0개=warning[선택사항]·공백값 무시). `countActiveJobs` 헬퍼. CLI
      `commands.ts`에 `runDoctor`(스토어 존재 여부를 큐 오픈 **전**에 캡처해 corrupt가 부재로 오인되지
      않게, config는 loadConfigFile+validateConfig, notify는 env에서 수집; 절대 throw 안 함) +
      `packages/cli/src/doctor.ts`에 순수 `renderDoctor`(색상 체크리스트+요약)·`renderDoctorJson`.
      `agentrelay doctor [--json]` 커맨드, 검사 실패 시 exit 1(CI/pre-flight 게이트로 사용 가능).
      부수: 타이밍에 따라 흔들리던 export.test.ts의 순서 의존 단언을 순서 무관으로 안정화(listAll이
      createdAt 내림차순 정렬이라 같은 ms 삽입 시에만 통과하던 flaky 테스트). branch
      `claude/wizardly-pascal-5rqier`)

- [x] 👷 `agentrelay restore --dry-run` — 복원 전 무엇이 바뀔지 미리보기(라이브 스토어 미변경).
      (완료 — `restore`가 되돌리기 어려운 파괴적 연산이라, 실행 전 "이 스냅샷을 복원하면 몇 개
      job이 현재 몇 개를 대체하고 안전 백업이 만들어지는가"를 안전하게 확인하는 수단이 없었다.
      `@agentrelay/core/backup.ts`에 `RestorePreview`(from·jobCount·currentJobCount·wouldBackUp)
      타입 추가. `RelayQueue.previewRestore({from,backupCurrent})`가 실제 `restore`와 **동일한 검증**
      (스냅샷 읽기+JSON 배열 체크 → 깨진 스냅샷은 미리보기에서도 throw)을 거치되, 라이브 스토어는
      읽기만(대체될 현재 job 수 집계) 하고 절대 쓰지 않음. CLI `commands.ts`에 read-only
      `previewRestoreStore`(선택자 해소는 `restoreStore`와 공유), `cli.ts` `restore`에 `--dry-run`
      플래그 배선(백업 여부·대체 job 수를 리포트하고 "No changes made"로 종료, 미매칭 selector는
      exit 1). branch `claude/wizardly-pascal-atytw7`)

- [x] 👷 `agentrelay status` 스코프 필터(`--tool`/`--project`) — `stats`와 동일한 부분집합
      필터를 status 테이블/`--json`/`--watch`에도 제공.
      (완료 — `packages/cli/src/status.ts`의 `JobSelection`에 `tools?`/`projects?` 추가,
      `selectJobs`가 status·tool·project를 차원 간 AND·차원 내 OR로 필터(항상 새 배열, 정렬/역순
      전에 적용). tool은 원시 문자열 매칭(미지 tool도 정확히 걸러냄). 순수 `isSelectionFiltering`
      (core `isJobScopeActive`의 status 버전) export. CLI `status`에 `-t/--tool`·`-p/--project`
      배선(공용 `splitList` 재사용, 잘못된 status/tool은 exit 1), 일회성·`--json`·`--watch` 세 뷰에
      동일 `selection` 적용. status.test.ts에 selectJobs tool/project/AND 5 + isSelectionFiltering 2
      신규. branch `claude/wizardly-pascal-6st1ab`)

- [x] 👷 `agentrelay stats --since/--until` 시간 창(time-window) 필터 — 최근 N일/시간에
      생성된 잡의 지표만 보기(추세 파악).
      (완료 — `@agentrelay/core`의 `JobScope`에 `createdFrom`/`createdTo`(epoch ms, 양끝 포함)
      차원 추가 — 클럭/기간이 아닌 명시 타임스탬프라 `scopeJobs`가 순수·테스트 가능 유지.
      `scopeJobs`가 `createdAt`을 파싱해 창 안의 잡만 남기고, 파싱 불가/누락 `createdAt`은
      시간 창이 활성일 때 제외(타임라인에 놓을 수 없으므로). `isJobScopeActive`가 시간 경계
      (0=falsy epoch 포함)도 활성으로 인식. CLI `stats`에 `--since <기간>`(now−기간=createdFrom)·
      `--until <기간>`(now−기간=createdTo, 창의 오래된 쪽 경계) 배선 — 기존 `parseDuration`
      재사용, 잘못된 기간/빈 범위(since<until)는 exit 1, scope note에 `since=…`/`until=…`,
      `--json`은 scope에 createdFrom/createdTo 에코. stats.test.ts에 6케이스 추가.
      branch `claude/wizardly-pascal-9uyktw`)

- [x] 👷 `agentrelay doctor` 어댑터 바이너리 PATH 검사 — 대기 중인 잡이 재개될 때 spawn할
      에이전트 바이너리(`command[0]`)가 PATH에 있는지 점검(가장 흔한 "재개가 조용히 실패" 원인).
      (완료 — 스케줄러는 재개 시 `job.command[0]`을 spawn하는데, 그 바이너리가 PATH에 없으면
      모든 재개가 실패했다. `doctor`는 지금까지 이를 잡지 못했다. `@agentrelay/core/doctor.ts`에
      `BinaryFact`(binary·found·resolvedPath·neededBy)·`AdapterFacts` 타입 + `DiagnosticInput.adapters`
      추가, 순수 `distinctActiveBinaries(jobs)`(활성 잡의 distinct `command[0]`+카운트, 종료 잡·빈
      command 제외, 첫 등장 순서 보존) 신설. `runDiagnostics`에 `adapters` 검사 추가(node→store→
      **adapters**→config→notify): 대기 잡 없으면 OK(점검 대상 없음), 전부 PATH에 있으면 OK(해석 경로
      표시), 하나라도 없으면 error("M of N … not on PATH" + `which <bin>` 힌트, 재개 실패 경고).
      CLI `commands.ts`에 `which`식 `resolveOnPath`(PATH 스캔, Windows PATHEXT 대응, 경로 포함
      바이너리는 직접 확인) + `isExecutableFile`(statSync isFile + accessSync X_OK) 신설, `runDoctor`가
      활성 잡 바이너리를 각각 PATH 해석해 `AdapterFacts` 구성. 검사 실패 시 exit 1(CI/pre-flight 게이트).
      core doctor 6 + cli doctor 3 신규 테스트, 실제 빌드 CLI e2e로 PATH 부재→error/존재→ok 검증.
      branch `claude/wizardly-pascal-66cnzs`)

- [x] 👷 `agentrelay export` 스코프 필터 확장(`--tool`/`--project`/`--since`/`--until`) — `stats`·`status`와
      동일한 부분집합·시간 창 필터를 export에도 제공해, 스코프한 그대로 CSV/JSON으로 내보내기.
      (완료 — 기존 export는 `--status`/`--sort`/`--reverse`만 지원해 특정 툴·프로젝트·기간의 잡만
      내보낼 수 없었다. CLI `cli.ts`의 export 액션에 `-t/--tool`·`-p/--project`(공용 `splitList` +
      `selectJobs`의 tools/projects 재사용)와 `--since`/`--until`(now−기간=createdFrom/createdTo,
      기존 `parseDuration` 재사용) 배선. 시간 창은 core `scopeJobs`로 **먼저** 필터한 뒤
      status/tool/project/sort/reverse를 `selectJobs`로 적용(선정렬 후 창 아님 — 창→선택 순서로
      stats와 동일 의미). 잘못된 tool/status/sort·파싱 불가 기간·빈 범위(since<until)는 exit 1.
      순수 로직은 전부 기존에 검증된 `selectJobs`(status.ts)·`scopeJobs`(stats.ts) 재사용이라 새
      core 코드 0줄, export.test.ts에 조합 파이프라인 회귀 2케이스 추가 + 빌드된 CLI e2e로
      tool/project AND·시간 창·에러 exit 검증. branch `claude/wizardly-pascal-xqzyk6`)

- [x] 👷 `agentrelay doctor` 스토어 디렉터리 쓰기 권한 검사 — 스토어가 읽히더라도 매 `flush()`가
      쓰기 실패하면 잡 상태 변경이 조용히 유실된다(PATH 다음으로 흔한 "재개 조용히 실패" 원인).
      (완료 — `@agentrelay/core/doctor.ts`에 `WritableFacts`(dir·writable·willCreate·error) 타입 +
      `DiagnosticInput.writable` 추가, 순수 `writableCheck` 신설(검사 순서 node→store→**store-writable**→
      adapters→config→notify): 쓰기 가능=OK(디렉터리 미존재면 "부모가 쓰기 가능, 첫 실행 시 생성"),
      쓰기 불가=error(OS 에러 텍스트 표기 + `AGENTRELAY_STORE` 재지정 힌트). CLI `commands.ts`에
      `probeStoreWritable`(실제 throwaway 파일 write+rm — 권한 비트뿐 아니라 read-only 마운트·풀
      디스크까지 잡음, 스토어 dir 미존재 시 `nearestExistingDir`로 가장 가까운 존재 조상을 프로브,
      절대 throw 안 함) 신설, `runDoctor`가 **큐 오픈 전**에 프로브(RelayQueue 생성자가 dir을 mkdir하므로
      순서 중요). 부수 견고화: RelayQueue 생성이 dir 생성 불가(부모가 파일·권한 거부·read-only)로 throw할
      때 `runDoctor`가 크래시하던 것을 try/catch로 감싸 store-writable error로 진단 리포트(doctor "절대
      throw 안 함" 계약 유지). core doctor 5 + cli doctor 4(1 skip: root는 권한 비트 우회) 신규 테스트,
      실제 빌드 CLI e2e로 쓰기 가능→ok/디렉터리 미존재→"will be created"/ENOTDIR→error+exit 1 검증.
      branch `claude/wizardly-pascal-nbitfy`)

- [x] 👷 `agentrelay status --since/--until` 시간 창 필터 — `stats`(세션 26)·`export`(세션 28)에는
      있지만 `status`에는 없던 시간 차원을 추가해, 큰 큐에서 최근 N일/시간에 생성된 잡만 라이브로 보기.
      (완료 — `status`는 `--status`/`--tool`/`--project`만 지원해 시간 창 스코프가 세 형제 명령 중 유일하게
      빠져 있었다. CLI `cli.ts`의 status 액션에 `--since`/`--until`(now−기간=createdFrom/createdTo, 기존
      `parseDuration` 재사용) 배선. 시간 창은 core `scopeJobs`로 **먼저** 필터한 뒤 status/tool/project/
      sort/reverse를 `selectJobs`로 적용(창→선택 순서로 stats·export와 동일 의미). 일회성 테이블·`--json`·
      `--watch` 세 뷰 모두에 동일 적용 — `runWatch`에 optional `window` 인자를 추가해 매 프레임 재적용
      (경계는 명령 시작 시 고정된 절대 epoch-ms라 라이브 쓰기는 계속 반영). 창이 스토어 전체를 걸러내면
      온보딩 문구 대신 `NO_MATCH_MESSAGE`. 파싱 불가 기간·빈 범위(since<until)는 exit 1. 새 core 코드
      0줄 — 전부 기존 검증된 `scopeJobs`(stats.ts)·`selectJobs`(status.ts) 재사용. status.test.ts에
      window→select 파이프라인 회귀 3케이스 추가 + 빌드된 CLI e2e로 시간 창·AND·NO_MATCH·JSON·에러 exit
      검증. branch `claude/wizardly-pascal-uxx5os`)

- [x] 👷 대시보드에 재개-루프(하트비트) 생존 상태 노출 — CLI `doctor` 없이도 데몬/tick이 살아있는지
      대시보드에서 바로 확인. 세션 30의 하트비트 인프라 후속.
      (완료 — `@agentrelay/core/heartbeat.ts`에 순수 `evaluateHeartbeat(heartbeat|null,{nowMs,waitingJobs})` +
      `HeartbeatStatus`/`HeartbeatLiveness`(alive/stale/absent) 신설. `doctor`의 alive/stale 규칙
      (`ageMs<=staleAfterMs`)을 미러링해 두 표면 판정이 일치하되, 메시지 대신 UI가 렌더할 구조화 데이터
      반환 + `concerning`(대기 job 있는데 루프 비생존) 필드. 파싱 불가 lastTickAt=stale, 음수 대기수=0 floor.
      대시보드 `lib/jobs.ts`가 스토어 옆 `daemon.json`을 읽어 `countActiveJobs`+`evaluateHeartbeat`로
      판정→`JobsSnapshot.heartbeat`에 실어 API가 매 폴링 반환(파일 없음/깨짐은 absent로 흡수, throw 없음).
      클라이언트에 `ResumeLoopCard`(상태별 색점·mode·pid·last tick age, concerning이면 경고 보더+
      `agentrelay daemon`/`tick` 힌트)+`.resume-loop*` CSS. core 8 + dashboard 4 신규 테스트, 실제 빌드
      대시보드 `next start`+임시 스토어 `/api/jobs` curl로 alive/absent-concerning e2e 검증.
      branch `claude/wizardly-pascal-2ksc89`)

- [x] 👷 `agentrelay stats --group-by <tool|project|status>` — 큐 전체가 아니라 툴/프로젝트/상태
      부분집합별로 릴레이 효과(성공률·해결 시간 등)를 나눠 비교.
      (완료 — core `stats.ts`에 순수 `groupStats`/`GROUP_DIMENSIONS`/`GroupDimension`, CLI `stats.ts`에
      `renderGroupedStats`/`renderGroupedStatsJson`. branch `claude/wizardly-pascal-cq3vt2`, PR #80)
- [x] 👷 `agentrelay status --limit <n>` — 큰 큐에서 상위 N개 행만 표시(+"M more not shown" 푸터).
      (완료 — `status.ts` `selectJobs`에 limit 적용, 세 뷰(테이블/--json/--watch) 공통.
      branch `claude/wizardly-pascal-1tlqol`, PR #73)
- [x] 👷 `agentrelay parse <message>` — rate-limit 파서 진단 커맨드(어떤 패턴이 잡히는지 즉시 확인).
      (완료 — CLI `parse.ts` `buildParseReport`/`renderParseReport(Json)`, `--tool`로 어댑터 선택.
      branch `claude/wizardly-pascal-fd2idj`, PR #79)
- [x] 👷 `agentrelay cancel/retry --all` — 스코프 필터(--status/--tool/--project/--since/--until)로
      대량 job 제어(+--dry-run 미리보기).
      (완료 — core `control.ts` `bulkControlJobs`, CLI 공용 `buildScope`/`registerBulkControl`.
      branch `claude/wizardly-pascal-fli139`, PR #82)
- [x] 👷 `agentrelay completion <bash|zsh>` — 쉘 탭 완성 스크립트 생성(실제 커맨더 프로그램에서 파생).
      (완료 — core `completion.ts` `generateCompletion`/`COMPLETION_SHELLS`/`isCompletionShell` +
      `CompletionSpec` 타입. branch `claude/wizardly-pascal-y7t7r0`, PR #83)
- [x] 👷 `agentrelay config set/unset <key> [value]` — 설정 파일을 손 편집 없이 CLI로 갱신.
      (완료 — core `config.ts` `SETTABLE_CONFIG_KEYS`, CLI `setConfigFile`/`unsetConfigFile`.
      branch `claude/wizardly-pascal-35ao82`, PR #84)
- [x] 👷 `agentrelay export --format md` — 잡 이력을 Markdown 테이블로 내보내기(문서/이슈 붙여넣기용).
      (완료 — core `export.ts`가 `EXPORT_FORMATS`에 `md` 추가 + Markdown 직렬화. RFC-4180 CSV/JSON과 병존.
      branch `claude/wizardly-pascal-1s67y3`, PR #87)
- [x] 👷 `agentrelay notify test` — 설정된 알림 채널(Slack/웹훅)로 실전 테스트 페이로드 전송·결과 리포트.
      (완료 — core `notify.ts` `sendTestNotification`, CLI `notify.ts` `renderTestNotifyResults(Json)`.
      branch `claude/wizardly-pascal-55aspp`, PR #77)
- [x] 👷 `agentrelay export --format ndjson` — 스트리밍/append 친화 줄단위 무손실 내보내기(`jq -c`용).
      (완료 — core `export.ts` `jobsToNdjson` + `EXPORT_FORMATS`에 `ndjson`. branch
      `claude/wizardly-pascal-orbdgw`, PR #70)
- [x] 👷 `agentrelay next` — 다음에 재개될 잡 하나를 카운트다운과 함께 한 줄로(스크립트/상태바 친화, `--exit-code`).
      (완료 — core `next.ts` `selectNextResume`, CLI `next.ts` `renderNext(Json)`. branch
      `claude/wizardly-pascal-lgawzr`, PR #64)
- [x] 👷 `agentrelay stats --trend [days]` — UTC 일별 활동 히스토그램(릴레이가 언제 바빴는지 시간 축).
      (완료 — core `stats.ts` `computeDailyTrend`/`DailyActivity`, CLI `stats.ts` `renderTrend` +
      `--trend`/`--group-by` 공존. branch `claude/wizardly-pascal-7u14qq`, PR #81)
- [x] 👷 `agentrelay import <file>` — 잡 이력을 JSON/NDJSON 덤프에서 스토어로 병합(`export`의 역연산).
      (완료 — `export`(CSV/JSON/md/ndjson)는 있지만 그 역연산인 가져오기가 없어 머신 간 이력 이전·
      팀원 스냅샷 병합·아카이브 복원이 불가능했다. `@agentrelay/core/import.ts` 신설(순수·파일시스템
      미접촉): 무손실 포맷만 취급하는 `IMPORT_FORMATS`(`json`/`ndjson` — CSV/md는 `command` 평탄화·
      `lastOutputTail` 유실이라 의도적 제외) + `isImportFormat`/`inferImportFormat`(확장자 추론,
      `.jsonl`→ndjson). 엄격한 `validateJobRecord`(미지 tool/status·비배열·빈 command·음수 attempts
      거부, 미지 *추가* 키는 무시=전방호환) + `parseImportJobs`(json=배열 루트, ndjson=줄단위 —
      한 줄이 깨져도 나머지 진행, 절대 throw 안 함, 에러를 line/index로 리포트). 순수 `planImport`
      (add/overwrite/skip-existing/skip-active 결정) + `summarizeImportPlan`. **안전 기본값**: 활성
      상태(queued/waiting/resuming) 잡은 제외(로컬 스케줄러가 남의 command를 spawn하는 footgun 방지) →
      `--include-active`로 opt-in, id 충돌은 기본 skip → `--overwrite`로 대체. `RelayQueue.importJobs`
      가 plan을 원자적 flush로 적용(순수-skip이면 파일 미변경). CLI `commands.ts` `importStore`(파일
      읽기+선택적 dryRun) + `agentrelay import <file> [-f json|ndjson] [--include-active] [--overwrite]
      [--dry-run]`. 잘못된 format/CSV·추론 실패·전부-무효는 exit 1. core 30 + cli 4 신규 테스트, 실제
      빌드 CLI e2e로 export→import 왕복·history-only·include-active·dry-run·NDJSON 깨진 줄·CSV 거부 검증.
      branch `claude/wizardly-pascal-3bznrg`)

- [x] 👷 `agentrelay export --columns <list>` — CSV/Markdown 내보내기 컬럼 선택·재정렬(스프레드시트/이슈에
      필요한 열만·원하는 순서로).
      (완료 — core `export.ts`엔 이미 `CsvOptions.columns`(순수 `jobsToCsv`/`jobsToMarkdown`가 소비)가
      있었지만 CLI가 노출하지 않았다. core에 순수 `isJobCsvColumn`(타입가드) + `parseCsvColumns(input)`
      (콤마 분리·trim·빈 토큰 제거·`JOB_CSV_COLUMNS` 검증 → `{columns, invalid}`, 순서·의도적 중복 보존) +
      `COLUMN_AWARE_FORMATS`(`["csv","md"]`, json/ndjson은 무손실 full-shape라 컬럼 무시) 신설. CLI
      `exportStore`가 `columns` 옵션을 `exportJobs`에 전달, `cli.ts` export에 `--columns <list>` 배선:
      json/ndjson과 함께 쓰면 exit 1(무손실 포맷은 컬럼 미적용을 조용히 삼키지 않고 명시), 미지 컬럼은
      invalid 목록과 함께 exit 1, 빈 목록도 exit 1. 기존 스코프 필터(--status/--tool/--project/--since/
      --until/--sort/--reverse)와 조합 가능(window→select 후 컬럼 적용). 새 core 직렬화 코드 0줄 —
      전부 기존 검증된 `jobsToCsv`/`jobsToMarkdown`의 columns 경로 재사용. core export.test에 isJobCsvColumn
      1 + parseCsvColumns 6 + COLUMN_AWARE_FORMATS 1, cli export.test에 csv/md 컬럼 e2e 2케이스 추가,
      실제 빌드 CLI로 subset·reorder·md·미지컬럼→exit1·json거부→exit1·빈목록→exit1·tool필터 조합 검증.
      branch `claude/wizardly-pascal-t9765g`)

- [x] 👷 `agentrelay export --columns <list>` — CSV/Markdown 내보내기 시 필요한 열만 원하는 순서로 선택.
      (완료 — core `export.ts` `isJobCsvColumn`/`parseCsvColumns`/`COLUMN_AWARE_FORMATS`(csv·md만),
      CLI `export --columns` 배선(json/ndjson·미지 컬럼·빈 목록은 exit 1). PR #132, 세션 33에 통합·병합.)
- [x] 👷 파서 일(day) 단위 상대 시간 인식 (`try again in 2 days` / `resets in 1d 4h`).
      (완료 — 제네릭 `relative-duration` 정규식에 `(\d+)d` 그룹을 시(h) 앞에 추가하고 resolve를
      days·hours·minutes로 재색인 → `((days*24+hours)*60+minutes)`분. 주간/일간 사용량 한도 문구를
      이제 놓치지 않고 큐잉. 초(second)는 어댑터 소관이라는 기존 설계 결정 존중. parser.test +4 회귀
      (days-only/1d 4h/singular 1 day/"3 minutes"를 days로 오인 안 함). PR #123 발원 → 세션 34에서
      cherry-pick 통합. branch `claude/wizardly-pascal-ig4v29`)
- [x] 👷 `agentrelay export --format html` — 브라우저에서 열거나 리포트로 첨부하는 독립형 HTML 표
      (인라인 CSS·라이트/다크·상태별 색상). Markdown(붙여넣기용)과 달리 더블클릭해 여는 완결 문서.
      (완료 — core `export.ts`에 순수 `escapeHtml`(5개 HTML 특수문자, `&` 먼저 → 이중 이스케이프
      방지)·`escapeHtmlCell`(빈 값 em dash·개행 `<br>`, `escapeMarkdownCell` 관례 일치)·`jobsToHtml`
      (외부 요청 0인 `<!doctype>` 완결 문서, `prefers-color-scheme` 라이트/다크, `status-<state>`
      색상 클래스, 빈 스토어는 "(no jobs)" placeholder row, `title` 옵션) 추가 + `EXPORT_FORMATS`에
      `html` 등록·`exportJobs` 디스패치. 기존 CSV/Markdown과 컬럼·셀 값 lockstep(`JOB_CSV_COLUMNS`/
      `jobCsvValue` 공유) — `COLUMN_AWARE_FORMATS`에 `html` 추가해 `--columns`와도 조합. CLI export는
      `EXPORT_FORMATS.includes`로 검증하므로 `-f html` 자동 배선(설명 문구만 갱신), `--out`으로 파일
      저장. 세션 33의 PR #127(구버전 base·`--columns` 미조합)을 **최신 main 위로 통합**하고 컬럼 조합을
      더해 대체. core export.test 15케이스 + cli export.test 3케이스, 실제 빌드 CLI e2e로 문서 구조·
      상태 색상·주입 이스케이프(`<script>`→`&lt;script&gt;`)·개행 `<br>`·빈 스토어·컬럼 조합·잘못된
      포맷 exit 1·파일 출력 검증. branch `claude/wizardly-pascal-e06tu1`)
- [x] 👷 파서: 분(minute) 없는 시각 표현 `reset at 5pm` / `resets at 10 AM` 인식.
      (완료 — Claude Code가 실제로 출력하는 `"Your limit will reset at 5pm (America/New_York)."`
      문구를 기존 `clock-time`(분 `:MM` 필수)이 놓쳐 잡이 큐잉 안 되던 실사용 갭. 신규
      `clock-time-meridiem` 패턴(`reset[s]? at (\d{1,2}) (am|pm)`) 추가 — 분 없이 시+meridiem이면
      minute=0으로 해석. am/pm **필수**로 `reset at 5`(모호) 오검출 방지, `hour>12`(13pm) 무효.
      `clock-time`(분 정밀) 뒤 배치라 `5:30pm`은 그대로 우선. 12am→0/12pm→12 경계·이미 지난 시각
      익일 롤 등 clock-time 규약 준수, 명명 타임존은 로컬 해석(기존 한계). parser.test +6 회귀,
      실제 빌드 CLI `parse`로 `clock-time-meridiem` 매치 e2e 확인. branch
      `claude/wizardly-pascal-m46r3y`)

- [x] 👷 `agentrelay wait <id>` — 특정 잡이 종료 상태에 도달할 때까지 블록 후 결과를 exit code로 반환.
      (완료 — `@agentrelay/core/wait.ts` 신설(순수·시계/스토어 미접촉): `isTerminalStatus`(stats의
      `TERMINAL_STATUSES` 재사용) + `WaitOutcome`(completed/failed/cancelled + 루프 종료 timeout/missing) +
      `WAIT_EXIT_CODES`/`waitExitCode`(0/1/2/124[GNU timeout 관례]/5) + `evaluateWait(job|null)`(스냅샷
      하나로 "대기 계속 vs 종료+outcome" 판정, null=missing). CLI `commands.ts` `waitForJob(idOrPrefix,
      options)` — id 1회 해소 후 full id로 추적, 매 폴링마다 스토어 재오픈해 별도 daemon/tick 프로세스의
      쓰기 관측, 첫 검사 즉시(이미 종료된 잡은 sleep 없이 반환), `--timeout`은 sleep 전 데드라인 검사로
      1인터벌 이상 초과 안 함, now/sleep/readJob 주입 가능. CLI `wait.ts` `renderWaitJson`(next/show와
      동일 형태). `agentrelay wait <id> [--timeout] [--interval] [--json] [-q]` 배선. 스크립트/CI가
      릴레이 결과에 &&/||로 체인 가능. core 6 + cli 6 신규 테스트, 실제 빌드 CLI e2e로 completed→0·
      failed→1·timeout→124·unknown→1·크로스-프로세스 관측 검증. PR #96 발원 → 세션 37에서 최신 main에
      cherry-pick 통합(#137/#96 중복 대체). branch `claude/wizardly-pascal-4b32lg`)

- [x] 👷 `agentrelay metrics` — 큐 지표를 Prometheus 텍스트 노출 형식으로 출력(관측성/스크레이프).
      (완료 — `@agentrelay/core/metrics.ts` 신설(순수): `renderPrometheusMetrics(stats,{prefix?})`가
      `computeStats` 결과를 Prometheus text exposition format으로 렌더. 전부 gauge(스토어가 prune으로
      줄어 단조 아님), export(잡당 1행)와 달리 집계 전용. 패밀리: jobs·jobs_by_status(전 상태 zero-fill)·
      jobs_by_tool·jobs_active/terminal·attempts·retried_jobs·success_rate(미해결 시 샘플 생략)·
      resolved_jobs·resolution_seconds(avg/min/median/p90/max, 초 단위, resolved 0건이면 생략). 순수
      `escapePrometheusLabel`·`sanitizeMetricPrefix` export, `summary.ts`의 `ALL_STATUSES` export해 공유.
      CLI `agentrelay metrics`가 공용 `buildScope`(--status/--tool/--project/--since/--until)+`--prefix`
      재사용, stdout 노출 텍스트 출력, 잘못된 입력은 exit 1. core metrics 12 신규 테스트, 실제 빌드 CLI
      e2e로 게이지 값·스코프 부분집합·prefix 정화·에러 exit 검증. branch `claude/wizardly-pascal-q77dxu`)
- [x] 👷 job에 rate-limit 감지 출처(provenance) 영속 — "릴레이가 왜 리셋 시각을 X로 판단했나"를
      `show`에서 확인. 지금까지 rate-limit이 감지되면 `resetAt`만 job에 저장되고, 어떤 파서 패턴이/
      어떤 raw 텍스트가 그 시각을 만들었는지는 enqueue 시점 콘솔 한 줄로만 찍혀 사후 조사가 불가능했다.
      (완료 — `@agentrelay/core/types.ts`에 순수 `RateLimitDetection`(pattern·rawMatch·resetAt·detectedAt)
      + `RelayJob.lastRateLimit?`(optional → 구버전 스토어 무마이그레이션 로드) 추가. `RelayQueue.enqueue`가
      `lastRateLimit: null` 초기화, `markWaitingForReset(id, resetAt, detection?)`가 detection 있을 때만
      영속(수동 재큐/백오프 재시도는 미설정). 스케줄러(재개 시)·CLI run(최초 감지 시) 두 rate-limit 경로가
      `{pattern, rawMatch, resetAt, detectedAt: now}`를 전달. `agentrelay show`가 detection 있을 때만 "rate
      limit" 블록(pattern/matched/detected) 렌더, `--json`은 job 전체라 자동 노출. `import.ts`가
      `parseRateLimitDetection`으로 well-formed provenance만 무손실 왕복 보존(malformed/부재는 레코드 거부
      대신 생략 → null≈absent shape 안정). 새 파서 로직 0줄 — 기존 `RateLimitInfo`(pattern/rawMatch) 재사용.
      core queue 3 + import 2 + cli show 1 신규 테스트, 실제 빌드 CLI e2e로 run→persist·show 블록·--json
      에코 검증. branch `claude/wizardly-pascal-7o70l9`)

- [x] 👷 `agentrelay patterns` — 큐 전체에서 실제로 발화한 rate-limit 파서 패턴 빈도표
      (감지 출처 집계). 세션 38의 provenance(`lastRateLimit`) 영속 작업의 후속으로, `show`는
      잡 하나의 감지 출처만 보여주는 반면 이 커맨드는 **어떤 메시지 포맷이 실제로 얼마나
      자주 잡히는지**를 플릿 레벨로 집계해 어떤 파서 패턴이 load-bearing이고 어떤 게 실전에서
      한 번도 안 걸리는지 드러낸다.
      (완료 — `@agentrelay/core/patterns.ts` 신설(순수·파일시스템/시계 미접촉):
      `summarizeRateLimitPatterns(jobs)` + `RateLimitPatternSummary`(total·withDetection·
      withoutDetection·patterns[]) + `RateLimitPatternStat`(pattern·count·lastDetectedAt·
      sampleRawMatch). 각 잡의 영속된 `lastRateLimit.pattern`을 버킷팅해 count desc·이름 asc로
      랭킹(projects 랭킹 관례 일치), 패턴 내에서는 가장 최근 `detectedAt`의 raw sample을 보존.
      비어있거나 malformed(pattern 없음)한 detection은 패턴 버킷을 만들지 않고 withoutDetection으로
      카운트, malformed detectedAt은 throw 없이 oldest로 정렬(견고). CLI `patterns.ts`에 순수
      `renderPatterns`(비례 막대+예시 매치)·`renderPatternsJson`(stats와 동일 envelope). `agentrelay
      patterns [--json]` + 공용 `buildScope`(--status/--tool/--project/--since/--until) 재사용.
      새 파서 로직 0줄 — 세션 38이 영속한 provenance만 읽음. core patterns 8 + cli patterns 7 신규
      테스트, 실제 빌드 CLI e2e로 랭킹·비례 막대·예시·스코프 부분집합·no-detection·빈 스토어·에러
      exit 검증. branch `claude/wizardly-pascal-patterns`)
- [x] 👷 재시도 백오프 지터(`AGENTRELAY_RETRY_JITTER`) — 전환 실패(transient failure) 재시도가 여러 잡에서
      lockstep으로 같은 시각에 몰려 재개→재충돌하는 것을 무작위 분산으로 완화.
      (완료 — `RetryPolicy`에 `jitter`(fraction [0,1], 기본 0=결정적) 필드 추가. `computeBackoffMs(policy,
      attempt, rng?)`가 `jitter>0`이고 `rng` 주입 시에만 클램프된 지연을 `[delay·(1−j), delay·(1+j)]`로
      균등 분산 후 `[0, maxDelayMs]` 재클램프 — `rng` 없거나 `jitter<=0`이면 기존과 완전 동일(하위호환).
      `retryPolicyFromEnv`가 `AGENTRELAY_RETRY_JITTER`를 [0,1] 클램프(음수·비수치는 기본 0)로 읽음.
      `RelayScheduler`에 주입 가능한 `rng`(기본 `Math.random`) 옵션 → 백오프 재큐 시 전달(테스트 결정성).
      config 전 계층 배선(type·sampleConfig·CONFIG_FIELDS·parseConfig·validateConfig[<0/>1 error]·
      configToEnv·CONFIG_ENV_KEYS — 드리프트 sync 테스트 통과). core retry +7 / config +2 / scheduler +1
      신규 테스트, 실제 빌드 CLI로 config set/validate/show 지터 배선 e2e 검증. branch
      `claude/wizardly-pascal-119tzo`)
- [x] 👷 `agentrelay run --project <name>` — 큐잉되는 잡의 프로젝트 라벨 명시 지정(자동 유도명 덮어쓰기).
      (완료 — `run`은 지금까지 프로젝트 라벨을 cwd 마지막 경로 세그먼트로만 유도해, 하위 디렉터리에서
      실행하면 `src`/`packages` 같은 무의미한 이름이 붙거나 여러 관련 잡을 하나의 논리적 프로젝트로
      묶을 수 없었다. 그런데 `status`/`stats`/`export`/`cancel`/`retry`/`metrics`/`patterns`의
      `--project` 필터가 전부 이 라벨을 키로 쓰므로, 라벨을 제어 못 하면 필터 생태계 전체의 효용이
      떨어졌다. `resolveProjectName(cwd, override?)`를 확장 — override에 비공백 내용이 있으면 우선,
      공백/빈 문자열이면 기존 cwd 유도로 폴백(하위호환, 순수·단위 테스트 가능). `RunOptions.project`
      추가, `runCommand`가 `resolveProjectName(cwd, options.project)`로 라벨 해소. CLI `run`에
      `-p, --project <name>` 옵션 배선. 새 core 코드 0줄. cli commands.test에 resolveProjectName 3 +
      runCommand override/blank-fallback 2케이스 추가, 실제 빌드 CLI e2e로 라벨 지정→status --project
      필터 매치·help 노출 검증. branch `claude/wizardly-pascal-881r8n`)

- [x] 👷 `agentrelay errors` — 실패 잡을 에러 사유별로 묶어 빈도순으로 보여주는 진단 커맨드
      ("왜 재개가 조용히 실패하나?"의 한눈 답).
      (완료 — `@agentrelay/core/errors.ts` 신설(순수·파일시스템 미접촉): `errorSignature(raw)`
      (첫 비어있지 않은 줄만 취해 CRLF/선행 공백 처리 → 내부 공백 런 단일화 → 200자 캡, null·공백뿐이면
      null=집계 제외) + `computeErrorBreakdown(jobs)`→`ErrorBreakdown`(totalWithErrors·distinctSignatures·
      groups). 정규화 시그니처로 버킷팅해 후행 공백·줄바꿈·스택 tail만 다른 near-identical 실패를 한 행으로
      합침, count desc·시그니처 asc 랭킹(기존 랭킹 관례와 동일), 그룹 내 jobIds/statuses는 first-seen 순서
      보존, sample은 첫 잡의 raw error 원문. CLI `packages/cli/src/errors.ts`에 순수 `renderErrorBreakdown`
      (랭크 헤더+시그니처+`agentrelay show`용 짧은 id 3개+"+N more" elision, `--limit`은 상위 N그룹만+숨김
      푸터, totals는 항상 전체)·`renderErrorBreakdownJson`. `agentrelay errors` 커맨드는 stats/status/export와
      동일한 스코프 필터(`--status`/`--tool`/`--project`/`--since`/`--until`)를 공용 `buildScope`로 재사용,
      `-n/--limit`·`--json`. core 13 + cli 7 신규 테스트, 실제 빌드 CLI e2e로 공백 정규화 병합·랭킹·스코프·
      limit 푸터·JSON·에러 exit 검증. branch `claude/wizardly-pascal-ziyovo`)

- [x] 👷 파서: 표준 HTTP `Retry-After` 응답 헤더 인식(RFC 9110 §10.2.3) — delay-seconds
      (`Retry-After: 3600`)와 HTTP-date(`Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`) 양쪽.
      (완료 — 에이전트 CLI가 HTTP API를 프록시하다 429에서 `Retry-After` 헤더를 콘솔에 덤프하는
      실사용 갭. `parser.ts`에 순수 `http-retry-after` 패턴 추가 — 숫자 그룹 `\d{1,7}`+`\b`로 epoch
      크기 값을 초 지연으로 오독 방지, 하이픈 헤더명으로 언더스코어 `retry_after`(unix-epoch, 절대
      epoch)와 분리. 사전필터를 `retry.?after`로 확장. parser.test +5(seconds/date/`0`즉시/비교차/
      malformed fallthrough). 새 CLI 코드 0줄 — 기존 `parse` 커맨드가 자동 노출.
      branch `claude/wizardly-pascal-hi5obo`)

- [x] 👷 `agentrelay paths` — AgentRelay가 디스크에 두는 파일 위치(스토어·스토어 디렉터리·설정·
      데몬 하트비트·백업)를 존재 여부와 함께 한눈에 보고. `config show`(유효 설정)·`doctor`(건강 판정)와
      달리 "이 도구가 실제로 어떤 파일을 읽고 쓰나, 존재는 하나"에 답함 — 잡이 조용히 재개 안 될 때
      "지금 올바른 스토어를 보고 있나?"를 가장 먼저 확인하는 수단(`AGENTRELAY_STORE`·프로젝트-로컬/
      per-user 설정이 서로 다른 곳을 가리킬 수 있으므로).
      (완료 — 순수 core `@agentrelay/core/locations.ts` 신설: `buildLocationReport(facts)`가 이미 수집된
      팩트(해소된 store/config 경로 + 디스크 존재)로 위치별 `LocationEntry`(kind/label/path/exists/note)를
      구성, `countStoreBackups`가 디렉터리 리스팅에서 이 스토어의 `.backup-*`만 카운트(`.corrupt-`/`.tmp-`/
      타 스토어 제외). 스토어 디렉터리·하트비트·백업-glob 경로는 store 경로에서 파생, 부재 위치엔
      "created on first run"/"using built-in defaults" 등 안내 note. CLI `commands.ts` `readLocationReport`
      (fs I/O 반: `readdirSync`/`existsSync` + `resolveConfigPath`, 절대 throw 안 함 — 못 읽는 디렉터리는
      "부재"로), `packages/cli/src/paths.ts`에 순수 `renderLocations`(✓/· 존재 마커 + 정렬 라벨 + note,
      color 게이트)·`renderLocationsJson`. `agentrelay paths [--json]` 커맨드 배선. core 12 + cli 7 신규
      테스트, 실제 빌드 CLI e2e로 부재→"created on first run"/존재→✓/`.backup-*` 카운트/`--json`/`--config`
      해소 검증. branch `claude/wizardly-pascal-tcasvv`)

- [x] 👷 `agentrelay health` — 재개 루프 생존 프로브(모니터링/systemd/cron/k8s liveness용). `doctor`는
      전체 셋업 진단이라 상호작용용인 반면, `health`는 "재개 루프가 필요할 때 실제로 돌고 있나?"라는
      단 하나의 질문을 빠르게 exit code로 답해, 모니터가 출력 파싱 없이 분기할 수 있게 한다.
      (완료 — `@agentrelay/core/health.ts` 신설(순수·시계/파일시스템 미접촉): `evaluateHealth(status,
      {strict?})`가 세션 31·36의 `evaluateHeartbeat` 판정(`HeartbeatStatus`)을 프로브 verdict로 증류 —
      `HealthLevel`(healthy=루프 alive / idle=루프 비생존이지만 대기 잡 0=무해 / unhealthy=대기 잡 있는데
      루프 비생존=릴레이가 막으려는 바로 그 실패) + `HealthReport`(level·exitCode·reason·heartbeat 에코) +
      `HEALTH_EXIT_OK`(0)/`HEALTH_EXIT_UNHEALTHY`(1). 판정은 전부 `evaluateHeartbeat`가 이미 계산한
      `state`·`concerning`(`!alive && waitingJobs>0`)만 사용 → doctor·대시보드와 절대 불일치 안 함. `--strict`는
      idle(루프 비생존+대기 0)도 실패로 승격(항상 켜져 있어야 하는 데몬 감시용, 예: k8s liveness). CLI
      `commands.ts` `readHealthReport({storePath,nowMs?,strict?})`(fs+clock 반: 활성 잡 수는 `countActiveJobs`,
      하트비트는 `parseDaemonHeartbeat`, 절대 throw 안 함 — 부재/깨짐은 absent로), `packages/cli/src/health.ts`
      순수 `renderHealth`(색상 verdict + reason + mode/pid/last-tick-age, `formatDurationMs` 재사용)·
      `renderHealthJson`. `agentrelay health [--json] [--strict]` 배선, exit code가 report.exitCode 반영(0
      healthy/idle, 1 unhealthy). 새 파서/스케줄러 코드 0줄 — 세션 31 하트비트 인프라 재사용. core health 10 +
      cli health 10 신규 테스트, 실제 빌드 CLI e2e로 idle→0/strict→1/대기 잡+무루프→unhealthy 1/JSON/help
      검증. branch `claude/wizardly-pascal-health`)

- [x] 👷 `agentrelay projects` — 큐에 존재하는 프로젝트 라벨을 프로젝트별 잡 집계·타이밍과 함께 조회.
      (완료 — `--project` 필터는 status/stats/export/cancel/retry/metrics/patterns/errors가 전부 키로
      쓰지만, 정작 **어떤 프로젝트 라벨이 스토어에 있는지·어디에 대기 작업이 몰렸는지 발견하는 수단**이
      없었다. `@agentrelay/core/projects.ts` 신설(순수·파일시스템/시계 미접촉): `summarizeProjects(jobs)`가
      프로젝트별 total/active(queued+waiting_for_reset+resuming)/terminal(completed+failed+cancelled)/
      waiting 집계 + `nextResetAt`(대기 잡의 사전식 min resetAt, 비대기 잡 무시) + `lastActivityAt`(max
      updatedAt), 랭킹은 active desc→total desc→이름 asc(**대기 작업이 몰린 프로젝트가 맨 위**). CLI
      `packages/cli/src/projects.ts`에 순수 `renderProjects`(표+대기 시 `formatCountdown` 카운트다운·전부
      종료면 `(idle)`·scope note·no-match 문구)·`renderProjectsJson`(stats/patterns와 동일 envelope).
      `agentrelay projects [--json]` + 공용 `buildScope`(--status/--tool/--project/--since/--until) 재사용.
      새 파서/시계 로직 0줄 — `summarizeJobs`의 ISO 사전식 비교 관례 재사용. core projects 7 + cli
      projects 8 신규 테스트, 실제 빌드 CLI e2e로 랭킹·카운트다운·idle·스코프 부분집합·--json·에러 exit
      검증. PR #222 발원 → 세션 48에서 최신 main 위로 cherry-pick 통합. branch `claude/wizardly-pascal-h1l3c3`)

- [x] 👷 `agentrelay upcoming` — 재개 대기 중인 잡들의 타임라인을 가장 임박한 순으로 카운트다운과 함께 조회.
      (완료 — `next`는 **단 하나**(가장 임박한 재개)만, `status`는 큐 전체를 생성순으로 덤프한다. 그 사이
      "앞으로 무엇이 언제 재개되나 — 다음 것 뒤로 무엇이 줄 서 있나"를 보는 활주로(runway) 뷰가 없었다.
      `@agentrelay/core/upcoming.ts` 신설(순수·파일시스템/시계 미접촉): `buildUpcomingTimeline(jobs, now, limit?)`가
      `waiting_for_reset` + 파싱 가능한 `resetAt` 잡만 골라 `next`와 **동일한 tie-break**(resetAt→createdAt→id)로
      정렬, 각 행에 `dueInMs`/`due`/`position`(1-based) 부여 + `totalWaiting`/`hidden`/`dueNow` 집계(limit로
      잘라도 totals는 정직하게 전체 반영). CLI `packages/cli/src/upcoming.ts`에 순수 `renderUpcoming`(표 +
      공용 `formatCountdown` 재사용으로 `due now`/`30m`/`3h 0m` 일관 + scope note + "N more not shown" 푸터)·
      `renderUpcomingJson`(next/projects와 동일 envelope). `agentrelay upcoming [--limit/-n] [--tool] [--project]
      [--since] [--until] [--json]` — 공용 `buildScope` 재사용, completion 자동 포함. 새 파서/시계 로직 0줄.
      core upcoming 10 + cli upcoming 9 신규 테스트, 실제 빌드 CLI e2e로 정렬·카운트다운·due now·--limit
      부분표시·--project 스코프·--json·--limit 0 에러(exit 1) 검증. branch `claude/wizardly-pascal-tw6lzf`)

- [x] 👷 `agentrelay overdue` — 리셋 시각이 이미 지났는데도 아직 재개 안 된 대기 잡을 가장 오래 지연된
      순으로 조회(`upcoming`의 진단용 거울). 재개 루프가 죽었거나 바이너리 spawn 실패의 무음 실패 신호.
      (완료 — `@agentrelay/core/overdue.ts` 신설(순수·시계/파일시스템 미접촉): `buildOverdueReport(jobs,
      now, {graceMs?, limit?})` + `OverdueEntry`(job·overdueByMs)·`OverdueReport`(entries·totalOverdue·
      hidden·graceMs·maxOverdueByMs)·`OverdueOptions`. `waiting_for_reset`+파싱 가능 `resetAt`이면서
      `now - resetMs > graceMs`인 잡만 골라 가장 오래 지연된 순(오래된 resetAt→createdAt→id tie-break,
      next/upcoming과 대칭) 정렬, `graceMs`(기본 0, 음수·비유한 0 클램프)로 방금 due된 잡 오탐 방지,
      `limit`로 잘라도 totals/maxOverdueByMs는 전체 반영, 입력 불변. CLI `overdue.ts` 순수 `renderOverdue`
      (표 + 공용 `formatDurationMs` 재사용 + 재개 루프 점검 힌트 + "keeping up" 빈 메시지)·`renderOverdueJson`.
      `agentrelay overdue [--limit/-n][--grace][--tool][--project][--since][--until][--json]` — 공용
      `buildScope` 재사용, `--grace` 기본 60s, completion 자동 포함. 새 파서/스케줄러 로직 0줄. core overdue
      13 + cli overdue 10 신규 테스트, 실제 빌드 CLI e2e로 grace 유예·정렬·스코프·JSON·에러 exit·빈 스토어
      검증. branch `claude/wizardly-pascal-pvjg81`)

- [x] 👷 `agentrelay tools` — 큐에 존재하는 에이전트 툴(claude-code/codex-cli/generic)을 툴별 잡 집계·
      다음 리셋·마지막 활동과 함께 조회(`projects`의 툴 축 거울).
      (완료 — `--tool` 필터는 status/stats/export/cancel/retry/metrics/patterns/errors/projects가 전부 키로
      쓰지만, 정작 어떤 툴이 스토어에 있고 어디에 대기 작업이 몰렸는지 발견하는 수단이 없었다. core
      `tools.ts` 신설(순수·파일시스템/시계 미접촉): `summarizeTools(jobs)`가 `job.tool`별 total/active
      (queued+waiting_for_reset+resuming)/terminal/waiting 집계 + `nextResetAt`(대기 잡의 사전식 min resetAt)·
      `lastActivityAt`(max updatedAt), 랭킹은 active desc→total desc→이름 asc(대기 몰린 툴이 맨 위,
      `summarizeProjects`와 동일 관례). CLI `tools.ts`에 순수 `renderTools`(표+대기 시 `formatCountdown`
      카운트다운·전부 종료면 `(idle)`·scope note·no-match 문구)·`renderToolsJson`(stats/projects와 동일 envelope).
      `agentrelay tools [--json]` + 공용 `buildScope`(--status/--tool/--project/--since/--until) 재사용, completion
      자동 포함. 새 파서/시계 로직 0줄. core tools 8 + cli tools 8 신규 테스트, 실제 빌드 CLI e2e로 랭킹·
      카운트다운·idle·스코프 부분집합·--json·에러 exit·completion 포함 검증. branch `claude/wizardly-pascal-tools`)

- [x] 👷 `agentrelay upcoming --watch [seconds]` — 재개 대기 타임라인을 라이브로 갱신(카운트다운이
      째깍째깍 줄어드는 뷰). `status --watch`(세션 12)를 재개 대기 타임라인에 확장.
      (완료 — CLI `upcoming.ts`에 순수 `renderUpcomingWatchFrame(timeline, storePath, intervalMs, now,
      scopeNote?)` 신설(`status`의 `renderWatchFrame`와 동일 title/meta 블록 + 항상 컬러인 `renderUpcoming`
      본문). `cli.ts`의 기존 `runWatch` draw/setInterval/시그널 정리 로직을 공용 `startWatchLoop(intervalMs,
      draw)`로 추출(리팩터링, 동작 불변) → `runWatch`·새 `runUpcomingWatch`가 재사용. `upcoming`에
      `-w, --watch [seconds]` 배선: limit/scope 검증을 먼저 통과시켜 잘못된 값은 watch 전에 exit 1,
      `--json`이 `--watch`보다 우선(일회성 기계 덤프), 인터벌 기본 2s. 매 프레임 스토어 재읽기·스코프
      재적용(경계는 시작 시 고정 epoch-ms)·타임라인 재구성·화면 clear. completion 자동 포함. 새 파서/
      스케줄러/core 로직 0줄. cli upcoming watch-frame 3케이스 신규, 실제 빌드 CLI e2e로 화면 clear·라이브
      배너·카운트다운·--json 우선·--limit 0 exit 1·completion 검증. branch `claude/wizardly-pascal-1z6gb2`)

- [x] 👷 `agentrelay overdue --watch [seconds]` — 지연 재개 리포트를 라이브로 갱신(지연 스팬이 자라는
      뷰). `upcoming --watch`(세션 52)와 동일 패턴으로 진단용 거울인 `overdue`에 확장.
      (완료 — CLI `overdue.ts`에 순수 `renderOverdueWatchFrame(report, storePath, intervalMs, now,
      scopeNote?)` 신설(`status`/`upcoming`의 watch-frame와 동일 title/meta 블록 + 항상 컬러인
      `renderOverdue` 본문). 세션 52가 추출한 공용 `startWatchLoop`을 재사용하는 `runOverdueWatch`
      (매 프레임 스토어 재읽기·스코프 재적용·`buildOverdueReport`를 fresh `now`로 재구성 → 지연 스팬
      live·화면 clear). `overdue`에 `-w, --watch [seconds]` 배선: limit/grace/scope 검증을 먼저 통과시켜
      잘못된 값은 watch 전에 exit 1, `--json`이 `--watch`보다 우선, 인터벌 기본 2s, completion 자동 포함.
      새 파서/스케줄러/core 로직 0줄. cli overdue watch-frame 3케이스 신규, 실제 빌드 CLI e2e로 화면
      clear·라이브 배너·지연 스팬·--json 우선·--limit 0/--grace nope exit 1·completion 검증.
      branch `claude/wizardly-pascal-79vs8n`)

- [x] 👷 `agentrelay tools --watch [seconds]` — 툴별 인덱스를 라이브로 갱신(리셋 카운트다운이 째깍째깍
      줄어드는 뷰). `overdue --watch`(세션 53)와 동일 패턴으로 `tools`에 확장(공용 `startWatchLoop` 재사용).
      (완료 — CLI `tools.ts`에 순수 `renderToolsWatchFrame(summary, storePath, intervalMs, now, scopeNote?)`
      신설(`status`/`upcoming`/`overdue`의 watch-frame와 동일 title/meta 블록 + 항상 컬러인 `renderTools`
      본문). 세션 52가 추출한 공용 `startWatchLoop`을 재사용하는 `runToolsWatch`(매 프레임 스토어 재읽기·
      스코프 재적용·`summarizeTools`를 fresh `now`로 재구성 → 리셋 카운트다운 live·화면 clear). `tools`에
      `-w, --watch [seconds]` 배선: 스코프 검증을 먼저 통과시켜 잘못된 값은 watch 전에 exit 1, `--json`이
      `--watch`보다 우선(일회성 기계 덤프), 인터벌 기본 2s, completion 자동 포함. 새 파서/스케줄러/core
      로직 0줄. cli tools watch-frame 3케이스 신규, 실제 빌드 CLI e2e로 화면 clear·라이브 배너·카운트다운·
      --json 우선·--tool nope exit 1·completion·help 검증. branch `claude/wizardly-pascal-jn5lc0`)

- [x] 👷 `agentrelay projects --watch [seconds]` — 프로젝트별 인덱스를 라이브로 갱신(리셋 카운트다운이
      째깍째깍 줄어드는 뷰). `tools --watch`(세션 54)와 동일 패턴으로 `projects`에 확장(공용
      `startWatchLoop` 재사용). watch 계열(status/upcoming/overdue/tools/projects) 완성.
      (완료 — CLI `projects.ts`에 순수 `renderProjectsWatchFrame`, `cli.ts`에 `runProjectsWatch`. 새
      파서/스케줄러/core 로직 0줄. branch `claude/wizardly-pascal-j5exbn`, PR #467)

- [x] 👷 `agentrelay stats --watch [seconds]` — 집계 지표(성공률·재시도·다음 리셋 카운트다운·
      per-tool/project 브레이크다운)를 라이브로 갱신. watch 계열의 마지막 조회 명령까지 확장.
      (완료 — 세션 55가 "다음 할 일"로 명시한 후속. `stats`는 watch 형제들과 달리 본문이 plain stats·
      `--group-by` 브레이크다운·`--trend` 히스토그램 세 형태를 가질 수 있어, watch 루프가 매 프레임 fresh
      `now`로 본문을 조합(→ "next reset in" 카운트다운 live)하고 새 순수 `renderStatsWatchFrame(body,
      storePath, intervalMs, now)`이 `status`/`tools`/`projects`와 동일한 title/meta 라이브 배너로 감싼다.
      CLI `cli.ts`에 `runStatsWatch`(매 프레임 스토어 재읽기·스코프 재적용·groupBy/trend 조합; 시간 창
      경계는 시작 시 고정 epoch-ms). `stats`에 `-w, --watch [seconds]` 배선 — scope/group-by/trend 검증을
      **먼저** 통과시켜 잘못된 값은 watch 전에 exit 1, `--json`이 `--watch`보다 우선(일회성 기계 덤프),
      인터벌 기본 2s, addHelpText 예시 3줄, completion 자동 포함. 새 파서/스케줄러/core 로직 0줄 — 전부
      기존 검증된 `computeStats`/`groupStats`/`computeDailyTrend`/`renderStats`/`renderGroupedStats`/
      `renderTrend` 재사용. cli stats watch-frame 3케이스 신규(plain·live countdown·group-by 본문 wrap),
      실제 빌드 CLI e2e로 화면 clear·라이브 배너·1h30m 카운트다운·group-by --watch·--json 우선·--status
      bogus exit 1·help/completion `--watch` 노출 검증. branch `claude/wizardly-pascal-stats-watch`)

- [x] 👷 대시보드에 프로젝트/툴 롤업(rollup) 노출 — CLI `projects`/`tools` 인덱스를 대시보드에서도
      한눈에. 세션 55·56이 "다음 할 일"로 반복 제안한 후속.
      (완료 — 대시보드는 잡 요약 타일·잡 테이블·재개-루프 하트비트만 보여줄 뿐, `--project`/`--tool`
      필터 생태계가 키로 쓰는 **프로젝트/툴 축의 롤업**을 노출하지 않아 "어느 프로젝트/툴에 대기
      작업이 몰렸나"를 대시보드에서 볼 수 없었다. `apps/dashboard/lib/jobs.ts`의 `JobsSnapshot`에
      `projects: ProjectsSummary`·`tools: ToolsSummary` 추가 — core의 `summarizeProjects`/
      `summarizeTools`를 매 폴링마다 재사용해 CLI와 절대 드리프트하지 않음(새 core 로직 0줄).
      `dashboard-client.tsx`에 공용 `RollupCard`(project/tool 브레이크다운은 동일 count/timing shape라
      `RollupRow`로 평탄화 후 한 렌더러로 처리) — active/waiting/done/total 컬럼 + 대기 잡 있을 때만
      `formatCountdown`으로 next-reset 카운트다운, 랭킹은 core 그대로(active desc→total desc→이름 asc,
      대기 몰린 축이 위). tile-row와 job 테이블 사이에 `By project`·`By tool` 2-카드 그리드(빈 스토어면
      숨김). `globals.css`에 `.rollup-grid`(auto-fit minmax 반응형)·`.rollup-card`·`.rollup-title` 추가.
      dashboard test에 롤업 스냅샷 2케이스(빈 스토어 empty + 3-잡 랭킹/카운트 mirror). 검증: `pnpm build`
      클린·`pnpm ci:lint`(Biome) 0경고·`pnpm test` 전 패키지 통과(dashboard 7→9). 실제 빌드 대시보드
      `next start`+임시 스토어(web-app 대기/완료 2 + api-svc 대기 1)로 `/api/jobs`가 projects/tools 롤업을
      정확히 반환(랭킹·nextResetAt)하고, 사전설치 Chromium 헤드리스 렌더로 클라이언트 폴링 후 `By project`/
      `By tool` 카드·라벨·1h 28m 카운트다운이 실제로 그려짐을 e2e 확인. branch `claude/wizardly-pascal-wip07r`)

- [x] 👷 `agentrelay stats --hours` — 하루 중 어느 UTC 시간대에 rate-limit이 몰리는지 시간(0–23) 분포 히스토그램.
      (완료 — 세션 26의 `--trend`(일별)는 있지만 "하루 중 언제 rate-limit에 걸리나"라는 시간-of-day 축이
      없었다. core `stats.ts`에 순수 `computeHourlyDistribution(jobs)` + `HourlyActivity`(hour 0–23, count)
      신설 — 각 잡의 `createdAt`을 UTC 시(hour)로 버킷팅해 **모든 날에 걸쳐** 집계, 항상 정확히 24 슬롯
      (0시→23시) zero-fill, `createdAt` 누락/파싱불가는 스킵. `--trend`와 달리 창(window)도 시계도 불필요
      (hour-of-day는 타임스탬프의 절대 속성). CLI `stats.ts`에 순수 `renderHours`(24행 ASCII 막대, 최다
      시간에 스케일, 0시간은 dim 베이스라인 점, `HH:00` 라벨 + 합계 푸터)·`renderStatsJson`에 옵셔널
      `hours` 필드(요청 시에만 방출, 기존 JSON shape 불변). `cli.ts` `stats`에 `--hours` 배선 —
      일회성·`--json`·`--watch` 세 뷰 모두 적용, 기존 스코프 필터(--status/--tool/--project/--since/--until)와
      조합 가능(`--trend`와 함께도 렌더). 새 파서/스케줄러 로직 0줄. core stats +5 + cli stats +5(=32) 신규
      테스트, 실제 빌드 CLI e2e로 시간 버킷팅·최다시간 풀바·스코프 부분집합·`--json` hours 필드·기본 JSON
      미포함·help/completion `--hours` 노출 검증. branch `claude/wizardly-pascal-hours`)

- [x] 👷 `agentrelay stats --weekday` — 하루 중이 아니라 한 주 중 어느 요일(Sun–Sat, UTC)에 rate-limit이
      몰리는지 요일 분포 히스토그램. 세션 58의 `--hours`(시간-of-day)를 요일 축으로 확장(직전 세션이
      "다음 할 일"로 제안).
      (완료 — core `stats.ts`에 순수 `computeWeekdayDistribution(jobs)` + `WeekdayActivity`(weekday 0–6·
      name Sun–Sat·count) + `WEEKDAY_NAMES` 상수 신설 — 각 잡의 `createdAt`을 `Date.getUTCDay()`로 버킷팅해
      **모든 주에 걸쳐** 집계, 항상 정확히 7 슬롯(Sun→Sat) zero-fill, `createdAt` 누락/파싱불가는 스킵.
      `computeHourlyDistribution`과 동일하게 창도 시계도 불필요(day-of-week는 타임스탬프의 절대 속성).
      CLI `stats.ts`에 순수 `renderWeekday`(7행 ASCII 막대, `--hours`와 동일 스케일 관례 — 최다 요일에
      스케일·비영일 최소 1블록·0일 dim 베이스라인 점·`Sun`…`Sat` 라벨 + 합계 푸터)·`renderStatsJson`에
      옵셔널 `weekday` 필드(요청 시에만 방출, 기존 JSON shape 불변). `cli.ts` `stats`에 `--weekday` 배선 —
      일회성·`--json`·`--watch` 세 뷰 모두 적용, 기존 스코프 필터(--status/--tool/--project/--since/--until)와
      `--hours`/`--trend`와도 조합 가능. 새 파서/스케줄러 로직 0줄. core stats +5(=563) + cli stats +5(=37)
      신규 테스트, 실제 빌드 CLI e2e로 요일 버킷팅(Mon 풀바)·스코프 부분집합·`--json` weekday 필드·기본 JSON
      미포함·`--hours --weekday` 동시 렌더·help/completion `--weekday` 노출 검증. branch
      `claude/wizardly-pascal-k411rs`)

- [x] 👷 `agentrelay stats --hours/--weekday --local` — 활동 히스토그램을 UTC가 아니라 이 머신의 로컬
      타임존으로 버킷팅. 세션 58·59가 "다음 할 일"로 반복 제안한 로컬 타임존 옵션(현재 UTC 고정이라
      KST 사용자 등이 자기 시간대로 패턴을 못 읽던 실사용 갭).
      (완료 — core `stats.ts`의 `computeHourlyDistribution`/`computeWeekdayDistribution`에 선택적
      `offsetMinutes = 0` 파라미터 추가 — 각 `createdAt`을 `offsetMinutes*60_000`만큼 시프트한 뒤 UTC 시/요일을
      읽음(양수=UTC 앞선 지역, 예 KST +540; 음수는 자정 넘겨 전날로 롤). 기본 0 = 기존 UTC 버킷팅과 완전 동일
      (하위호환), 오프셋을 명시적으로 받으므로 순수·시계 미접촉 유지. CLI `stats.ts`에 순수
      `formatUtcOffsetLabel(offsetMinutes)`(0/비유한→`UTC`, `540`→`UTC+09:00`, `-330`→`UTC-05:30`) 신설 +
      `renderHours`/`renderWeekday`에 `zoneLabel`(기본 "UTC") 옵션 추가 → 헤더·푸터가 어느 시계로 버킷팅됐는지
      표기. `cli.ts` `stats`에 `--local` 플래그 배선 — `-new Date().getTimezoneOffset()`로 머신 오프셋 유도,
      `local (UTC±HH:MM)` 라벨 구성 후 일회성·`--json`·`--watch` 세 뷰 모두에 offsetMinutes(compute)·zoneLabel
      (render) 전달. 스코프 검증은 watch 전에 통과시켜 잘못된 값은 여전히 exit 1. 새 파서/스케줄러 로직 0줄.
      core stats +5(=568) + cli stats +5(=42, formatUtcOffsetLabel 3 + zoneLabel 2) 신규 테스트, 실제 빌드
      CLI e2e로 Seoul(UTC+09:00) 20:00/23:00→05:00/08:00·NewYork(UTC-04:00) Monday 이동·`--json` 로컬 버킷·
      help/completion `--local` 노출 검증. branch `claude/wizardly-pascal-ip0xkp`)

- [x] 👷 `agentrelay stats --heatmap` — 세션 58의 `--hours`(시간-of-day)와 세션 59의 `--weekday`(요일)
      두 축을 결합한 UTC 요일×시간(7×24) 활동 히트맵. "한 주 중 언제(요일+시각) rate-limit이 몰리나"를
      한눈에(예: "월요일 오전"). 자기 발굴 항목 — 기존 함수 시그니처를 안 건드리는 순수 추가라 회귀 위험 최소.
      (완료 — core `stats.ts`에 순수 `computeActivityHeatmap(jobs)` + `ActivityHeatmap`(cells[7][24]·
      total·maxCell) 신설 — 각 잡의 `createdAt`을 `Date.getUTCDay()`×`getUTCHours()` 셀로 버킷팅해 **모든
      주에 걸쳐** 집계, 항상 7행×24열 완전 할당·zero-fill, `createdAt` 누락/파싱불가는 스킵. `--hours`/
      `--weekday`처럼 창도 시계도 불필요(두 좌표 모두 타임스탬프의 절대 속성). CLI `stats.ts`에 순수
      `renderHeatmap`(요일 행×시간 열 그리드, `·░▒▓█` 강도 램프[최다 셀에 스케일]·0/6/12/18 시간축 라벨·
      행별 요일 합계·범례+총계 푸터[peak N/cell])·`renderStatsJson`에 옵셔널 `heatmap` 필드(요청 시에만
      방출, 기존 JSON shape 불변). `cli.ts` `stats`에 `--heatmap` 배선 — 일회성·`--json`·`--watch` 세 뷰
      모두 적용, 기존 스코프 필터(--status/--tool/--project/--since/--until) 및 `--hours`/`--weekday`/`--trend`와도
      조합 가능. 새 파서/스케줄러 로직 0줄. core stats +5(=568) + cli stats +4(=41) 신규 테스트, 실제 빌드
      CLI e2e로 요일×시간 버킷팅(Mon 09 풀바·Wed 23 램프)·스코프 부분집합(--project web)·`--json` heatmap
      필드·기본 JSON 미포함·help/completion `--heatmap` 노출 검증. 세션 60에서 최신 main(#544 `--local`)
      위로 리베이스 통합하며 `computeActivityHeatmap`/`renderHeatmap`에도 `offsetMinutes`/`zoneLabel`을 더해
      `--heatmap --local`(로컬 타임존 히트맵)까지 조합 가능하게 확장. branch `claude/wizardly-pascal-kppnrt`)

- [x] 👷 `agentrelay eta` — 큐 전체가 언제 다 따라잡히나(모든 대기 잡 중 가장 늦은 리셋까지의 카운트다운).
      `next`(가장 이른 하나)·`upcoming`(목록)·`overdue`(지연)의 빠진 짝 — "언제까지 지켜봐야 하나".
      (완료 — core `eta.ts` 순수 `computeQueueEta(jobs, now)`+`QueueEta`(waiting·dueNow·first/lastResetAt·
      etaMs·spanMs·caughtUp), `next`/`upcoming`과 동일 필터·최댓값 resetAt=캐치업 시각. CLI `eta.ts`
      `renderEta`/`renderEtaJson`, `agentrelay eta [--json] [--exit-code]`(캐치업 0/대기 3, 폴링 루프 친화).
      새 파서/스케줄러 로직 0줄. core 7 + cli 7 신규 테스트, 실제 빌드 CLI e2e 검증. branch
      `claude/wizardly-pascal-y4hcy6`)

- [x] 👷 `agentrelay stats` 해결 시간 분산 지표(IQR·표준편차) — 백분위수(중심·꼬리)에 더해 "얼마나
      들쭉날쭉한가"(퍼짐)를 노출. 세션 60이 후속 후보로 지목한 항목.
      (완료 — core `stats.ts`의 `TimingStats`에 `p25ResolutionMs`·`p75ResolutionMs`·`iqrResolutionMs`
      (p75−p25, 중앙 50% 폭 — 이상치에 강건)·`stdevResolutionMs`(모표준편차) 추가. 순수 `populationStdev`
      헬퍼 신설, p25/p75는 기존 `percentile`(type-7 보간) 재사용 → 이미 오름차순 정렬한 배열에서 읽어
      새 정렬 0줄. resolved 0개면 넷 다 null, 단일 잡이면 iqr·stdev 0. stdev이 IQR보다 훨씬 크면 소수의
      무거운 이상치가 평균을 끄는 신호. CLI `stats.ts` resolution-time 블록에 `spread: iqr … (p25 … –
      p75 …)   stdev …` 라인 추가, `--json`은 timing 전체 직렬화라 자동 노출. core stats.test +2(3-잡
      quartile/stdev·단일 잡 collapse), cli stats.test render 단언 확장. 실제 빌드 CLI e2e로 spans
      {1h,3h,9h}→iqr 4h·stdev 3h23m·JSON 필드 방출 검증. branch `claude/wizardly-pascal-mzvln3`)

- [x] 👷 `agentrelay stats` 해결 시간 변동계수(CV=stdev/mean) — 절대 ms 지표(stdev·IQR)에 더해
      "평균 대비 얼마나 들쭉날쭉한가"를 무차원 비율로 노출. 세션 66이 후속 후보로 지목한 항목.
      (완료 — stdev·IQR·백분위수는 전부 절대 ms라 잡이 분 단위인 큐와 시간 단위인 큐의 변동성을
      직접 비교할 수 없었다. CV는 스케일 프리(stdev÷mean)라 크기와 무관하게 "평균 대비 상대 분산"을
      비교 가능하게 한다. core `stats.ts`의 `TimingStats`에 `cvResolution`(4소수 반올림 비율) 추가 +
      순수 `coefficientOfVariation(values, mean)` 헬퍼(mean=0 → 비율 미정 0/0이라 null; 비음수 span의
      mean 0은 전부 0을 의미하므로 정확히 null, 절대 0 아님. 반올림 안 한 stdev 사용해 ms 반올림이
      비율을 왜곡하지 않음). resolved 0개면 null, 단일 잡이면 0(분산 없음, 잘 정의됨). CLI `stats.ts`에
      순수 `formatCv`(비율→퍼센트, 0.564→"56%", null/비유한→"n/a") + resolution-time spread 라인 끝에
      `cv N%` 추가, `--json`은 timing 전체 직렬화라 자동 노출. 새 파서/스케줄러 로직 0줄. core stats
      +2 단언(cv 0.5·단일 잡 0) + cli stats formatCv 2 + render cv 단언 신규. 실제 빌드 CLI e2e로
      spans {1h,3h}→cv 50%·zero-span→cv n/a(null)·`--json` cvResolution 방출 검증. branch
      `claude/stats-cv-resolution`)

- [x] 👷 `agentrelay stats` 해결 시간 MAD(median absolute deviation) — stdev(이상치 민감)·CV에 더해
      이상치에 가장 강건한(50% 붕괴점) 분산 지표.
      (완료 — stdev는 잡 하나가 길어져도 부풀고 IQR도 사분위 위치에 묶여 있어, "절반이 아무리 커져도
      안 움직이는" 강건 분산 지표가 없었다. core `stats.ts`의 `TimingStats`에 `madResolutionMs`
      (whole-ms) 추가 + 순수 `medianAbsoluteDeviation(values, median)` 헬퍼(값별 `|v-median|`을 새로
      정렬 후 기존 `percentile` p=0.5 재사용). `computeStats`가 median을 한 번 계산해 median과 MAD가
      공유. resolved 0개면 null, 단일 잡이면 0(잘 정의). CLI `stats.ts` spread 라인에 `mad …`를
      stdev와 cv 사이 삽입, `--json`은 timing 전체 직렬화라 자동 노출. 새 파서/스케줄러/집계 로직 0줄.
      core stats +3(spread mad 1h·단일 잡 mad 0·이상치 강건성 신규[1h×4+20h→MAD 0<stdev]) + cli stats
      render `mad 1h 0m` 단언. 실제 빌드 CLI e2e로 {1h×4,20h}→`stdev 7h 36m mad <1s`·`--json`
      madResolutionMs 0 검증. branch `claude/wizardly-pascal-fbgzlf`)

- [x] 👷 파서: Claude Code 비대화형(`claude -p`) 모드의 머신 판독 rate-limit 포맷
      `Claude AI usage limit reached|<unix_epoch초>`(파이프 구분 절대 리셋 시각) 인식. 자기 발굴 항목 —
      헤드리스로 에이전트를 감싸는 이 도구가 실전에서 가장 자주 마주칠 실제 포맷인데(경쟁 도구
      claude-auto-retry가 핵심적으로 파싱하는 바로 그 wording) 어떤 기존 패턴도 잡지 못했다.
      (완료 — `@agentrelay/core/adapters.ts`의 `CLAUDE_CODE_ADAPTER.patterns`에 순수
      `CLAUDE_USAGE_LIMIT_EPOCH_PATTERN`(`name: "claude-usage-limit-epoch"`) 추가 — 정규식
      `/usage limit reached\s*\|\s*(\d{10})\b/i`로 파이프 뒤 10자리 unix epoch초를 절대 리셋 시각으로
      해소(파이프 주변 공백·대소문자 관용, `\b`로 자릿수 초과 방지). Claude 고유 wording이라 generic
      파서가 아닌 어댑터 패턴에 둠(Codex 초 패턴과 대칭) — 그래서 다른 곳의 `...|<10자리>`를 리셋으로
      오독하지 않음. 기존 `unix-epoch`(제네릭, `retry_after` 접두 필요)와 별개. 새 파서/스케줄러 로직은
      패턴 하나뿐 — 어댑터의 `detectRateLimit`가 이미 extraPatterns를 최우선으로 시도. adapters.test에
      5케이스 추가(epoch 파싱·공백/대소문자 관용·generic 미매치·generic 패턴 폴백 유지·rawMatch 검증),
      실제 빌드 CLI `parse --tool claude-code "…|1752345600"` e2e로 `claude-usage-limit-epoch` 매치 +
      generic은 "No rate-limit detected" 확인. branch `claude/wizardly-pascal-j0fz82`)

- [x] 👷 파서: rate-limit 리셋 시각 plausibility 가드(미래 지평선) — 미스파싱이 잡을 수일/수년 뒤로
      파킹해 조용히 재개 안 되는 "silent failure"를 차단. 자기 발굴 항목 — 파서는 지금까지 해소한
      resetAt에 상한 검증이 없어, 잘못된 epoch 단위·거대한 상대 기간·오탐 timezone이 만든 먼-미래
      리셋을 그대로 큐에 넣어 잡을 영원히 대기시킬 수 있었다(대회 도구·doctor·recover가 반복해 겨냥해온
      바로 그 무음 실패 부류).
      (완료 — `@agentrelay/core/parser.ts`에 순수 `isPlausibleReset(resetAt, now, maxFutureMs?)`
      (미래 쪽만 경계; 과거 리셋=이미 풀린 한도라 즉시 재개가 안전하므로 허용; 비양수·비유한·nullish
      maxFutureMs는 "가드 없음"으로 항상 true) + `DEFAULT_MAX_RESET_HORIZON_MS`(8일 — 주간 한도를
      여유 있게 덮되 오탐은 거름) + `maxResetHorizonMsFromEnv`(`AGENTRELAY_MAX_RESET_HORIZON` 기간 파싱;
      미설정=기본 8일, `0`/`off`/`none`/파싱불가=null[가드 비활성], 기존 `parseDuration` 재사용) 추가.
      `ParseOptions.maxFutureMs` 옵션을 `tryPattern`에 배선 — 지평선 밖 리셋은 매치 안 한 것처럼 스킵해
      더 합당한 패턴으로 폴스루하거나 null 반환(호출자는 일반 완료로 처리). **기본 undefined = 하위호환**
      (기존 파서/`parse` 진단 커맨드 동작 불변). `RelayScheduler`에 `maxResetHorizonMs` 옵션 추가 → resume
      시 detectRateLimit에 배선, CLI run/daemon/tick이 env로 배선. 어댑터의 `detectRateLimit`는 옵션을
      그대로 전달하므로 별도 수정 0줄. parser.test +11(지평선 밖 드롭·안 유지·과거 허용·먼-미래 후 폴스루·
      비양수=가드없음·isPlausibleReset 경계·env 기본/파싱/비활성) + scheduler.test +2(먼-미래 resume 드롭→
      completed·가드 없으면 재큐). 실제 빌드 CLI e2e로 기본 지평선은 30일 리셋 드롭(미큐잉)·`off`면 큐잉·
      2h는 정상 큐잉·`parse` 진단은 지평선 미적용(30일 표시) 확인. branch `claude/wizardly-pascal-reset-horizon`)

- [x] 👷 스토어 `close()` lost-update 버그 수정 — 읽기 전용 명령이 동시 쓰기를 조용히 덮어쓰던 데이터 유실.
      자기 발굴 항목 — `RelayQueue.close()`의 docstring은 "No-op"이라 적혀 있지만 실제로는 `this.flush()`를
      호출해 **인메모리 맵 전체를 무조건 디스크에 다시 썼다.** 그 맵은 큐를 연 시점의 스냅샷이라, 읽기
      전용 명령(`status`/`stats`/`show`/`export`)이 큐를 열고 읽은 뒤 `close()`하면, 그 사이 다른
      프로세스(예: 실행 중인 `agentrelay daemon`)가 추가·변경한 잡을 **stale 스냅샷으로 통째로 덮어써
      유실**시켰다(전형적 lost update). 로컬 우선 도구에서 "잡 상태를 절대 조용히 잃지 않는다"는
      프로젝트의 핵심 관심사(손상 파일 보존·recover 등과 동일 계열)를 정면으로 위반. `concurrency.ts`가
      스토어의 무-lost-update 불변식을 문서화하는데 close()가 그것을 깨고 있었다.
      (완료 — `queue.ts`의 `close()`를 자기 docstring대로 **진짜 no-op**으로 변경[`this.flush()` 제거].
      모든 mutating 메서드가 이미 호출 시점에 원자적으로 영속화하므로 close()가 커밋할 지연 변경은
      없다 → close()의 쓰기는 순수 잉여이자 유해했다. 부수 효과로 읽기 전용 명령이 매 실행마다 스토어를
      재기록하던 낭비도 제거. queue.test.ts에 회귀 2케이스(동시 writer의 변경을 close()가 안 덮어씀·
      읽기 전용 open/close가 파일을 바이트 단위로 불변 유지). 실제 빌드 CLI e2e로 status 실행 중 동시
      enqueue된 잡이 유실되지 않음 검증. core 641 전 테스트 통과. branch `claude/wizardly-pascal-close-noop`)
- [x] 👷 `agentrelay doctor` 먼-미래 리셋 파킹 잡 검사(reset-horizon) — 이미 큐에 파킹된 잡의
      리셋 시각이 지평선을 넘으면 경고. 자기 발굴 항목(세션 72 파서 지평선 가드의 후속) — 세션 72
      가드는 **새로 파싱되는** rate-limit만 검증하므로, 가드가 없던 시절 큐잉됐거나·가드를 끈 채·잘못된
      epoch 단위/거대한 상대 기간 misparse로 이미 `waiting_for_reset`으로 파킹된 잡은 수일/수년 조용히
      대기해도 아무도 못 잡았다. doctor가 라이브 큐를 동일 지평선으로 재검사해 이 무음 실패를 표면화.
      (완료 — `@agentrelay/core/doctor.ts`에 순수 `selectFarFutureResets(jobs,{now,horizonMs})`(활성 잡
      중 resetAt이 now+horizon을 넘는 것만; 과거/근접 리셋은 안전하므로 제외, 종료 잡·resetAt 없음/
      파싱불가는 스킵, 비양수·비유한 horizon은 "가드 없음"으로 빈 배열 — parser `isPlausibleReset` 재사용)
      + `FarFutureResetJob`/`ResetHorizonFacts` 타입 추가, `DiagnosticInput.resetHorizon` 추가.
      `runDiagnostics`에 `reset-horizon` 검사 배선(순서 node→store→writable→adapters→daemon→
      **reset-horizon**→config→notify): horizonMs null(가드 off)=OK 스킵, 파킹 잡 0개=OK, 1개 이상=warning
      (가장 덜 극단(가장 이른)인 잡을 예시로 이름·프로젝트·카운트다운 표기, `show`/`cancel`/`retry`/`recover`
      힌트). CLI `runDoctor`가 `maxResetHorizonMsFromEnv(env)`로 지평선 해소 후 `selectFarFutureResets`로
      facts 구성(null이면 빈 리스트). core doctor +11(selectFarFutureResets 7 + reset-horizon 검사 3 +
      기존 카운트 갱신) · cli doctor +3(먼-미래 warning·근접 OK·`off` 스킵). 실제 빌드 CLI e2e로 100일
      파킹→warning(예시 표기)·`off`→disabled OK·2h→OK·`--json` 노출 확인. branch
      `claude/wizardly-pascal-4p3s77`)

- [x] 👷 대시보드 먼-미래 리셋 파킹 잡 경고 카드(reset-horizon) — CLI `doctor`의 `reset-horizon`
      검사를 로컬 대시보드에도 노출. 자기 발굴 항목(세션 73 doctor 검사의 후속으로 세션 73 로그가
      명시한 "대시보드에도 동일 먼-미래 파킹 잡 경고 노출"). doctor는 CLI를 켜야만 보이지만, 대시보드는
      상시 떠 있어 사용자가 큐를 시각적으로 감시하는 경로 — misparse로 수일/수년 파킹된 잡을 여기서도
      즉시 눈에 띄게. (완료 — `apps/dashboard/lib/jobs.ts`가 core `selectFarFutureResets` +
      `maxResetHorizonMsFromEnv`를 스냅샷에서 재사용해 `resetHorizon:{jobs,horizonMs}` 필드 추가(가드 off면
      horizonMs=null·빈 리스트). `dashboard-client.tsx`에 `FarFutureResetsCard` 추가: 하트비트 카드와 동일한
      "concerning" 경고 카드 패턴 재사용, 가장 이른(덜 극단) 잡부터 최대 5개 표기(+N more)·id 8자·프로젝트·
      `resets in Nd/Ny`(먼 기간용 `formatLongDuration` 신설, 기존 시간 단위 카운트다운이 수천 시간으로
      넘치는 것 방지)·`show`/`cancel`/`retry`/`recover` 힌트. 가드 off거나 파킹 0개면 렌더 안 함(조용). CSS
      `.far-future*` 추가. 순수 로직은 전부 core 재사용이라 CLI doctor와 절대 드리프트 안 함. dashboard test
      +4(먼-미래 플래그·근접 미플래그·종료 잡 미플래그·빈 스토어). branch
      `claude/dashboard-reset-horizon-card`)

- [x] 👷 `agentrelay recover --far-future` — 먼-미래 파킹 잡을 자동 감지·재큐(경고를 고침으로).
      자기 발굴 항목(세션 73 doctor·세션 74 대시보드 카드가 명시한 후속 "recover가 먼-미래 파킹 잡을
      자동 감지·재큐 대상으로 포함하는지 점검"). 세션 72~74가 만든 reset-horizon 인프라는 misparse로
      수일/수년 파킹된 잡을 `doctor`(CLI)·대시보드 카드에서 **경고**만 했지 **고치는** 원커맨드가 없어,
      사용자가 잡마다 `retry <id>`를 손으로 쳐야 했다. `recover`(지금까지 `resuming` 고아 잡만 회수)에
      두 번째 무음-실패 클래스를 붙여 이 루프를 닫는다.
      (완료 — `@agentrelay/core/recover.ts`에 순수 `selectFarFutureParkedJobs(jobs,{nowMs,horizonMs})` +
      `FarFutureParkedReport`/`FarFutureParkedOptions` 신설: `waiting_for_reset`(파킹된) 잡만 후보 —
      `queued`는 어차피 다음 tick에 실행, `resuming`은 라이브거나 `selectStuckResumingJobs` 담당 —
      resetAt이 지평선 초과인 것만 골라 가장 이른(덜 극단) 순 정렬, resetAt 없음/파싱불가는 스킵,
      가드 비활성(null/비양수/비유한 horizon)은 빈 리스트(pool은 계속 카운트). parser `isPlausibleReset`
      재사용으로 doctor·대시보드와 지평선 의미 절대 드리프트 안 함. CLI `recover`에 `--far-future` opt-in
      플래그(더 결과가 큰 클래스라 기본 off) 추가: `maxResetHorizonMsFromEnv()`로 지평선 해소 후
      `recoverJobs`가 파킹 잡을 `RelayQueue.requeueNow`로 재큐(attempts 0 리셋·lastError 클리어 — 먼-미래
      resetAt 자체가 버그였으므로 새 시도 예산으로 fresh run이 맞음, `recoverResuming`의 attempts 보존과
      대비). `--dry-run`·`--json`에 far-future 섹션 병존, 가드 off면 스캔 스킵 문구. 순수 렌더는
      `renderFarFutureBlock`로 분리, 먼 기간용 `resetInWords`(일/년). core recover +6·cli recover +7 신규
      테스트, 실제 빌드 CLI e2e로 기본 미포함·`--far-future` dry-run(스토어 불변)·실제 재큐(resetAt=now·
      attempts 0·err null·근접 2h 잡 보존)·`--json` farFuture 블록·`off` 스킵 검증. branch
      `claude/wizardly-pascal-w9pkuw`)

- [x] 👷 먼-미래 리셋 경고의 fix 힌트를 `recover --far-future`로 교정(doctor + 대시보드). 자기 발굴 항목
      (바로 위 `recover --far-future` 랜딩의 후속 정확성 수정). `recover --far-future`가 main에 들어오기 전엔
      doctor `reset-horizon` warning과 대시보드 먼-미래 카드가 fix로 `agentrelay recover`(플래그 없이)를
      제시했는데, plain `recover`는 `resuming` 고아 잡만 회수하고 **먼-미래 파킹 잡은 건드리지 않는다** — 즉
      경고를 보고 안내대로 `recover`를 쳐도 아무것도 안 고쳐지는 **오도(misleading) 힌트**였다. 이제 존재하는
      원커맨드 `agentrelay recover --far-future`를 명시적으로 가리키도록 양쪽 표면을 교정. (완료 —
      `packages/core/src/doctor.ts` `resetHorizonCheck`의 hint를 "Requeue them all with `agentrelay recover
      --far-future` (plain `recover` won't …). Or inspect one with `show`/`cancel`/`retry`."로 교체,
      `apps/dashboard/app/dashboard-client.tsx` `FarFutureResetsCard` 안내문도 동일 교정. core doctor.test에
      hint가 `recover --far-future`를 포함하는지 단언 추가. build/lint/test 통과(core 655·cli 365/1skip·
      dashboard 13), 실제 빌드 CLI `doctor` e2e로 교정된 힌트 출력 확인. branch `claude/wizardly-pascal-wmsc0y`)

- [x] 👷 `agentrelay config schema` — `agentrelay.config.json`용 JSON Schema 출력(에디터 검증/자동완성). 자기 발굴
      항목. 지금까지 config는 `init`(샘플 파일)·`validate`(구조+의미 검사)·`show`/`get`/`set`/`unset`은 있었지만,
      **에디터가 편집 중 실시간으로** 오타(`retry.maxAttemps`)·범위 밖 값을 잡아줄 수단이 없었다. (완료 —
      `@agentrelay/core/config-schema.ts` 신설(순수·파일시스템 미접촉): `buildConfigJsonSchema()`가 기존
      `CONFIG_FIELDS`(config set/get/show와 동일한 단일 진실 원천)에서 draft-07 스키마를 **생성** + 키별
      description/제약 테이블(FIELD_INFO). 숫자 제약은 `validateConfig`와 동일하게 미러(maxAttempts≥0 정수,
      factor≥1, jitter 0~1, keep/everyTicks≥0 정수), duration 필드는 `parseDuration`을 흉내 낸 case-insensitive
      pattern(`7d`/`1.5h`/`500ms`), 그룹 오브젝트는 `additionalProperties:false`, 인라인 `"$schema"` 참조 허용.
      `CONFIG_SCHEMA_ID`/`CONFIG_SCHEMA_DIALECT`·`configJsonSchemaJson()`(2-스페이스 pretty + trailing newline).
      CLI `agentrelay config schema`는 순수 stdout(파일 미접촉) → `agentrelay config schema > agentrelay.config.schema.json`으로
      파이프. config-schema.test 9케이스(모든 settable 필드가 스키마에 존재·타입 매핑·duration 패턴이 실제
      parseDuration 통과 입력과 일치·sampleConfig 제약 부합·JSON 왕복). build/lint/test 통과(**core 664 · cli
      365/1skip · dashboard 13**), 실제 빌드 CLI e2e로 유효 JSON 출력·top/그룹 props·duration pattern 확인.
      branch `claude/wizardly-pascal-ixo6hb`)

- [x] 👷 `agentrelay completion fish` — bash·zsh만 지원하던 쉘 탭 완성에 fish(세 번째 주요 셸) 추가.
      자기 발굴 항목 + **스테일 중복 8개 통합(consolidation)**. 세션 78이 진단한 "중복 PR 루프"의 전형으로,
      fish 완성은 이미 열린 PR **8개**(#606·#495·#581·#315·#241·#210·#100·#561)가 각기 다른 오래된 base에서
      독립 재구현돼 있었으나, 전부 문서 append 충돌로 클린 병합이 불가능했다(큐가 막힌 근본 원인). 세션
      33/48 등의 확립된 "최신 main 위로 통합 → 스테일 중복 대체" 패턴대로, 최신 main 기반의 검증된 통합본을
      열어 8개를 대체·정리한다.
      (완료 — core `completion.ts`: `CompletionShell` 유니온·`COMPLETION_SHELLS`에 `"fish"` 추가,
      `generateCompletion` 디스패치에 `generateFish` 배선. bash/zsh는 단일 case-문 디스패치 함수지만 fish는
      선언적 `complete -c` 규칙 목록을 fish 표준 술어(`__fish_use_subcommand`/`__fish_seen_subcommand_from`)로
      가드: 최상위 커맨드명·글로벌 옵션은 서브커맨드 선택 전에만, 각 커맨드 플래그는 이름이 라인에 있을 때,
      부모 커맨드(`config`)는 서브명이 골라지기 전까지 서브명 제안 + 골라진 뒤엔 그 서브의 플래그. 순수
      `fishOptionSpec`가 플래그를 fish 형식으로 변환(long `--json`→`-l json`, short `-r`→`-s r`, 그 외 선행
      대시→`-o`). 기존 `assertSafeToken` 안전 가드·`uniq` 중복 제거 재사용, `-f`로 파일 완성 억제. spec은
      여전히 라이브 커맨더 프로그램에서 파생되므로 실제 커맨드 표면과 절대 드리프트 안 함. CLI `cli.ts`의
      `completion` description·help 예시에 fish 추가(검증·미지 셸 exit 1은 기존 `isCompletionShell` 재사용).
      새 파서/스케줄러 로직 0줄. completion.test에 fish 6케이스 + 기존 "fish는 무효" 단언을 유효로 갱신
      (COMPLETION_SHELLS·isCompletionShell). build/lint/test 통과(**core 670 · cli 365/1skip · dashboard 13**,
      Biome 0경고), 실제 빌드 CLI e2e로 `completion fish` 방출(글로벌 옵션·최상위 커맨드·run 플래그·config
      부모 가드)·미지 셸 exit 1 검증. branch `claude/wizardly-pascal-am8gcl`)
- [x] 👷 `agentrelay doctor` 스토어 무결성(store-integrity) 검사 + doctor 읽기 전용화(중복-id 파괴 버그 수정).
      자기 발굴 항목. `doctor`는 전체 파일 손상(corrupt)·활성 잡 수만 봤고, **읽히는** 스토어 내부의
      의미적 문제(중복 id·구조 불량 레코드·resetAt 없는 waiting_for_reset)는 못 잡았다 — 이는 `verify`
      커맨드(`verifyStore`)에만 있어 사용자가 따로 실행해야 했다. 게다가 `runDoctor`가 큐를 열고
      `close()`하며 flush → 로드 시 Map이 이미 붕괴시킨 중복 id를 디스크에 **재기록**해, 읽기 전용이어야 할
      진단이 이전 잡을 조용히 파괴하는 버그가 있었다(그래서 두 번째 doctor 실행은 문제가 "사라진" 것처럼 보임).
      (완료 — core `doctor.ts`에 `StoreIntegrityFacts`(checked·total·errorCount·warningCount·sampleIssues) 타입 +
      `integrityCheck` 판정 함수 추가, `runDiagnostics` 검사 순서에 store 바로 뒤 `store-integrity` 배선
      (node→store→**store-integrity**→store-writable→adapters→daemon→reset-horizon→config→notify). 판정은
      linter(`verifyStore`) 등급 미러: error(중복 id·구조 불량)=검사 error, warning(방치 잡·파싱 불가 날짜)=
      warning, 읽을 스토어 없음(부재/전체 손상)=skip-OK(같은 파일 이중 보고 방지). CLI `commands.ts`에
      `gatherIntegrityFacts`(기존 `runVerify` raw 읽기+순수 `verifyStore` 재사용, error 우선 최대 3개 샘플
      메시지) + `runDoctor`가 이를 주입. **부수 버그 수정**: `runDoctor`의 `queue.close()` 제거 →
      생성자가 이미 load하므로 읽기 전용 유지, flush로 인한 중복-id 파괴 차단. 새 파서/스케줄러 로직 0줄.
      core doctor +4 · cli doctor +5(무결성 ok/skip/중복-id error + 비파괴 회귀 + gatherIntegrityFacts) 테스트.
      build/lint/test 통과(**core 679 · cli 370/1skip · dashboard 13**, Biome 0경고), 실제 빌드 CLI e2e로
      clean→ok / 중복-id→error+exit 1 / 스토어 UNCHANGED(비파괴) / 두 번째 실행도 여전히 flag 검증.
      branch `claude/wizardly-pascal-uems38`)
- [x] 👷 출력 tail 비밀 레닥션(secret redaction) — `jobs.json`/`export`에 자격증명 유출 방지.
      (스스로 발굴. 스케줄러가 재개 실행마다 에이전트 stdout/stderr 꼬리를 `lastOutputTail`로 스토어에
      영속화하는데, 실제 에이전트 출력엔 자격증명이 흔히 섞임 — 크래시 스크립트가 echo한
      `ANTHROPIC_API_KEY`, 로깅된 HTTP 요청의 `Authorization: Bearer …`, PAT 박힌 git remote URL.
      그대로 저장하면 편의용 로그가 디스크(및 디버깅용으로 공유하는 `export`)의 평문 비밀 저장소가 됨.
      완료 — `@agentrelay/core/redact.ts` 신설: 순수 `redactSecrets(text)`(Anthropic `sk-ant-`/OpenAI
      `sk-`/GitHub `ghp_`·`github_pat_`/AWS `AKIA`/Slack `xox*`/Google `AIza`/`Authorization: Bearer|token`/
      `NAME=secret`·`NAME: secret` 자격증명 대입을 `[REDACTED]`로 마스킹, 분류 못 하는 텍스트는 불변 →
      일반 출력 안 망가뜨림) + `REDACTION_PLACEHOLDER` + `redactOutputTailFromEnv`(`AGENTRELAY_REDACT_OUTPUT`,
      secure-by-default: 미설정·오타는 on, 명시적 off/0/false/no/none/disabled만 off). 스케줄러는 tail을
      **슬라이스 후 스크럽**해 저장 — rate-limit 감지는 항상 un-redacted `output`에서 돌아 재개 시점 불변,
      마스킹은 디스크에 쓰이는 것만 바꿈. `redactOutputTail` 옵션(기본 true), CLI daemon/tick이 env로 배선.
      redact.test.ts 22케이스 + scheduler.test.ts 3케이스(completed/failed tail 레닥션 + 비활성화 시 raw 보존).
      build/lint/test 통과(**core 707 · cli 370/1skip · dashboard 13**, Biome 0경고), 빌드된 dist로 실제
      스크럽 e2e 확인. branch `claude/wizardly-pascal-q3j8uv`)

- [x] 👷 `agentrelay redact` — 이미 저장된 잡의 비밀 소급 스크럽(세션 85 #875의 write-time 레닥션 후속:
      레닥션 이전 저장·`import` 유입·손 편집 잡의 평문 자격증명이 `show`/`export`로 노출되는 갭 차단).
      (완료 — `@agentrelay/core/redact.ts`에 순수 `redactJob(job)`(`lastOutputTail`·`lastError`·
      `lastRateLimit.rawMatch`에 기존 `redactSecrets` 적용, 바뀐 필드만 보고, **updatedAt 불변**)·
      `planStoreRedaction(jobs)`(순서 보존 계획+변경 로그+총계)·`RedactableField`/`REDACTABLE_FIELDS`/
      `JobRedactionChange`/`StoreRedactionPlan` 추가. `RelayQueue.redact({dryRun})`가 변경 잡만 set 후 원자적
      flush(dry-run 무기록). CLI `redactStore`+순수 `renderRedact`/`renderRedactJson`+`agentrelay redact
      [--dry-run] [--json]` 배선. prune/recover의 pure 선택+I/O 분리 재사용, 새 파서/스케줄러 로직 0줄.
      core redact.test +9·cli redact.test +8, 빌드 CLI e2e로 디스크 스크럽·updatedAt 불변·idempotent 확인.
      branch `claude/wizardly-pascal-lsguqd`)

- [x] 👷 Gemini CLI 어댑터 — Google `gemini` CLI 지원 추가(툴 추론 + Google API `RetryInfo.retryDelay`
      구조화 리셋 인식). 세션 초기 "다른 에이전트 툴 어댑터"(claude-code/codex-cli/generic) 확장 후속.
      (완료 — `AgentTool` 유니온에 `"gemini-cli"` 추가(`types.ts`), `@agentrelay/core/adapters.ts`에
      `GEMINI_CLI_ADAPTER`(binaries `["gemini"]`) + `GEMINI_RETRY_DELAY_PATTERN` 신설: Gemini API가 429
      `RESOURCE_EXHAUSTED` 페이로드에 싣는 `google.rpc.RetryInfo`의 `retryDelay:"56s"`(protobuf Duration,
      항상 초 단위 `s` 접미사)를 인식 — 일반 파서(시/분 prose)도, Codex 초 패턴("try again in Ns" 문구
      필요)도 놓치던 구조화 필드. `retryDelay`/`retry_delay`/`retry-delay` + 키·값 양쪽 선택적 따옴표 허용,
      소수 초는 whole-ms로 ceil해 조기 재개 방지. 필드명에 앵커돼 다른 패턴과 disjoint. `ADAPTERS` 레지스트리
      (컴파일타임 `Record<AgentTool,…>` 강제)·`ALL_TOOLS`(stats zero-fill/metrics 자동 전파)·`VALID_TOOLS`
      (import 검증)·CLI 도움말/`tools` 설명문에 gemini-cli 반영. 새 명령/스케줄러 로직 0줄 — 기존 어댑터
      파이프라인 재사용. adapters.test +6(binary 추론·resolve·retryDelay 감지·소수 ceil·generic 폴백·generic이
      구조화 필드 미인식)·stats.test byTool zero-fill 3케이스 gemini 키 반영. build/lint/test 통과
      (**core 722 · cli 378/1skip · dashboard 13**, Biome 0에러), 빌드 CLI `parse --tool gemini-cli`로
      retryDelay→resets in 1m·generic 미인식 e2e 확인. branch `claude/wizardly-pascal-gr62f3`)

- [x] 👷 컨텍스트 보존 재개(`agentrelay run --resume-context`) — 재개 시 명령을 처음부터 다시 돌리는
      대신 툴의 대화-이어가기 형태(Claude Code의 `--continue`)로 실행. **SPEC §4의 미구현 요구사항**
      직접 구현("가능하면 --resume/컨텍스트 유지 플래그 사용"). 자기 발굴 항목. 지금까지 스케줄러는
      rate-limit 재개 시 `job.command`를 **그대로** 재실행해, `claude -p "..."` 잡은 리셋 후 이전 대화
      컨텍스트를 잃고 프롬프트를 처음부터 다시 보냈다.
      (완료 — `@agentrelay/core`: `AgentAdapter`에 순수 `resumeCommand(command)` 추가(툴별 대화-이어가기
      변환, 없는 툴은 identity=그대로) + `claudeResumeCommand`(바이너리 바로 뒤에 `--continue` 삽입, 이미
      `--continue`/`-c`/`--resume`/`--resume=<id>`가 있으면 그대로 두어 이중 삽입·명시 세션 오버라이드
      방지, 빈 command는 그대로). `RelayJob`/`CreateJobInput`에 optional `resumeContext` 추가(미설정 시
      기존 verbatim 재실행 그대로 — 하위호환). `RelayQueue.enqueue`가 opt-in일 때만 플래그 영속(기본
      스토어 바이트 불변), `update`의 `{...existing}` 병합으로 상태 변경·재직렬화 후에도 보존. 스케줄러
      `resume`이 `job.resumeContext`면 어댑터 변환 적용 후 spawn(원본 command는 불변이라 매 재개가 원본에서
      멱등 변환), `runCommand(command,cwd)`로 시그니처 정리. CLI `agentrelay run --resume-context` 플래그,
      큐 메시지가 활성 시 실제 재개 형태를 안내, `show`가 `resume` 라인으로 노출(변환 없는 툴은 "re-runs
      verbatim"). Codex/generic은 이어가기 플래그가 없어 no-op(안전). 파서/큐 저장 포맷 변경 0줄.
      build/lint/test 통과(**core 696 · cli 375/1skip · dashboard 13**, Biome 0경고), core adapters +4·
      scheduler +3·queue +2 · cli commands +2·show +3 신규 테스트, 실제 빌드 CLI e2e로 claude 바이너리→
      `--continue` 삽입·generic→verbatim·show 라인 검증. branch `claude/wizardly-pascal-mx96ky`)

- [x] 👷 `agentrelay search <query>` — 큐 자유 텍스트 검색(명령어·프로젝트·id·마지막 에러). 큐가
      한 화면을 넘어가면 status의 구조적 필터(상태/툴/프로젝트/시간창)로는 "지난주 그 리팩터 잡이
      뭐였지?"를 찾을 수 없었다 — 사람이 잡을 식별하는 유일한 텍스트(command·project·lastError)를
      grep할 방법이 없었다.
      (완료 — `@agentrelay/core/search.ts` 신설(순수·파일시스템 미접촉): `SEARCH_FIELDS`/`SearchField`·
      `DEFAULT_SEARCH_FIELDS`(command/project/id/error — tool은 닫힌 어휘라 opt-in)·`isSearchField` +
      `compileSearch`(기본 대소문자 무시 substring, `--regex`면 정규식[잘못된 패턴은 SyntaxError],
      `--case-sensitive`) + `jobFieldText`(command는 공백 조인, null은 "") + `searchJobs`(빈 쿼리는
      전부가 아니라 []=footgun 방지, 필드 중 하나라도 매치하면 hit, 입력 순서 보존, 비파괴 새 배열) +
      `matchedFields`(어느 필드가 걸렸는지 provenance). CLI `search.ts`에 순수 `searchHeadline`
      ("N of M job(s) match …", substring은 큰따옴표·regex는 슬래시)·`renderSearch`(헤드라인+status
      테이블 재사용)·`renderSearchJson`(--limit 캡은 emitted만, matched는 진짜 개수). `agentrelay search
      <query> [--field ...] [-E/--regex] [-c/--case-sensitive] [--json] [-n/--limit]` 배선, 빈 쿼리·잘못된
      필드·잘못된 limit·잘못된 정규식은 exit 1. core 21 + cli 6 신규 테스트, 실제 빌드 CLI e2e로
      substring/필드 제한/regex+json/no-match/에러 exit 검증. branch `claude/wizardly-pascal-7fkr66`)

- [x] 👷 fix(core): `listDue`가 파싱 불가 `resetAt` 잡을 영구 orphan하던 무음 실패 수정. 자기 발굴
      **버그 픽스** — 열린 PR ~200개가 전부 feature 중복(reset-horizon ×20, NO_COLOR ×4 등)이라
      실질 갭이 없어, 코드를 훑어 아무 PR도 안 건드린 진짜 correctness 버그를 발굴했다.
      (완료 — `listDue`의 인라인 필터가 `new Date(job.resetAt).getTime() <= ref`였는데, `resetAt`이
      파싱 불가 문자열이면 `NaN <= ref`가 **항상 false** → 그 잡은 `listDue`에서 절대 안 나와
      `waiting_for_reset`에 영원히 앉아 재개 안 됨. `import`의 검증(`import.ts`)이 `resetAt`을 "문자열
      또는 null"로만 확인하고 파싱 가능성은 안 봐서, 외부 덤프의 `"resetAt":"next tuesday"` 같은 값이
      그대로 들어오는 실제 도달 경로가 있다 — doctor·recover가 반복 겨냥한 바로 그 "silent failure" 부류.
      `queue.ts`에 순수 `isJobDue(job, refMs)` 신설: `waiting_for_reset` + 비-null resetAt만 대상,
      파싱 결과가 `NaN`이면 **due-now로 취급**(스케줄 불가 잡은 orphan보다 표면화가 안전 — 재개해 성공
      하거나 유효 resetAt으로 재파킹하거나 실패). `listDue`가 이 predicate 사용. queue.test +7(파싱불가
      →due-now e2e 1 + isJobDue 6: 경과/미래/경계 inclusive/null 비-due/파싱불가 due/비-waiting 상태).
      실제 빌드 CLI e2e로 `import`한 `resetAt:"next tuesday"` 잡이 `tick`에서 `-> completed`로 재개됨
      확인(수정 전엔 영구 스킵). branch `claude/fix-listdue-unparseable-reset`)

## 코워크가 발굴한 신규 항목 (수시 추가)

- (아직 없음)
