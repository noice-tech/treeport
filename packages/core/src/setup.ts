export interface WorktreeSetupTask {
  label: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}
