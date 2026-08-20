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

[STUB_PLACEHOLDER_TO_BE_REPLACED_BY_LOCAL_FILE_UPLOAD]
