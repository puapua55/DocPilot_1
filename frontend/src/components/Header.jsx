function Header() {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-icon" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 3 4.5 7.2v5.6C4.5 17.1 7.7 20.9 12 22c4.3-1.1 7.5-4.9 7.5-9.2V7.2L12 3Z"
              fill="currentColor"
              opacity="0.18"
            />
            <path
              d="M9.75 12.5 11 13.75 14.75 10"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M12 3 4.5 7.2v5.6C4.5 17.1 7.7 20.9 12 22c4.3-1.1 7.5-4.9 7.5-9.2V7.2L12 3Z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div className="brand-copy">
          <h1>DocPilot</h1>
          <p>문서 관리 AI 어시스턴트</p>
        </div>
      </div>
      <div className="window-dots" aria-label="window controls">
        <span />
        <span />
        <span />
      </div>
    </header>
  );
}

export default Header;
