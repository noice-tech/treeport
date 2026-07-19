#!/usr/bin/env node
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import type { LaunchSpec } from "./tmux.js";

const specPath = process.argv[2];
if (!specPath) {
  process.stderr.write("wtr launcher: missing launch spec\n");
  process.exit(127);
}

let spec: LaunchSpec;
try {
  spec = JSON.parse(await fs.readFile(specPath, "utf8")) as LaunchSpec;
} catch (error) {
  process.stderr.write(
    `wtr launcher: cannot read launch spec: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(127);
}

const [executable, ...args] = spec.argv;
if (!executable) {
  process.stderr.write("wtr launcher: argv is empty\n");
  process.exit(127);
}

const child = spawn(executable, args, {
  cwd: spec.cwd,
  env: { ...process.env, ...spec.env },
  stdio: "inherit",
  shell: false,
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  process.stderr.write(`wtr launcher: ${error.message}\n`);
  process.exit(127);
});
child.once("exit", (code) => {
  process.exit(code ?? 1);
});
