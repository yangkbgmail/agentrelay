# AgentRelay — PRD / SPEC (v0.1, working name)

> 이 문서는 24시간 무인 자율 빌드의 "북극성"입니다. 매 시간 새로 시작되는 에이전트 세션은
> 이 문서와 `PROGRESS.md`만 보고 이전 맥락 없이 작업을 이어갑니다. 임의로 이 문서의 방향을
> 바꾸지 말고, 체크리스트를 하나씩 완료해 나가세요.

## 1. 문제 정의

AI 코딩 에이전트(Claude Code, Codex CLI, 기타 CLI 기반 에이전트)를 하루 종일 돌리는
파워유저는 5시간 단위 사용량 제한(rate limit)에 자주 부딪힌다. 제한에 걸리면 세션이
끊기고, 사람이 리셋 시각을 기억했다가 직접 돌아와 `--resume`으로 이어줘야 한다.
커뮤니티에는 `claude-auto-retry` 같은 tmux 기반 땜질 스크립트가 있지만, 다음이 없다.

- 여러 프로젝트/여러 에이전트/여러 CLI 툴을 한 곳에서 보는 대시보드
- 리셋까지 남은 시간, 밀린 작업 큐, 완료 로그를 한눈에 보는 UI
- Slack/이메일 알림
- 여러 CLI 도구(Claude Code, 향후 Codex 등)에 확장 가능한 공통 추상화

## 2. 타깃 사용자

- 하루 여러 시간 AI 코딩 에이전트를 돌리는 개발자 / 인디해커
- 여러 명이 각자 에이전트를 돌리는 소규모 개발팀 (누가 얼마나 막혀있는지 모름)

## 3. MVP 범위 (반드시 지킬 것: 로컬 우선, 클라우드 인프라 불필요)

빌드 주체가 무인 상태로 24시간 작업하므로, **클라우드 배포/결제/도메인 등 사람의
승인이 필요한 요소는 MVP에서 제외**한다. 대신 "내 컴퓨터에서 `npx agentrelay` 한 줄로
설치해서 바로 쓸 수 있는 로컬 CLI + 로컬 대시보드"를 완성도 있게 만드는 데 집중한다.
클라우드/SaaS화는 v2 로드맵으로 문서화만 해둔다.

### MVP 기능 체크리스트 (PROGRESS.md의 소스 오브 트루스)

1. **core 패키지**: rate-limit 메시지 파서, 작업 큐(SQLite), 스케줄러
2. **cli 패키지**: `agentrelay run -- <command>` 래퍼, `agentrelay daemon`, `agentrelay status`
3. **dashboard 앱**: Next.js 로컬 대시보드 (localhost) — 큐 상태, 리셋 카운트다운, 로그, 사용량 차트
4. **알림**: Slack webhook 연동 (선택적 설정)
5. **테스트**: core 패키지 유닛 테스트 (vitest), 주요 파서/스케줄러 케이스 커버
6. **문서**: README(설치/사용법), ARCHITECTURE.md, ROADMAP.md(v2: 클라우드 동기화, 팀 대시보드, 과금)
7. **패키징**: 로컬에서 `pnpm build` 후 정상 동작 확인, 배포 전 최종 QA

## 4. 아키텍처

```
agentrelay/ (pnpm monorepo)
├── packages/
│   ├── core/         # 순수 로직: 파서, 큐, 스케줄러, 타입 (프레임워크 무관)
│   └── cli/           # core를 사용하는 CLI 실행 파일 (bin/agentrelay)
├── apps/
│   └── dashboard/      # Next.js, core의 SQLite DB를 읽어 로컬에서 렌더
├── SPEC.md
├── PROGRESS.md
└── README.md
```

- **저장소**: SQLite 파일(`~/.agentrelay/agentrelay.db`), 외부 DB 불필요
- **파서**: Claude Code rate-limit 에러 메시지에서 리셋 시각(ISO 타임스탬프 또는
  "5시간 후" 류 상대 시간)을 정규식으로 추출. 여러 포맷에 대응하도록 설계하고,
  테스트 케이스로 회귀 방지.
- **스케줄러**: 폴링 루프(기본 30초 간격)로 큐를 확인, 리셋 시각이 지난 작업을
  꺼내 `child_process.spawn`으로 원 명령을 재실행(가능하면 `--resume`/컨텍스트 유지 플래그 사용).
- **대시보드**: 같은 SQLite 파일을 읽기 전용으로 폴링해 상태를 보여줌. 별도 백엔드 서버 불필요
  (Next.js API route가 better-sqlite3로 직접 읽음).

## 5. 성공 기준 (24시간 뒤 기준)

- [ ] `pnpm install && pnpm build`가 에러 없이 통과
- [ ] `agentrelay run -- <가짜 rate-limit 명령>`으로 파서/큐/재개 흐름이 로컬에서 실제로 동작하는 데모 가능
- [ ] 대시보드가 `localhost:3000`에서 큐 상태를 실시간으로 보여줌
- [ ] 유닛 테스트 통과
- [ ] README만 보고 처음 보는 사람이 5분 안에 설치·실행 가능
- [ ] ROADMAP.md에 v2(클라우드/팀/과금) 방향이 정리되어 있어 사업화 여부를 사람이 바로 판단 가능

## 6. 경쟁/포지셔닝 메모

- `claude-auto-retry`(npm): tmux 래핑, CLI 전용, UI 없음, 단일 툴 전용 — AgentRelay는
  "여러 툴 + 대시보드 + 알림"으로 차별화.
- Claude Code 자체 Routines(클라우드 예약 작업)와는 보완 관계: Routines는 "정해진 스케줄"에
  강하고, AgentRelay는 "예측 불가능한 rate-limit 리셋 시점"에 강하다.

## 7. 무인 빌드 운영 규칙 (매 시간 세션이 지켜야 할 것)

1. 작업 시작 전 반드시 `PROGRESS.md`를 읽고 마지막 상태를 파악한다.
2. 한 세션에서 체크리스트 1~3개 항목을 "제대로" 끝내는 것을 목표로 한다(전체를 한번에
   끝내려 하지 않는다).
3. 코드를 만들면 반드시 실행/테스트해서 실제로 동작하는지 확인한 뒤 커밋한다.
4. 매 세션 종료 전 `PROGRESS.md`에 한 줄 로그(시각, 한 일, 다음에 할 일)를 추가한다.
5. MVP 체크리스트가 전부 끝났으면 `COMPLETE.md`를 작성하고 더 이상 작업하지 않는다
   (완료 상태를 반복해서 덮어쓰지 않는다).
6. 막히거나 사람의 판단이 필요한 결정(예: 유료 API 키 필요, 배포 계정 필요)이 생기면
   억지로 진행하지 말고 `BLOCKED.md`에 무엇이 필요한지 적고 다음으로 넘어갈 수 있는
   작업을 대신 진행한다.
