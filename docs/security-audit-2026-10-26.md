# DocPilot Node.js / Java 보안 점검 보고서

- 점검일: 2026-10-26
- 기준 소스: `origin/main` 커밋 `0a74edb` (`end13`)
- 작업 브랜치: `security/node-java-2026-10-26`
- 배포 형태: 서버 없는 Windows Electron 무설치 EXE

## A. 기존 환경 확인

| 항목 | 기존 버전 | 보안 점검 결과 |
|---|---:|---|
| Electron | 38.8.6 | EOL. 실제 바이너리에서 Node.js 22.22.0, Chromium 140.0.7339.249 확인. Node.js 2026-10-21 보안 릴리스 이전 버전이며 Electron eMudhra 차단 패치도 없음. |
| Node.js(개발 셸) | 24.22.1 | 2026-10-21 공식 보안 릴리스. 이번 Brotli/TLS/DNS 패치 포함. |
| Node.js(EXE 내장) | 22.22.0 | CVE-2026-105482, CVE-2026-105483, CVE-2026-106069, CVE-2026-111497 영향 대상. |
| Java(프로젝트) | Java 21 | `pom.xml`과 devcontainer가 Java 21을 요구. Electron EXE에는 Java/JRE가 포함되지 않음. |
| Java(점검 호스트) | Ubuntu OpenJDK 17.0.20+8 | 프로젝트 배포 런타임은 아니지만 eMudhra 관련 루트가 신뢰 저장소에 남아 있어 미패치 상태로 판정. 시스템 파일은 수정하지 않음. |
| Docker 이미지 | `mcr.microsoft.com/devcontainers/java:1-21-bullseye` | Bullseye 기반 가변 태그이며 실제 JDK 패치 수준을 보장하는 검증이 없었음. |

## B. 보안 조치 결과

| 점검 항목 | 취약 여부 | 조치 내용 | 최종 상태 |
|---|---|---|---|
| Brotli | 기존 Electron 내장 Node가 영향 대상 | AI API 요청에 `Accept-Encoding: identity` 강제, `Content-Encoding: br` 응답을 본문 처리 전에 거부 | 애플리케이션 경로 임시 방어 완료. 내장 Node 자체 패치는 안정판 Electron 반영 대기 |
| TLS 호스트 검증 | 기존 내장 Node가 영향 대상 | HTTPS만 허용, OpenAI/Google 고정 호스트 허용 목록, 사용자 정보·포트·제어문자·비ASCII URL 거부, 리디렉션 거부 | 외부 입력이 취약 TLS 호스트 경로에 도달하지 않도록 차단 |
| DNS | 기존 내장 Node가 영향 대상 | 프로젝트에 `dns.resolve*`, `dns.lookup` 직접 호출 없음 확인. 고정 ASCII DNS 호스트만 허용하고 NUL/제어문자 URL 차단 | 현재 코드 경로에서 도달 불가 |
| Electron eMudhra CA | 38.8.6 취약 | Electron을 안정판 45.0.0으로 선별 업데이트 | 해결. Electron 공식 차단 패치 포함 |
| Java CA | 점검 호스트는 미패치, EXE와 무관 | `blocked.certs`를 덮어쓰지 않음. devcontainer를 Bookworm으로 변경하고 Java 21.0.12.1 이상이 아니면 빌드 실패하도록 검증 추가 | 개발 컨테이너 재빌드 시 패치 강제. Docker 부재로 이미지 실빌드는 미실행 |
| Spring Boot 포트 | 실행 시 기본적으로 모든 인터페이스 바인딩 가능 | `server.address=127.0.0.1` 추가 | 개발용 API를 로컬 호스트로 제한 |

## C. 구조 및 수정 내역

### 실행 구조

- PDF/DOCX 보기, 검색, 하이라이트, 편집, 저장은 React 렌더러에서 수행한다.
- Windows EXE는 Electron 메인 프로세스가 Gemini/OpenAI를 직접 호출하므로 Spring Boot와 JRE가 필요하지 않다.
- Spring Boot는 브라우저 개발 모드의 `/api/chat` 용도이며 EXE 패키징 파일 목록에 포함되지 않는다.
- Vite 개발 서버는 5173, Spring Boot는 8080을 사용한다. devcontainer의 8080 포트 공개 범위는 `private`이고 Spring Boot 주소도 이번 변경으로 `127.0.0.1`에 제한된다.
- 외부 통신 대상은 `api.openai.com`과 `generativelanguage.googleapis.com`으로 고정되어 있다. TLS 검증 우회 설정은 발견되지 않았다.

### 변경 파일

- `frontend/package.json`, `frontend/package-lock.json`
  - Electron 38.8.6에서 45.0.0으로 단일 패키지 업데이트 및 정확한 버전 고정.
- `frontend/electron/secureApiFetch.js`
  - HTTPS·호스트 허용 목록, 제어문자 검증, 리디렉션 차단, Brotli 응답 차단.
- `frontend/electron/geminiService.js`, `frontend/electron/openaiService.js`
  - 기존 API 기능을 유지하면서 보안 요청 래퍼 사용.
- `frontend/electron/main.js`
  - 실행 시 Electron/Node.js/Chromium 실제 버전을 로그로 남겨 배포본 점검 가능하도록 함. 키나 문서 내용은 기록하지 않음.
