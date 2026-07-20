import { expect, test, type Page } from "@playwright/test";

const project = {
  id: "proj_1",
  name: "example",
  repositoryPath: "/repo",
  mainWorktreePath: "/repo",
  defaultBranch: "trunk",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  worktrees: [
    {
      id: "wt_main",
      projectId: "proj_1",
      name: "main worktree",
      path: "/repo",
      head: "aaaaaaaa",
      branch: "trunk",
      detached: false,
      locked: false,
      lockReason: null,
      kind: "main",
      tmuxSocketName: "wtr-wt-main",
      status: "active",
      cleanupError: null,
      managedWrapperPath: null,
      pr: {
        state: "no_pr",
        number: null,
        url: null,
        baseBranch: null,
        headBranch: null,
        mergedAt: null,
        refreshedAt: null,
      },
      dirty: { dirty: false, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, total: 0 },
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      terminals: [
        {
          id: "term_shell",
          worktreeId: "wt_main",
          name: "Shell",
          tmuxSessionName: "wtr-term-shell",
          argv: ["/bin/zsh", "-l"],
          status: "running",
          exitCode: null,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        },
      ],
    },
    {
      id: "wt_topic",
      projectId: "proj_1",
      name: "topic",
      path: "/worktrees/topic",
      head: "bbbbbbbb",
      branch: "feature/topic",
      detached: false,
      locked: false,
      lockReason: null,
      kind: "linked",
      tmuxSocketName: "wtr-wt-topic",
      status: "active",
      cleanupError: null,
      managedWrapperPath: null,
      pr: {
        state: "merged",
        number: 12,
        url: "https://example.test/pr/12",
        baseBranch: "trunk",
        headBranch: "feature/topic",
        mergedAt: "2026-01-02",
        refreshedAt: "2026-01-02",
      },
      dirty: { dirty: false, staged: 0, unstaged: 0, untracked: 0, conflicts: 0, total: 0 },
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      terminals: [
        {
          id: "term_pi",
          worktreeId: "wt_topic",
          name: "Pi",
          tmuxSessionName: "wtr-term-pi",
          argv: ["pi"],
          status: "running",
          exitCode: null,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        },
      ],
    },
  ],
};

