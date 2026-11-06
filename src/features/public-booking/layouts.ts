// The three booking-page layouts a business can choose (Booking Pages > Layout). Each changes the page's structure
// and look; every layout shows the same steps, fields, validation and buttons, so booking works identically.

export type BookingLayout = 'classic' | 'modern' | 'minimal';
export type StepStyle = 'circles' | 'bar' | 'text';

export interface LayoutStyle {
  /** Width and spacing of the whole page. */
  container: string;
  /** The header with the business mark, page title and business name. */
  header: string;
  title: string;
  subtitle: string;
  /** Whether the logo or monogram is shown (the page's own "show logo" setting still applies). */
  showMark: boolean;
  /** How progress through the six steps is shown. */
  steps: StepStyle;
  /** The box around the current step. */
  card: string;
  /** Extra classes for the Back / Continue / Confirm buttons. */
  button: string;
}

export const LAYOUTS: Record<BookingLayout, LayoutStyle> = {
  classic: {
    container: 'max-w-2xl mx-auto px-4 py-8',
    header: 'flex items-center gap-3 mb-6',
    title: 'font-bold text-text-primary',
    subtitle: 'text-xs text-text-muted',
    showMark: true,
    steps: 'circles',
    card: 'bg-surface rounded-xl border border-border shadow-card p-5 sm:p-6 mb-6 min-h-[280px]',
    button: 'rounded-lg',
  },
  modern: {
    container: 'max-w-3xl mx-auto px-4 py-10',
    header: 'flex flex-col items-center text-center gap-3 mb-8 px-6 py-8 rounded-3xl bg-primary/10',
    title: 'text-2xl sm:text-3xl font-extrabold tracking-tight text-text-primary',
    subtitle: 'text-sm font-medium text-primary',
    showMark: true,
    steps: 'bar',
    card: 'bg-surface rounded-3xl shadow-lg ring-1 ring-black/5 p-6 sm:p-8 mb-6 min-h-[280px]',
    button: 'rounded-full',
  },
  minimal: {
    container: 'max-w-xl mx-auto px-4 py-10',
    header: 'mb-6',
    title: 'text-lg font-semibold text-text-primary',
    subtitle: 'text-sm text-text-muted',
    showMark: false,
    steps: 'text',
    card: 'border-t border-border pt-6 mb-6 min-h-[280px]',
    button: 'rounded-md',
  },
};

/** The layout for a page's saved setting; anything unknown or missing is Classic (the original look). */
export function layoutFor(value: unknown): { name: BookingLayout; style: LayoutStyle } {
  const name = typeof value === 'string' && value in LAYOUTS ? value as BookingLayout : 'classic';
  return { name, style: LAYOUTS[name] };
}
