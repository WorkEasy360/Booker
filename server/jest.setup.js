// Set test environment variables BEFORE any modules are imported.
// This file runs via Jest's globalSetup / setupFiles chain.
// A fresh database per test file keeps suites independent of each other and of earlier runs.
// jest.teardown.ts deletes it afterwards unless KEEP_TEST_DB=1.
// In the OS temp folder: outside the synced project, where sync clients scan and lock new files.
process.env.DB_PATH = require('path').join(require('os').tmpdir(), 'we360-jest', `test-run-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
process.env.JWT_SECRET = 'test-secret-for-unit-tests-only-at-least-64-chars-xxxxxxxxxxxxxxxxxxx';
process.env.JWT_EXPIRES_IN = '1h';
process.env.ADMIN_EMAIL = 'testadmin@example.com';
process.env.ADMIN_PASSWORD = 'TestPass123!';
process.env.CORS_ORIGIN = 'http://localhost:5173';
process.env.PORT = '3002'; // different port so it doesn't clash with dev server
process.env.EMAIL_TRANSPORT = 'memory'; // tests never send real email
process.env.PUBLIC_APP_URL = 'http://localhost:5173';
// Suites make many requests from one address; security.test.ts switches limits back on to test them.
process.env.RATE_LIMITS = 'off';
