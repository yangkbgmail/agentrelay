# PROGRESS LOG

이 파일은 무인 빌드 세션 간의 유일한 "기억"입니다. 새 세션은 항상 이 파일을 먼저 읽고,
가장 아래(최신) 항목부터 확인해서 다음 할 일을 정합니다.

## MVP 체크리스트 (SPEC.md §3 동기화)

- [x] 0. 프로젝트 부트스트랩: SPEC.md, PROGRESS.md, 모노레포 골격
- [ ] 1. core 패키지: rate-limit 파서 + 큐 + 스케줄러 (+ 유닛 테스트)
- [ ] 2. cli 패키지: `agentrelay run` / `agentrelay daemon` / `agentrelay status`
- [ ] 3. dashboard 앱: Next.js 로컬 대시보드
- [ ] 4. Slack 알림 연동 (선택적 설정)
- [ ] 5. 테스트 커버리지 점검 (core 위주)
- [ ] 6. 문서: README / ARCHITECTURE.md / ROADMAP.md
- [ ] 7. 최종 QA + 데모 시나리오 스크립트

## 로그

### [세션 0 — 킥오프] (2026-07-12, 사람이 지켜보는 상태에서 시작)
- 한 일: 아이디어 확정(AgentRelay), SPEC.md/PROGRESS.md 작성, git 저장소 초기화.
- 다음 할 일: pnpm 모노레포 골격 생성 → core 패키지의 파서/큐/스케줄러부터 구현.
- 참고: 이후 세션은 매시간 자동 트리거로 발화되며, 이전 대화 맥락이 전혀 없습니다.
  반드시 SPEC.md 전체를 읽고 시작하세요.
