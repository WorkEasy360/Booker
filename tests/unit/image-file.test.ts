// Run with: npm run test:unit. The browser's quick check of a chosen logo or staff photo (the server decides).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageFileProblem, MAX_IMAGE_BYTES } from '../../src/lib/imageFile.ts';

test('PNG, JPEG and WebP up to 2 MB are accepted', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) assert.equal(imageFileProblem({ type, size: 1000 }), null, type);
  assert.equal(imageFileProblem({ type: 'image/png', size: MAX_IMAGE_BYTES }), null);
});

test('other types, empty files and files over 2 MB are refused with a reason', () => {
  for (const type of ['image/svg+xml', 'image/gif', 'text/html', 'application/pdf', '']) {
    assert.match(imageFileProblem({ type, size: 1000 }) ?? '', /PNG, JPEG or WebP/, type);
  }
  assert.match(imageFileProblem({ type: 'image/png', size: 0 }) ?? '', /empty/);
  assert.match(imageFileProblem({ type: 'image/jpeg', size: MAX_IMAGE_BYTES + 1 }) ?? '', /2 MB/);
});
