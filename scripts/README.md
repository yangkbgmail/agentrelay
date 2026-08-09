# scripts/

저장소 유지·데모용 보조 스크립트.

## `demo.mjs` — 재현 가능한 엔드투엔드 데모 & 스모크 QA

실제 rate-limit을 기다리지 않고도 AgentRelay의 전 경로
(**run → 감지 → 큐 → tick → 재개 → completed**)를 로컬에서 몇 초 만에 재현한다.
스크린샷/GIF용 시나리오이자, 마지막에 최종 상태를 검증하고 어긋나면 0이 아닌 종료
코드로 끝나는 **스모크 테스트**이기도 하다(로컬/CI 프리플라이트 게이트로 사용 가능).

### 실행

```bash
pnpm build          # 최초 1회(또는 CLI 변경 후). 스크립트가 산출물이 없으면 자동 빌드도 시도.
pnpm demo           # = node scripts/demo.mjs
# 또는 직접:
node scripts/demo.mjs [--reset <초>] [--keep] [--quiet]
```

| 플래그          | 의미 |
| --------------- | ---- |
| `--reset <초>`  | 가짜 rate-limit의 리셋까지 초(기본 4). 더 빠른 데모는 2~3. |
| `--keep`        | 끝나도 임시 스토어/작업공간을 지우지 않고 경로를 출력(직접 `agentrelay --store <path> show <id>` 등으로 탐색). |
| `--quiet`       | 단계별 설명 없이 최종 결과만(성공/실패 + 종료 코드). CI 친화. |

### 동작 원리

스케줄러가 잡의 `command`를 **그대로 재실행**한다는 사실
(`packages/core/src/scheduler.ts`) 위에서, 상태 기반 "가짜 에이전트"를 심는다:

- **첫 실행**: `Your limit resets at <ISO>` 를 출력하고 exit 1 →
  파서(`iso-timestamp` 패턴)가 감지해 잡을 `waiting_for_reset`로 큐잉.
- **재개 실행**(`tick`이 리셋 후 재실행): 성공 메시지 + exit 0 → 잡 `completed`.

카운터 파일로 실행 횟수를 구분하므로, 동일 명령의 재실행만으로 "제한 → 해제 → 완료"
전 과정을 결정론적으로 보여준다. 모든 상태는 격리된 임시 `jobs.json`에만 기록되어
사용자의 실제 큐(`~/.agentrelay/jobs.json`)를 건드리지 않는다.
