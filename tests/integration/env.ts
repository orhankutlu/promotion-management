export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://modaco:modaco@localhost:55432/modaco_test?schema=public';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:56379/15';
