import { useEffect, useRef } from 'react';
import MessageBubble from './MessageBubble';

export default function ChatThread({ messages = [] }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  if (!messages.length) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400 text-sm">
        Belum ada pesan di percakapan ini.
      </div>
    );
  }

  return (
    <div className="flex flex-col py-4 px-4">
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
