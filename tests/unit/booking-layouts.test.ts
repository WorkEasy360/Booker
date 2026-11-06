// Run with: npm run test:unit. The three booking-page layouts are really different from each other (not three names
// for one look), and an unknown or missing setting shows the original Classic layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAYOUTS, layoutFor } from '../../src/features/public-booking/layouts.ts';

test('each layout differs from the others in structure: header, progress, step box and buttons', () => {
  const names = Object.keys(LAYOUTS) as Array<keyof typeof LAYOUTS>;
  assert.deepEqual(names, ['classic', 'modern', 'minimal']);
  for (const key of ['header', 'card', 'button', 'steps', 'container'] as const) {
    const values = names.map(n => LAYOUTS[n][key]);
    assert.equal(new Set(values).size, names.length, `${key} must differ between layouts`);
  }
  assert.deepEqual(names.map(n => LAYOUTS[n].steps), ['circles', 'bar', 'text']);
});

test('Minimal hides the mark; Classic and Modern show it', () => {
  assert.deepEqual(['classic', 'modern', 'minimal'].map(n => LAYOUTS[n as keyof typeof LAYOUTS].showMark), [true, true, false]);
});

test('the saved setting picks the layout; anything else is Classic', () => {
  assert.equal(layoutFor('modern').name, 'modern');
  assert.equal(layoutFor('minimal').style, LAYOUTS.minimal);
  for (const v of [undefined, null, '', 'MODERN', 'retro', 42, {}]) assert.equal(layoutFor(v).name, 'classic', String(v));
});
