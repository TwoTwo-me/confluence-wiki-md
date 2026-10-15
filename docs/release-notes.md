# v0.4.0

페이지를 `ID/문서 제목.md`로 저장하며, 하위 페이지를 모두 내려받으면 ID 폴더 계층이 Confluence의 부모·자식 계층을 그대로 나타냅니다.

- `download ID`는 현재 폴더에 파일을 저장합니다. stdout으로 읽으려면 `read ID`를 사용하세요. 명시적인 `download ID -o FILE.md`는 계속 지원합니다.
- `download ID --recursive -o DIR`, `export DIR --parent ID`는 루트와 모든 자손을 포함합니다. 페이지네이션과 상한을 검증하며, 링크·앵커·첨부 경로와 원래 제목을 유지합니다.
- 각 페이지 폴더에 Markdown 파일 하나만 두고, 탐색 정보는 `cfwiki-manifest.json`에 기록합니다. 한글 제목, 안전한 파일명, 제목 변경·이동 시 로컬 편집 보호를 지원합니다.
- 다운로드·수정 파일의 YAML에서 불필요한 기본값과 중복 URL을 줄입니다. ID·버전·사이트 바인딩·해시·사용자 필드·필수 네이티브 XML은 유지합니다.
- 일반 패널·펼치기·인용은 편집 가능한 `confluence-*` 펜스로 표현합니다. 할 일 안의 코드·이미지·링크, 표와 이미지 제목 등에서 내용이 사라지는 변환을 수정했습니다.
- 스킬은 기본 흐름과 필요할 때 읽는 참조로 나눴습니다. `cfwiki skill install --agent codex|claude|opencode|cursor|all`로 프로그램과 같은 버전의 스킬을 설치합니다.
- GitHub 공개 릴리스와 공개 npm 설치를 지원하며, 설치하는 사람에게 GitHub/npm 로그인을 요구하지 않습니다. 공식 MCP·curl·cfwiki 실제 문서 실험은 토큰 비교 보고서에 기록합니다.

## 로그인 없이 설치

```sh
PUPPETEER_SKIP_DOWNLOAD=true npm install --global https://github.com/TwoTwo-me/confluence-wiki-md/releases/download/v0.4.0/confluence-wiki-md.tgz
cfwiki skill install --agent codex
cfwiki --help
```

공개 npm에서도 `npm install --global @twotwo-me/confluence-wiki-md@0.4.0`으로 설치할 수 있습니다. Node.js 24 이상이 필요하며, Confluence 프로필은 각자의 계정으로 설정합니다.

[설치 안내](https://github.com/TwoTwo-me/confluence-wiki-md/blob/main/docs/installation.md) · [토큰 비교](https://github.com/TwoTwo-me/confluence-wiki-md/blob/main/docs/token-benchmark.md)

기존 평탄한 번들은 별도 디렉터리에 새로 다운로드해 옮기세요. 형식 정규화와 미지원 네이티브 요소 보존은 문서 전체의 시각적 동일성이나 완전한 백업을 보장하지 않습니다. Cloud 실사이트와 Cloud/DC HTTP fixture를 검증하며 실제 Data Center 서버 호환성은 별도 검증이 필요합니다.
