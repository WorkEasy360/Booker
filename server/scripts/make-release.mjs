// Packs a release for copying to the production server: the source the builds need, from an explicit list, so the
// secrets file (server/.env), the development database (server/data, server/dev.db), backups, uploads, test suites and
// their test-only certificates can never be included. The archive is listed afterwards and refused (deleted) if anything
// that looks like a secret or a database got in. A .sha256 file is written next to it (`sha256sum -c` on the server).
// The server then runs npm ci and both builds (docs/PRODUCTION_LAUNCH.md).
//
//   node server/scripts/make-release.mjs --out <folder outside the project>
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INCLUDE = [
  'package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json', 'tsconfig.node.json',
  'tailwind.config.js', 'postcss.config.js', 'eslint.config.js', 'README.md', 'public', 'src', 'docs',
  'Dockerfile', '.dockerignore', '.railwayignore',
  'server/package.json', 'server/package-lock.json', 'server/tsconfig.json', 'server/tsconfig.build.json',
  'server/.env.example', 'server/src', 'server/scripts', 'server/knowledge',
];
const EXCLUDE = ['server/src/tests'];
// Anything matching one of these must not be in a release.
const FORBIDDEN = [
  /(^|\/)\.env($|\.(?!example$))/,                          // secrets files (the .env.example template is allowed)
  /\.(db|sqlite3?)($|-wal$|-shm$|-journal$|\.json$)/,       // databases, their WAL files and backup manifests
  /(^|\/)(data|backups|uploads|node_modules|dist|\.acceptance)\//,
  /\.(pem|key|p12|pfx)$/,                                   // private keys and certificates
];

function fail(message) {
  console.error(`Release not made: ${message}`);
  process.exit(1);
}
const outArg = process.argv[process.argv.indexOf('--out') + 1];
if (!process.argv.includes('--out') || !outArg) fail('--out <folder> is required');
const out = path.resolve(outArg);
if ((out + path.sep).startsWith(ROOT + path.sep)) fail('choose a folder outside the project');
for (const p of INCLUDE) if (!fs.existsSync(path.join(ROOT, p))) fail(`missing ${p}`);
fs.mkdirSync(out, { recursive: true });

// Windows: the system tar (bsdtar); the Git Bash tar would read "C:" as a remote host.
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const name = `workeasy360-release-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.tar.gz`;
const file = path.join(out, name);
const made = spawnSync(tar, ['-czf', file, ...EXCLUDE.map(e => `--exclude=${e}`), '-C', ROOT, ...INCLUDE], { encoding: 'utf8' });
if (made.status !== 0) fail(`tar failed: ${(made.stderr || made.error?.message || '').trim()}`);

const listed = spawnSync(tar, ['-tzf', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (listed.status !== 0) { fs.rmSync(file, { force: true }); fail('the archive could not be listed'); }
const entries = listed.stdout.split(/\r?\n/).filter(Boolean).map(e => e.replace(/^\.\//, ''));
const bad = entries.filter(e => FORBIDDEN.some(re => re.test(e)) || EXCLUDE.some(x => e === x || e.startsWith(`${x}/`)));
if (bad.length) { fs.rmSync(file, { force: true }); fail(`it would contain ${bad.length} forbidden file(s), for example ${bad[0]}; nothing was kept`); }

const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.writeFileSync(`${file}.sha256`, `${hash}  ${name}\n`);
console.log(`Release written: ${file} (${entries.length} entries, ${fs.statSync(file).size} bytes)`);
console.log(`Checksum: ${file}.sha256`);
console.log('Checked: no secrets file, database, backup, upload, key, build output, node_modules or test suite inside.');
