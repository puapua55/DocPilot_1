# DocPilot Node.js / Java 보안 점검 보고서

## 2026-11-01 재점검 및 추가 조치

이 절은 아래 2026-10-26 기록 이후의 상태를 반영한다. 아래 표의 과거 판정과 후속 조치 항목은 당시 기록이다.

| 항목 | 재점검 결과 및 조치 |
|---|---|
| 배포용 Electron/Node.js | 기존 Electron 45.0.0의 내장 Node.js는 24.22.0으로 10월 21일 Brotli·TLS·DNS 보안 패치 전 버전이었다. 안정판 Electron 45.2.1은 Node.js 24.22.1을 포함한다. `frontend/package.json`과 잠금 파일을 45.2.1로 갱신했다. Windows EXE를 새로 빌드·배포해야 기존 설치본에 패치가 적용된다. |
| Node.js 통신 경로 | 메인 프로세스의 고정 HTTPS API 호스트, 제어문자/NUL 차단, 리디렉션 거부, 비압축 요청 및 Brotli 응답 거부는 유지했다. 프로젝트 코드에서 `dns.resolve*` 직접 호출은 확인되지 않았다. 외부 공개 Brotli 디코딩 서버·API 게이트웨이·프록시는 이 저장소에 없다. |
| Java | 이 저장소의 Spring Boot 개발용 백엔드는 Java 21을 사용하지만 배포용 Electron EXE에는 JRE가 없다. 기존 devcontainer의 `21.0.12.1` 이상 검사는 이번 인증서 사고의 패치 기준으로 부족했다. Microsoft OpenJDK 21.0.13.0.2 이상을 요구하도록 변경했다. 현재 점검 PC의 Microsoft OpenJDK `21.0.12.1`도 미달하며 PC의 JDK 교체는 저장소 변경만으로 이루어지지 않는다. |
| 인증서 로그 | 운영 서버와 TLS 인증 로그에 접근할 수 없어 유출된 eMudhra 중간 CA로 인증한 이력을 확인하지 못했다. 실제 운영 환경에서 관련 인증서 체인과 접속 로그를 점검해야 한다. |
| Docker | devcontainer는 가변 베이스 이미지이므로 재빌드 시 최신 이미지를 가져오고 Dockerfile의 JDK 버전 검사가 통과하는지 확인해야 한다. 이 PC에 Docker가 없어 이미지 빌드는 검증하지 못했다. |
| 의존성 취약점 | jsPDF 3.0.4 → 4.2.1, 하위 의존성 DOMPurify 3.4.14 → 3.4.17로 갱신했다. `npm audit --omit=dev` 경고가 Critical 2건에서 0건으로 감소했다. |
| Windows 빌드 | Electron 45.2.1 기반 portable EXE를 재빌드했다. 패키징된 앱 프로세스가 Windows에서 실행 상태를 유지하고 내장 Node.js가 24.22.1임을 확인했다. `frontend/release/DocPilot 0.1.0.exe` SHA-256은 `b7517c669e951d78b5cf6e7112fc591094e9b56e0d24811385e9d26d151a3784`이다. 배포는 수행하지 않았다. |
| 검증 | 보안 단위 테스트 5/5, Vite 프로덕션 빌드, PDF 저장 E2E 5건, DOCX 표·단락 E2E 4건 통과. 전체 Node 단위 테스트는 53건 중 50건 통과·2건 건너뜀·1건 실패했다. PDF E2E 2건은 jsPDF 3.0.4에서도 동일하게 실패해 이번 갱신의 신규 회귀는 아니다. DOCX 변환 테스트는 현재 UI에 없는 버튼을 찾고, 다른 DOCX 테스트 4건은 로컬 자료 파일이 없어 실행할 수 없었다. DOCX 이미지 이동 테스트 1건은 실패해 추가 조사 대상이다. 실제 Gemini/OpenAI 호출은 수행하지 않았다. |

공식 근거: [Node.js 2026-10-21 보안 릴리스](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases), [Electron 45.2.1 내장 런타임](https://releases.electronjs.org/release/v45.2.1), [Microsoft OpenJDK 릴리스 정보](https://learn.microsoft.com/en-us/java/openjdk/release-notes), [Oracle eMudhra 안내](https://ops.java/emudhra).

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

## 남은 문제와 후속 조치 (2026-11-01 갱신)

1. **Electron 런타임 패치 완료, 배포 필요:** 2026-10-30 안정판 Electron 45.2.1에 Node.js 24.22.1이 포함되었다. 이 버전으로 소스와 Windows portable EXE를 갱신했다. 기존 배포본 교체는 별도 작업이다.
2. **개발 컨테이너 재빌드 필요:** Dockerfile은 Microsoft OpenJDK 21.0.13.0.2 이상을 강제한다. 현재 PC에 Docker가 없어 이미지 재빌드와 실제 `java -version`, eMudhra 인증서 상태를 검증하지 못했다. 실행 중인 Codespace는 변경하지 않았다. 로컬 PC의 Java 21.0.12.1과 Node.js 24.19.0도 해당 보안 패치 전 버전이다.
3. **프로덕션 npm 취약점 조치 완료:** jsPDF와 DOMPurify를 패치 버전으로 갱신했고 `npm audit --omit=dev`는 0건이다. PDF 저장 E2E 5건 통과. 실패한 PDF 테스트 2건은 이전 jsPDF에서도 같은 결과였다.
4. **남은 실행 검증:** Windows 패키지 프로세스 기동은 확인했으나 화면 전체 조작과 PDF/DOCX 전체 회귀는 완료되지 않았다. 일부 기존 테스트는 현재 UI 또는 로컬 자료 파일과 맞지 않는다. DOCX 이미지 이동 테스트 실패는 별도 조사 필요. 실제 Gemini/OpenAI 호출과 운영 인증 로그 확인에는 해당 환경·자격 증명이 필요하다.

## 공식 근거

- Node.js 2026-10-21 보안 릴리스: <https://nodejs.org/en/blog/vulnerability/october-2026-security-releases>
- Electron 38.8.6 런타임 정보: <https://releases.electronjs.org/release/v38.8.6>
- Electron 45.0.0 런타임 정보: <https://releases.electronjs.org/release/v45.0.0>
- Electron eMudhra 보안 권고: <https://github.com/advisories/GHSA-jr5w-w6x2-84p9>
- Electron 릴리스 일정/내장 Node 버전: <https://releases.electronjs.org/schedule>
- Oracle CVE-2026-91403 보안 경고: <https://www.oracle.com/security-alerts/alert-cve-2026-91403.html>
- Oracle eMudhra 점검·완화 안내: <https://ops.java/emudhra>
- Microsoft Build of OpenJDK 릴리스 정보: <https://learn.microsoft.com/java/openjdk/release-notes>
