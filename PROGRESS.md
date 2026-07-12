# PROGRESS LOG

이 파일은 무인 빌드 세션 간의 유일한 "기억"입니다. 새 세션은 항상 이 파일을 먼저 읽고,
가장 아래(최신) 항목부터 확인해서 다음 할 일을 정합니다.

## MVP 체크리스트 (SPEC.md §3 동기화)

- [x] 0. 프로젝트 부트스트랩: SPEC.md, PROGRESS.md, 모노레포 골격
- [x] 1. core 패키지: rate-limit 파서 + 큐 + 스케줄러 (+ 유닛 테스트) — 16개 테스트 통과
- [x] 2. cli 패키지: `agentrelay run` / `agentrelay daemon` / `agentrelay tick` / `agentrelay status` — 실제 프로세스로 e2e 스모크 테스트 완료
- [ ] 3. dashboard 앱: Next.js 로컬 대시보드
- [ ] 4. Slack 알림 연동 (선택적 설정)
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
