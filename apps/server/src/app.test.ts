import { describe, expect, it, vi } from "vitest";
import { ProductEventBus, type AppConfig, type TmuxAdapter, type WtrService } from "@wtr/core";
import { createApp } from "./app.js";

function fixture(authToken: string | null = null) {
  const config: AppConfig = {
    host: "127.0.0.1",
    port: 4780,
    authToken,
    databasePath: "/tmp/wtr-test.db",
    dataDir: "/tmp",
    runtimeDir: "/tmp",
    shell: "/bin/zsh",
    tmuxPath: "tmux",
    gitPath: "git",
    ghPath: "gh",
    apiUrl: "http://127.0.0.1:4780",
  };
  const service = {
    events: new ProductEventBus(),
    listProjects: vi.fn(async () => []),
    createTerminal: vi.fn(),
    createWorktree: vi.fn(async () => ({
      worktree: {},
      terminal: null,
      terminalError: null,
      setupError: null,
    })),
    removePreview: vi.fn(async () => ({ worktreeId: "wt_1" })),
    beginRemove: vi.fn(async () => ({ id: "op_1" })),
  } as unknown as WtrService;
  const app = createApp({ service, config, tmux: {} as TmuxAdapter, webDist: "/missing" });
  return { app, service };
}

describe("HTTP API validation and authentication", () => {
  it("returns consistent validation errors without calling domain services", async () => {
    const { app, service } = fixture();
    const response = await app.request("/api/worktrees/wt_1/terminals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bad", argv: "pnpm dev" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "Request validation failed" },
    });
    expect(service.createTerminal).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with a machine-readable code", async () => {
    const { app } = fixture();
    const response = await app.request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_JSON" } });
  });

  it("accepts detached worktree creation and one remove endpoint", async () => {
    const { app, service } = fixture();
    const created = await app.request("/api/projects/p/worktrees", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "topic", base: "current", sourceWorktreeId: "wt_main" }),
    });
    expect(created.status).toBe(201);
    expect(service.createWorktree).toHaveBeenCalledWith(
      "p",
      "topic",
      "current",
      undefined,
      "wt_main",
    );

    expect((await app.request("/api/worktrees/wt_1/remove-preview")).status).toBe(200);
    const removed = await app.request("/api/worktrees/wt_1/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmationToken: "a".repeat(64), confirmDestructive: true }),
    });
    expect(removed.status).toBe(202);
    expect(service.beginRemove).toHaveBeenCalledWith("wt_1", {
      confirmationToken: "a".repeat(64),
      confirmDestructive: true,
    });
  });

  it("does not expose removed diagnostics and finish/discard routes", async () => {
    const { app } = fixture();
    expect((await app.request("/api/diagnostics")).status).toBe(404);
    expect((await app.request("/api/worktrees/w/finish-preview")).status).toBe(404);
    expect((await app.request("/api/worktrees/w/discard-preview")).status).toBe(404);
  });

  it("allows health checks but protects APIs when a token is configured", async () => {
    const { app } = fixture("static-secret");
    expect((await app.request("/api/health")).status).toBe(200);
    expect((await app.request("/api/projects")).status).toBe(401);
    expect(
      (await app.request("/api/projects", { headers: { authorization: "Bearer static-secret" } }))
        .status,
    ).toBe(200);
  });
});
