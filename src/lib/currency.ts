// Keep in sync with server/src/currency.ts.
export const SUPPORTED_CURRENCIES = [
  { code: 'USD', label: 'USD — US Dollar ($)', locale: 'en-US' },
  { code: 'EUR', label: 'EUR — Euro (€)', locale: 'en-IE' },
  { code: 'GBP', label: 'GBP — British Pound (£)', locale: 'en-GB' },
  { code: 'INR', label: 'INR — Indian Rupee (₹)', locale: 'en-IN' },
  { code: 'CAD', label: 'CAD — Canadian Dollar ($)', locale: 'en-CA' },
  { code: 'AUD', label: 'AUD — Australian Dollar ($)', locale: 'en-AU' },
] as const;

export const CURRENCY_OPTIONS = SUPPORTED_CURRENCIES.map(c => ({ value: c.code, label: c.label }));

/**
 * Formats money with the conventions of the currency's home locale, e.g. ₹12,34,567.50 for INR
 * and $1,234,567.50 for USD. Unknown codes fall back to "XYZ 12.00" instead of throwing.
 */
export function formatMoney(amount: number, currency: string): string {
  const code = (currency || '').toUpperCase();
  const locale = SUPPORTED_CURRENCIES.find(c => c.code === code)?.locale ?? 'en-US';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code }).format(amount);
  } catch {
    return `${code || '?'} ${amount.toFixed(2)}`;
  }
}

/** The symbol for a currency in its home locale, e.g. ₹ for INR, £ for GBP. */
export function currencySymbol(currency: string): string {
  const code = (currency || '').toUpperCase();
  const locale = SUPPORTED_CURRENCIES.find(c => c.code === code)?.locale ?? 'en-US';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code }).formatToParts(0).find(p => p.type === 'currency')?.value ?? code;
  } catch {
    return code;
  }
}
