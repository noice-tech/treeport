import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface CommandRequest {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunner {
  run(request: CommandRequest): Promise<CommandResult>;
}

export class ExternalCommandError extends Error {
  constructor(
    message: string,
    readonly request: CommandRequest,
    readonly result: CommandResult,
  ) {
    super(message);
    this.name = "ExternalCommandError";
  }
}

export class SpawnCommandRunner implements CommandRunner {
  run(request: CommandRequest): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: request.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      const timer = request.timeoutMs
        ? setTimeout(() => {
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
          }, request.timeoutMs)
        : null;
      timer?.unref();
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: code ?? 1,
        });
      });
      if (request.stdin !== undefined) child.stdin.end(request.stdin);
      else child.stdin.end();
    });
  }
}

export async function runChecked(
  runner: CommandRunner,
  request: CommandRequest,
): Promise<CommandResult> {
  const result = await runner.run(request);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    throw new ExternalCommandError(
      `${request.executable} ${request.args[0] ?? ""} failed: ${detail}`,
      request,
      result,
    );
  }
  return result;
}

export function resolveExecutablePath(
  executable: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (path.isAbsolute(executable) || executable.includes(path.sep)) return executable;
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, executable);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH without invoking a shell.
    }
  }
  return executable;
}

export async function commandAvailable(
  runner: CommandRunner,
  executable: string,
  args: string[],
): Promise<{ available: boolean; version: string | null }> {
  try {
    const result = await runner.run({ executable, args, timeoutMs: 5_000 });
    const output = `${result.stdout}\n${result.stderr}`.trim().split("\n")[0]?.trim() || null;
    return { available: result.exitCode === 0, version: output };
  } catch {
    return { available: false, version: null };
  }
}