async function mockApp(page: Page) {
  await page.addInitScript(() => {
    class MockEventSource {
      listeners = new Map<string, Array<() => void>>();
      constructor() {
        const scope = window as any;
        scope.__eventSource = this;
        setTimeout(() => this.emit("connected"), 0);
      }
      addEventListener(name: string, listener: () => void) {
        this.listeners.set(name, [...(this.listeners.get(name) || []), listener]);
      }
      emit(name: string) {
        this.listeners.get(name)?.forEach((listener) => listener());
      }
      close() {}
    }
    class MockWebSocket {
      static OPEN = 1;
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      clientId = "";
      readonly streamId = crypto.randomUUID();
      constructor(public url: string) {
        const scope = window as any;
        scope.__controllerClientId ||= "other";
        scope.__wsInstances = [...(scope.__wsInstances || []), this];
        scope.__lastWs = this;
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.();
        }, 10);
      }
      send(data: string) {
        const scope = window as any;
        const message = JSON.parse(data);
        scope.__wsSent = [...(scope.__wsSent || []), message];
        if (message.type === "hello") {
          this.clientId = message.clientId;
          const controller = scope.__controllerClientId === this.clientId;
          this.onmessage?.({
            data: JSON.stringify({
              version: 1,
              type: "ready",
              connectionId: crypto.randomUUID(),
              streamId: this.streamId,
              controller,
              reset: "full",
              heartbeatMs: 15000,
            }),
          });
          this.onmessage?.({
            data: JSON.stringify({
              version: 1,
              type: "output",
              streamId: this.streamId,
              sequence: 1,
              data: "same persistent terminal session\\r\\n",
            }),
          });
          if (!scope.__suppressInitialTitle) {
            this.onmessage?.({
              data: JSON.stringify({
                version: 1,
                type: "title",
                title: this.url.includes("term_dev")
                  ? "dev · /worktrees/topic"
                  : "zsh · /worktrees/topic",
              }),
            });
          }
        }
        if (message.type === "take_control") {
          scope.__controllerClientId = this.clientId;
          this.onmessage?.({
            data: JSON.stringify({
              version: 1,
              type: "control",
              controller: true,
            }),
          });
        }
      }
      close() {
        this.readyState = 3;
        this.onclose?.();
      }
    }
    Object.assign(window, { EventSource: MockEventSource, WebSocket: MockWebSocket });
  });
  const state = structuredClone(project);
  let projectRequests = 0;
  let removePreviewRequests = 0;
  let removePreviewDelayMs = 0;
  let removePreviewOverride: Record<string, unknown> = {};
  let staleRemoveToken: string | null = null;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === "/api/projects" && route.request().method() === "GET") {
      projectRequests += 1;
      await route.fulfill({ json: { projects: [state] } });
      return;
    }
    if (pathname.endsWith("/remove-preview")) {
      removePreviewRequests += 1;
      if (removePreviewDelayMs)
        await new Promise((resolve) => setTimeout(resolve, removePreviewDelayMs));
      const worktree = state.worktrees[1]!;
      await route.fulfill({
        json: {
          preview: {
            worktreeId: worktree.id,
            name: worktree.name,
            branch: worktree.branch,
            path: worktree.path,
            head: worktree.head,
            detached: worktree.detached,
            locked: false,
            lockReason: null,
            dirty: worktree.dirty,
            detachedHeadReachable: null,
            forceRequired: false,
            eligible: true,
            reasons: [],
            warnings: [],
            terminals: worktree.terminals.map(({ id, name, status }) => ({ id, name, status })),
            confirmationToken: "a".repeat(64),
            ...removePreviewOverride,
          },
        },
      });
      return;
    }
    if (pathname.endsWith("/worktree-destination")) {
      await route.fulfill({
        json: {
          destination: {
            name: url.searchParams.get("name"),
            path: `/worktrees/${url.searchParams.get("name")}/repo`,
          },
        },
      });
      return;
    }
    if (pathname === "/api/projects/proj_1/worktrees" && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as {
        name: string;
        base: "default" | "current";
        sourceWorktreeId?: string;
      };
      await route.fulfill({
        status: 201,
        json: {
          worktree: { ...state.worktrees[1], id: "wt_new", name: body.name },
          terminal: null,
          terminalError: null,
          setupError: null,
        },
      });
      return;
    }
    if (pathname === "/api/worktrees/wt_topic/terminals" && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { name: string; argv?: string[] };
      const terminal = {
        id: "term_dev",
        worktreeId: "wt_topic",
        name: body.name,
        tmuxSessionName: "wtr-term-dev",
        argv: body.argv || ["/bin/zsh", "-l"],
        status: "running",
        exitCode: null,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      };
      state.worktrees[1]!.terminals.push(terminal);
      await route.fulfill({ status: 201, json: { terminal } });
      return;
    }
    if (pathname.startsWith("/api/terminals/") && route.request().method() === "DELETE") {
      const terminalId = pathname.split("/").at(-1);
      for (const worktree of state.worktrees) {
        worktree.terminals = worktree.terminals.filter((terminal) => terminal.id !== terminalId);
      }
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (pathname.endsWith("/remove")) {
      if (staleRemoveToken) {
        removePreviewOverride = { ...removePreviewOverride, confirmationToken: staleRemoveToken };
        staleRemoveToken = null;
        await route.fulfill({
          status: 409,
          json: {
            error: {
              code: "REMOVE_PREVIEW_STALE",
              message: "The worktree changed after the removal preview; review it again",
            },
          },
        });
        return;
      }
      await route.fulfill({ status: 202, json: { operation: { id: "op_1", status: "pending" } } });
      return;
    }
    if (pathname.endsWith("/pr/refresh")) {
      await route.fulfill({ json: { pr: state.worktrees[1]!.pr } });
      return;
    }
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  return {
    state,
    projectRequests: () => projectRequests,
    removePreviewRequests: () => removePreviewRequests,
    setRemovePreview: (value: Record<string, unknown>) => {
      removePreviewOverride = value;
    },
    setRemovePreviewDelay: (value: number) => {
      removePreviewDelayMs = value;
    },
    staleNextRemoveWithToken: (value: string) => {
      staleRemoveToken = value;
    },
  };
}

