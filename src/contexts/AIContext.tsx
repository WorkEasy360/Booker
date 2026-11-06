import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AIConversation, AIMessage, AIProposal, WorkflowInfo } from '../features/ai/types';
import { aiApi, type LocalAnswerResult } from '../features/ai/api';

interface AIContextValue {
  // Panel state
  isOpen: boolean;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;

  // Conversation state
  conversations: AIConversation[];
  activeConversationId: string | null;
  messages: AIMessage[];
  proposals: AIProposal[];
  isStreaming: boolean;

  // Actions
  loadConversations: () => Promise<void>;
  selectConversation: (id: string) => Promise<void>;
  newConversation: () => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  confirmProposal: (id: string) => Promise<void>;
  cancelProposal: (id: string) => Promise<void>;
  updateProposal: (id: string, update: Partial<AIProposal>) => void;
}

const AIContext = createContext<AIContextValue | null>(null);

export function AIProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();

  const [isOpen, setIsOpen] = useState(false);
  const [conversations, setConversations] = useState<AIConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [proposals, setProposals] = useState<AIProposal[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const streamingMsgIdRef = useRef<string | null>(null);

  const openPanel = useCallback(async () => {
    setIsOpen(true);
    // Load conversations if not yet loaded
    if (conversations.length === 0) {
      try {
        const convs = await aiApi.listConversations();
        setConversations(convs);
        // Auto-open most recent conversation
        if (convs.length > 0 && !activeConversationId) {
          await selectConversationById(convs[0].id);
        }
      } catch (e) {
        setMessages([{
          id: `local-error-${Date.now()}`, role: 'assistant',
          content: `⚠️ Could not load conversation history: ${(e as Error).message}`,
          toolCalls: [], sources: [], createdAt: new Date().toISOString(),
        }]);
      }
    }
  }, [conversations.length, activeConversationId]);

  const closePanel = useCallback(() => setIsOpen(false), []);
  const togglePanel = useCallback(() => {
    if (isOpen) closePanel();
    else openPanel();
  }, [isOpen, openPanel, closePanel]);

  const loadConversations = useCallback(async () => {
    const convs = await aiApi.listConversations();
    setConversations(convs);
  }, []);

  const selectConversationById = async (id: string) => {
    const data = await aiApi.getConversation(id);
    setActiveConversationId(id);
    setMessages((data.messages as AIMessage[]) ?? []);
    setProposals(data.proposals ?? []);
  };

  const selectConversation = useCallback(async (id: string) => {
    await selectConversationById(id);
  }, []);

  const newConversation = useCallback(async () => {
    const conv = await aiApi.createConversation();
    setConversations(prev => [conv, ...prev]);
    setActiveConversationId(conv.id);
    setMessages([]);
    setProposals([]);
  }, []);

  const deleteConversation = useCallback(async (id: string) => {
    await aiApi.deleteConversation(id);
    setConversations(prev => prev.filter(c => c.id !== id));
    if (activeConversationId === id) {
      setActiveConversationId(null);
      setMessages([]);
      setProposals([]);
    }
  }, [activeConversationId]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || isStreaming) return;

    let convId = activeConversationId;
    if (!convId) {
      const conv = await aiApi.createConversation(text.slice(0, 60));
      setConversations(prev => [conv, ...prev]);
      setActiveConversationId(conv.id);
      convId = conv.id;
    }

    // Optimistically add user message
    const userMsg: AIMessage = {
      id: `local-user-${Date.now()}`,
      role: 'user',
      content: text,
      toolCalls: [], sources: [],
      createdAt: new Date().toISOString(),
    };
    setMessages(prev => [...prev, userMsg]);

    // Add a placeholder streaming message
    const streamingMsgId = `local-ai-${Date.now()}`;
    streamingMsgIdRef.current = streamingMsgId;
    const streamingMsg: AIMessage = {
      id: streamingMsgId,
      role: 'assistant',
      content: '',
      isStreaming: true,
      streamedContent: '',
      toolCalls: [], sources: [],
      createdAt: new Date().toISOString(),
    };
    setMessages(prev => [...prev, streamingMsg]);
    setIsStreaming(true);

    try {
      // Local knowledge search — no external AI service
      const result: LocalAnswerResult = await aiApi.ask(text, convId ?? undefined);

      // Navigation: trigger client-side route change
      if (result.type === 'navigation' && result.navigateTo) {
        navigate(result.navigateTo);
      }

      // Action proposal: add to proposals state so ProposalCard renders
      let messagePropId: string | undefined;
      if (result.type === 'action_proposal' && result.proposalId && result.proposalDisplayData) {
        const proposal: AIProposal = {
          id: result.proposalId,
          toolName: result.proposalToolName ?? 'propose_create_service',
          displayData: result.proposalDisplayData as AIProposal['displayData'],
          status: 'pending',
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          createdAt: new Date().toISOString(),
        };
        setProposals(prev => {
          const exists = prev.find(p => p.id === proposal.id);
          return exists ? prev : [proposal, ...prev];
        });
        messagePropId = result.proposalId;
      }

      // Build visible answer text
      let answerText = result.answer;
      if (result.steps && result.steps.length > 0) {
        answerText += '\n\n' + result.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
      }
      // Navigation hint from BM25 answers
      if (result.navigation && result.type === 'text') {
        answerText += `\n\n**Go to:** \`${result.navigation}\``;
      }
      if (result.sources && result.sources.length > 0) {
        answerText += '\n\n---\n**Sources:** ' + result.sources.join(', ');
      }

      const msgWorkflowInfo: WorkflowInfo | undefined =
        result.type === 'workflow_blocker' ? result.workflowInfo : undefined;

      setMessages(prev => prev.map(m =>
        m.id === streamingMsgId
          ? { ...m, isStreaming: false, content: answerText, streamedContent: undefined,
              toolCalls: messagePropId ? [messagePropId] : [],
              workflowInfo: msgWorkflowInfo }
          : m
      ));
      setIsStreaming(false);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Failed to send message';
      setMessages(prev => prev.map(m =>
        m.id === streamingMsgId
          ? { ...m, isStreaming: false, content: `⚠️ ${errMsg}` }
          : m
      ));
      setIsStreaming(false);
    }
  }, [activeConversationId, isStreaming, navigate]);

  const confirmProposal = useCallback(async (id: string) => {
    updateProposal(id, { status: 'confirmed' });
    try {
      const result = await aiApi.confirmProposal(id);
      updateProposal(id, { status: 'executed' });
      const resultData = result.result as Record<string, unknown> | null;
      const successMsg: AIMessage = {
        id: `local-success-${Date.now()}`,
        role: 'assistant',
        content: `✅ Done! The action was completed successfully.${resultData?.bookingRef ? ` Booking ref: **${resultData.bookingRef}**` : ''}`,
        toolCalls: [], sources: [],
        createdAt: new Date().toISOString(),
      };
      setMessages(prev => [...prev, successMsg]);

      // After service creation: check if there is a pending availability workflow to resume
      if (resultData?.type === 'service') {
        try {
          const resumeResult = await aiApi.ask('resume', activeConversationId ?? undefined, true);
          if (resumeResult.type === 'availability' || resumeResult.type === 'workflow_blocker') {
            const resumeMsg: AIMessage = {
              id: `local-resume-${Date.now()}`,
              role: 'assistant',
              content: resumeResult.answer,
              toolCalls: [], sources: [],
              workflowInfo: resumeResult.type === 'workflow_blocker' ? resumeResult.workflowInfo : undefined,
              createdAt: new Date().toISOString(),
            };
            setMessages(prev => [...prev, resumeMsg]);
          }
        } catch { /* resume errors are non-fatal */ }
      }
    } catch (err) {
      updateProposal(id, { status: 'failed' });
      const errMsg = err instanceof Error ? err.message : 'Execution failed';
      const failMsg: AIMessage = {
        id: `local-fail-${Date.now()}`,
        role: 'assistant',
        content: `❌ Action failed: ${errMsg}`,
        toolCalls: [], sources: [],
        createdAt: new Date().toISOString(),
      };
      setMessages(prev => [...prev, failMsg]);
    }
  }, [activeConversationId]);

  const cancelProposal = useCallback(async (id: string) => {
    updateProposal(id, { status: 'cancelled' });
    try {
      await aiApi.cancelProposal(id);
    } catch { /* Revert on failure */ updateProposal(id, { status: 'pending' }); }
  }, []);

  function updateProposal(id: string, update: Partial<AIProposal>) {
    setProposals(prev => prev.map(p => p.id === id ? { ...p, ...update } : p));
  }

  const value: AIContextValue = {
    isOpen, openPanel, closePanel, togglePanel,
    conversations, activeConversationId, messages, proposals, isStreaming,
    loadConversations, selectConversation, newConversation, deleteConversation,
    sendMessage, confirmProposal, cancelProposal, updateProposal,
  };

  return <AIContext.Provider value={value}>{children}</AIContext.Provider>;
}

export function useAI(): AIContextValue {
  const ctx = useContext(AIContext);
  if (!ctx) throw new Error('useAI must be used within AIProvider');
  return ctx;
}
