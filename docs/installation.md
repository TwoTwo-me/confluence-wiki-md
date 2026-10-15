# 로그인 없이 설치하고 에이전트에 연결하기

Node.js 24 이상과 npm이 필요합니다. 프로그램과 스킬 설치에는 GitHub·npm 로그인이나 Confluence 계정이 필요하지 않습니다. 실제 Confluence 문서를 읽고 수정할 때만 본인 계정의 인증 프로필을 설정합니다.

## GitHub 릴리스로 설치

공개 GitHub 릴리스의 패키지를 직접 설치합니다. 아래 URL은 최신 릴리스를 선택하므로 자동화에서는 `releases/latest/download` 대신 `releases/download/vX.Y.Z`를 사용해 검증한 버전을 고정하세요.

```sh
PUPPETEER_SKIP_DOWNLOAD=true npm install --global https://github.com/TwoTwo-me/confluence-wiki-md/releases/latest/download/confluence-wiki-md.tgz
cfwiki --help
cfwiki skill install --agent codex
```

`PUPPETEER_SKIP_DOWNLOAD=true`는 일반 Markdown 작업에 필요하지 않은 Chrome 다운로드를 생략합니다. Mermaid 도표를 로컬에서 검증하려면 Chrome을 별도로 설치하고 `CFWIKI_CHROME_PATH`를 지정하세요. 설치된 Chrome이 없으면 이 환경 변수를 생략해 Puppeteer의 브라우저 설치를 허용할 수도 있습니다. PowerShell에서는 설치 명령 앞의 환경 변수 설정을 다음처럼 분리합니다.

```powershell
$env:PUPPETEER_SKIP_DOWNLOAD = "true"
npm install --global https://github.com/TwoTwo-me/confluence-wiki-md/releases/latest/download/confluence-wiki-md.tgz
```

릴리스에 첨부된 `SHA256SUMS`로 다운로드한 파일을 검증할 수도 있습니다.

## 공개 npm 레지스트리와 일회성 실행

