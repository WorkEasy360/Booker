import { useEffect } from 'react';
import { pageTitle } from '@/lib/brand';

/**
 * Sets the browser tab title while the page is shown. `title` is the full title when `raw` is set (public pages
 * compose their own, business first); otherwise it becomes "Title — WorkeasyBooking".
 */
export function usePageTitle(title: string, { raw = false }: { raw?: boolean } = {}) {
  useEffect(() => {
    const prev = document.title;
    document.title = raw ? title : pageTitle(title);
    return () => { document.title = prev; };
  }, [title, raw]);
}
