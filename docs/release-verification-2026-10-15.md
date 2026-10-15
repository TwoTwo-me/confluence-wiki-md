# v0.4.0 공개 배포 확인

2026-10-15에 기능 구현, 실제 Confluence 비교 실험과 공개 설치를 확인했습니다. 이 문서는 배포 후의 확인 기록이며, 이미 게시한 v0.4.0 파일과 태그는 변경하지 않습니다.

## 배포 파일

- 소스 커밋: `28be84e1563f1d07585b4a5ea5e328b38c2a3fa1`
- [GitHub v0.4.0 릴리스](https://github.com/TwoTwo-me/confluence-wiki-md/releases/tag/v0.4.0)
- [공개 npm 패키지](https://www.npmjs.com/package/@twotwo-me/confluence-wiki-md): `@twotwo-me/confluence-wiki-md@0.4.0`
- `confluence-wiki-md.tgz`: 149,644 bytes
- SHA-256: `dcc67416c5cb3624d5cf49d28868fd50e0b02022ccd7961006fda3fd01fb7692`
- npm SHA-512: `ACsrRR0w8nsmoZl8eHz74k0n9OXnWp6QrYZnFmfNlyLLNF9Jv4SMjiGdFfSGZf+CqYXUPYbp2DAoFOQpvjpFvw==`

npm과 GitHub에서 받은 압축파일은 검증한 로컬 압축파일과 일치했습니다. npm 게시 직후에는 처리 중 응답과 일시적인 404가 있었으며, 공개 메타데이터와 설치까지 확인한 뒤 완료로 판단했습니다.

## 검증 결과

| 확인 | 결과 |
| --- | --- |
| 전체 자동 테스트 | 824/824 통과, Linux·macOS CI 성공 |
| 패키지 검사 | 저장소 밖 전역 설치, CLI 실행, Markdown 왕복 통과 |
| GitHub 공개 설치 | 빈 npm 설정·새 캐시·인증 없는 URL로 설치 통과 |
| npm 공개 설치 | 빈 사용자/시스템 설정·새 캐시·토큰 환경 변수 제거 후 설치 통과 |
| 배포된 스킬 | Codex·Claude Code·OpenCode·Cursor 복사, 재설치, 일회성 실행 통과 |
| 외부 skills 설치기 | `skills@1.7.2`로 공개 GitHub 익명 설치, 네 에이전트 선택 및 원본 파일 일치 확인 |
| 실제 페이지 트리 | 한글 제목·3단계 계층·링크·첨부·충돌 거부 확인 |
| 실제 편집 비교 | 6종 문서 × 6개 원격 편집 방식 중 34개 저장·내용 검사 통과, MCP Markdown 2개 안전 거부 후 원문 유지 확인 |

curl의 원시·필터링·로컬 패치 열은 같은 실제 REST 작업을 문맥에 노출하는 세 가지 방식입니다. 독립된 세 번의 원격 편집으로 세지 않습니다. 내용 검사 범위와 토큰 계산의 한계는 [토큰 비교 보고서](token-benchmark.md)에 기록했습니다.

[CI 실행](https://github.com/TwoTwo-me/confluence-wiki-md/actions/runs/38740084232) · [릴리스 및 GitHub 무인증 설치 실행](https://github.com/TwoTwo-me/confluence-wiki-md/actions/runs/38740212404)

외부 설치기는 임시 HOME·작업 폴더·새 npm 캐시, 빈 npm 설정, Git 자격 증명 비활성화 상태에서 [설치 안내](installation.md)의 공개 저장소 명령을 실행했습니다. Codex·OpenCode·Cursor는 `.agents/skills` 복사본을 공유하고 Claude Code는 `.claude/skills` 복사본을 사용했습니다. 두 위치의 스킬 파일 5개씩이 공개 소스 커밋의 원본과 바이트·SHA-256 모두 일치했습니다. 해당 실행의 설치 시간은 약 2초였으며 일반적인 성능 보장으로 보지는 않습니다.

## 로그인 없는 설치

Node.js 24 이상에서 다음을 실행합니다.

```sh
PUPPETEER_SKIP_DOWNLOAD=true npm install --global @twotwo-me/confluence-wiki-md@0.4.0 --registry=https://registry.npmjs.org/
cfwiki skill install --agent codex
```

다른 에이전트는 `--agent claude`, `--agent opencode`, `--agent cursor` 또는 `--agent all`을 사용합니다. 프로젝트에만 설치하려면 `--project /absolute/path/to/project`를 추가합니다. [전체 설치 안내](installation.md)에 GitHub 직접 설치, Windows와 npx 명령도 있습니다. Confluence 프로필은 각 사용자가 별도로 설정합니다.

## 다음 npm 배포

이번 npm 배포에 사용한 임시 granular token은 게시 후 폐기했습니다. 인증 정보는 공개 소스와 패키지에 포함하지 않았습니다.

GitHub Actions OIDC 배포 작업은 구현했지만 활성화하지 않았습니다. npm 웹사이트에서 Trusted Publisher를 저장할 때 계정 2FA 등록으로 전환됐고, 사용 가능한 등록 방식은 패스키·보안 키였습니다. 계정 소유자의 기기 인증이 남아 있어 연결이 생성됐다고 기록하지 않습니다.

기기에서 계정 2FA를 설정한 뒤 패키지 Settings의 Trusted Publisher를 아래 값으로 등록합니다.

- Publisher: GitHub Actions
- Organization or user: `TwoTwo-me`
- Repository: `confluence-wiki-md`
- Workflow filename: `release.yml`
- Allow npm publish: 선택

연결을 확인한 뒤 저장소 변수 `NPM_PUBLISH_ENABLED=true`를 설정하면 이후 릴리스에서 OIDC 게시와 공개 npm 설치 검증이 실행됩니다. 이번 릴리스에서 해당 두 작업은 조건에 따라 건너뛰었으며, 공개 npm 설치는 로컬의 격리된 환경에서 별도로 통과했습니다. GitHub 릴리스 게시와 무인증 설치 자동화는 실행을 통과했습니다.
