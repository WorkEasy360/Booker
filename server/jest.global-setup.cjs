// Runs once before all test files: hold a power request so the computer cannot idle into standby mid-run.
const { startKeepAwake } = require('./scripts/keep-awake.cjs');
// CommonJS bundles of the ES-module-only OIDC libraries for Jest (scripts/jest-esm-deps.cjs).
const { buildEsmDeps } = require('./scripts/jest-esm-deps.cjs');

module.exports = async () => {
  globalThis.__WE360_KEEP_AWAKE__ = startKeepAwake();
  buildEsmDeps();
};
