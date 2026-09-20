import { useState } from 'react';

function ChatInput({ onSendMessage, loading = false, disabled = false }) {
  const [value, setValue] = useState('');

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!value.trim() || loading || disabled) {
      return;
    }

    onSendMessage(value);
    setValue('');
  };

  return (
    <form className="chat-input-form" onSubmit={handleSubmit}>
      <textarea
        className="chat-input"
        value={value}
        rows={3}
        placeholder={disabled ? '문서를 선택한 뒤 문서 작업 요청을 입력하세요.' : '검색, 하이라이트, 텍스트 교체 요청만 입력할 수 있습니다.'}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        disabled={loading || disabled}
      />
      <button className="chat-submit" type="submit" disabled={loading || disabled || !value.trim()}>
        {loading ? '전송 중' : '전송'}
      </button>
    </form>
  );
}

export default ChatInput;
