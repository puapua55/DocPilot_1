# DocPilot Windows portable build

## A. Electron 단독 portable 빌드 (권장)

기본 portable 빌드는 Electron main process와 React renderer만 포함합니다.

- Spring Boot backend와 JRE를 포함하지 않습니다.
- localhost:8080 포트를 사용하지 않으며 `/api/health`도 확인하지 않습니다.
- AI 요청은 Electron main process가 Gemini `generateContent` API로 전송합니다.
- API Key와 모델명은 Gemini 설정 화면을 통해 Electron `userData/settings.json`에 저장됩니다.

```bash
cd frontend
npm run electron:build:portable
```

`frontend/release`에 portable 결과가 생성됩니다. Windows용 exe는 Windows 환경에서 빌드하는 것을 권장합니다.

Codespaces/Linux에서는 Windows용 단일 portable exe 압축 단계 대신 폴더형 배포본을 생성할 수 있습니다.

```bash
cd frontend
npm run electron:build:unpacked
```

ZIP까지 생성하려면 다음을 실행합니다.

```bash
npm run electron:zip:unpacked
```

결과는 `frontend/release/DocPilot-win-unpacked.zip`입니다. Windows에서 압축을 해제한 뒤 `win-unpacked/DocPilot.exe`를 실행합니다. 이 ZIP도 Electron 단독 구조이므로 Spring Boot, JRE, backend.jar를 포함하지 않습니다.

## B. Spring Boot 포함형 legacy 빌드

기존 구조를 비교·백업하거나 개발용으로 사용할 때만 사용합니다.

- `backend.jar`와 JRE가 필요합니다.
- 8080 포트를 사용하고 Electron이 백엔드를 자동 실행·종료합니다.
- 사전 점검이 `frontend/runtime/jre/bin/java.exe`와 `target/*.jar`를 확인합니다.

```bash
mvn clean package
cd frontend
npm run electron:build:with-backend
```

legacy 모드를 수동으로 실행하려면 `DOC_PILOT_BACKEND_MODE=legacy` 또는 `DOC_PILOT_BACKEND_AUTO_START=true`를 사용합니다. 기본값은 Electron 단독 모드입니다.

## 설정 및 보안

설정 파일 위치는 Windows에서 일반적으로 `%APPDATA%\DocPilot\settings.json`입니다. API Key는 renderer나 IPC 응답에 전달하지 않고 Electron main process에서만 사용합니다. 저장소, frontend `.env`, 로그에는 API Key를 넣지 마세요. 현재 저장 방식은 OS Credential Manager가 아닌 로컬 파일 방식입니다.

## legacy 진단

```powershell
netstat -ano | findstr :8080
Test-Path .\frontend\release\win-unpacked\resources\jre\bin\java.exe
Test-Path .\frontend\release\win-unpacked\resources\backend
```

Electron 진단 로그는 `%APPDATA%\DocPilot\logs\backend-startup.log`에 저장됩니다. 문서 내용과 API Key는 기록하지 않습니다.
