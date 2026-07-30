# DocPilot

DocPilot은 React 기반 문서 작업 화면을 중심으로 정리 중이며, 최종 목표는 Electron 기반 Windows 실행 프로그램입니다.

현재의 Spring Boot는 2026-07-30 기준으로 화면 확인용 정적 리소스 제공 또는 임시 API 테스트 용도입니다. 최종 구조의 핵심은 아니며, React 화면은 나중에 Electron API로 전환하기 쉽게 분리하고 있습니다.

## React 실행 방법

```bash
cd frontend
npm install
npm run dev
```

## Spring Boot 실행 방법

```bash
mvn spring-boot:run
```

실행 후 Codespaces의 PORTS 탭에서 8080 포트를 Open in Browser로 열면 정적 리소스 기반 화면을 확인할 수 있습니다.

## 현재 포함 기능

- 브라우저에서 확인 가능한 테스트 UI
- 좌우 분할 레이아웃
- 문서 선택 및 드래그 앤 드롭
- 채팅 입력창과 예시 메시지
- Electron 전환을 고려한 서비스 분리 구조
