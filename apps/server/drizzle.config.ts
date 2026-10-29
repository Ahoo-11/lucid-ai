import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "../../packages/schema/src/db.ts",
  out: "./drizzle",
});
