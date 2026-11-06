import React from 'react';
import { User } from 'lucide-react';
import agentLogo from '../../assets/brand/agent-logo.png';
import { cn } from '../../lib/utils';
import type { AIMessage, AIProposal } from './types';
import { ProposalCard } from './ProposalCard';
import { WorkflowBlockerCard } from './WorkflowBlockerCard';

interface MessageBubbleProps {
  message: AIMessage;
  proposals: AIProposal[];
}

// Minimal markdown renderer: bold, code, bullet lists, line breaks
function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Bullet list
    if (line.match(/^[-*•]\s/)) {
      const listItems: string[] = [];
      while (i < lines.length && lines[i].match(/^[-*•]\s/)) {
        listItems.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <ul key={`ul-${i}`} className="my-1 ml-4 space-y-0.5 list-disc">
          {listItems.map((item, j) => (
            <li key={j}>{inlineFormat(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Numbered list
    if (line.match(/^\d+\.\s/)) {
      const listItems: string[] = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s/)) {
        listItems.push(lines[i].replace(/^\d+\.\s/, ''));
        i++;
      }
      elements.push(
        <ol key={`ol-${i}`} className="my-1 ml-4 space-y-0.5 list-decimal">
          {listItems.map((item, j) => (
            <li key={j}>{inlineFormat(item)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Heading
    if (line.startsWith('## ')) {
      elements.push(<p key={i} className="font-semibold mt-2 mb-0.5">{line.slice(3)}</p>);
    } else if (line.startsWith('# ')) {
      elements.push(<p key={i} className="font-bold mt-2 mb-1">{line.slice(2)}</p>);
    } else if (line.trim() === '') {
      elements.push(<br key={i} />);
    } else {
      elements.push(<p key={i} className="my-0.5">{inlineFormat(line)}</p>);
    }
    i++;
  }
  return elements;
}

function inlineFormat(text: string): React.ReactNode {
  // Split by bold (**...**) and code (`...`)
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} className="bg-black/10 px-1 py-0.5 rounded text-[11px] font-mono">{part.slice(1, -1)}</code>;
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

export function MessageBubble({ message, proposals }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  // Use streamedContent only when it has actual content (not an empty placeholder)
  const content = (message.streamedContent || '') || message.content;

  // Find proposals referenced in this message's toolCalls
  const myProposals = proposals.filter(p => message.toolCalls?.includes(p.id));

  return (
    <div className={cn('flex gap-2.5 mb-3', isUser && 'flex-row-reverse')}>
      {/* Avatar */}
      <div className={cn(
        'w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5',
        isUser && 'bg-[#00BF62]/15 text-[#00BF62]',
      )}>
        {isUser
          ? <User className="w-3.5 h-3.5" />
          : <img src={agentLogo} alt="" className="w-full h-full object-contain" />
        }
      </div>

      {/* Content */}
      <div className={cn('max-w-[88%] flex flex-col gap-1', isUser && 'items-end')}>
        <div className={cn(
          'rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed',
          isUser
            ? 'bg-[#00BF62] text-white rounded-tr-sm'
            : 'bg-gray-100 text-gray-900 rounded-tl-sm',
        )}>
          {isUser
            ? <span>{content}</span>
            : renderMarkdown(content)}
          {message.isStreaming && !content && (
            <span className="inline-flex gap-0.5 ml-1">
              <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </span>
          )}
        </div>

        {/* Proposal cards */}
        {myProposals.map(p => (
          <ProposalCard key={p.id} proposal={p} />
        ))}

        {/* Workflow blocker card */}
        {message.workflowInfo && (
          <WorkflowBlockerCard workflowInfo={message.workflowInfo} />
        )}
      </div>
    </div>
  );
}
