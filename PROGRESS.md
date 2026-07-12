# PROGRESS LOG

이 파일은 무인 빌드 세션 간의 유일한 "기억"입니다. 새 세션은 항상 이 파일을 먼저 읽고,
가장 아래(최신) 항목부터 확인해서 다음 할 일을 정합니다.

## MVP 체크리스트 (SPEC.md §3 동기화)

- [x] 0. 프로젝트 부트스트랩: SPEC.md, PROGRESS.md, 모노레포 골격
- [x] 1. core 패키지: rate-limit 파서 + 큐 + 스케줄러 (+ 유닛 테스트) — 16개 테스트 통과
- [x] 2. cli 패키지: `agentrelay run` / `agentrelay daemon` / `agentrelay tick` / `agentrelay status` — 실제 프로세스로 e2e 스모크 테스트 완료
- [x] 3. dashboard 앱: Next.js 로컬 대시보드 — `apps/dashboard`, `/api/jobs` 폴링, 라이트/다크 검증 완료
- [x] 4. Slack 알림 연동 (선택적 설정) — `@agentrelay/core` Slack notifier, run/daemon/tick 연결, e2e 검증
- [ ] 5. 테스트 커버리지 점검 (core/cli 엣지 케이스 보강)
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
