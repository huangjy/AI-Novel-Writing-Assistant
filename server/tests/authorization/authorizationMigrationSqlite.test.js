const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const Database = require("better-sqlite3");

test("additive SQLite authorization migration preserves existing provider and novel data", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-migration-"));
  const db = new Database(path.join(directory, "fixture.db"));
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE "APIKey" ("provider" TEXT PRIMARY KEY, "key" TEXT, "model" TEXT);
      CREATE TABLE "Novel" ("id" TEXT PRIMARY KEY, "title" TEXT);
      INSERT INTO "APIKey" VALUES ('original', 'fake-original-key', 'original-model');
      INSERT INTO "Novel" VALUES ('fixture-novel', 'fixture title');`);
    const backup = path.join(directory, "before-migration.db");
    await db.backup(backup); assert.ok(fs.statSync(backup).size > 0);
    const sql = fs.readFileSync(path.resolve(__dirname, "../../src/prisma/migrations.sqlite/20261116160000_copilot_authorization/migration.sql"), "utf8");
    db.exec(sql);
    assert.deepEqual(db.prepare('SELECT * FROM "APIKey"').get(), {
      provider: "original", key: "fake-original-key", model: "original-model", connectionType: "api_key", authorizationAccountId: null,
    });
    assert.equal(db.prepare('SELECT title FROM "Novel"').get().title, "fixture title");
    assert.throws(() => db.prepare('INSERT INTO "APIKey" (provider, authorizationAccountId) VALUES (?, ?)').run("bad-binding", "missing"));
  } finally { db.close(); }
});
