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

## 코워크가 발굴한 신규 항목 (수시 추가)

- (아직 없음)
