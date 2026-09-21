import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests run against a throwaway SQLite file, never the league's dev.db.
    env: { DATABASE_URL: 'file:./test.db' },
    globalSetup: ['./test/global-setup.ts'],
    // SQLite takes a single writer. Running files in one process keeps the concurrency tests
    // measuring our locking rather than the filesystem's.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
