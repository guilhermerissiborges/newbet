import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof makeDb>;
export function makeDb(url = process.env.DATABASE_URL ?? "postgresql://live@localhost:5432/arrematto") {
  const sql = postgres(url, { max: 10 });
  return drizzle(sql, { schema });
}
export { schema };
