import React, { useState } from 'react';
import { CheckCircle, XCircle, Clock, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { useAI } from '../../contexts/AIContext';
import type { AIProposal } from './types';
import { cn } from '../../lib/utils';

interface ProposalCardProps {
  proposal: AIProposal;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  pending:   { label: 'Awaiting confirmation', color: 'text-amber-600 bg-amber-50 border-amber-200' },
  confirmed: { label: 'Confirmed', color: 'text-blue-600 bg-blue-50 border-blue-200' },
  executed:  { label: 'Completed', color: 'text-emerald-600 bg-emerald-50 border-emerald-200' },
  failed:    { label: 'Failed', color: 'text-red-600 bg-red-50 border-red-200' },
  cancelled: { label: 'Cancelled', color: 'text-gray-500 bg-gray-50 border-gray-200' },
  expired:   { label: 'Expired', color: 'text-gray-500 bg-gray-50 border-gray-200' },
};

export function ProposalCard({ proposal }: ProposalCardProps) {
  const { confirmProposal, cancelProposal } = useAI();
  const [loading, setLoading] = useState<'confirm' | 'cancel' | null>(null);
  const [expanded, setExpanded] = useState(true);

  const isExpired = new Date(proposal.expiresAt) < new Date();
  const effectiveStatus = isExpired && proposal.status === 'pending' ? 'expired' : proposal.status;
  const statusInfo = STATUS_LABELS[effectiveStatus] ?? STATUS_LABELS.pending;
  const canAct = effectiveStatus === 'pending' && !isExpired;

  async function handleConfirm() {
    setLoading('confirm');
    try { await confirmProposal(proposal.id); } finally { setLoading(null); }
  }

  async function handleCancel() {
    setLoading('cancel');
    try { await cancelProposal(proposal.id); } finally { setLoading(null); }
  }

  return (
    <div className={cn(
      'my-2 rounded-xl border-2 overflow-hidden text-sm',
      canAct ? 'border-[#00BF62]/40 bg-emerald-50/50' : `border-gray-200 bg-white`,
      effectiveStatus === 'executed' && 'border-emerald-200 bg-emerald-50/30',
    )}>
      {/* Header */}
      <button
        className="w-full flex items-center justify-between px-3 py-2.5 font-medium hover:bg-black/5 transition-colors"
        onClick={() => setExpanded(v => !v)}
      >
        <div className="flex items-center gap-2">
          {effectiveStatus === 'executed' && <CheckCircle className="w-4 h-4 text-emerald-600" />}
          {effectiveStatus === 'failed' && <AlertCircle className="w-4 h-4 text-red-500" />}
          {effectiveStatus === 'cancelled' && <XCircle className="w-4 h-4 text-gray-400" />}
          {effectiveStatus === 'pending' && <Clock className="w-4 h-4 text-amber-500" />}
          <span className="text-gray-800">{proposal.displayData.type ?? 'Action Proposal'}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn('text-[11px] font-semibold px-1.5 py-0.5 rounded-full border', statusInfo.color)}>
            {statusInfo.label}
          </span>
          {expanded ? <ChevronUp className="w-3.5 h-3.5 text-gray-400" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-400" />}
        </div>
      </button>

      {/* Body */}
      {expanded && (
        <div className="px-3 pb-3">
          {/* Fields table */}
          <div className="rounded-lg border border-gray-200 overflow-hidden mb-3 bg-white">
            {(proposal.displayData.fields ?? []).map((field, i) => (
              <div key={i} className={cn('flex text-xs', i > 0 && 'border-t border-gray-100')}>
                <div className="w-28 shrink-0 px-3 py-2 font-medium text-gray-500 bg-gray-50">{field.label}</div>
                <div className="flex-1 px-3 py-2 text-gray-800 break-words">
                  {String(field.value ?? '—')}
                </div>
              </div>
            ))}
          </div>

          {/* Actions */}
          {canAct && (
            <div className="flex gap-2">
              <button
                onClick={handleConfirm}
                disabled={!!loading}
                className="flex-1 py-2 px-3 rounded-lg bg-[#00BF62] hover:bg-[#008F49] text-white text-xs font-semibold disabled:opacity-60 transition-colors flex items-center justify-center gap-1.5"
              >
                {loading === 'confirm' ? (
                  <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <CheckCircle className="w-3.5 h-3.5" />
                )}
                Confirm & Execute
              </button>
              <button
                onClick={handleCancel}
                disabled={!!loading}
                className="py-2 px-3 rounded-lg border border-gray-300 hover:bg-gray-100 text-gray-600 text-xs font-semibold disabled:opacity-60 transition-colors flex items-center gap-1.5"
              >
                {loading === 'cancel' ? (
                  <span className="w-3.5 h-3.5 border-2 border-gray-400/30 border-t-gray-400 rounded-full animate-spin" />
                ) : (
                  <XCircle className="w-3.5 h-3.5" />
                )}
                Cancel
              </button>
            </div>
          )}

          {effectiveStatus === 'expired' && (
            <p className="text-xs text-gray-500 text-center py-1">This proposal expired. Ask the AI to prepare a new one.</p>
          )}
        </div>
      )}
    </div>
  );
}
