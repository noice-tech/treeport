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
      path: "/repo",
      branch: "trunk",
      kind: "main",
      tmuxSocketName: "wtr-wt-main",
      status: "active",
      cleanupError: null,
      pr: {
        state: "no_pr",
        number: null,
        url: null,
        baseBranch: null,
        headBranch: null,
        mergedAt: null,
        refreshedAt: null,
      },
      dirty: { dirty: false, staged: 0, unstaged: 0, untracked: 0, total: 0 },
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
      path: "/worktrees/topic",
      branch: "feature/topic",
      kind: "linked",
      tmuxSocketName: "wtr-wt-topic",
      status: "active",
      cleanupError: null,
      pr: {
        state: "merged",
        number: 12,
        url: "https://example.test/pr/12",
        baseBranch: "trunk",
        headBranch: "feature/topic",
        mergedAt: "2026-01-02",
        refreshedAt: "2026-01-02",
      },
      dirty: { dirty: false, staged: 0, unstaged: 0, untracked: 0, total: 0 },
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
      addEventListener() {}
      close() {}
    }
    class MockWebSocket {
      static OPEN = 1;
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) {
        const scope = window as any;
        scope.__wsInstances = [...(scope.__wsInstances || []), this];
        scope.__lastWs = this;
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.();
          this.onmessage?.({
            data: JSON.stringify({ type: "control", controller: false, controllerId: "other" }),
          });
          this.onmessage?.({
            data: JSON.stringify({ type: "output", data: "same persistent Pi session\\r\\n" }),
          });
        }, 10);
      }
      send(data: string) {
        const scope = window as any;
        scope.__wsSent = [...(scope.__wsSent || []), JSON.parse(data)];
        if (JSON.parse(data).type === "take_control") {
          this.onmessage?.({
            data: JSON.stringify({ type: "control", controller: true, controllerId: "me" }),
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
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === "/api/projects" && route.request().method() === "GET") {
      await route.fulfill({ json: { projects: [state] } });
      return;
    }
    if (pathname.endsWith("/finish-preview") || pathname.endsWith("/discard-preview")) {
      const worktree = state.worktrees[1]!;
      await route.fulfill({
        json: {
          preview: {
            worktreeId: worktree.id,
            branch: worktree.branch,
            path: worktree.path,
            pr: worktree.pr,
            gitMerged: true,
            dirty: worktree.dirty,
            eligible: true,
            reasons: [],
            terminals: worktree.terminals.map(({ id, name, status }) => ({ id, name, status })),
            commits: { ahead: 0, behind: 0 },
          },
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
    if (pathname.endsWith("/finish") || pathname.endsWith("/discard")) {
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
}

test.describe("desktop worktree terminal UI", () => {
  test.skip(({ isMobile }) => Boolean(isMobile));

  test("navigates projects, worktrees, and persistent terminal output", async ({ page }) => {
    await mockApp(page);
    await expect(page.getByText("example")).toBeVisible();
    await expect(page.getByText("feature/topic")).toBeVisible();
    await page.locator(".terminal-row").filter({ hasText: "Pi" }).click();
    await expect(page.locator(".xterm")).toBeVisible();
    await expect(page.locator(".xterm-rows")).toContainText("same persistent Pi session");
    await expect(page.locator(".pr-badge")).toContainText("merged");
  });

  test("reconnects and allows a viewer to take control without relaunching", async ({ page }) => {
    await mockApp(page);
    await page.locator(".terminal-row").filter({ hasText: "Pi" }).click();
    await expect(page.getByText("View only")).toBeVisible();
    await page.getByRole("button", { name: "Take control" }).click();
    await expect(page.getByText("Control", { exact: true })).toBeVisible();
    const before = await page.evaluate(() => (window as any).__wsInstances.length);
    await page.evaluate(() => (window as any).__lastWs.onclose());
    await expect
      .poll(() => page.evaluate(() => (window as any).__wsInstances.length))
      .toBeGreaterThan(before);
  });

  test("creates a custom argv terminal", async ({ page }) => {
    await mockApp(page);
    await page.getByRole("button", { name: "Terminal", exact: true }).nth(1).click();
    await page.getByLabel("Display name").fill("Dev server");
    await page.getByLabel("Command").selectOption("custom");
    await page.getByLabel("JSON argv array").fill('["pnpm", "dev", "--literal;$HOME"]');
    await page.getByRole("button", { name: "Create terminal" }).click();
    await expect(page.locator(".terminal-row").filter({ hasText: "Dev server" })).toBeVisible();
  });

  test("shows cleanup facts before finish confirmation", async ({ page }) => {
    await mockApp(page);
    await page.getByRole("button", { name: "Finish", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Finish worktree" })).toBeVisible();
    await expect(page.getByText("/worktrees/topic")).toBeVisible();
    await expect(page.getByText("Pi", { exact: true }).last()).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Finish and terminate terminals" }),
    ).toBeEnabled();
  });
});

test.describe("mobile terminal UI", () => {
  test.skip(({ isMobile }) => !isMobile);

  test("uses the drawer, full terminal, control takeover, and accessory keys", async ({ page }) => {
    await mockApp(page);
    await page.getByLabel("Open worktree drawer").click();
    await expect(page.locator(".sidebar")).toHaveClass(/open/);
    await page.locator(".terminal-row").filter({ hasText: "Pi" }).click();
    await expect(page.locator(".xterm")).toBeVisible();
    await page.getByRole("button", { name: "Take control" }).click();
    await page.getByRole("button", { name: "Esc" }).click();
    await page.getByRole("button", { name: "Arrow up" }).click();
    const sent = await page.evaluate(() => (window as any).__wsSent);
    expect(sent).toEqual(
      expect.arrayContaining([
        { type: "input", data: "\u001b" },
        { type: "input", data: "\u001b[A" },
      ]),
    );
  });
});
