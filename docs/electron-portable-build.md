# DocPilot Windows portable build

## 목적

DocPilot의 Windows portable 패키지는 시스템에 Java를 설치하지 않아도 Spring Boot 백엔드를 실행할 수 있도록 JRE를 함께 포함합니다.

JRE 바이너리는 용량과 라이선스 관리 문제로 저장소에 커밋하지 않습니다.

## JRE 준비

Windows x64용 JRE를 준비한 뒤 압축을 해제해 다음 위치에 배치합니다.

```text
frontend/runtime/jre/
└─ bin/java.exe
```

Temurin/Adoptium 등 OpenJDK 계열 런타임을 사용할 수 있지만, 선택한 JRE의 배포 라이선스와 고지 의무를 확인해야 합니다.

## portable 빌드

프로젝트 루트에서 backend jar를 먼저 만듭니다.

```bash
mvn clean package
```

그 다음 frontend에서 portable 사전 점검과 패키징을 실행합니다.

```bash
cd frontend
npm run electron:build:portable
```

사전 점검은 `frontend/runtime/jre/bin/java.exe`와 `target/*.jar`를 확인하며 API Key는 확인하거나 출력하지 않습니다.

생성 결과는 electron-builder 기본 출력 디렉터리인 `frontend/dist` 또는 설정된 release 디렉터리에서 확인할 수 있습니다.

## Java 실행 우선순위

Electron은 다음 순서로 Java를 찾습니다.

1. `DOC_PILOT_JAVA_PATH`
2. 패키징된 `resources/jre/bin/java.exe`
3. 개발 환경의 시스템 `java` 명령

백엔드 jar는 `DOC_PILOT_BACKEND_JAR`, 패키징된 `resources/backend`, 프로젝트 `target` 순서로 찾습니다.

## OpenAI 로컬 설정

Electron 앱의 OpenAI 설정은 Electron `userData` 경로의 `settings.json`에 저장됩니다. Windows에서는 일반적으로 다음 위치입니다.

```text
C:\Users\사용자명\AppData\Roaming\DocPilot\settings.json
```

이 방식은 4차 구현의 로컬 파일 저장 방식이며 OS Credential Manager를 사용하지 않습니다. 공용 PC나 접근 권한이 불확실한 PC에서는 주의해야 합니다. API Key는 저장소, frontend `.env`, `application.properties`에 넣지 않습니다.
