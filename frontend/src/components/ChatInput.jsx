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
        placeholder={disabled ? '문서를 선택한 뒤 요청사항을 입력하세요.' : '요청사항을 입력하세요.'}
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
