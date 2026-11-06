// Run with: npm run test:unit. Hindi covers every English text, with the same {placeholders}, and is really Hindi
// (Devanagari), not a copy of the English; values are filled in; an unknown language falls back to English.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGES, translate, isLanguage, type MessageKey } from '../../src/i18n/messages.ts';
import { longDate } from '../../src/i18n/format.ts';

const keys = Object.keys(MESSAGES.en) as MessageKey[];
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

test('every English key has a Hindi text with the same placeholders', () => {
  assert.deepEqual(Object.keys(MESSAGES.hi).sort(), [...keys].sort());
  for (const k of keys) {
    assert.ok(MESSAGES.hi[k].trim(), `${k} is empty`);
    assert.deepEqual(placeholders(MESSAGES.hi[k]), placeholders(MESSAGES.en[k]), k);
  }
});

test('Hindi texts are written in Devanagari, not copied from English', () => {
  const devanagari = /[ऀ-ॿ]/;
  for (const k of keys) assert.match(MESSAGES.hi[k], devanagari, k);
});

test('values are filled in; unknown names stay visible; languages are checked', () => {
  assert.equal(translate('en', 'step.progress', { step: 2, total: 6 }), 'Step 2 of 6');
  assert.equal(translate('hi', 'step.progress', { step: 2, total: 6 }), 'चरण 2 / 6');
  assert.equal(translate('hi', 'block.answer', {}), 'आगे बढ़ने के लिए "{label}" का उत्तर दें।');
  assert.equal(translate('hi', 'status.no_show'), 'नहीं आए');
  assert.equal(isLanguage('hi'), true);
  assert.equal(isLanguage('fr'), false);
});

test('dates are written in the chosen language', () => {
  assert.match(longDate('2026-11-04', 'en'), /Wednesday.*4 November 2026/);
  assert.match(longDate('2026-11-04', 'hi'), /बुधवार/);
  assert.match(longDate('2026-11-04', 'hi'), /नवंबर/);
});
