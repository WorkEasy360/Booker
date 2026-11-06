// Runs once before all test files: hold a power request so the computer cannot idle into standby mid-run.
const { startKeepAwake } = require('./scripts/keep-awake.cjs');

module.exports = async () => {
  globalThis.__WE360_KEEP_AWAKE__ = startKeepAwake();
};
