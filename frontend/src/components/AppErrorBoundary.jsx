import { Component } from 'react';

class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      errorMessage: ''
    };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      errorMessage: error?.message || '알 수 없는 오류가 발생했습니다.'
    };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[AppErrorBoundary] render failed:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="app-page">
          <div className="app-shell">
            <main className="main-layout">
              <section className="unsupported-document">
                <div>
                  <strong>화면을 표시하는 중 오류가 발생했습니다.</strong>
                  <p>{this.state.errorMessage}</p>
                  <p>브라우저 콘솔에서 상세 오류를 확인해주세요.</p>
                </div>
              </section>
            </main>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default AppErrorBoundary;
