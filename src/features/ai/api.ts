import type { AIConversation, AIProposal, WorkflowInfo } from './types';
import { apiRequest } from '@/api/client';

// Shares the main client so session expiry and CSRF protection behave the same everywhere.
const req = apiRequest;

export type LocalResponseType =
  | 'text' | 'clarification' | 'search_results' | 'navigation'
  | 'action_proposal' | 'live_data' | 'availability' | 'out_of_scope' | 'error'
  | 'workflow_blocker';

export interface LocalAnswerResult {
  type: LocalResponseType;
  answer: string;
  steps?: string[];
  navigation?: string;
  sources: string[];
  confidence: 'high' | 'medium' | 'low';
  intent: string;
  retrievedChunks: number;
  noResults: boolean;
  // search_results
  searchResults?: Array<Record<string, unknown>>;
  // navigation
  navigateTo?: string;
  navigationTitle?: string;
  // action_proposal
  proposalId?: string;
  proposalDisplayData?: { type: string; fields: Array<{ label: string; value: unknown }> };
  proposalToolName?: string;
  // live_data
  liveData?: Record<string, unknown>;
  // availability
  slots?: Array<{ staffName: string; times: string[] }>;
  // clarification
  clarificationQuestion?: string;
  // workflow_blocker
  workflowInfo?: WorkflowInfo;
}

export const aiApi = {
  ask: (query: string, conversationId?: string, triggerWorkflowResume?: boolean) =>
    req<LocalAnswerResult>('POST', '/ai/ask', { query, conversationId, triggerWorkflowResume }),

  cancelWorkflow: (id: string) =>
    req<{ cancelled: boolean }>('POST', `/ai/workflows/${id}/cancel`, {}),

  coverage: () =>
    req<{ documentsOnDisk: number; documentsIndexed: number; chunksIndexed: number; lastUpdated: string | null }>('GET', '/ai/knowledge/coverage'),

  listConversations: () => req<AIConversation[]>('GET', '/ai/conversations'),

  createConversation: (title?: string) =>
    req<AIConversation>('POST', '/ai/conversations', { title }),

  getConversation: (id: string) =>
    req<AIConversation & { messages: unknown[]; proposals: AIProposal[] }>('GET', `/ai/conversations/${id}`),

  deleteConversation: (id: string) =>
    req<{ deleted: boolean }>('DELETE', `/ai/conversations/${id}`),

  confirmProposal: (id: string) =>
    req<{ executed: boolean; result: unknown }>('POST', `/ai/proposals/${id}/confirm`),

  cancelProposal: (id: string) =>
    req<{ cancelled: boolean }>('POST', `/ai/proposals/${id}/cancel`),

};