- `frontend/tests/secure-api-fetch.test.mjs`
  - URL, TLS/DNS 입력, Brotli, 리디렉션, Gemini/OpenAI 인증 헤더 회귀 테스트.
- `.devcontainer/Dockerfile`, `.devcontainer/devcontainer.json`
  - Bookworm 전환, OS 보안 업데이트, Microsoft OpenJDK 21.0.12.1 이상 검증, Git LFS 설치 유지.
- `src/main/resources/application.properties`
  - Spring Boot 수신 주소를 로컬 호스트로 제한.

UI와 PDF/DOCX 편집 코드는 변경하지 않았다.

## D. 테스트 결과

| 항목 | 결과 | 세부 내용 |
|---|---|---|
| React/Vite 프로덕션 빌드 | 성공 | 1,226개 모듈 빌드 완료 |
| 보안 단위 테스트(Node 24.22.1) | 성공 | 5/5 |
| 보안 단위 테스트(Electron 내장 Node 24.22.0) | 성공 | 5/5 |
| 기존 Node 단위 테스트 | 부분 성공 | 53개 중 50 성공, 2 건너뜀(로컬 PDF 없음), 1 실패. 실패한 한글 폴백 글꼴 테스트는 변경 전 `main`에서도 동일 재현 |
| PDF/DOCX Playwright E2E | 미실행 | Playwright Chromium이 없고 다운로드가 0바이트 손상 응답으로 실패하여 브라우저를 시작하지 못함. 애플리케이션 assertion 실패로 처리하지 않음 |
| Gemini/OpenAI | 성공(모의 응답) | 고정 호스트, 인증 헤더, 비압축 요청과 기존 결과 파싱 확인. 실제 API 키 호출은 미실행 |
| Electron 바이너리 확인 | 성공 | Electron 45.0.0 / Node.js 24.22.0 / Chromium 156.0.8078.48 확인 |
| Electron Linux GUI 기동 | 미실행에 준함 | 메인 프로세스와 런타임 로그 출력 후, 현재 컨테이너에 GUI/DBus/udev가 없어 Chromium 프로세스 종료 |
| Windows portable EXE 빌드 | 성공 | `DocPilot 0.1.0.exe` 생성, 207MB, SHA-256 `fd7b1acfa002e493cb173680ec999e76797f44af0938e7fd77810086dc6b5f55` |
| 패키지 포함 여부 | 성공 | ASAR에 `secureApiFetch.js`, Gemini/OpenAI 서비스, 빌드된 UI 포함 확인 |
| Maven 테스트 | 미실행 | Maven은 내려받았으나 실행 환경에서 Maven Central DNS 접근이 차단되어 Spring Boot parent POM을 받을 수 없었음 |
| Docker/devcontainer 빌드 | 미실행 | 현재 실행 환경에 Docker/Podman이 없음 |

## E. GitHub 작업 상태

- 작업 브랜치: `security/node-java-2026-10-26`
- `main` 병합/배포: 하지 않음
- 커밋: 완료(작업 브랜치 HEAD)

## 남은 문제와 후속 조치

1. 2026-10-26 기준 패치된 Node.js 24.22.1을 포함하는 Electron은 46.0.0-alpha.1뿐이다. 안정판 43~45는 Node.js 24.22.0이므로 알파 업그레이드는 하지 않았다. 지원 안정판에 Node.js 24.22.1 이상이 포함되면 Electron을 다시 업데이트해야 런타임 자체 조치가 완료된다.
2. 개발 컨테이너는 재빌드 후 `java -version`과 eMudhra 점검을 다시 실행해야 한다. 실행 중인 Codespace는 이번 작업에서 삭제하거나 강제 재생성하지 않았다.
3. `npm audit --omit=dev`에는 현재 범위 밖의 `jspdf` 및 `dompurify` Critical 경고 2건이 남아 있다. PDF 기능 회귀 위험이 있는 별도 패키지 업데이트이므로 이번 Node/Java 변경에는 포함하지 않았다. 별도 브랜치에서 문서 편집·저장 회귀 테스트와 함께 조치해야 한다.
4. Windows 실제 PC에서 EXE 실행, PDF/DOCX 전체 회귀, 실제 Gemini/OpenAI 호출을 추가 확인해야 한다.

## 공식 근거

- Node.js 2026-10-21 보안 릴리스: <https://nodejs.org/en/blog/vulnerability/october-2026-security-releases>
- Electron 38.8.6 런타임 정보: <https://releases.electronjs.org/release/v38.8.6>
- Electron 45.0.0 런타임 정보: <https://releases.electronjs.org/release/v45.0.0>
- Electron eMudhra 보안 권고: <https://github.com/advisories/GHSA-jr5w-w6x2-84p9>
- Electron 릴리스 일정/내장 Node 버전: <https://releases.electronjs.org/schedule>
- Oracle CVE-2026-91403 보안 경고: <https://www.oracle.com/security-alerts/alert-cve-2026-91403.html>
- Oracle eMudhra 점검·완화 안내: <https://ops.java/emudhra>
- Microsoft Build of OpenJDK 릴리스 정보: <https://learn.microsoft.com/java/openjdk/release-notes>
