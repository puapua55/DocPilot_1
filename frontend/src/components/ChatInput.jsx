import { useState } from 'react';

function ChatInput({ onSendMessage }) {
  const [value, setValue] = useState('');

  const handleSubmit = (event) => {
    event.preventDefault();
    if (!value.trim()) {
      return;
    }

    onSendMessage(value);
    setValue('');
  };

  return (
    <form className="chat-input-form" onSubmit={handleSubmit}>
      <input
        className="chat-input"
        type="text"
        value={value}
        placeholder="AI에게 문서 검색, 요약, 수정 요청하기"
        onChange={(event) => setValue(event.target.value)}
      />
      <button className="chat-submit" type="submit">
        전송
      </button>
    </form>
  );
}

export default ChatInput;