공개 npm 게시가 활성화된 버전은 같은 패키지를 npm에서도 설치할 수 있습니다. 공개 패키지를 내려받는 사용자는 npm 계정이 필요 없습니다. ([npm 공개 패키지 문서](https://docs.npmjs.com/about-public-packages/))

```sh
PUPPETEER_SKIP_DOWNLOAD=true npm install --global @twotwo-me/confluence-wiki-md --registry=https://registry.npmjs.org/
cfwiki --help
cfwiki skill install --agent claude
```

과거 GitHub Packages 설치를 위해 `@twotwo-me` 범위를 별도 레지스트리에 연결했다면 먼저 해당 설정을 지웁니다. `npm config delete @twotwo-me:registry`는 인증 토큰을 생성하지 않습니다.

전역 설치 없이 실행할 수도 있습니다. 패키지에 실행 파일이 두 개 들어 있으므로 `--package`와 실행할 명령을 모두 명시합니다. npm은 패키지를 캐시에 내려받고 명령이 실행되는 동안 PATH에 추가합니다. ([npm exec 문서](https://docs.npmjs.com/cli/v11/commands/npm-exec/))

```sh
PUPPETEER_SKIP_DOWNLOAD=true npx --yes --package=@twotwo-me/confluence-wiki-md cfwiki --help
PUPPETEER_SKIP_DOWNLOAD=true npx --yes --package=@twotwo-me/confluence-wiki-md cfwiki-skill install --agent codex
```

npm 게시 전이거나 npm 레지스트리 사용이 어려우면 `--package` 값을 공개 GitHub 릴리스 URL로 바꿉니다.

```sh
PUPPETEER_SKIP_DOWNLOAD=true npx --yes --package=https://github.com/TwoTwo-me/confluence-wiki-md/releases/latest/download/confluence-wiki-md.tgz cfwiki-skill install --agent codex
```

스킬만 복사한 경우 다음 작업에서 전역 `cfwiki`를 사용하거나 같은 `npx --package=... cfwiki` 명령을 사용하세요. npm 캐시의 절대 경로에 의존하는 심볼릭 링크는 만들지 않습니다.

## 에이전트 선택과 설치 위치

설치기는 지정한 에이전트에 포함된 스킬 파일만 복사합니다. 토큰, Confluence 프로필, 에이전트 설정 파일은 복사하거나 변경하지 않습니다. `--agent`를 반드시 지정하며 `all`을 명시하면 아래 네 에이전트에 설치합니다.

| `--agent` | 사용자 설치 위치 | `--project DIR` 설치 위치 |
| --- | --- | --- |
| `codex` | `~/.agents/skills/confluence-wiki` | `DIR/.agents/skills/confluence-wiki` |
| `claude` | `~/.claude/skills/confluence-wiki` | `DIR/.claude/skills/confluence-wiki` |
| `opencode` | `~/.config/opencode/skills/confluence-wiki` | `DIR/.opencode/skills/confluence-wiki` |
| `cursor` | `~/.cursor/skills/confluence-wiki` | `DIR/.cursor/skills/confluence-wiki` |

OpenCode 사용자 설치는 절대 경로인 `XDG_CONFIG_HOME`이 있으면 `XDG_CONFIG_HOME/opencode/skills/confluence-wiki`를 사용합니다. 경로는 각 제품의 공식 문서에 맞췄습니다: [Codex](https://learn.chatgpt.com/docs/build-skills), [Claude Code](https://code.claude.com/docs/en/skills), [OpenCode](https://opencode.ai/docs/skills/), [Cursor](https://cursor.com/docs/skills). 파일 배치 검증과 각 에이전트 제품에서의 실제 실행 검증은 다릅니다. 로컬 전역 스킬이 클라우드 에이전트에 자동 전송되지는 않습니다. 팀·클라우드 작업에는 프로젝트 설치 후 해당 스킬을 저장소에 포함하는 방법이 적합합니다.

```sh
cfwiki skill paths --agent all --json
cfwiki skill install --agent all --project /absolute/path/to/project --dry-run
cfwiki skill install --agent all --project /absolute/path/to/project
```

같은 내용은 `unchanged`로 처리합니다. 다른 내용이 있으면 덮어쓰지 않고 중단합니다. 검토 후 `--overwrite`를 명시하면 기존 폴더 전체를 각 에이전트의 `skill-backups` 폴더로 옮기고 새 스킬을 설치합니다. 출력의 `backup` 경로로 복구할 수 있습니다. 백업은 스킬 검색 폴더 밖에 둡니다. 기존 스킬 폴더 자체가 심볼릭 링크라면 `--overwrite`로도 바꾸지 않습니다. 링크를 직접 검토·제거한 후 복사 설치하세요.

```sh
cfwiki skill install --agent codex --overwrite --json
```

업데이트도 프로그램을 다시 설치한 뒤 위 명령을 실행합니다. 필요 없어지면 `cfwiki skill paths --agent all`로 복사본 위치를 먼저 확인한 뒤 `npm uninstall --global @twotwo-me/confluence-wiki-md`를 실행하고 해당 복사본을 직접 제거합니다. 프로그램 제거는 사용자 스킬이나 프로필을 지우지 않습니다.

## 다른 스킬 설치 도구

[Vercel의 skills CLI](https://github.com/vercel-labs/skills)는 여러 에이전트에 공개 GitHub 저장소의 스킬을 설치할 수 있습니다. 이 저장소의 `skills/confluence-wiki`도 표준 `SKILL.md` 구조입니다.

```sh
npx --yes skills@1.7.2 add TwoTwo-me/confluence-wiki-md --skill confluence-wiki --agent codex claude-code opencode cursor --copy --yes
```

이 명령은 현재 프로젝트에 설치합니다. 사용자 전체에 적용하려면 `--global`을 추가하세요. `skills`는 별도 프로젝트이므로 기존 파일 처리와 에이전트별 경로 정책은 해당 도구를 따릅니다. 검증한 버전을 고정했으며, CLI 프로그램 설치는 별도로 필요합니다. cfwiki 자체 설치기는 배포된 프로그램과 같은 버전의 스킬을 복사하므로 버전 일치가 필요한 경우에 적합합니다.

2026-10-15에 `skills@1.7.2`와 로컬 저장소로 임시 프로젝트 설치를 실행했습니다. 네 에이전트 선택이 성공했고, 이 도구는 Codex·OpenCode·Cursor에 공유 `.agents/skills` 복사본을 사용하고 Claude용 `.claude/skills` 복사본을 추가했습니다. cfwiki 설치기는 위 표의 각 에이전트 전용 경로를 사용합니다.

## 연결과 검증

Cloud와 Data Center 프로필 예제는 설치 패키지에 포함됩니다. [기본 인증 안내](https://github.com/TwoTwo-me/confluence-wiki-md#readme)를 따라 프로필을 만든 후 선택해 연결을 확인합니다.

```sh
cfwiki doctor --env /absolute/path/to/profile.env --json
```

`npm run test:package`는 빈 npm 설정·별도 캐시·임시 설치 경로에서 실제 tarball의 전역 설치, 일회성 실행, 네 에이전트 스킬 복사와 재설치를 검증합니다. 릴리스 후 `npm run test:release -- VERIFIED.tgz`는 인증 없는 GitHub URL 설치를, `npm run test:registry -- VERIFIED.tgz`는 인증 없는 공개 npm 설치와 검증한 파일의 SHA-512 일치를 확인합니다.
