# v0.3.0

기존 공간에 근거 기반 공유 LLM Wiki를 만들고, 댓글과 페이지 보기·편집 제한을 CLI에서 관리할 수 있습니다.

- `init`은 기존 공간에 위키 루트를 만듭니다. Cloud는 공간 홈페이지의 자식 페이지와 동적 Child items 목록을, Data Center는 최상위 페이지와 Page Tree를 사용합니다.
- `create`, `read`, `apply`, `delete`는 명시한 위키 루트 안의 term을 생성·검증·수정·휴지통 이동합니다. `apply`는 기준 버전과 현재 본문을 재확인하고, 충돌이나 작성자를 확정할 수 없는 결과를 성공으로 오인하지 않습니다.
- `lookup`은 공간의 검색 후보를 찾고, `explore`는 검색과 실제 저장 본문에서 확인한 정방향 링크를 제한된 예산 안에서 탐색합니다. 역링크나 외부 인덱스는 사용하지 않으며 검색 발췌문을 답변 근거로 삼지 않습니다.
- `comments`는 Cloud의 footer·inline 댓글과 답글, Data Center에서 지원하는 footer 작업을 제공합니다. 댓글 수정·삭제·해결에는 조회한 현재 버전을 명시해야 합니다.
- 새 `upload`·`push` 페이지는 기본 `view-edit` 직접 제한으로 생성합니다. `restrictions get|set`은 기존 페이지의 직접 제한을 조회하거나 명시적으로 교체하며, 상속된 권한이나 실제 접근 가능 여부까지 계산하지는 않습니다.
- 패키지에 들어 있는 에이전트 스킬과 README에 루트 생성부터 근거 인용까지의 사용법을 추가했습니다.

## 업그레이드 시 확인

Cloud와 Data Center 사용자는 기존 프로필을 계속 분리해서 사용합니다. Cloud에서 새 위키 및 댓글·제한 작업을 실행할 계정에는 해당 공간 접근 권한과 작업별 API 권한이 필요합니다. 자세한 범위와 Data Center 지원 차이는 [README](https://github.com/TwoTwo-me/confluence-wiki-md#readme)를 확인하세요.

새 `upload`·`push`의 기본 제한을 설정할 수 없는 Cloud Free 등에서는 게시가 실패하며 공개 페이지로 다시 생성하지 않습니다. 의도한 경우에만 `--restrictions none` 또는 프로필의 `CONFLUENCE_RESTRICTIONS`를 명시하세요. 기존 페이지에 대한 `upload`·`push`는 제한을 바꾸지 않습니다. 위키의 `init`·`create`와 일반 `upload`의 생성·권한 흐름도 구분하세요.

## 설치

GitHub Packages에 로그인한 뒤 설치하거나 업데이트합니다. GitHub 사용자 이름과 `read:packages` 권한의 classic PAT를 사용하세요.

```sh
npm login --scope=@twotwo-me --auth-type=legacy --registry=https://npm.pkg.github.com
npm install --global @twotwo-me/confluence-wiki-md@0.3.0
cfwiki --help
```

GitHub Packages 인증 없이 동일한 릴리스 파일로 설치할 수도 있습니다.

```sh
npm install --global https://github.com/TwoTwo-me/confluence-wiki-md/releases/download/v0.3.0/confluence-wiki-md.tgz
cfwiki --help
```

Node.js 24 이상이 필요합니다. 일반 Markdown만 사용하거나 Chrome을 별도로 준비했다면 설치 명령 앞에 `PUPPETEER_SKIP_DOWNLOAD=true`를 붙여 브라우저 다운로드를 생략할 수 있습니다.
패키지에는 인증 정보가 빈 Cloud/PAT 설정 예제, Markdown 예제, YAML 템플릿과 `confluence-wiki` 스킬이 들어 있습니다. 실제 인증 정보는 사용자가 설정합니다.

v0.1.1 이하의 비스코프 패키지를 사용했다면 `npm uninstall --global confluence-wiki-md` 후 새 패키지를 설치하고 에이전트 스킬 심볼릭 링크를 새 경로로 바꾸세요.

## 검증

자동 테스트와 체크아웃 밖에서의 패키지 설치 검사를 수행합니다. 릴리스 워크플로는 게시 후 GitHub Packages에서 다시 설치해 검증된 배포 파일과 SHA-512 무결성이 같은지 확인합니다.
위키 루트·자식 탐색과 페이지 수정·충돌 거부, Cloud 댓글 작업은 실제 Cloud 사이트에서 확인했습니다. 유료 Cloud의 제한된 페이지 생성 성공과 Data Center 실서버 검증은 포함되지 않습니다. Cloud Free 테스트 사이트는 페이지 제한을 지원하지 않아 제한 설정 실패를 성공으로 간주하지 않습니다.

[설치 및 인증 안내](https://github.com/TwoTwo-me/confluence-wiki-md#readme). `SHA256SUMS`에 릴리스 파일의 SHA-256을 제공합니다.
