import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { deserializeOperation, serializeOperation, WtrDatabase } from "./database.js";

const databases: WtrDatabase[] = [];
const directories: string[] = [];
afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("SQLite metadata", () => {
  it("migrates an empty database and serializes operation payloads", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wtr-db-"));
    directories.push(directory);
    const database = new WtrDatabase(path.join(directory, "metadata.db"));
    databases.push(database);
    const request = {
      branch: "feature/üñîçødé",
      argv: ["echo", "a b", "x;y", "$HOME", '"quoted"'],
    };
    database.connection
      .prepare(
        `INSERT INTO operations(id,kind,project_id,worktree_id,status,request_json,result_json,error,created_at,updated_at)
         VALUES('op_1','finish',NULL,NULL,'pending',?,NULL,NULL,'2026-01-01','2026-01-01')`,
      )
      .run(serializeOperation(request));
    expect(database.operation("op_1")).toMatchObject({
      id: "op_1",
      kind: "finish",
      status: "pending",
      request,
    });
    expect(deserializeOperation(serializeOperation(request))).toEqual(request);
    expect(database.connection.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("migrates version 1 rows to nullable branches and remove operations", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wtr-db-v1-"));
    directories.push(directory);
    const filePath = path.join(directory, "metadata.db");
    const legacy = new Database(filePath);
    legacy.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES(1,'2026-01-01');
      CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,repository_path TEXT NOT NULL UNIQUE,main_worktree_path TEXT NOT NULL,default_branch TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE worktrees(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,path TEXT NOT NULL UNIQUE,branch TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('main','linked')),tmux_socket_name TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN ('active','cleaning','cleanup_failed','removed')),cleanup_error TEXT,pr_state TEXT NOT NULL DEFAULT 'unknown',pr_number INTEGER,pr_url TEXT,pr_base_branch TEXT,pr_head_branch TEXT,pr_merged_at TEXT,pr_refreshed_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX worktrees_project_idx ON worktrees(project_id);
      CREATE TABLE terminals(id TEXT PRIMARY KEY,worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,name TEXT NOT NULL,tmux_session_name TEXT NOT NULL,argv_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('running','exited','missing')),exit_code INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(worktree_id,tmux_session_name));
      CREATE INDEX terminals_worktree_idx ON terminals(worktree_id);
      CREATE TABLE operations(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('finish','discard','project_cleanup')),project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL,status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),request_json TEXT NOT NULL,result_json TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX operations_worktree_idx ON operations(worktree_id);
      INSERT INTO projects VALUES('p','repo','/repo','/repo','main','t','t');
      INSERT INTO worktrees(id,project_id,path,branch,kind,tmux_socket_name,status,created_at,updated_at) VALUES('w','p','/repo/topic','(detached)','linked','sock','active','t','t');
      INSERT INTO terminals VALUES('term','w','Terminal','session','["sh"]','running',NULL,'t','t');
      INSERT INTO operations VALUES('old','finish','p','w','completed','{}','{}',NULL,'t','t');
    `);
    legacy.close();

    const database = new WtrDatabase(filePath);
    databases.push(database);
    expect(database.worktree("w")).toMatchObject({
      branch: null,
      detached: true,
      head: "",
      name: "topic",
    });
    expect(database.terminal("term")?.name).toBe("Terminal");
    expect(database.project("p")?.color).toBeNull();
    expect(database.operation("old")?.kind).toBe("finish");
    expect(() =>
      database.connection
        .prepare(
          "INSERT INTO operations VALUES('new','remove','p','w','pending','{}',NULL,NULL,'t','t')",
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      database.connection.prepare("UPDATE projects SET color='indigo' WHERE id='p'").run(),
    ).toThrow();
  });
});
