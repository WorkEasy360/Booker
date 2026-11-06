import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { tokenFromHash } from './authRules';

/**
 * The token of the emailed link the page was opened with (#token=…), removed from the address bar and history once
 * read. A newer link opened in the same tab changes only the part after #, so the page does not reload: that token
 * replaces the old one. `onToken` runs for each token read; `onMissing` when the page was opened without one.
 */
export function useEmailLinkToken(onToken: (token: string) => void, onMissing: () => void): string {
  const location = useLocation();
  const navigate = useNavigate();
  const [token, setToken] = useState('');
  const read = useRef(false);

  useEffect(() => {
    const fresh = tokenFromHash(location.hash);
    if (location.hash) navigate(location.pathname + location.search, { replace: true });
    if (fresh) { read.current = true; setToken(fresh); onToken(fresh); }
    else if (!read.current) onMissing();
  }, [location.hash]); // eslint-disable-line react-hooks/exhaustive-deps

  return token;
}
