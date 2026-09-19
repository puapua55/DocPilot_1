import { useEffect, useState } from 'react';
import './OpenAiSettingsModal.css';

const DEFAULT_MODEL = 'gpt-5-mini';

function OpenAiSettingsModal({ isOpen, status, onSaved, onClose }) {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const settingsApi = typeof window !== 'undefined' ? window.docPilotSettings : null;

  useEffect(() => {
    if (!isOpen) return;
    setApiKey('');
    setModel(status?.model || DEFAULT_MODEL);
    setMessage('');
    setError('');
  }, [isOpen, status]);

  if (!isOpen) return null;

  const handleSave = async (event) => {
    event.preventDefault();
    setMessage('');
    setError('');
    try {
      const nextStatus = await settingsApi.saveOpenAiSettings({
        openAiApiKey: apiKey,
        openAiModel: model
      });
      setApiKey('');
      onSaved?.(nextStatus);
      setMessage('저장되었습니다. 앱을 다시 시작하면 백엔드에 적용됩니다.');
    } catch {
      setError('설정을 저장하지 못했습니다. 다시 시도해주세요.');
    }
  };

  const handleClear = async () => {
    setMessage('');
    setError('');
    try {
      const nextStatus = await settingsApi.clearOpenAiSettings();
      setApiKey('');
      setModel(DEFAULT_MODEL);
      onSaved?.(nextStatus);
      setMessage('로컬 API Key 설정을 초기화했습니다.');
    } catch {
      setError('설정을 초기화하지 못했습니다. 다시 시도해주세요.');
    }
  };

  return (
    <div className="settings-modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose?.();
    }}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="openai-settings-title">
        <div className="settings-modal-header">
          <div>
            <p className="settings-eyebrow">DESKTOP SETTINGS</p>
            <h2 id="openai-settings-title">OpenAI 설정</h2>
          </div>
          <button className="settings-close-button" type="button" onClick={onClose} aria-label="설정 닫기">×</button>
        </div>
        <p className="settings-description">
          API Key는 이 PC의 DocPilot 사용자 설정에만 저장되며 채팅 요청에는 포함되지 않습니다.
        </p>
        <form onSubmit={handleSave}>
          <label className="settings-field">
            <span>API Key</span>
            <input
              type="password"
              value={apiKey}
              placeholder={status?.hasApiKey ? '기존 Key를 변경할 때만 입력' : 'sk-...'}
              autoComplete="off"
              onChange={(event) => setApiKey(event.target.value)}
            />
            <small>{status?.hasApiKey ? `현재 상태: ${status.maskedApiKey || '설정됨'}` : '현재 API Key가 설정되지 않았습니다.'}</small>
          </label>
          <label className="settings-field">
            <span>모델명</span>
            <input
              type="text"
              value={model}
              placeholder={DEFAULT_MODEL}
              onChange={(event) => setModel(event.target.value)}
            />
          </label>
          {message ? <p className="settings-success" role="status">{message}</p> : null}
          {error ? <p className="settings-error" role="alert">{error}</p> : null}
          <div className="settings-actions">
            <button className="settings-secondary-button" type="button" onClick={handleClear}>초기화</button>
            <div className="settings-actions-right">
              <button className="settings-secondary-button" type="button" onClick={onClose}>닫기</button>
              <button className="settings-primary-button" type="submit">저장</button>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}

export default OpenAiSettingsModal;
