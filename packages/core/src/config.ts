import os from "node:os";
import path from "node:path";

export interface AppConfig {
  host: string;
  port: number;
  authToken: string | null;
  databasePath: string;
  dataDir: string;
  runtimeDir: string;
  shell: string;
  tmuxPath: string;
  gitPath: string;
  ghPath: string;
  apiUrl: string;
}

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function defaultDataDir(env: NodeJS.ProcessEnv, platform = process.platform): string {
  if (env.XDG_DATA_HOME) return path.join(expandHome(env.XDG_DATA_HOME), "wtr");
  if (platform === "darwin")
    return path.join(os.homedir(), "Library", "Application Support", "wtr");
  return path.join(os.homedir(), ".local", "share", "wtr");
}

function defaultRuntimeDir(env: NodeJS.ProcessEnv): string {
  if (env.XDG_RUNTIME_DIR) return path.join(expandHome(env.XDG_RUNTIME_DIR), "wtr");
  return path.join(
    os.tmpdir(),
    `wtr-${typeof process.getuid === "function" ? process.getuid() : "user"}`,
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const host = env.WTR_HOST?.trim() || "127.0.0.1";
  const portValue = Number.parseInt(env.WTR_PORT || "4780", 10);
  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65_535) {
    throw new Error("WTR_PORT must be an integer between 1 and 65535");
  }
  const dataDir = path.resolve(expandHome(env.WTR_DATA_DIR || defaultDataDir(env)));
  const runtimeDir = path.resolve(expandHome(env.WTR_RUNTIME_DIR || defaultRuntimeDir(env)));
  const authToken = env.WTR_AUTH_TOKEN?.trim() || null;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost" && !authToken) {
    throw new Error("Refusing to bind a non-loopback address without WTR_AUTH_TOKEN");
  }
  return {
    host,
    port: portValue,
    authToken,
    dataDir,
    runtimeDir,
    databasePath: path.resolve(expandHome(env.WTR_DATABASE_PATH || path.join(dataDir, "wtr.db"))),
    shell: path.resolve(expandHome(env.WTR_SHELL || env.SHELL || "/bin/sh")),
    tmuxPath: env.WTR_TMUX_PATH?.trim() || "tmux",
    gitPath: env.WTR_GIT_PATH?.trim() || "git",
    ghPath: env.WTR_GH_PATH?.trim() || "gh",
    apiUrl: env.WTR_API_URL?.trim() || `http://${host}:${portValue}`,
  };
}
