import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  X, Plus, MessageSquare, Trash2, ChevronLeft,
  Send, Sparkles,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAI } from '../../contexts/AIContext';
import { PRODUCT_NAME } from '../../lib/brand';
import { MessageBubble } from './MessageBubble';
import agentLogo from '../../assets/brand/agent-logo.png';

const SUGGESTIONS = [
  'How do I add a new staff member?',
  'Show me available slots for tomorrow',
  'Create a 30-minute consultation service for ₹500',
  "What's my appointment count this month?",
  'Go to the calendar',
  'Find customer by name',
];

export function AIPanel() {
  const {
    isOpen, closePanel,
    conversations, activeConversationId,
    messages, proposals, isStreaming,
    newConversation, selectConversation, deleteConversation,
    sendMessage,
  } = useAI();

  const [inputValue, setInputValue] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen]);

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || isStreaming) return;
    setInputValue('');
    await sendMessage(text);
  }, [inputValue, isStreaming, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === 'Escape') closePanel();
  };

  const handleSuggestion = (s: string) => {
    setInputValue(s);
    inputRef.current?.focus();
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Panel */}
      <div
        role="complementary"
        aria-label="AI Assistant"
        className={cn(
          'fixed right-0 top-0 h-screen z-40 flex flex-col',
          'w-full sm:w-[400px] lg:w-[420px]',
          'bg-white border-l border-gray-200 shadow-2xl',
          'transition-transform duration-200',
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-100 shrink-0 bg-white">
          {showHistory ? (
            <button
              onClick={() => setShowHistory(false)}
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-500"
              aria-label="Back to chat"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          ) : (
            <div className="w-7 h-7 flex items-center justify-center">
              <img src={agentLogo} alt="" className="w-full h-full object-contain" />
            </div>
          )}

          <div className="flex-1 min-w-0">
            {showHistory
              ? <span className="font-semibold text-sm text-gray-800">Conversation History</span>
              : (
                <div>
                  <span className="font-semibold text-sm text-gray-800">
                    Workeasy Ai Agent
                  </span>
                </div>
              )
            }
          </div>

          <div className="flex items-center gap-1">
            {!showHistory && (
              <>
                <button
                  onClick={() => setShowHistory(true)}
                  className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-500"
                  aria-label="View conversation history"
                  title="History"
                >
                  <MessageSquare className="w-4 h-4" />
                </button>
                <button
                  onClick={newConversation}
                  className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-500"
                  aria-label="New conversation"
                  title="New conversation"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </>
            )}
            <button
              onClick={closePanel}
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-500"
              aria-label="Close AI assistant"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* History view */}
        {showHistory ? (
          <div className="flex-1 overflow-y-auto px-3 py-3">
            <button
              onClick={() => { newConversation(); setShowHistory(false); }}
              className="w-full flex items-center gap-2 px-3 py-2.5 mb-2 rounded-lg border-2 border-dashed border-[#00BF62]/40 hover:border-[#00BF62] text-[#00BF62] text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Conversation
            </button>
            {conversations.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">No conversations yet</p>
            ) : (
              conversations.map(conv => (
                <div key={conv.id} className="group flex items-center gap-2 mb-1">
                  <button
                    onClick={() => { selectConversation(conv.id); setShowHistory(false); }}
                    className={cn(
                      'flex-1 flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left transition-colors',
                      conv.id === activeConversationId
                        ? 'bg-[#00BF62]/10 text-[#00BF62] font-medium'
                        : 'hover:bg-gray-100 text-gray-700',
                    )}
                  >
                    <MessageSquare className="w-3.5 h-3.5 shrink-0 opacity-60" />
                    <span className="truncate">{conv.title}</span>
                  </button>
                  <button
                    onClick={() => deleteConversation(conv.id)}
                    className="w-7 h-7 flex items-center justify-center rounded text-gray-400 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all"
                    aria-label="Delete conversation"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        ) : (
          <>
            {/* Messages area */}
            <div className="flex-1 overflow-y-auto px-4 py-4" role="log" aria-live="polite" aria-label="AI conversation">
              {/* Empty state */}
              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-center pt-8">
                  <div className="w-12 h-12 rounded-2xl bg-navy/5 flex items-center justify-center mb-3">
                    <Sparkles className="w-6 h-6 text-[#00BF62]" />
                  </div>
                  <p className="text-sm font-semibold text-gray-700 mb-1">What can I help with?</p>
                  <p className="text-xs text-gray-400 mb-6">Ask me anything about {PRODUCT_NAME}, or ask me to navigate, search, or prepare an action for you.</p>
                  <div className="flex flex-col gap-1.5 w-full max-w-xs">
                    {SUGGESTIONS.slice(0, 4).map(s => (
                      <button
                        key={s}
                        onClick={() => handleSuggestion(s)}
                        className="text-left px-3 py-2 rounded-xl bg-gray-50 hover:bg-[#00BF62]/5 hover:border-[#00BF62]/20 border border-gray-200 text-xs text-gray-600 transition-colors"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Messages */}
              {messages.map((msg, i) => (
                <MessageBubble
                  key={msg.id ?? i}
                  message={msg}
                  proposals={proposals}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Input area */}
            <div className="px-3 py-3 border-t border-gray-100 bg-white shrink-0">
              <div className={cn(
                'flex items-end gap-2 rounded-2xl border bg-gray-50 px-3 py-2 transition-colors',
                isStreaming ? 'border-gray-200' : 'border-gray-300 focus-within:border-[#00BF62] focus-within:bg-white',
              )}>
                <textarea
                  ref={inputRef}
                  value={inputValue}
                  onChange={e => {
                    setInputValue(e.target.value);
                    e.target.style.height = 'auto';
                    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder={isStreaming ? 'AI is responding…' : 'Ask me anything…  (Enter to send)'}
                  disabled={isStreaming}
                  rows={1}
                  className="flex-1 resize-none bg-transparent text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none min-h-[24px] max-h-[120px] py-0.5 leading-relaxed"
                  aria-label="Message input"
                />
                <button
                  onClick={handleSend}
                  disabled={!inputValue.trim() || isStreaming}
                  className={cn(
                    'w-8 h-8 rounded-xl flex items-center justify-center shrink-0 transition-colors',
                    inputValue.trim() && !isStreaming
                      ? 'bg-[#00BF62] text-white hover:bg-[#008F49]'
                      : 'bg-gray-200 text-gray-400 cursor-not-allowed',
                  )}
                  aria-label="Send message"
                >
                  {isStreaming
                    ? <span className="w-3.5 h-3.5 border-2 border-gray-400/40 border-t-gray-400 rounded-full animate-spin" />
                    : <Send className="w-3.5 h-3.5" />
                  }
                </button>
              </div>
              <p className="text-[10px] text-gray-400 text-center mt-1.5">
                Answers come from {PRODUCT_NAME} documentation and your own records. Review proposed actions before confirming.
              </p>
            </div>
          </>
        )}
      </div>
    </>
  );
}
