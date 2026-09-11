# DocPilot

DocPilot은 React 기반 문서 작업 화면을 중심으로 정리 중이며, 최종 목표는 Electron 기반 Windows 실행 프로그램입니다.

현재 Spring Boot는 React 개발 서버의 백엔드 API와 정적 리소스 제공 역할을 담당합니다. React 화면은 추후 Electron API로 전환하기 쉽도록 서비스 계층을 분리해 유지합니다.

## React 실행 방법

```bash
cd frontend
npm install
npm run dev
```

실행 후 Codespaces의 PORTS 탭에서 5173 포트를 Open in Browser로 열면 React 화면을 확인할 수 있습니다.

## Spring Boot 실행 방법

OpenAI API Key는 프론트엔드에 넣지 말고 Spring Boot를 실행하는 터미널의 환경변수로만 설정합니다.

```bash
export OPENAI_API_KEY="YOUR_OPENAI_API_KEY"
# 선택: 기본 모델을 바꾸고 싶을 때만 지정
export OPENAI_MODEL="gpt-5.6-luna"
mvn spring-boot:run
```

React 개발 서버의 `/api/*` 요청은 `frontend/vite.config.js` 프록시를 통해 `http://localhost:8080`으로 전달됩니다.

Windows PowerShell에서는 다음처럼 설정할 수 있습니다.

```powershell
$env:OPENAI_API_KEY="YOUR_OPENAI_API_KEY"
$env:OPENAI_MODEL="gpt-5.6-luna"
mvn spring-boot:run
```

API Key를 `frontend/.env`, React 소스, Vite 환경변수(`VITE_*`)에 저장하지 마세요.

## 현재 포함 기능

- PDF / DOCX 문서 선택 및 뷰어
- 정확한 문서 검색
- 위치 하이라이트
- 즉시 텍스트 교체
- 오른쪽 DocPilot AI 챗봇 패널
- React `/api/chat` → Spring Boot → OpenAI Responses API 연결
- Electron 전환을 고려한 서비스 분리 구조
