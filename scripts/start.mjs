#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(root, "apps", "server", "dist", "index.js");
if (!fs.existsSync(serverEntry)) {
  console.error("TaskTTY is not built. Run `pnpm build` first.");
  process.exit(1);
}

const host = process.env.TASKTTY_HOST?.trim() || "0.0.0.0";
const port = process.env.TASKTTY_PORT?.trim() || "4780";
const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
const generatedToken = !loopback && !process.env.TASKTTY_AUTH_TOKEN?.trim();
const authToken =
  process.env.TASKTTY_AUTH_TOKEN?.trim() ||
  (generatedToken ? crypto.randomBytes(32).toString("base64url") : "");

console.log(`TaskTTY network listener: http://${host}:${port}`);
if (generatedToken) {
  console.log("Generated authentication token (enter this in the browser):");
  console.log(authToken);
} else {
  console.log(`authentication: ${authToken ? "enabled" : "disabled (loopback only)"}`);
}
if (!loopback)
  console.warn("LAN access enabled. Do not expose this port directly to the public internet.");

const child = spawn(process.execPath, [serverEntry], {
  cwd: root,
  env: {
    ...process.env,
    TASKTTY_HOST: host,
    TASKTTY_PORT: port,
    TASKTTY_AUTH_TOKEN: authToken,
    TASKTTY_API_URL: process.env.TASKTTY_API_URL?.trim() || `http://127.0.0.1:${port}`,
  },
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.once("error", (error) => {
  console.error(`Failed to start TaskTTY: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
