import { useEffect } from 'react';

/** Width the artwork-based screens were drawn at (the Appointments artwork). */
export const DESIGN_WIDTH = 1536;
/**
 * Comfortable reading size: the artwork's type is poster-sized, so the screens drawn from it (navigation, header,
 * Appointments) are shown at 80% of the artwork, and never enlarged on wide monitors.
 */
export const BASE_SCALE = 0.8;

/**
 * Laptop and desktop windows: wide windows, and any window from 768px wide used with a mouse or trackpad. Must match
 * the lg / xl screens in tailwind.config.js.
 */
export const DESKTOP_QUERY = '(min-width: 1280px), (min-width: 768px) and (hover: hover) and (pointer: fine)';

export function isDesktopWindow(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DESKTOP_QUERY).matches;
}

/** Scale of the artwork-based screens for a window width: 80%, or less when the window is too narrow to fit them. */
export function shellScale(width: number): number {
  return Math.min(BASE_SCALE, width / DESIGN_WIDTH);
}

/**
 * Sets --shell-zoom for the navigation, the header and the Appointments screen (they apply it with CSS zoom), so they
 * keep the artwork's arrangement and proportions on any laptop or desktop window: at a comfortable size on wide
 * monitors, scaled down just enough on narrow ones. Other screens are not scaled: their text stays at normal size.
 * Phones and touch tablets use the responsive layout (scale 1).
 */
export function useDesignScale(): void {
  useEffect(() => {
    const root = document.documentElement;
    const query = window.matchMedia(DESKTOP_QUERY);
    const apply = () => {
      root.style.setProperty('--shell-zoom', query.matches ? String(shellScale(window.innerWidth)) : '1');
    };
    apply();
    window.addEventListener('resize', apply);
    query.addEventListener('change', apply);
    return () => {
      window.removeEventListener('resize', apply);
      query.removeEventListener('change', apply);
      root.style.removeProperty('--shell-zoom');
    };
  }, []);
}

/** Inline style that draws an element at the artwork scale. */
export const SHELL_ZOOM_STYLE = { zoom: 'var(--shell-zoom, 1)' } as const;
