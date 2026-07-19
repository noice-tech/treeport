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
