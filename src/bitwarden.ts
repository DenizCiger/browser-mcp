// Bitwarden access through the `bw` CLI.
//
// Secrets read here (passwords, TOTP codes, the master password) stay inside this
// process: they are typed into the page by Playwright and never returned to the
// agent. The master password is entered once by the user into a local zenity dialog
// and then kept in the Secret Service keyring (gnome-keyring / KWallet), together
// with the current session key. That lets browser-mcp unlock the vault on its own,
// also after a reboot or `bw lock`.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { askPassword } from "./dialog.ts";

const run = promisify(execFile);
const BW = process.env.BROWSER_MCP_BW ?? "bw";

export interface LoginItem {
  id: string;
  name: string;
  username: string | null;
  uris: string[];
  hasTotp: boolean;
}

interface RawItem {
  id: string;
  name: string;
  type: number;
  login?: {
    username?: string | null;
    password?: string | null;
    totp?: string | null;
    uris?: { uri?: string | null }[] | null;
  };
}

async function bw(args: string[], session?: string, extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, BW_NOINTERACTION: "true" };
  if (session) env.BW_SESSION = session;
  const { stdout } = await run(BW, args, { env, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

type KeyringKey = "bw-session" | "bw-master";
const LABELS: Record<KeyringKey, string> = {
  "bw-session": "browser-mcp: Bitwarden session key",
  "bw-master": "browser-mcp: Bitwarden master password",
};

async function keyringGet(key: KeyringKey): Promise<string | undefined> {
  try {
    const { stdout } = await run("secret-tool", ["lookup", "service", "browser-mcp", "key", key]);
    return stdout.replace(/\n$/, "") || undefined;
  } catch {
    return undefined;
  }
}

async function keyringSet(key: KeyringKey, value: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      "secret-tool",
      ["store", `--label=${LABELS[key]}`, "service", "browser-mcp", "key", key],
      (err) => (err ? reject(err) : resolve()),
    );
    child.stdin?.end(value);
  });
}

async function keyringClear(key: KeyringKey): Promise<void> {
  await run("secret-tool", ["clear", "service", "browser-mcp", "key", key]).catch(() => undefined);
}

async function unlockWith(password: string): Promise<string | undefined> {
  try {
    return await bw(["unlock", "--raw", "--passwordenv", "BROWSER_MCP_BW_PW"], undefined, {
      BROWSER_MCP_BW_PW: password,
    });
  } catch {
    return undefined;
  }
}

async function status(session?: string): Promise<string> {
  const out = await bw(["status"], session);
  return (JSON.parse(out) as { status: string }).status;
}

let session: string | undefined;

/** Returns a valid session key, unlocking the vault via a local dialog if needed. */
export async function ensureUnlocked(): Promise<string> {
  // 1. A session key that is still valid (this process, env, or shared via keyring
  //    with the other browser-mcp processes, so they don't invalidate each other).
  for (const candidate of [session, process.env.BW_SESSION, await keyringGet("bw-session")]) {
    if (candidate && (await status(candidate)) === "unlocked") {
      session = candidate;
      return candidate;
    }
  }
  if ((await status()) === "unauthenticated") {
    throw new Error("Bitwarden CLI is not logged in. The user has to run `bw login` once.");
  }

  // 2. Unlock with the master password stored in the keyring.
  let key: string | undefined;
  const stored = await keyringGet("bw-master");
  if (stored) {
    key = await unlockWith(stored);
    if (!key) await keyringClear("bw-master"); // master password changed
  }

  // 3. Ask the user once, in a local dialog, and remember it in the keyring.
  if (!key) {
    const password = await askPassword(
      "browser-mcp: Bitwarden entsperren",
      "Bitwarden-Master-Passwort.\nWird verschlüsselt im System-Schlüsselbund gespeichert, damit browser-mcp künftig selbst entsperren kann.",
    );
    key = await unlockWith(password);
    if (!key) throw new Error("Unlocking Bitwarden failed (wrong master password?).");
    await keyringSet("bw-master", password).catch(() => undefined);
  }

  session = key;
  await keyringSet("bw-session", key).catch(() => undefined);
  await bw(["sync"], key).catch(() => undefined);
  return key;
}

function toItem(r: RawItem): LoginItem {
  return {
    id: r.id,
    name: r.name,
    username: r.login?.username ?? null,
    uris: (r.login?.uris ?? []).map((u) => u.uri ?? "").filter(Boolean),
    hasTotp: Boolean(r.login?.totp),
  };
}

async function listRaw(args: string[]): Promise<RawItem[]> {
  const s = await ensureUnlocked();
  const items = JSON.parse(await bw(["list", "items", ...args], s)) as RawItem[];
  return items.filter((i) => i.type === 1 && i.login);
}

/** Login items whose URIs match the given page URL (Bitwarden's own matching). */
export async function itemsForUrl(url: string): Promise<LoginItem[]> {
  return (await listRaw(["--url", url])).map(toItem);
}

export async function searchItems(query: string): Promise<LoginItem[]> {
  return (await listRaw(["--search", query])).map(toItem);
}

/** Secret values for an item. Only used internally to fill fields; never returned to the agent. */
export async function secretsFor(id: string): Promise<{ username: string; password: string; totp?: () => Promise<string> }> {
  const s = await ensureUnlocked();
  const raw = JSON.parse(await bw(["get", "item", id], s)) as RawItem;
  return {
    username: raw.login?.username ?? "",
    password: raw.login?.password ?? "",
    totp: raw.login?.totp ? () => bw(["get", "totp", id], s) : undefined,
  };
}
