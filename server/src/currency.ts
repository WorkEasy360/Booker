import { z } from 'zod';

// Keep in sync with src/lib/currency.ts in the frontend.
export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD'] as const;
export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

export const CurrencySchema = z.preprocess(
  v => (typeof v === 'string' ? v.trim().toUpperCase() : v),
  z.enum(SUPPORTED_CURRENCIES, { errorMap: () => ({ message: `Currency must be one of ${SUPPORTED_CURRENCIES.join(', ')}` }) }),
);
