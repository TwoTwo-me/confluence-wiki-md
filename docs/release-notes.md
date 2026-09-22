# v0.2.0

Markdown의 중복 `preserved` XML을 줄이고, Confluence 네이티브 템플릿 ID를 CLI에서 사용할 수 있습니다.

- 기본 보존 모드는 `minimal`입니다. 일반 Markdown과 설정된 Mermaid/PlantUML 도표는 소스로 재생성하고, 재생성할 수 없는 요소만 보존합니다. `--preserve all|none` 또는 `CONFLUENCE_PRESERVE`로 변경할 수 있습니다.
- TOC는 `confluence-toc` YAML 코드블록으로 다운로드하며, preserved 없이 실제 목차 매크로로 다시 게시합니다.
- Include Page는 `minimal`에서도 참조 매크로 보존 항목이 필요합니다. `none`에서는 포함 본문과 동적 포함 기능을 잃으며, 남는 링크도 포함 원문 링크가 아닙니다.
- `templates list`, `templates read`, `--template ID`, `CONFLUENCE_TEMPLATE`로 네이티브 템플릿을 선택합니다. 새 페이지에 한 번 적용하고 이후 업데이트에는 중복 삽입하지 않습니다. 로컬 YAML 템플릿도 지원합니다.
- 표의 파이프·줄바꿈과 위·아래첨자 왕복 변환을 수정했습니다. Cloud의 중첩 인용은 읽을 수 있는 `›` 깊이 표시로 정규화합니다.

## 업그레이드 시 설정

기본 인증 파일은 `~/.config/cfwiki/.env`입니다. 절대 경로의 `XDG_CONFIG_HOME`을 사용하면 그 아래 `cfwiki/.env`를 읽습니다.
현재 작업 폴더의 `.env`는 자동으로 읽지 않습니다. 기존 파일을 계속 사용하려면 `cfwiki ... --env .env`를 지정하거나 기본 위치로 옮기세요.
Cloud와 사내 Data Center PAT 프로필은 계속 분리해서 사용합니다.

네이티브 템플릿을 조회하는 Cloud granular 토큰에는 `read:template:confluence`와 `read:content-details:confluence` 권한이 필요합니다.
로컬 `validate` / `convert`에서 새 네이티브 템플릿을 조회하려면 `--server`를 명시해야 합니다.

## 설치

GitHub Packages에 로그인한 뒤 설치하거나 업데이트합니다. GitHub 사용자 이름과 `read:packages` 권한의 classic PAT를 사용하세요.

```sh
npm login --scope=@twotwo-me --auth-type=legacy --registry=https://npm.pkg.github.com
npm install --global @twotwo-me/confluence-wiki-md@0.2.0
cfwiki --help
```

GitHub Packages 인증 없이 동일한 릴리스 파일로 설치할 수도 있습니다.

```sh
npm install --global https://github.com/TwoTwo-me/confluence-wiki-md/releases/download/v0.2.0/confluence-wiki-md.tgz
cfwiki --help
```

Node.js 24 이상이 필요합니다. 일반 Markdown만 사용하거나 Chrome을 별도로 준비했다면 설치 명령 앞에 `PUPPETEER_SKIP_DOWNLOAD=true`를 붙여 브라우저 다운로드를 생략할 수 있습니다.
패키지에는 인증 정보가 빈 Cloud/PAT 설정 예제, Markdown 예제, YAML 템플릿과 `confluence-wiki` 스킬이 들어 있습니다. 실제 인증 정보는 사용자가 설정합니다.

v0.1.1 이하의 비스코프 패키지를 사용했다면 `npm uninstall --global confluence-wiki-md` 후 새 패키지를 설치하고 에이전트 스킬 심볼릭 링크를 새 경로로 바꾸세요.

## 검증

101개 자동 테스트와 체크아웃 밖에서의 패키지 설치 검사를 수행합니다. 릴리스 워크플로는 게시 후 GitHub Packages에서 다시 설치해 검증된 배포 파일과 SHA-512 무결성이 같은지 확인합니다.
실제 Cloud에서 Markdown·도표·첨부·네이티브 템플릿 왕복과 TOC 이동, Include 원문 변경 반영을 확인했습니다. 사내 Data Center 실서버 검증은 이번 릴리스에 포함되지 않습니다.

[설치 및 인증 안내](https://github.com/TwoTwo-me/confluence-wiki-md#readme). `SHA256SUMS`에 릴리스 파일의 SHA-256을 제공합니다.
