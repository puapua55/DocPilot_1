import { useState } from 'react';

function ChatInput({ onSendMessage, loading = false }) {
  const [value, setValue] = useState('');

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!value.trim() || loading) {
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
        placeholder="DocPilot AI에게 질문해보세요."
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        disabled={loading}
      />
      <button className="chat-submit" type="submit" disabled={loading || !value.trim()}>
        {loading ? '전송 중' : '전송'}
      </button>
    </form>
  );
}

export default ChatInput;
