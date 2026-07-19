export function extractJsonOutput(args: string[]): boolean {
  const separator = args.indexOf("--");
  const index = args.findIndex(
    (value, valueIndex) => value === "--json" && (separator === -1 || valueIndex < separator),
  );
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}
