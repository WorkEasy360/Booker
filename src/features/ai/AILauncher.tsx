import React from 'react';
import agentLogo from '../../assets/brand/agent-logo.png';
import { cn } from '../../lib/utils';
import { useAI } from '../../contexts/AIContext';

export function AILauncher() {
  const { isOpen, togglePanel, isStreaming } = useAI();

  // While the chat is open it has its own close button; the launcher would cover its input.
  if (isOpen) return null;

  return (
    <button
      onClick={togglePanel}
      aria-label="Open AI assistant"
      aria-expanded={false}
      className={cn(
        'fixed bottom-6 right-6 z-50',
        'w-14 h-14',
        'flex items-center justify-center',
        'transition-all duration-200 hover:scale-105 active:scale-95',
      )}
    >
      <img src={agentLogo} alt="" className="w-full h-full object-contain drop-shadow-lg" />
      {isStreaming && (
        <span
          className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-[#00BF62] border-2 border-white animate-pulse"
          aria-hidden="true"
        />
      )}
    </button>
  );
}
