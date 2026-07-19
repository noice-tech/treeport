import { describe, expect, it } from "vitest";
import {
  createTerminalSchema,
  createWorktreeSchema,
  discardSchema,
  registerProjectSchema,
  spawnSchema,
} from "./index.js";

describe("API input validation", () => {
  it("requires repository paths and valid names", () => {
    expect(registerProjectSchema.safeParse({ path: "" }).success).toBe(false);
    expect(registerProjectSchema.parse({ path: "/repo with spaces" })).toEqual({
      path: "/repo with spaces",
    });
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
    expect(spawnSchema.parse({ project: ".", branch: "topic", name: "Pi", argv }).argv).toEqual(
      argv,
    );
  });

  it("rejects empty argv rather than accepting a shell command string", () => {
    expect(createTerminalSchema.safeParse({ name: "bad", argv: [] }).success).toBe(false);
    expect(createTerminalSchema.safeParse({ name: "bad", argv: "pnpm dev" }).success).toBe(false);
  });

  it("validates worktree and destructive confirmation payloads", () => {
    expect(createWorktreeSchema.parse({ branch: "feature/cache" })).toMatchObject({
      branch: "feature/cache",
      fromCurrent: false,
    });
    expect(discardSchema.safeParse({ confirm: "" }).success).toBe(false);
  });
});
