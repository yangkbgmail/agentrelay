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
- [ ] 👷 엣지 케이스 테스트 보강(다양한 rate-limit 메시지 포맷 회귀 케이스).
- [ ] 👷🧭 최종 QA + 재현 가능한 데모 스크립트.

## 무한 개선 백로그 (SPEC §8 — MVP 이후에도 계속)

- [ ] 👷 Codex CLI 등 다른 에이전트 툴 어댑터.
- [x] 👷 job 재시도 정책 / 지수 백오프 / 최대 시도 횟수.
      (완료 — `@agentrelay/core`의 `retry.ts`: `RetryPolicy`/`computeBackoffMs`/`canRetry`/
      `retryPolicyFromEnv`. 스케줄러가 명령 실패(non-zero exit·spawn 에러)를 감지해 지수
      백오프로 재큐잉하고 `maxRetries` 초과 시 `failed` 처리. 레이트리밋 재큐잉과는 분리
      (`retryCount` 별도). CLI daemon/tick에 env 설정 연결. branch `claude/wizardly-pascal-k87ir2`)
- [ ] 👷 `agentrelay status`를 실시간 TUI로.
- [ ] 👷 lint(ESLint/Biome) + CI 워크플로 도입.
- [ ] 🧭 경쟁 도구(claude-auto-retry 등) 심층 조사 → 차별화 포인트 문서화.
- [ ] 🧭 실제 rate-limit 메시지 샘플 수집 → 파서 패턴 보강 제안.
- [ ] 🧭 성능/효율화 분석(파일 I/O, 대량 job) → 최적화 항목 도출.

## 코워크가 발굴한 신규 항목 (수시 추가)

- (아직 없음)
