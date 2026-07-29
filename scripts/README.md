# scripts/

저장소 개발·QA용 보조 스크립트. 배포 산출물(`packages/**`)에는 포함되지 않는다.

## `demo.mjs` — 재현 가능한 end-to-end 데모 / 스모크 테스트

AgentRelay의 핵심 흐름(rate-limit 감지 → 리셋까지 큐잉 → 자동 재개)을 실제 5시간
창을 기다리지 않고 **몇 초 만에** 처음부터 끝까지 재현한다.

```bash
pnpm build && pnpm demo
# 또는
node scripts/demo.mjs
```

무슨 일을 하나:

1. rate-limit에 걸렸다가 리셋 후 성공하는 "가짜 에이전트"(`fake-agent.mjs`)를 임시
   디렉터리에 생성한다.
2. `agentrelay run -- node fake-agent.mjs` 로 감싸 실행 → rate-limit 메시지를 파서가
   감지 → 리셋 시각까지 job이 큐에 park 된다.
3. `agentrelay status` 로 대기 중 job과 리셋 예정 시각을 보여준다.
4. 리셋 시각(기본 3초)이 지날 때까지 기다린다.
5. `agentrelay tick` 으로 스케줄러 한 패스를 돌려 job을 재개시킨다 → 가짜 에이전트가
   이번엔 성공하므로 job이 `completed` 로 마감된다.
6. `agentrelay stats` 로 성공률·해결 시간 등 릴레이 효과를 요약한다.

특징:

- **완전 격리** — OS 임시 디렉터리에 전용 스토어(`AGENTRELAY_STORE`)를 두므로 사용자의
  실제 `~/.agentrelay/jobs.json` 을 건드리지 않고, 끝나면 임시 디렉터리를 지운다.
- **QA 겸용** — 마지막에 job이 실제로 `completed` 인지 검증하고, 아니면 비정상 종료
  코드(exit 1)로 끝난다. 수동/CI 스모크 테스트로 그대로 쓸 수 있다.
- `dist` 가 없으면 CLI 패키지만 자동 빌드한다.
- `NO_COLOR` 또는 파이프(non-TTY) 환경에서는 색상 없이 평문으로 출력한다.
