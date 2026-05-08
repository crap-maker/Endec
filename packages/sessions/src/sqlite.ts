import Database from "better-sqlite3";

export function openSessionsDatabase(filename: string): Database.Database {
  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  return db;
}
