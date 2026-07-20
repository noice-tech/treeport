import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  TerminalSession,
  TerminalSessionManager as TerminalSessionManagerInstance,
  TerminalSessionSnapshot,
} from "./terminal-session.js";

type TerminalSessionManagerConstructor = new (
  maxSessions?: number,
  idleMs?: number,
  createSession?: (terminalId: string) => TerminalSession,
) => TerminalSessionManagerInstance;

let TerminalSessionManager: TerminalSessionManagerConstructor;

class FakeSession {
  disposed = false;
  private readonly listeners = new Set<() => void>();
  private snapshot: TerminalSessionSnapshot = {
    phase: "ready",
    degraded: false,
    controller: false,
    title: null,
    bellActive: false,
    bellSerial: 0,
    exitSerial: 0,
    error: null,
  };

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  ring(): void {
    this.snapshot = { ...this.snapshot, bellSerial: this.snapshot.bellSerial + 1 };
    this.listeners.forEach((listener) => listener());
  }

  setTitle(title: string | null): void {
    this.snapshot = { ...this.snapshot, title };
    this.listeners.forEach((listener) => listener());
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

beforeAll(async () => {
  vi.stubGlobal("self", globalThis);
  ({ TerminalSessionManager } = await import("./terminal-session.js"));
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function fixture(maxSessions = 3, idleMs = 1_000) {
  const sessions = new Map<string, FakeSession>();
  const manager = new TerminalSessionManager(maxSessions, idleMs, (terminalId) => {
    const session = new FakeSession();
    sessions.set(terminalId, session);
    return session as unknown as TerminalSession;
  });
  return { manager, sessions };
}

describe("TerminalSessionManager", () => {
  it("evicts the least-recent unselected session over capacity", () => {
    const { manager, sessions } = fixture(2);
    manager.acquire("one");
    manager.release("one");
    manager.acquire("two");
    manager.release("two");
    manager.acquire("three");

    expect(sessions.get("one")?.disposed).toBe(true);
    expect(sessions.get("two")?.disposed).toBe(false);
    expect(sessions.get("three")?.disposed).toBe(false);
  });

  it("disposes an unselected session after the idle timeout", async () => {
    const { manager, sessions } = fixture();
    manager.acquire("one");
    manager.release("one");

    await vi.advanceTimersByTimeAsync(999);
    expect(sessions.get("one")?.disposed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(sessions.get("one")?.disposed).toBe(true);
  });

  it("retains and clears attention from background BEL events", () => {
    const { manager, sessions } = fixture();
    manager.acquire("one");
    manager.release("one");
    sessions.get("one")?.ring();

    expect(manager.getAttentionSnapshot().has("one")).toBe(true);
    manager.acquire("one");
    expect(manager.getAttentionSnapshot().has("one")).toBe(false);
  });

  it("publishes one runtime title snapshot and retains it across LRU eviction", () => {
    const { manager, sessions } = fixture(1);
    manager.acquire("one");
    manager.release("one");
    sessions.get("one")?.setTitle("vim · file.ts");
    expect(manager.getTitleSnapshot().get("one")).toBe("vim · file.ts");

    manager.acquire("two");
    expect(sessions.get("one")?.disposed).toBe(true);
    expect(manager.getTitleSnapshot().get("one")).toBe("vim · file.ts");

    manager.reconcile([{ id: "two" }]);
    expect(manager.getTitleSnapshot().has("one")).toBe(false);
  });

  it("clears a runtime title when the session reports an empty title", () => {
    const { manager, sessions } = fixture();
    manager.acquire("one");
    sessions.get("one")?.setTitle("shell");
    sessions.get("one")?.setTitle("");
    expect(manager.getTitleSnapshot().has("one")).toBe(false);
  });
});
