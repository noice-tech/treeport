import { describe, expect, it } from "vitest";
import {
  createTerminalSchema,
  createWorktreeSchema,
  registerProjectSchema,
  removeWorktreeSchema,
  spawnSchema,
  updateProjectSchema,
} from "./index.js";

describe("API input validation", () => {
  it("requires repository paths and valid names", () => {
    expect(registerProjectSchema.safeParse({ path: "" }).success).toBe(false);
    expect(registerProjectSchema.parse({ path: "/repo with spaces" })).toEqual({
      path: "/repo with spaces",
    });
  });

  it("accepts only curated project colors and neutral", () => {
    expect(updateProjectSchema.parse({ color: "cyan" })).toEqual({ color: "cyan" });
    expect(updateProjectSchema.parse({ color: null })).toEqual({ color: null });
    expect(updateProjectSchema.safeParse({ color: "indigo" }).success).toBe(false);
    expect(updateProjectSchema.safeParse({ color: "#00ffff" }).success).toBe(false);
  });

  it("preserves command argv literally", () => {
    const argv = [
      "command with spaces",
      'a "quote"',
      "semi;colon",
      "$HOME",
      "Unicode 世界",
      "single'quote",
    ];
    expect(createTerminalSchema.parse({ name: "researcher", argv }).argv).toEqual(argv);
    expect(
      spawnSchema.parse({ project: ".", worktreeName: "topic", name: "Pi", argv }).argv,
    ).toEqual(argv);
  });

  it("rejects empty argv rather than accepting a shell command string", () => {
    expect(createTerminalSchema.safeParse({ name: "bad", argv: [] }).success).toBe(false);
    expect(createTerminalSchema.safeParse({ name: "bad", argv: "pnpm dev" }).success).toBe(false);
  });

  it("validates detached worktree creation and removal payloads", () => {
    expect(createWorktreeSchema.parse({ name: "feature-cache" })).toMatchObject({
      name: "feature-cache",
      base: "default",
    });
    expect(createWorktreeSchema.safeParse({ name: "topic", base: "current" }).success).toBe(false);
    const confirmationToken = "a".repeat(64);
    expect(removeWorktreeSchema.parse({ confirmationToken, confirmDestructive: true })).toEqual({
      confirmationToken,
      confirmDestructive: true,
    });
    expect(
      removeWorktreeSchema.safeParse({ confirmationToken: "short", confirmDestructive: true })
        .success,
    ).toBe(false);
  });
});
