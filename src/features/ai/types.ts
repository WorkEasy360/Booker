export interface AIConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowAction {
  label: string;
  style: 'primary' | 'secondary';
  intent: 'navigate' | 'cancel_workflow';
  navigateTo?: string;
}

export interface WorkflowInfo {
  workflowId: string;
  reason: string;
  actions: WorkflowAction[];
}

export interface AIMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: string[];
  sources: string[];
  createdAt: string;
  // local-only fields for optimistic rendering
  isStreaming?: boolean;
  streamedContent?: string;
  workflowInfo?: WorkflowInfo;
}

export interface ProposalField {
  label: string;
  value: string | number | undefined;
}

export interface AIProposal {
  id: string;
  toolName: string;
  displayData: {
    type: string;
    fields: ProposalField[];
  };
  status: 'pending' | 'confirmed' | 'cancelled' | 'executed' | 'failed' | 'expired';
  expiresAt: string;
  createdAt: string;
}

export type StreamEventType = 'text' | 'tool_call' | 'proposal' | 'navigate' | 'error' | 'done';

export interface StreamEvent {
  type: StreamEventType;
  delta?: string;
  tool?: string;
  proposal?: AIProposal;
  navigate?: string;
  error?: string;
}
