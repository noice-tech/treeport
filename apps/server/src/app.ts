import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import type { Context, MiddlewareHandler } from "hono";
import type { ZodType } from "zod";
import { upgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  cleanupSchema,
  createTerminalSchema,
  createWorktreeSchema,
  discardSchema,
  registerProjectSchema,
  spawnSchema,
  updateTerminalSchema,
} from "@wtr/shared";
import type { AppConfig, TmuxAdapter, WtrService } from "@wtr/core";
import { DomainError } from "@wtr/core";
import { TerminalAttachmentManager } from "./attachments.js";

interface AppDependencies {
  service: WtrService;
  config: AppConfig;
  tmux: TmuxAdapter;
  webDist?: string;
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function input<T>(context: Context, schema: ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    throw new DomainError("INVALID_JSON", "Request body must be valid JSON", 400);
  }
  const result = schema.safeParse(body);
  if (!result.success)
    throw new DomainError(
      "VALIDATION_ERROR",
      "Request validation failed",
      400,
      result.error.flatten(),
    );
  return result.data;
}

export function createApp({ service, config, tmux, webDist }: AppDependencies): Hono {
  const app = new Hono();
  const attachments = new TerminalAttachmentManager(service, tmux, config.tmuxPath);

  const authenticate: MiddlewareHandler = async (context, next) => {
    if (!config.authToken) return next();
    if (context.req.path === "/api/health" || context.req.path === "/api/auth/session")
      return next();
    const authorization = context.req.header("authorization");
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    const cookie = getCookie(context, "wtr_session");
    if (
      (bearer && secureEqual(bearer, config.authToken)) ||
      (cookie && secureEqual(cookie, config.authToken))
    )
      return next();
    return context.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication is required" } },
      401,
    );
  };

  app.use("/api/*", authenticate);

  app.onError((error, context) => {
    if (error instanceof DomainError) {
      return context.json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        },
        error.status as any,
      );
    }
    console.error("[wtr]", error instanceof Error ? error.message : String(error));
    return context.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : "Unexpected server error",
        },
      },
      500,
    );
  });

  app.get("/api/health", (context) => context.json({ ok: true, version: 1 }));
  app.post("/api/auth/session", async (context) => {
    if (!config.authToken) return context.json({ ok: true, authenticationEnabled: false });
    const body = (await context.req.json().catch(() => ({}))) as { token?: unknown };
    if (typeof body.token !== "string" || !secureEqual(body.token, config.authToken)) {
      return context.json(
        { error: { code: "UNAUTHORIZED", message: "Invalid authentication token" } },
        401,
      );
    }
    setCookie(context, "wtr_session", config.authToken, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return context.json({ ok: true, authenticationEnabled: true });
  });
  app.get("/api/diagnostics", async (context) => context.json(await service.diagnostics()));

  app.get("/api/projects", async (context) =>
    context.json({ projects: await service.listProjects() }),
  );
  app.post("/api/projects", async (context) => {
    const body = await input(context, registerProjectSchema);
    return context.json({ project: await service.registerProject(body.path, body.name) }, 201);
  });
  app.get("/api/projects/:projectId", (context) =>
    context.json({ project: service.getProject(context.req.param("projectId")) }),
  );
  app.post("/api/projects/:projectId/refresh", async (context) =>
    context.json({ project: await service.refreshProject(context.req.param("projectId")) }),
  );
  app.delete("/api/projects/:projectId", async (context) => {
    await service.deleteProject(context.req.param("projectId"));
    return context.json({ ok: true });
  });

  app.get("/api/projects/:projectId/worktrees", (context) =>
    context.json({ worktrees: service.getProject(context.req.param("projectId")).worktrees }),
  );
  app.post("/api/projects/:projectId/worktrees", async (context) => {
    const body = await input(context, createWorktreeSchema);
    const initialTerminal = body.initialTerminal
      ? {
          name: body.initialTerminal.name,
          ...(body.initialTerminal.argv ? { argv: body.initialTerminal.argv } : {}),
        }
      : undefined;
    const result = await service.createWorktree(
      context.req.param("projectId"),
      body.branch,
      body.fromCurrent,
      initialTerminal,
      body.sourceWorktreeId,
    );
    return context.json(result, 201);
  });

  app.get("/api/worktrees/:worktreeId", async (context) => {
    const worktreeId = context.req.param("worktreeId");
    await service.refreshPr(worktreeId, false);
    return context.json({ worktree: service.getWorktree(worktreeId) });
  });
  app.post("/api/worktrees/:worktreeId/terminals", async (context) => {
    const body = await input(context, createTerminalSchema);
    const terminal = await service.createTerminal(
      context.req.param("worktreeId"),
      body.name,
      body.argv,
    );
    return context.json({ terminal }, 201);
  });
  app.get("/api/worktrees/:worktreeId/finish-preview", async (context) =>
    context.json({ preview: await service.finishPreflight(context.req.param("worktreeId"), true) }),
  );
  app.get("/api/worktrees/:worktreeId/discard-preview", async (context) =>
    context.json({ preview: await service.discardPreview(context.req.param("worktreeId")) }),
  );
  app.post("/api/worktrees/:worktreeId/finish", async (context) =>
    context.json({ operation: await service.beginFinish(context.req.param("worktreeId")) }, 202),
  );
  app.post("/api/worktrees/:worktreeId/discard", async (context) => {
    const body = await input(context, discardSchema);
    return context.json(
      { operation: await service.beginDiscard(context.req.param("worktreeId"), body.confirm) },
      202,
    );
  });
  app.post("/api/worktrees/:worktreeId/pr/refresh", async (context) =>
    context.json({ pr: await service.refreshPr(context.req.param("worktreeId"), true) }),
  );

  app.get("/api/terminals/:terminalId", async (context) =>
    context.json({
      terminal: await service.refreshTerminalStatus(context.req.param("terminalId")),
    }),
  );
  app.patch("/api/terminals/:terminalId", async (context) => {
    const body = await input(context, updateTerminalSchema);
    return context.json({
      terminal: await service.renameTerminal(context.req.param("terminalId"), body.name),
    });
  });
  app.delete("/api/terminals/:terminalId", async (context) => {
    await service.deleteTerminal(context.req.param("terminalId"));
    return context.json({ ok: true });
  });

  app.post("/api/spawn", async (context) => {
    const body = await input(context, spawnSchema);
    const project = await service.resolveProject(body.project);
    const initialTerminal = { name: body.name, ...(body.argv ? { argv: body.argv } : {}) };
    const result = await service.createWorktree(
      project.id,
      body.branch,
      body.fromCurrent,
      initialTerminal,
      body.sourceWorktreeId,
    );
    return context.json(result, 201);
  });

  app.get("/api/projects/:projectId/cleanup-preview", async (context) =>
    context.json({ previews: await service.cleanupPreview(context.req.param("projectId")) }),
  );
  app.post("/api/projects/:projectId/cleanup", async (context) => {
    const body = await input(context, cleanupSchema);
    if (body.preview)
      return context.json({
        previews: await service.cleanupPreview(context.req.param("projectId")),
      });
    return context.json(
      { operation: await service.beginProjectCleanup(context.req.param("projectId")) },
      202,
    );
  });
  app.get("/api/operations/:operationId", (context) =>
    context.json({ operation: service.getOperation(context.req.param("operationId")) }),
  );

  app.get("/api/events", (context) =>
    streamSSE(context, async (stream) => {
      await stream.writeSSE({
        event: "connected",
        data: JSON.stringify({ at: new Date().toISOString() }),
      });
      const unsubscribe = service.events.subscribe((event) => {
        void stream.writeSSE({ id: event.id, event: event.type, data: JSON.stringify(event) });
      });
      const heartbeat = setInterval(
        () => void stream.writeSSE({ event: "heartbeat", data: "{}" }),
        15_000,
      );
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
      clearInterval(heartbeat);
      unsubscribe();
    }),
  );

  app.get(
    "/api/terminals/:terminalId/attach",
    upgradeWebSocket((context) => {
      const terminalId = context.req.param("terminalId")!;
      let connectionId: string | null = null;
      let closed = false;
      return {
        onOpen(_event, ws) {
          void attachments
            .open(terminalId, ws)
            .then((idValue) => {
              if (closed) attachments.close(idValue);
              else connectionId = idValue;
            })
            .catch((error: unknown) => {
              if (closed) return;
              try {
                ws.send(
                  JSON.stringify({
                    type: "error",
                    message: error instanceof Error ? error.message : String(error),
                  }),
                );
                ws.close();
              } catch {
                closed = true;
              }
            });
        },
        onMessage(event) {
          if (connectionId) attachments.message(connectionId, event.data);
        },
        onClose() {
          closed = true;
          if (connectionId) attachments.close(connectionId);
        },
        onError() {
          closed = true;
          if (connectionId) attachments.close(connectionId);
        },
      };
    }),
  );

  const staticRoot =
    webDist ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  app.use("/assets/*", serveStatic({ root: staticRoot }));
  app.get("/manifest.webmanifest", serveStatic({ root: staticRoot, path: "manifest.webmanifest" }));
  app.get("/sw.js", serveStatic({ root: staticRoot, path: "sw.js" }));
  app.get("*", serveStatic({ root: staticRoot, path: "index.html" }));

  return app;
}
