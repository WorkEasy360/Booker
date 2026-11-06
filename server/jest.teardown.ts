import { afterAll } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import db from './src/db/init';

afterAll(() => {
  const file = db.name;
  if (db.open) db.close();
  if (process.env.KEEP_TEST_DB === '1' || !path.basename(file).startsWith('test-run-')) return;
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(file + suffix, { force: true }); } catch { /* already gone */ }
  }
});