test.describe("desktop worktree terminal UI", () => {
  test.skip(({ isMobile }) => Boolean(isMobile));

  test("navigates projects, worktrees, and persistent terminal output", async ({ page }) => {
    await mockApp(page);
    await expect(page.getByText("example")).toBeVisible();
    await expect(page.getByText("topic", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "example", exact: true }).click();
    await expect(page.getByText("topic", { exact: true })).toBeHidden();
    await page.getByRole("button", { name: "example", exact: true }).click();
    await page.getByRole("button", { name: "Pi running", exact: true }).click();
    await expect(page.locator(".xterm")).toBeVisible();
    await expect(page.locator(".xterm-rows")).toContainText("same persistent terminal session");
    await expect(page.getByRole("tab", { name: /zsh · \/worktrees\/topic/ })).toHaveAttribute(
      "data-state",
      "active",
    );
    await expect(
      page.getByRole("button", { name: "zsh · /worktrees/topic running", exact: true }).last(),
    ).toBeVisible();
    await expect(page.locator('select[name="terminal-selector"] option:checked')).toHaveText(
      "zsh · /worktrees/topic",
    );
    await expect(page.locator(".pr-badge")).toHaveCount(0);
  });

  test("synchronizes fallback, runtime, and cleared titles across every desktop consumer", async ({
    page,
  }) => {
    await mockApp(page);
    await page.evaluate(() => ((window as any).__suppressInitialTitle = true));
    await page.getByRole("button", { name: "Pi running", exact: true }).click();

    await expect(page.getByRole("tab", { name: "Pi, running" })).toBeVisible();
    await expect(page.locator('main[aria-label="Pi terminal"]')).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Pi running", exact: true }).last(),
    ).toBeVisible();

    await page.evaluate(() => {
      const socket = (window as any).__wsInstances.find((item: any) =>
        item.url.includes("term_pi"),
      );
      socket.onmessage?.({
        data: JSON.stringify({ version: 1, type: "title", title: "runtime · /repo" }),
      });
    });
    await expect(page.getByRole("tab", { name: "runtime · /repo, running" })).toBeVisible();
    await expect(page.locator('main[aria-label="runtime · /repo terminal"]')).toBeVisible();
    await expect(
      page.getByRole("button", { name: "runtime · /repo running", exact: true }).last(),
    ).toBeVisible();
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("runtime · /repo");
      await dialog.dismiss();
    });
    await page.getByRole("button", { name: "Close runtime · /repo" }).click();

    await page.evaluate(() => {
      const socket = (window as any).__wsInstances.find((item: any) =>
        item.url.includes("term_pi"),
      );
      socket.onmessage?.({ data: JSON.stringify({ version: 1, type: "title", title: "" }) });
    });
    await expect(page.getByRole("tab", { name: "Pi, running" })).toBeVisible();
    await expect(page.locator('main[aria-label="Pi terminal"]')).toBeVisible();
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("Pi");
      await dialog.dismiss();
    });
    await page.getByRole("button", { name: "Close Pi" }).click();
  });

  test("traps modal focus, closes on Escape, and restores its trigger", async ({ page }) => {
    await mockApp(page);
    const trigger = page.getByRole("button", { name: "New worktree" });
    await trigger.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Worktree name").fill("focus-test");
    const submit = dialog.getByRole("button", { name: "Create worktree" });
    await expect(submit).toBeEnabled();
    await submit.focus();
    await submit.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("refreshes the metadata snapshot whenever SSE reconnects", async ({ page }) => {
    const mocked = await mockApp(page);
    await expect(page.getByText("example")).toBeVisible();
    await expect.poll(() => mocked.projectRequests()).toBeGreaterThan(1);
    await page.waitForTimeout(150);
    const before = mocked.projectRequests();
    await page.evaluate(() => (window as any).__eventSource.emit("connected"));
    await expect.poll(() => mocked.projectRequests()).toBeGreaterThan(before);
  });

  test("reconnects and allows a viewer to take control without relaunching", async ({ page }) => {
    await mockApp(page);
    await page.getByRole("button", { name: "Pi running", exact: true }).click();
    await expect(page.getByRole("button", { name: "Take control" })).toBeVisible();
    await page.getByRole("button", { name: "Take control" }).click();
    await expect(page.getByRole("button", { name: "Take control" })).toHaveCount(0);
    const before = await page.evaluate(() => (window as any).__wsInstances.length);
    await page.evaluate(() => (window as any).__lastWs.onclose());
    await expect
      .poll(() => page.evaluate(() => (window as any).__wsInstances.length))
      .toBeGreaterThan(before);
  });

  test("does not automatically retry a fatal terminal error", async ({ page }) => {
    await mockApp(page);
    await page.getByRole("button", { name: "Pi running", exact: true }).click();
    await expect(page.getByRole("button", { name: "Take control" })).toBeVisible();
    await page.evaluate(() => {
      const socket = (window as any).__lastWs;
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: "error",
          code: "ATTACH_FAILED",
          message: "Terminal unavailable",
          retryable: false,
        }),
      });
      socket.close();
    });
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    const before = await page.evaluate(() => (window as any).__wsInstances.length);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForTimeout(750);
    expect(await page.evaluate(() => (window as any).__wsInstances.length)).toBe(before);
    await page.getByRole("button", { name: "Retry" }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).__wsInstances.length))
      .toBeGreaterThan(before);
  });

  test("surfaces BEL attention from a retained background terminal", async ({ page }) => {
    await mockApp(page);
    await page.getByRole("button", { name: "Pi running", exact: true }).click();
    await expect(page.getByRole("tab", { name: /zsh · \/worktrees\/topic/ })).toBeVisible();
    await page.getByRole("button", { name: "New terminal" }).click();
    await expect(page.getByRole("tab", { name: /dev · \/worktrees\/topic/ })).toHaveAttribute(
      "data-state",
      "active",
    );
    await page.evaluate(() => {
      const socket = (window as any).__wsInstances.find((item: any) =>
        item.url.includes("term_pi"),
      );
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: "output",
          streamId: socket.streamId,
          sequence: 2,
          data: "\u0007",
        }),
      });
    });
    const piTab = page.getByRole("tab", { name: /zsh · \/worktrees\/topic.*bell/ });
    await expect(piTab).toBeVisible();
    await piTab.click();
    await expect(page.getByRole("tab", { name: /zsh · \/worktrees\/topic.*bell/ })).toHaveCount(0);
  });

  test("creates and selects a login shell terminal without prompting", async ({ page }) => {
    await mockApp(page);
    await page.locator(".worktree-row").filter({ hasText: "topic" }).click();
    await expect(page.getByRole("button", { name: "Terminal", exact: true })).toHaveCount(0);
    const requestPromise = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/worktrees/wt_topic/terminals",
    );
    await page.getByRole("button", { name: "New terminal" }).click();
    const request = await requestPromise;
    expect(request.postDataJSON()).toEqual({ name: "Terminal" });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".terminal-row.selected")).toBeVisible();

    await expect(page.getByRole("tab", { name: /^dev · \/worktrees\/topic,/ })).toBeVisible();
    const socketsBeforeSwitch = await page.evaluate(() => (window as any).__wsInstances.length);
    await page.getByRole("tab", { name: /^zsh · \/worktrees\/topic,/ }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).__wsInstances.length))
      .toBe(socketsBeforeSwitch);
    await expect(page.getByRole("tab", { name: /^dev · \/worktrees\/topic,/ })).toBeVisible();

    const terminalId = "term_dev";
    page.once("dialog", (dialog) => dialog.accept());
    const closeRequest = page.waitForRequest(
      (request) =>
        request.method() === "DELETE" &&
        new URL(request.url()).pathname === `/api/terminals/${terminalId}`,
    );
    await page.getByRole("button", { name: /^Close dev · \/worktrees\/topic$/ }).click();
    await closeRequest;
    await expect(page.getByRole("tab", { name: /^dev · \/worktrees\/topic,/ })).toHaveCount(0);
  });

  test("routes wheel scrolling through tmux mouse mode instead of arrow keys", async ({ page }) => {
    await mockApp(page);
    await page.getByRole("button", { name: "Pi running", exact: true }).click();
    await page.getByRole("button", { name: "Take control" }).click();
    await page.evaluate(() => {
      const socket = (window as any).__lastWs;
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: "output",
          streamId: socket.streamId,
          sequence: 2,
          data: "\u001b[?1000h\u001b[?1006h",
        }),
      });
      (window as any).__wsSent = [];
    });
    await page.locator(".xterm-screen").dispatchEvent("wheel", { deltaY: -120 });
    await expect
      .poll(() => page.evaluate(() => (window as any).__wsSent))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: expect.stringMatching(/input|binary/) }),
        ]),
      );
    const sent = await page.evaluate(() => (window as any).__wsSent);
    expect(sent.some((message: any) => message.data === "\u001b[A")).toBe(false);
    expect(sent.some((message: any) => String(message.data).includes("\u001b[<"))).toBe(true);
  });

  test("resizes the sidebar with an accessible panel handle", async ({ page }) => {
    await mockApp(page);
    const separator = page.getByRole("separator", { name: "Resize sidebar" });
    await expect(separator).toHaveAttribute("aria-valuenow", "272");
    await separator.press("ArrowRight");
    await expect(separator).toHaveAttribute("aria-valuenow", "288");
  });

  test("uses one removal action, live preview state, and places New worktree last", async ({
    page,
  }) => {
    const mocked = await mockApp(page);
    await expect(page.getByRole("button", { name: "Diagnostics" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Clean merged/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Finish" })).toHaveCount(0);
    const projectList = page.locator(".project-tree ul").first();
    await expect(projectList.locator(":scope > li").last()).toContainText("New worktree");

    mocked.setRemovePreview({
      branch: null,
      detached: true,
      head: "cccccccc",
      detachedHeadReachable: false,
      warnings: ["Detached commits may become unreachable after removal"],
      confirmationToken: "b".repeat(64),
    });
    await page.locator(".worktree-row").filter({ hasText: "topic" }).hover();
    await page.getByRole("button", { name: "Remove topic" }).click();
    await expect(page.getByRole("heading", { name: "Remove worktree" })).toBeVisible();
    await expect(page.getByText("/worktrees/topic", { exact: true })).toBeVisible();
    await expect(page.getByText("Detached at cccccccc")).toBeVisible();
    await expect(page.getByText("Pi", { exact: true }).last()).toBeVisible();
    const removeRequest = page.waitForRequest(
      (request) =>
        request.method() === "POST" && new URL(request.url()).pathname.endsWith("/remove"),
    );
    await page.getByRole("button", { name: "Remove anyway" }).click();
    expect((await removeRequest).postDataJSON()).toEqual({
      confirmationToken: "b".repeat(64),
      confirmDestructive: true,
    });
  });

  test("requires a fresh removal preview and refreshes stale confirmations in place", async ({
    page,
  }) => {
    const mocked = await mockApp(page);
    const openRemove = async () => {
      await page.locator(".worktree-row").filter({ hasText: "topic" }).hover();
      await page.getByRole("button", { name: "Remove topic" }).click();
    };

    await openRemove();
    await expect(page.getByRole("button", { name: "Remove worktree" })).toBeEnabled();
    await page.getByRole("button", { name: "Close", exact: true }).click();

    mocked.setRemovePreviewDelay(250);
    const previewsBeforeReopen = mocked.removePreviewRequests();
    await openRemove();
    await expect(page.getByRole("button", { name: "Remove worktree" })).toBeDisabled();
    await expect.poll(() => mocked.removePreviewRequests()).toBeGreaterThan(previewsBeforeReopen);
    await expect(page.getByRole("button", { name: "Remove worktree" })).toBeEnabled();
    mocked.setRemovePreviewDelay(0);

    const previewsBeforeStale = mocked.removePreviewRequests();
    mocked.staleNextRemoveWithToken("c".repeat(64));
    await page.getByRole("button", { name: "Remove worktree" }).click();
    await expect.poll(() => mocked.removePreviewRequests()).toBeGreaterThan(previewsBeforeStale);
    await expect(page.getByRole("heading", { name: "Remove worktree" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove worktree" })).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("creates a named detached worktree from the default branch", async ({ page }) => {
    await mockApp(page);
    await page.getByRole("button", { name: "New worktree" }).click();
    await page.getByLabel("Worktree name").fill("new topic");
    await expect(page.getByText("Destination: /worktrees/new topic/repo")).toBeVisible();
    const requestPromise = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/projects/proj_1/worktrees",
    );
    await page.getByRole("button", { name: "Create worktree" }).click();
    const request = await requestPromise;
    expect(request.postDataJSON()).toEqual({ name: "new topic", base: "default" });
  });
});

test.describe("mobile terminal UI", () => {
  test.skip(({ isMobile }) => !isMobile);

  test("closes only a nested modal on Escape and restores its drawer trigger", async ({ page }) => {
    await mockApp(page);
    const drawer = page.locator(".sidebar");
    await page.getByLabel("Open worktree drawer").click();
    const trigger = page.getByRole("button", { name: "New worktree" });
    await trigger.click();
    await expect(page.getByRole("dialog")).toHaveCount(2);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "Create worktree" })).toHaveCount(0);
    await expect(drawer).toHaveClass(/open/);
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(drawer).not.toHaveClass(/open/);
  });

  test("makes sync controls inert while the mobile drawer is open", async ({ page }) => {
    await mockApp(page);
    await page.evaluate(() => (window as any).__eventSource.emit("error"));
    const status = page.locator('[role="status"]');
    await expect(status).toBeVisible({ timeout: 5_000 });
    await page.getByLabel("Open worktree drawer").click();
    await expect(status).toHaveAttribute("inert", "");
    await expect(status).toHaveAttribute("aria-hidden", "true");
  });

  test("uses an accessible drawer, synchronized titles, control takeover, and accessory keys", async ({
    page,
  }) => {
    await mockApp(page);
    const drawer = page.locator(".sidebar");
    const trigger = page.getByLabel("Open worktree drawer");
    await expect(drawer).toHaveAttribute("inert", "");
    await trigger.click();
    await expect(drawer).toHaveClass(/open/);
    await expect(drawer).not.toHaveAttribute("inert", "");
    await expect(page.getByLabel("Close drawer")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveAttribute("inert", "");
    await expect(trigger).toBeFocused();

    await trigger.click();
    await page.getByRole("button", { name: "Pi running", exact: true }).click();
    await expect(page.locator(".xterm")).toBeVisible();
    await expect(page.locator('select[name="terminal-selector"] option:checked')).toHaveText(
      "zsh · /worktrees/topic",
    );
    await page.evaluate(() => {
      const socket = (window as any).__wsInstances.find((item: any) =>
        item.url.includes("term_pi"),
      );
      socket.onmessage?.({ data: JSON.stringify({ version: 1, type: "title", title: "" }) });
    });
    await expect(page.locator('select[name="terminal-selector"] option:checked')).toHaveText("Pi");
    await page.getByRole("button", { name: "Take control" }).click();
    await page.getByRole("button", { name: "Esc" }).click();
    await page.evaluate(() => {
      const socket = (window as any).__lastWs;
      socket.onmessage?.({
        data: JSON.stringify({
          version: 1,
          type: "output",
          streamId: socket.streamId,
          sequence: 2,
          data: "\u001b[?1h",
        }),
      });
    });
    await page.waitForTimeout(50);
    await page.getByRole("button", { name: "Arrow up" }).click();
    const sent = await page.evaluate(() => (window as any).__wsSent);
    expect(sent).toEqual(
      expect.arrayContaining([
        { version: 1, type: "input", data: "\u001b" },
        { version: 1, type: "input", data: "\u001bOA" },
      ]),
    );
  });
});
