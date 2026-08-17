import { defineConfig } from 'drizzle-kit';

const databasePath = process.env['DATABASE_PATH'] ?? './data/bookkeeper.db';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dbCredentials: { url: databasePath },
  strict: true,
  verbose: true,
});
