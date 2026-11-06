import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowRight, X } from 'lucide-react';
import { aiApi } from './api';
import type { WorkflowInfo } from './types';
import { cn } from '../../lib/utils';

interface WorkflowBlockerCardProps {
  workflowInfo: WorkflowInfo;
}

export function WorkflowBlockerCard({ workflowInfo }: WorkflowBlockerCardProps) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <div className="mt-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
        Cancelled.
      </div>
    );
  }

  async function handleAction(action: WorkflowInfo['actions'][number]) {
    setLoading(action.label);
    try {
      if (action.intent === 'navigate' && action.navigateTo) {
        navigate(action.navigateTo);
      } else if (action.intent === 'cancel_workflow') {
        await aiApi.cancelWorkflow(workflowInfo.workflowId);
        setDone(true);
      }
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50/60 overflow-hidden">
      <div className="flex items-start gap-2 px-3 pt-2.5 pb-1">
        <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
        <p className="text-xs text-amber-800 font-medium leading-relaxed">
          Set up a service to unlock availability checks.
        </p>
      </div>
      <div className="flex gap-2 px-3 pb-3 pt-1">
        {workflowInfo.actions.map(action => (
          <button
            key={action.label}
            onClick={() => handleAction(action)}
            disabled={!!loading}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-60 transition-colors',
              action.style === 'primary'
                ? 'bg-[#00BF62] hover:bg-[#008F49] text-white'
                : 'border border-gray-300 hover:bg-gray-100 text-gray-600 bg-white',
            )}
          >
            {loading === action.label ? (
              <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
            ) : action.style === 'primary' ? (
              <ArrowRight className="w-3 h-3" />
            ) : (
              <X className="w-3 h-3" />
            )}
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}
