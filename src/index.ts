#!/usr/bin/env node
// browser-mcp: browser use over MCP with a persistent profile shared by all clients,
// plus Bitwarden-backed logins whose secrets never reach the agent.

import { importSessionEnv } from "./env.ts";
importSessionEnv();

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Page } from "playwright-core";
import { page, pages, setCurrent, context, config } from "./browser.ts";
import { snapshot, locate } from "./snapshot.ts";
import { fillLogin } from "./login.ts";

const server = new McpServer(
  { name: "browser-mcp", version: "0.1.0" },
  {
    instructions:
      "A real Chrome with a persistent profile: logins survive between sessions. " +
      "Typical flow: navigate → snapshot (text with [eN] refs) → click/type by ref → snapshot again. " +
      "Use get_text for long articles. If a page shows a login form or redirects to one, call fill_login: " +
      "it fills credentials from the user's Bitwarden after the user confirms in a local dialog; you never see " +
      "the password, and the type tool refuses password fields. If fill_login finds nothing to use, ask the user. " +
      "CAPTCHAs and logins the tool cannot fill are for the user to do in the visible browser window.",
  },
);

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (t: string) => ({ content: [{ type: "text", text: t } as Content] });

async function settle(p: Page): Promise<void> {
  await p.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => undefined);
  await p.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
}

async function where(p: Page): Promise<string> {
  return `Now at: ${p.url()} — ${await p.title().catch(() => "")}`;
}

