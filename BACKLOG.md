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
- [x] 👷 `agentrelay backup` — 스토어 스냅샷 + 백업 로테이션. 세션 14의 손상 복구(사후)를
      보완하는 **사전 예방** 백업으로, 정상 상태의 스토어를 롤백 지점으로 남긴다.
      (완료 — `@agentrelay/core/backup.ts` 신설: 순수 `backupStamp(now)`(fs-safe ISO 접미사,
      corruptBackupPath와 동일 규약이라 고정폭·연도우선 → 문자열 정렬=시간순)·
      `backupPathFor(store,now)`(형제 파일 `<store>.bak-<stamp>`)·`isBackupFile(name,base)`
      (`.corrupt-`/`.tmp-` 사이드카는 제외)·`selectRotatedBackups(entries,base,keepLast)`
      (백업만 필터→오름차순 정렬→keepLast 초과분[가장 오래된 것부터] 반환, `≤0`이면 전부).
      `DEFAULT_BACKUP_KEEP`(10). CLI `backupStore({storePath,keepLast,now})`가 스토어를
      temp 형제로 복사→원자적 rename(point-in-time 스냅샷)→디렉터리 스캔→오래된 백업 unlink.
      스토어 없으면 ok:false, 로테이션 실패(unlink/readdir)는 삼켜 스냅샷 성공 보장.
      `agentrelay backup [--keep N] [--json]`, `--keep`는 1 미만 거부(방금 만든 백업이
      즉시 로테이션되는 것 방지). branch `claude/wizardly-pascal-o3t0dh`)

## 코워크가 발굴한 신규 항목 (수시 추가)

- (아직 없음)
