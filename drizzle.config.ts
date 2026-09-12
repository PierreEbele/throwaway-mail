import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./app/server/db/schema.ts",
  out: "./app/server/db/migrations",
});
