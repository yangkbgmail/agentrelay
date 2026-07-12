# CLAUDE.md — Claude Code 작업 지침 (주력 빌더용)

> 이 파일은 **클로드 코드**가 이 저장소에서 작업할 때 매 세션 시작에 읽는 지침입니다.
> 코워크(오케스트레이터)와의 협업 규칙은 `COLLAB.md`, 무엇을 만들지는 `SPEC.md`,
> 진행 상황은 `PROGRESS.md`, 할 일 큐는 `BACKLOG.md`를 보세요.

## 당신의 역할

당신(클로드 코드)은 이 프로젝트의 **주력 코드 빌더**입니다. `packages/**`, `apps/**`의
실제 구현을 담당합니다. 기획/리서치/리뷰/문서/조율은 코워크가 맡습니다.

## 프로젝트 한 줄 요약

AgentRelay — AI 코딩 에이전트(Claude Code 등)의 사용량 제한(rate limit)을 감지해 리셋
시점에 작업을 자동 재개시키는 **로컬 우선 CLI + 로컬 Next.js 대시보드**. 클라우드 배포/결제는
범위 밖(로컬 완결). 자세한 내용은 `SPEC.md`.

## 개발 환경 / 명령어

- pnpm 모노레포. 루트에서 `pnpm install`, `pnpm build`, `pnpm test`.
- Node ≥ 22.5 (이유는 아래 "중요한 결정" 참고).
- 패키지: `packages/core`(파서·큐·스케줄러), `packages/cli`(commander CLI), `apps/dashboard`(예정).

## 코드 컨벤션

- TypeScript strict, ESM(`"type": "module"`), `.js` 확장자로 상대 import(NodeNext).
- 테스트는 vitest. 새 로직엔 반드시 유닛 테스트를 붙이고 통과시킨 뒤 커밋.
- 목업/TODO만 남기지 말 것 — 실제로 실행·테스트해서 동작을 확인.

## 중요한 결정 (뒤집지 말 것)

- **저장소는 SQLite가 아니라 의존성 0개의 JSON 파일**을 씀. `better-sqlite3`는 네이티브
  빌드가 샌드박스 네트워크에서 실패했고, `node:sqlite`는 experimental이라 Vite/vitest와
  충돌했음. 이미 두 번 검증하고 내린 결론. 근거는 `packages/core/src/queue.ts` 상단 주석.

## 작업 방식 — 멈추지 않고 최대치로

- `BACKLOG.md`에서 우선순위 높은 항목을 골라 **브랜치를 파고**(`feat/...`, `fix/...`)
  구현 → 테스트 → PR을 연다. 한 항목 끝나면 곧바로 다음 항목으로.
- MVP(`SPEC.md` §3)가 끝나도 멈추지 말고 §8 "무한 개선 백로그"를 계속 소진. 비면 스스로
  새 개선 항목을 발굴해 `BACKLOG.md`에 추가.
- PR 본문에 "무엇을/왜/어떻게 테스트했는지"를 적는다. 코워크가 리뷰한다(`COLLAB.md`).

## 하지 말 것

- 되돌리기 어렵거나 비용이 드는 행동: 실제 클라우드 배포, 결제, 도메인 구매, 외부로의 실제 발송.
- 저장소 밖의 파일이나 다른 프로젝트를 건드리는 것.
- `docs/**`, `SPEC.md`, `BACKLOG.md`, `COLLAB.md` 등 코워크 소유 영역을 임의로 대폭 수정하는 것
  (제안은 PR/코멘트로).
