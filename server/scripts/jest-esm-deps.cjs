// openid-client and jose (used by src/workeasy360) are published as ES modules only. The compiled server loads them
// with Node's require(esm); Jest, which runs this suite as CommonJS (and with --experimental-vm-modules refuses to
// require() an ES module), gets a CommonJS bundle of each instead, built here once per installed version and mapped in
// package.json ("jest.moduleNameMapper"). Test-only: nothing here is used by the server.
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'node_modules', '.cache', 'workeasy360-cjs');
const PACKAGES = ['openid-client', 'jose'];

function version(name) {
  return JSON.parse(fs.readFileSync(require.resolve(`${name}/package.json`, { paths: [path.join(__dirname, '..')] }), 'utf8')).version;
}

function buildEsmDeps() {
  const stamp = PACKAGES.map(name => `${name}@${version(name)}`).join(' ');
  const stampFile = path.join(OUT, 'versions.txt');
  if (fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === stamp && PACKAGES.every(n => fs.existsSync(path.join(OUT, `${n}.cjs`)))) return;
  const esbuild = require('esbuild');
  fs.mkdirSync(OUT, { recursive: true });
  for (const name of PACKAGES) {
    esbuild.buildSync({
      entryPoints: [name],
      absWorkingDir: path.join(__dirname, '..'),
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'node22',
      outfile: path.join(OUT, `${name}.cjs`),
      logLevel: 'error',
    });
  }
  fs.writeFileSync(stampFile, stamp);
}

module.exports = { buildEsmDeps, OUT };
if (require.main === module) buildEsmDeps();
