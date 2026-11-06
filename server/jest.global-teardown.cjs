// Runs once after all test files: release the power request taken in jest.global-setup.cjs.
module.exports = async () => {
  try { globalThis.__WE360_KEEP_AWAKE__?.kill(); } catch { /* already gone */ }
};
