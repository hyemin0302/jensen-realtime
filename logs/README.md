# logs

Claude Code 실행 로그가 쌓이는 폴더입니다.

- `claude-code.log` — Claude Code 세션이 시작될 때마다 한 줄씩 자동 기록됩니다.
  - 형식: `[YYYY-MM-DD HH:MM:SS TZ] SessionStart  session=<id>  source=<startup|resume|clear|compact>  cwd=<경로>`
  - 기록 시점: `.claude/settings.json`의 `SessionStart` hook이 담당합니다.

## 동작 방식

`.claude/settings.json`에 등록된 SessionStart hook이 세션 시작 시 stdin으로 받은
JSON(`session_id`, `source` 등)을 파싱해 `claude-code.log`에 append 합니다.

hook을 확인/수정/비활성화하려면 Claude Code에서 `/hooks` 메뉴를 사용하세요.