function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  fn: (args: z.infer<z.ZodObject<S>>) => Promise<{ content: Content[] }>,
) {
  const handler = async (args: any): Promise<any> => {
    try {
      return await fn(args);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  };
  server.registerTool(name, { description, inputSchema: shape }, handler as any);
}

tool(
  "navigate",
  "Open a URL in the current tab. Also accepts \"back\", \"forward\" and \"reload\".",
  { url: z.string().describe("Absolute URL, or back / forward / reload") },
  async ({ url }) => {
    const p = await page();
    if (url === "back") await p.goBack({ timeout: 30000 });
    else if (url === "forward") await p.goForward({ timeout: 30000 });
    else if (url === "reload") await p.reload({ timeout: 30000 });
    else await p.goto(/^[a-z]+:/i.test(url) ? url : `https://${url}`, { timeout: 30000, waitUntil: "domcontentloaded" });
    await settle(p);
    return text(`${await where(p)}\nCall snapshot to see the page.`);
  },
);

tool(
  "snapshot",
  "Text outline of the current page in reading order. Interactive elements are tagged like [e12 link \"Name\" -> href]; pass those refs to click, type and select_option. Refs are valid until the next snapshot.",
  { max_chars: z.number().int().positive().optional().describe("Default 40000") },
  async ({ max_chars }) => text(await snapshot(await page(), max_chars ?? 40000)),
);

tool(
  "get_text",
  "Plain visible text of the page (or of one CSS selector), without refs. Good for reading long content.",
  {
    selector: z.string().optional().describe("CSS selector, e.g. main, article, #content. Default: main/article/body"),
    max_chars: z.number().int().positive().optional().describe("Default 60000"),
  },
  async ({ selector, max_chars }) => {
    const p = await page();
    const t: string = await p.evaluate((sel: string | null) => {
      const el = sel
        ? document.querySelector(sel)
        : document.querySelector("main") ?? document.querySelector("article") ?? document.body;
      return el ? (el as HTMLElement).innerText : `(no element matches ${sel})`;
    }, selector ?? null);
    const max = max_chars ?? 60000;
    const out = t.length > max ? t.slice(0, max) + `\n[… truncated at ${max} chars]` : t;
    return text(`URL: ${p.url()}\n\n${out}`);
  },
);

tool(
  "click",
  "Click an element by its ref from the last snapshot.",
  { ref: z.string(), double: z.boolean().optional() },
  async ({ ref, double }) => {
    const p = await page();
    const ctx = await context();
    const popup = ctx.waitForEvent("page", { timeout: 1500 }).catch(() => undefined);
    const el = await locate(p, ref);
    if (double) await el.dblclick({ timeout: 10000 });
    else await el.click({ timeout: 10000 });
    const opened = await popup;
    if (opened) {
      setCurrent(opened);
      await settle(opened);
      return text(`Clicked ${ref}; it opened a new tab, which is now current.\n${await where(opened)}`);
    }
    await settle(p);
    return text(`Clicked ${ref}.\n${await where(p)}`);
  },
);

tool(
  "type",
  "Type text into an input/textarea by ref. Refuses password fields: use fill_login for credentials.",
  {
    ref: z.string(),
    text: z.string(),
    submit: z.boolean().optional().describe("Press Enter afterwards"),
    append: z.boolean().optional().describe("Keep existing content instead of replacing it"),
  },
  async ({ ref, text: value, submit, append }) => {
    const p = await page();
    const el = await locate(p, ref);
    const kind = await el.evaluate((e) => {
      const i = e as HTMLInputElement;
      const ac = (i.getAttribute("autocomplete") ?? "").toLowerCase();
      if (i.tagName === "INPUT" && i.type === "password") return "password";
      if (ac.includes("password") || ac.includes("one-time-code") || ac.startsWith("cc-")) return "password";
      return "ok";
    });
    if (kind === "password") {
      throw new Error("This is a password/one-time-code/card field. Use fill_login (Bitwarden) or let the user type it.");
    }
    if (append) await el.pressSequentially(value);
    else await el.fill(value);
    if (submit) {
      await el.press("Enter");
      await settle(p);
    }
    return text(`Typed into ${ref}${submit ? " and pressed Enter" : ""}.\n${await where(p)}`);
  },
);

tool(
  "select_option",
  "Choose an option in a <select> by ref (matches option value or label).",
  { ref: z.string(), option: z.string() },
  async ({ ref, option }) => {
    const p = await page();
    const el = await locate(p, ref);
    await el.selectOption(option).catch(() => el.selectOption({ label: option }));
    await settle(p);
    return text(`Selected "${option}" in ${ref}.\n${await where(p)}`);
  },
);

tool(
  "press_key",
  "Press a key or chord in the focused element, e.g. Enter, Escape, Tab, PageDown, Control+a.",
  { key: z.string() },
  async ({ key }) => {
    const p = await page();
    await p.keyboard.press(key);
    await settle(p);
    return text(`Pressed ${key}.\n${await where(p)}`);
  },
);

tool(
  "scroll",
  "Scroll the page (useful for lazy-loading content).",
  { direction: z.enum(["down", "up", "top", "bottom"]) },
  async ({ direction }) => {
    const p = await page();
    await p.evaluate((d: string) => {
      if (d === "top") window.scrollTo(0, 0);
      else if (d === "bottom") window.scrollTo(0, document.body.scrollHeight);
      else window.scrollBy(0, (d === "down" ? 1 : -1) * window.innerHeight * 0.9);
    }, direction);
    await p.waitForTimeout(500);
    return text(`Scrolled ${direction}.`);
  },
);

tool(
  "wait_for",
  "Wait until some text appears on the page, or for a number of seconds.",
  { text: z.string().optional(), seconds: z.number().positive().max(60).optional() },
  async ({ text: t, seconds }) => {
    const p = await page();
    if (t) await p.getByText(t, { exact: false }).first().waitFor({ timeout: (seconds ?? 15) * 1000 });
    else await p.waitForTimeout((seconds ?? 2) * 1000);
    return text(t ? `"${t}" is on the page.` : `Waited ${seconds ?? 2}s.`);
  },
);

tool(
  "screenshot",
  "Screenshot of the current tab (viewport, or the full page).",
  { full_page: z.boolean().optional() },
  async ({ full_page }) => {
    const p = await page();
    const buf = await p.screenshot({ fullPage: full_page ?? false, type: "jpeg", quality: 70 });
    return { content: [{ type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" }] };
  },
);

tool(
  "tabs",
  "List, open, switch to or close tabs. The browser (and its tabs) is shared with other sessions using browser-mcp.",
  {
    action: z.enum(["list", "new", "select", "close"]),
    index: z.number().int().nonnegative().optional().describe("For select/close; default: current tab for close"),
    url: z.string().optional().describe("For new"),
  },
  async ({ action, index, url }) => {
    const all = await pages();
    const cur = await page();
    if (action === "new") {
      const p = await (await context()).newPage();
      setCurrent(p);
      if (url) {
        await p.goto(/^[a-z]+:/i.test(url) ? url : `https://${url}`, { timeout: 30000, waitUntil: "domcontentloaded" });
        await settle(p);
      }
      return text(`Opened a new tab.\n${await where(p)}`);
    }
    if (action === "select" || action === "close") {
      const target = index === undefined ? (action === "close" ? cur : undefined) : all[index];
      if (!target) throw new Error(`No tab with index ${index}.`);
      if (action === "select") {
        setCurrent(target);
        await target.bringToFront().catch(() => undefined);
        return text(`Switched to tab ${all.indexOf(target)}.\n${await where(target)}`);
      }
      await target.close();
      const rest = await pages();
      if (rest.length) setCurrent(rest.at(-1)!);
      return text(`Closed tab. ${rest.length} left.`);
    }
    const lines = await Promise.all(
      all.map(async (p, i) => `${i}${p === cur ? " *" : ""}  ${await p.title().catch(() => "")}  ${p.url()}`),
    );
    return text(lines.join("\n") || "(no tabs)");
  },
);

tool(
  "fill_login",
  "Fill the login form on the current page from the user's Bitwarden vault, then (by default) submit. " +
    "The user confirms each fill in a local dialog; the secrets never appear in the response. " +
    "Works step by step: call it again for a second page (password after username) or a one-time code. " +
    "Use it whenever a site has logged you out.",
  {
    item: z.string().optional().describe("Bitwarden item id or name, only when several items match or none matches by URL"),
    submit: z.boolean().optional().describe("Press Enter after filling (default true)"),
  },
  async ({ item, submit }) => text(await fillLogin(await page(), { item, submit: submit ?? true })),
);

await server.connect(new StdioServerTransport());
process.stderr.write(`browser-mcp ready (profile ${config.PROFILE}, CDP port ${config.PORT})\n`);
