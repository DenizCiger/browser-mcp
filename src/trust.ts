// What may be filled without asking. Two sources:
//  - exact-host match: the Bitwarden item has a URL on exactly this host (see login.ts);
//  - "always allow" choices the user made in the dialog, stored per host + item.
// BROWSER_MCP_CONFIRM=always turns both off and asks every time.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const FILE = join(process.env.BROWSER_MCP_PROFILE ?? join(homedir(), ".local/share/browser-mcp/profile"), "..", "trust.json");

export const alwaysAsk = process.env.BROWSER_MCP_CONFIRM === "always";

const key = (host: string, itemId: string) => `${host}|${itemId}`;

function load(): Record<string, { name: string; at: string }> {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

export function isTrusted(host: string, itemId: string): boolean {
  return !alwaysAsk && key(host, itemId) in load();
}

export function trust(host: string, itemId: string, itemName: string): void {
  const all = load();
  all[key(host, itemId)] = { name: itemName, at: new Date().toISOString() };
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
}
