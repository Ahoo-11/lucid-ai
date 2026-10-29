// Applies database migrations and exits. Deploys run this before a release
// goes live (release.prepare), so a new version never starts on an old schema.
import { openDb } from "./db";

const { close } = await openDb({ databaseUrl: process.env.DATABASE_URL, dataDir: process.env.DATABASE_URL ? undefined : process.env.LUCID_DATA_DIR });
await close();
console.info(`Migrations applied to ${process.env.DATABASE_URL ? "Postgres (DATABASE_URL)" : "the embedded database"}.`);
