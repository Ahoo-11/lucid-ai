// Read-only release check (release.verify): fails unless every migration in
// this commit is already applied to DATABASE_URL. Unlike db:migrate it never
// writes, so it is safe to run against the live database at any time.
import pg from "pg";
import { migrationCount, missingMigrations } from "./schemaCheck";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const missing = await missingMigrations((text) => client.query(text));
  if (missing.length) {
    console.error(`The database is missing migrations: ${missing.join(", ")}`);
    process.exitCode = 1;
  } else {
    await client.query("select count(*) from users"); // one real read against the newest tables
    console.info(`Schema is current (${migrationCount} migrations applied).`);
  }
} finally {
  await client.end();
}
