import { execSync } from 'node:child_process';
import { TEST_DATABASE_URL } from './env';

export default function globalSetup(): void {
  // Fresh schema for every run; `migrate reset` creates the database if missing.
  execSync('npx prisma migrate reset --force --skip-seed --skip-generate', {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'ignore',
  });
}
