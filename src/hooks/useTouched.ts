import { useCallback, useState } from 'react';

/**
 * Which fields the person has left at least once. Forms show a field's error only after that (or after a save
 * attempt), so nobody is told off while still typing, and the error updates as soon as the value is corrected.
 */
export function useTouched() {
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const touch = useCallback((...keys: string[]) => {
    setTouched(prev => (keys.every(k => prev[k]) ? prev : { ...prev, ...Object.fromEntries(keys.map(k => [k, true])) }));
  }, []);
  return [touched, touch] as const;
}
