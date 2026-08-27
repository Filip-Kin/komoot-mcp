/** Minimal stderr logger. Never log secrets, tokens, or the code_verifier. */
export function log(...parts: unknown[]): void {
  process.stderr.write(`[komoot-mcp] ${parts.map(String).join(" ")}\n`);
}
