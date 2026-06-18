import { defineConfig } from "vitest/config";

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://creatorflow:creatorflow@localhost:5433/creatorflow_indexer";

export default defineConfig({
  test: {
    // Integration tests share one Postgres DB and TRUNCATE between cases —
    // run serially so they don't clobber each other's rows.
    fileParallelism: false,
    env: {
      DATABASE_URL: DB_URL,
    },
  },
});
