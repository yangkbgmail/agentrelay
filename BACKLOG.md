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

- (자세한 이전 세션 항목은 이 파일의 앞부분과 PROGRESS.md 로그에 있음. 이 세션이 추가한 항목:)

- [x] 👷 `agentrelay doctor` 큐-사이드 리셋 지평선 검사(`queued-reset-horizon`) — 세션 72
      파스-사이드 가드(`isPlausibleReset`)가 못 잡는 잔여 케이스: 가드 도입 전에 만들어진 스토어,
      가드가 꺼졌던 시점에 큐잉된 잡, 라이터 지평선이 짧아진 뒤 남은 잡. 잡의 `resetAt`이 현재
      지평선 너머에 파킹되어 있으면 `listDue`가 영원히 릴리스하지 않아 조용히 재개 실패 — 자기
      발굴 항목(어떤 열린 PR도 다루지 않음).
      (완료 — `@agentrelay/core/doctor.ts`에 `FarFutureResetFact`(id·project·resetAt·futureMs)
      타입 + 순수 `distinctFarFutureResets(jobs, {now, maxFutureMs})` 신설: `waiting_for_reset`인
      잡 중 `resetAt`이 `now + maxFutureMs`를 넘는 것만 반환, 미래-쪽만 경계(파스 가드와 동일 규칙 —
      과거 리셋은 due-now이므로 별개 관심사), 파싱 불가/null `resetAt`은 스킵(다른 방식으로 malformed
      이라 여기서 울지 않음), worst-first 정렬. `maxFutureMs`가 null/비양수/비유한이면 빈 배열(가드
      비활성 신호). `DiagnosticInput`에 `farFutureResets`+`maxFutureResetMs` 필드, `runDiagnostics`에
      `queuedResetHorizonCheck`(파스 가드와 같은 완만한 warning — 릴레이 자체는 안 부서졌고 잡 하나가
      스스로 안 풀릴 뿐, `cancel`/`retry` 힌트) 추가(node→store→...→daemon→**queued-reset-horizon**
      →config→notify 순). `humanizeDuration`(초~일 컴팩트) 헬퍼도 sibling으로 신설(`humanizeAge`와 동일
      라운딩). CLI `commands.ts` `runDoctor`가 `maxResetHorizonMsFromEnv()`로 지평선을 파스와 **동일하게**
      해소해 `distinctFarFutureResets`에 주입(`options.nowMs` 지원 유지 → 결정론). 파스 가드가 `off`면
      큐-검사도 자동 OK-skipped(설정 한 곳으로 양 표면 판정이 일치). core doctor +12 신규(파스+검사 파싱
      경계·비-waiting 무시·과거 무시·null/미파싱 무시·가드 비활성 빈 배열·worst-first 정렬·검사 OK/warning/
      skipped 3케이스), CLI doctor +3 신규(실제 스토어·seed된 30일 ghost·기본/off 스위치). 실제 빌드 CLI
      `agentrelay doctor` e2e로 빈 스토어→OK·30일 ghost 잡→warning(`8d horizon` + `ghost` project +
      `30d` future + cancel/retry hint)·`AGENTRELAY_MAX_RESET_HORIZON=off`면 skipped 확인. 새 파서/스케줄러
      로직 0줄 — 판정은 순수, 데이터 소스는 스토어 자체. branch `claude/wizardly-pascal-z54k04`)

## 코워크가 발굴한 신규 항목 (수시 추가)

- (아직 없음)
