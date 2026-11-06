import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { isLanguage, translate, type Language, type MessageKey } from './messages';

// The language the app is shown in. A person's own choice (kept in this browser) wins; otherwise the browser's
// language when it is Hindi; otherwise English. Public booking pages may pass the business's language as the default.

const STORAGE_KEY = 'we360_language';

function stored(): Language | null {
  try { const v = localStorage.getItem(STORAGE_KEY); return isLanguage(v) ? v : null; } catch { return null; }
}

function browserLanguage(): Language {
  try { return /^hi\b/i.test(navigator.language) ? 'hi' : 'en'; } catch { return 'en'; }
}

interface LanguageValue {
  lang: Language;
  /** Sets the language and remembers it in this browser. */
  setLang: (lang: Language) => void;
  /** Uses this language unless the person has chosen one (for example a business's booking-page language). */
  setDefault: (lang: Language) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LanguageValue | null>(null);

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Language>(() => stored() ?? browserLanguage());

  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  const setLang = useCallback((next: Language) => {
    setLangState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* not remembered; still applied */ }
  }, []);
  const setDefault = useCallback((next: Language) => { if (!stored()) setLangState(next); }, []);
  const t = useCallback((key: MessageKey, vars?: Record<string, string | number>) => translate(lang, key, vars), [lang]);

  const value = useMemo(() => ({ lang, setLang, setDefault, t }), [lang, setLang, setDefault, t]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

/** Outside a provider (for example in isolated tests) everything is English. */
export function useLanguage(): LanguageValue {
  return useContext(LanguageContext) ?? {
    lang: 'en', setLang: () => {}, setDefault: () => {}, t: (key, vars) => translate('en', key, vars),
  };
}
