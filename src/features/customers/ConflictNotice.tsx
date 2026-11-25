import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import type { SaveConflict } from './customerData';

/** Why a customer could not be saved because the contact details already belong to someone, with links to them. */
export function ConflictNotice({ conflict, onUse }: { conflict: SaveConflict; onUse?: (id: string) => void }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
      <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" aria-hidden="true" />
      <div className="min-w-0 text-sm text-amber-900">
        <p className="font-medium">{conflict.message}</p>
        {conflict.matches.length > 0 && (
          <ul className="mt-2 space-y-1.5">
            {conflict.matches.map(m => (
              <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>{m.name}{m.phone ? ` · ${m.phone}` : ''}{m.email ? ` · ${m.email}` : ''}</span>
                {onUse
                  ? <button type="button" onClick={() => onUse(m.id)} className="font-semibold text-primary hover:text-primary-dark underline-offset-2 hover:underline">Use this customer</button>
                  : <Link to={`/customers/${m.id}`} className="font-semibold text-primary hover:text-primary-dark underline-offset-2 hover:underline">Open customer</Link>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
