# 운영 메모 (사람용)

## 현재 아키텍처 (2-에이전트 협업, 2026-07-12 가동)

- **원격 저장소**: https://github.com/yangkbgmail/agentrelay (main). 백업 + 공유 지점.
- **클로드 코드 Routine (주력 빌더)**: 사용자 계정에서 매시 실행. `claude/*` 브랜치로
  기능 구현 후 main으로 PR 생성. (claude.ai/code/routines 에서 관리/일시정지 가능.)
- **코워크 오케스트레이터 트리거**: `AgentRelay 코워크 오케스트레이터`
  (id `trig_01Nbiksv1YGDgxya8HCm1LYa`, cron `45 * * * *` — 클로드 코드와 겹치지 않게 스태거).
  하는 일: 클로드 코드 PR 리뷰·테스트·병합, 문서/리서치, 그리고 클로드 코드가 멈추면 빌더 폴백.
- **24시간 체크인 리마인더**: 2026-07-13T18:22:00Z 원래 대화 세션으로 복귀 예정
  (id `trig_01XWtUKWgz8GQotFgzFS47hh`). 그때 진행 점검 후 사용자에게 보고.

## 진행 상황 빠르게 보는 법

- 깃허브 저장소의 커밋/PR 목록이 가장 정확한 현황.
- 샌드박스 안에서는: `cd /home/claude/projects/agentrelay && git fetch origin && git log origin/main --oneline`,
  그리고 `git ls-remote --heads origin 'claude/*'`(클로드 코드 진행 브랜치), `cat PROGRESS.md`.

## 히스토리 (지난 트리거들, 이미 삭제됨)

- `trig_013MW...` 초기 24h 빌드(1~2개만/COMPLETE 후 정지) → non-stop으로 교체하며 삭제.
- `trig_01KWu...` non-stop 단독 빌더 → 깃허브 연결 후 오케스트레이터로 전환하며 삭제.

## 자격증명

- 깃허브 push용 fine-grained PAT가 credential store 파일로 샌드박스에 저장됨(만료 7일 설정).
  만료/폐기되면 자율 세션의 push가 실패하므로, 그때는 토큰 갱신 또는 수동 동기화로 전환 필요.
