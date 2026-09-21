# confluence-wiki-md

에이전트가 작성한 Markdown을 Confluence 페이지로 게시하기 위한 개발 프로젝트입니다.
현재는 Node.js로 작성한 **Confluence Cloud REST API 연결 검증용 CLI**를 제공합니다.
외부 패키지 없이 인증, 공간 조회, 페이지 읽기 및 테스트 페이지 생성·수정을 확인할 수 있습니다.

**Markdown 변환과 문서 파일 게시 기능은 아직 구현되지 않았습니다.**
`smoke` 명령은 코드에 포함된 Confluence Storage Format 예제 본문을 게시합니다.

## 요구 사항

- Node.js 24 이상 및 npm
- 본인이 접근할 수 있는 Confluence Cloud 사이트와 테스트 공간
- 공간 조회 및 페이지 읽기·쓰기가 가능한 API 토큰

Confluence Data Center용 API와 인증 방식은 지원하지 않습니다.

## 연결 설정

프로젝트 루트에서 `.env.example`을 `.env`로 복사한 뒤 본인 환경의 값을 입력합니다.
macOS 또는 Linux에서는 다음과 같이 준비할 수 있습니다.

```bash
cp -n .env.example .env
chmod 600 .env
```

기존 `.env`가 있다면 그대로 사용합니다. `.env`와 로컬 검증 결과는 Git에서 제외됩니다.
실제 이메일, 사이트 주소, Cloud ID와 토큰을 공개 문서나 이슈에 붙여 넣지 마세요.

| 변수 | 내용 |
| --- | --- |
| `CONFLUENCE_SITE_URL` | 테스트 사이트의 HTTPS 주소. `/wiki` 제외 |
| `CONFLUENCE_EMAIL` | API 토큰을 발급한 Atlassian 계정 이메일 |
| `CONFLUENCE_CLOUD_ID` | 사이트의 `/_edge/tenant_info`에서 확인한 `cloudId` |
| `CONFLUENCE_SPACE_KEY` | 테스트 공간 키. 기본값 `AGENTTEST` |
| `CONFLUENCE_API_TOKEN` | 범위가 지정된 Confluence API 토큰 |

필요한 토큰 범위:

- `read:space:confluence`
- `read:page:confluence`
- `write:page:confluence`

브라우저에서 테스트 공간을 만들고 키를 `AGENTTEST`로 지정하거나,
`CONFLUENCE_SPACE_KEY`를 본인의 테스트 공간 키로 변경하세요.
이 CLI는 공간을 조회하고 페이지를 생성·수정하므로 공간 생성 권한 범위는 요구하지 않습니다.

토큰은 [Atlassian 계정 설정](https://id.atlassian.com/manage-profile/security/api-tokens)에서 발급합니다.
클라이언트는 이메일과 토큰을 Basic 인증으로 보내며, 범위 지정 토큰의 API 주소인
`https://api.atlassian.com/ex/confluence/{cloudId}/wiki/api/v2`를 사용합니다.

Cloud ID는 `https://your-test-site.atlassian.net/_edge/tenant_info`의 `cloudId`에서 확인합니다.
API 토큰의 권한 외에도 발급 계정이 해당 공간과 페이지에 접근할 수 있어야 합니다.

## 실행

```bash
npm run confluence -- --help
npm run doctor
npm run smoke
npm run confluence -- read PAGE_ID
npm test
```

`doctor`는 인증과 테스트 공간 조회를 확인합니다.

`smoke`는 최초 실행에서 테스트 페이지를 생성하고 본문을 읽은 뒤,
최신 버전보다 1 큰 버전 번호로 수정하고 다시 읽어 본문과 버전을 검증합니다.
결과 페이지에는 제목, 목록, 표, 인라인 코드와 한글 문자열이 포함됩니다.
**재실행하면 저장된 테스트 페이지의 본문을 예제 내용으로 덮어씁니다.**

생성한 페이지 ID는 `.confluence-dev.json`에 저장합니다. 재실행은 이 페이지를 재사용합니다.
사이트 또는 공간이 달라졌으면 수정을 중단합니다. 저장된 페이지를 삭제한 경우에는
`.confluence-dev.json`을 검토한 뒤 새 테스트 페이지를 생성하도록 설정해야 합니다.
검증 기록은 `artifacts/smoke-test.json`에 저장하며 토큰을 포함하지 않습니다.

프로젝트 디렉터리에서 실행하세요. `PAGE_ID`는 실제 숫자 페이지 ID로 바꿉니다.
생성한 페이지 ID와 URL은 `smoke` 실행 결과 및 `artifacts/smoke-test.json`에서 확인합니다.
토큰 만료 후에는 같은 범위의 새 토큰을 발급해 `.env`의 `CONFLUENCE_API_TOKEN`을 교체합니다.

`read`는 지정한 페이지 본문과 메타데이터를 JSON으로 출력합니다.
본문은 Markdown이 아닌 Confluence Storage Format입니다.
클라이언트는 인증 토큰과 인증 헤더를 로그에 기록하지 않습니다.
조회한 페이지 내용에는 비공개 정보가 포함될 수 있으므로 출력 결과를 공유하기 전에 확인하세요.

## 검증

```bash
npm test
```

테스트는 로컬 HTTP 서버에서 실행하므로 실제 API 토큰이 필요하지 않습니다.
설정 누락, Basic 인증과 JSON 요청, 페이지 버전 증가, 공간 불일치 시 수정 중단,
HTTP 오류 응답에 포함된 비밀값을 출력하지 않는 동작을 검증합니다.

실제 Confluence 연결은 자신의 테스트 공간에서 `doctor`와 `smoke`로 확인합니다.
로컬 `.env`, `.confluence-dev.json`, `artifacts/`는 저장소에 포함하지 않습니다.

## 오류 확인

| 상태 | 확인할 항목 |
| --- | --- |
| 401 | 이메일, 토큰, 만료일, Cloud ID |
| 403 | 토큰 범위와 계정의 공간 접근 권한 |
| 404 | 페이지 ID, 공간 ID 및 계정 접근 권한 |
| 409 | 다른 편집으로 인한 버전 충돌. 최신 페이지를 다시 조회 |
| 429 | 호출 제한. 서버에서 안내한 시간 이후 재시도 |

가입 화면이 빈 페이지로 바뀌는 경우 Chrome 자동 번역을 끄고 다시 진행하세요.

## 공식 문서

- [API 토큰 관리](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/)
- [Confluence Cloud Page API](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/)
- [Confluence Cloud Space API](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-space/)
