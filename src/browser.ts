// Shared, persistent Chrome instance.
//
// The first browser-mcp process that needs a browser starts Chrome detached with a
// dedicated profile and a localhost-only CDP port. Every other browser-mcp process
// (Claude Code, Claude Desktop, several sessions) connects to that same Chrome, so
// they all share one profile and one set of logins, and the browser survives when a
// session ends.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { watchAuth } from "./httpauth.ts";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const PORT = Number(process.env.BROWSER_MCP_PORT ?? 9333);
const PROFILE =
  process.env.BROWSER_MCP_PROFILE ?? join(homedir(), ".local/share/browser-mcp/profile");
const HEADLESS = /^(1|true|yes)$/i.test(process.env.BROWSER_MCP_HEADLESS ?? "");
const CDP = `http://127.0.0.1:${PORT}`;

function findChrome(): string {
  const candidates = [
    process.env.BROWSER_MCP_CHROME,
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/opt/google/chrome/chrome",
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  throw new Error(
    "No Chrome/Chromium found. Set BROWSER_MCP_CHROME to the browser executable.",
  );
}

async function cdpAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function launchChrome(): Promise<void> {
  mkdirSync(PROFILE, { recursive: true });
  const args = [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    "--remote-debugging-address=127.0.0.1",
    "--class=browser-mcp",
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
  ];
  if (HEADLESS) args.push("--headless=new");
  args.push("about:blank");
  // Chrome's output goes to a log next to the profile, for debugging launch problems.
  const log = openSync(join(PROFILE, "..", "chrome.log"), "w");
  const child = spawn(findChrome(), args, { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  for (let i = 0; i < 60; i++) {
    if (await cdpAlive()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Chrome did not open its debugging port ${PORT} within 15s.`);
}

let browser: Browser | undefined;
let current: Page | undefined;

export async function context(): Promise<BrowserContext> {
  if (!browser || !browser.isConnected()) {
    if (!(await cdpAlive())) await launchChrome();
    browser = await chromium.connectOverCDP(CDP);
    browser.on("disconnected", () => {
      browser = undefined;
      current = undefined;
    });
  }
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("Chrome exposed no browser context.");
  return ctx;
}

/** The page this server is working on; opens one if needed. */
export async function page(): Promise<Page> {
  const ctx = await context();
  if (!current || current.isClosed()) {
    const pages = ctx.pages().filter((p) => !p.isClosed());
    current = pages.at(-1) ?? (await ctx.newPage());
  }
  await watchAuth(ctx, current).catch(() => undefined);
  return current;
}

export async function pages(): Promise<Page[]> {
  return (await context()).pages().filter((p) => !p.isClosed());
}

export function setCurrent(p: Page): void {
  current = p;
}

export const config = { PORT, PROFILE, HEADLESS };
