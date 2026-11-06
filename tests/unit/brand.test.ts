// Run with: npm run test:unit. Product identity: one spelling everywhere, official colours, and metadata/icons that exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as brand from '../../src/lib/brand.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * The constants in server/src/brand.ts, read as text: the server is a CommonJS package, so importing its TypeScript
 * here would make Node reparse it as an ES module (with a warning).
 */
function serverBrand(): Record<string, unknown> {
  const src = read('server/src/brand.ts');
  const str = (name: string) => src.match(new RegExp(`export const ${name} = '([^']*)';`))?.[1];
  const block = src.match(/export const BRAND_COLORS = \{([\s\S]*?)\}/)?.[1] ?? '';
  return {
    PRODUCT_NAME: str('PRODUCT_NAME'), COMPANY_NAME: str('COMPANY_NAME'),
    PRODUCT_ATTRIBUTION: str('PRODUCT_ATTRIBUTION'), PRODUCT_DESCRIPTION: str('PRODUCT_DESCRIPTION'),
    BRAND_COLORS: Object.fromEntries([...block.matchAll(/(\w+): '([^']*)'/g)].map(m => [m[1], m[2]])),
  };
}

/** Width and height from a PNG header; fails if the file is not a PNG. */
function pngSize(p: string): { width: number; height: number } {
  const b = fs.readFileSync(path.join(ROOT, p));
  assert.equal(b.subarray(1, 4).toString('latin1'), 'PNG', `${p} is not a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

test('the official identity, spelled once', () => {
  assert.equal(brand.PRODUCT_NAME, 'WorkeasyBooking');
  assert.equal(brand.COMPANY_NAME, 'WorkEasy360');
  assert.equal(brand.PRODUCT_ATTRIBUTION, 'A WorkEasy360 Product');
  assert.equal(brand.PRODUCT_DESCRIPTION, 'Smart appointment scheduling for businesses');
  assert.equal(brand.POWERED_BY, 'Powered by WorkeasyBooking');
  assert.deepEqual(brand.BRAND_COLORS, { primary: '#00BF62', secondary: '#008F49', navy: '#13222E', accent: '#FFC940' });
});

test('emails use the same identity as the web app', () => {
  const server = serverBrand();
  for (const key of ['PRODUCT_NAME', 'COMPANY_NAME', 'PRODUCT_ATTRIBUTION', 'PRODUCT_DESCRIPTION', 'BRAND_COLORS'] as const) {
    assert.deepEqual(server[key], { ...brand }[key], `server/src/brand.ts ${key} differs from src/lib/brand.ts`);
  }
});

test('the Tailwind theme uses the official colours', async () => {
  const { default: config } = await import('../../tailwind.config.js');
  const colors = config.theme.extend.colors;
  assert.equal(colors.primary.DEFAULT, brand.BRAND_COLORS.primary);
  assert.equal(colors.primary.dark, brand.BRAND_COLORS.secondary);
  assert.equal(colors.navy.DEFAULT, brand.BRAND_COLORS.navy);
  assert.equal(colors.accent, brand.BRAND_COLORS.accent);
});

test('browser tab titles: the page, then the product; a business page leads with the business', () => {
  assert.equal(brand.pageTitle('Dashboard'), 'Dashboard — WorkeasyBooking');
  assert.equal(brand.pageTitle(), 'WorkeasyBooking — Smart appointment scheduling for businesses');
  assert.equal(brand.pageTitle('   '), brand.pageTitle());
  assert.equal(brand.businessPageTitle('Glow Studio', 'Booking confirmed'), 'Booking confirmed · Glow Studio — WorkeasyBooking');
  assert.equal(brand.businessPageTitle('Glow Studio', 'Glow Studio'), 'Glow Studio — WorkeasyBooking');
  assert.equal(brand.businessPageTitle('Glow Studio'), 'Glow Studio — WorkeasyBooking');
  // Business not known yet: no empty slot, just the page.
  assert.equal(brand.businessPageTitle(undefined, 'Manage your booking'), 'Manage your booking — WorkeasyBooking');
  assert.equal(brand.copyrightNotice(2026), '© 2026 WorkEasy360');
});

test('index.html names the product and points to the official icons', () => {
  const html = read('index.html');
  assert.equal(html.match(/<title>([^<]*)<\/title>/)?.[1], brand.pageTitle());
  const meta = (name: string) => html.match(new RegExp(`<meta (?:name|property)="${name}" content="([^"]*)"`))?.[1];
  assert.equal(meta('application-name'), brand.PRODUCT_NAME);
  assert.equal(meta('apple-mobile-web-app-title'), brand.PRODUCT_NAME);
  assert.equal(meta('og:site_name'), brand.PRODUCT_NAME);
  assert.equal(meta('theme-color'), brand.BRAND_COLORS.navy);
  assert.match(meta('description') ?? '', /^WorkeasyBooking: smart appointment scheduling for businesses\. A WorkEasy360 Product\.$/);
  const icons = [...html.matchAll(/<link rel="(icon|apple-touch-icon)"[^>]*sizes="(\d+)x\d+" href="([^"]+)"/g)];
  assert.equal(icons.length, 3);
  for (const [, , size, href] of icons) {
    const { width, height } = pngSize(`public${href}`);
    assert.deepEqual([width, height], [Number(size), Number(size)], `${href} is ${width}x${height}, declared ${size}`);
  }
  assert.ok(!html.includes('/favicon.png'), 'the 4500 px original is no longer the favicon');
});

test('the web manifest names the product and its icons exist', () => {
  const manifest = JSON.parse(read('public/site.webmanifest'));
  assert.equal(manifest.name, brand.PRODUCT_NAME);
  assert.equal(manifest.short_name, brand.PRODUCT_NAME);
  assert.match(manifest.description, /A WorkEasy360 Product/);
  for (const icon of manifest.icons) {
    const { width, height } = pngSize(`public${icon.src}`);
    assert.equal(`${width}x${height}`, icon.sizes);
  }
});

test('in-app logos are right-sized copies of the official artwork', () => {
  // The originals stay as the source artwork; the UI loads these.
  assert.deepEqual(pngSize('src/assets/brand/workeasy360-logo.png'), { width: 742, height: 120 });
  assert.deepEqual(pngSize('src/assets/brand/workeasy360-logo-white.png'), { width: 742, height: 120 });
  assert.deepEqual(pngSize('src/assets/brand/workeasy360-mark.png'), { width: 128, height: 128 });
  for (const f of ['src/assets/brand/workeasy360-logo.png', 'src/assets/brand/workeasy360-logo-white.png', 'src/assets/brand/workeasy360-mark.png']) {
    assert.ok(fs.statSync(path.join(ROOT, f)).size < 40_000, `${f} is larger than expected`);
  }
});
