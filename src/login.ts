// fill_login: fills a login form from Bitwarden without the secrets ever leaving this
// process. Every fill is confirmed by the user in a local dialog that names the site
// and the Bitwarden item.

import type { Frame, Locator, Page } from "playwright-core";
import { itemsForUrl, searchItems, secretsFor, type LoginItem } from "./bitwarden.ts";
import { confirmChoice } from "./dialog.ts";
import { alwaysAsk, isTrusted, trust } from "./trust.ts";
import { answerAuth, pendingAuth, type AuthChallenge } from "./httpauth.ts";

const LOGIN_ATTR = "data-bmcp-login";

// Runs inside the page: marks the username / password / one-time-code fields.
function markFields(): { user: boolean; pass: boolean; otp: boolean } {
  const ATTR = "data-bmcp-login";
  document.querySelectorAll(`[${ATTR}]`).forEach((el) => el.removeAttribute(ATTR));
  const visible = (el: Element) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0 &&
      !(el as HTMLInputElement).disabled && !(el as HTMLInputElement).readOnly;
  };
  const inputs = Array.from(document.querySelectorAll("input")).filter(visible) as HTMLInputElement[];
  const hint = (el: HTMLInputElement) =>
    [el.name, el.id, el.autocomplete, el.placeholder, el.getAttribute("aria-label"), el.labels?.[0]?.textContent]
      .join(" ").toLowerCase();

  const passwords = inputs.filter((i) => i.type === "password");
  const pass = passwords.find((i) => i.autocomplete !== "new-password") ?? passwords[0];

  const textLike = inputs.filter((i) => ["text", "email", "tel", ""].includes(i.type));
  const userRe = /user|login|e-?mail|mail|benutzer|account|anmelde|name|ident|kennung/;
  let user: HTMLInputElement | undefined;
  const scope = pass?.form ? textLike.filter((i) => i.form === pass.form) : textLike;
  const before = pass
    ? scope.filter((i) => i.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING)
    : scope;
  user =
    before.find((i) => /username|email/.test(i.autocomplete)) ??
    before.find((i) => i.type === "email") ??
    before.find((i) => userRe.test(hint(i))) ??
    (pass ? before.at(-1) : undefined);

  let otp: HTMLInputElement | undefined;
  if (!pass && !user) {
    otp = inputs.find((i) => i.autocomplete === "one-time-code") ??
      inputs.find((i) => ["text", "tel", "number", ""].includes(i.type) && /otp|totp|code|token|2fa|mfa|verif/.test(hint(i)));
  }
  if (user) user.setAttribute(ATTR, "user");
  if (pass) pass.setAttribute(ATTR, "pass");
  if (otp) otp.setAttribute(ATTR, "otp");
  return { user: Boolean(user), pass: Boolean(pass), otp: Boolean(otp) };
}

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Registrable-ish domain: last two labels (good enough for at/com/dev style TLDs, plus *.gv.at / *.ac.at). */
function baseDomain(h: string): string {
  const parts = h.split(".");
  const n = /\.(gv|ac|co|or)\.(at|uk)$/.test(h) ? 3 : 2;
  return parts.slice(-n).join(".");
}

function itemMatchesHost(item: LoginItem, h: string): boolean {
  return item.uris.some((u) => {
    const uh = host(/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`);
    return uh !== "" && (uh === h || baseDomain(uh) === baseDomain(h));
  });
}

function itemHasExactHost(item: LoginItem, h: string): boolean {
  return item.uris.some((u) => host(/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`) === h);
}

/** Ask unless the item is saved for exactly this host (not for TOTP) or the user said "always". */
async function authorize(h: string, item: LoginItem, matches: boolean, otp: boolean, title: string, text: string): Promise<boolean> {
  if (!alwaysAsk && (isTrusted(h, item.id) || (!otp && itemHasExactHost(item, h)))) return true;
  const choice = await confirmChoice(title, text, matches);
  if (choice === "always") trust(h, item.id, item.name);
  return choice !== "deny";
}

function describeItem(i: LoginItem): string {
  return `${i.name} (id ${i.id}${i.username ? `, user ${i.username}` : ""}${i.hasTotp ? ", has TOTP" : ""})`;
}

type Picked = { item: LoginItem; matches: boolean } | { message: string };

/** Choose the Bitwarden item for a URL, or explain why that is not possible. */
async function pickItem(url: string, fieldHost: string, itemOpt?: string): Promise<Picked> {
  let candidates = await itemsForUrl(url);
  if (itemOpt) {
    const byId = candidates.filter((c) => c.id === itemOpt);
    const byName = candidates.filter((c) => c.name.toLowerCase().includes(itemOpt.toLowerCase()));
    candidates = byId.length ? byId : byName;
    if (!candidates.length) candidates = await searchItems(itemOpt);
  }
  if (!candidates.length) {
    return { message: `No Bitwarden login item matches ${fieldHost}. Ask the user which item to use and pass it as \`item\` (name or id), or have them add the site's URL to the item.` };
  }
  if (candidates.length > 1 && !itemOpt) {
    // Bitwarden matches on the base domain by default; prefer items saved for this exact host.
    const exact = candidates.filter((c) =>
      c.uris.some((u) => host(/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`) === fieldHost),
    );
    if (exact.length >= 1) candidates = exact;
  }
  if (candidates.length > 1) {
    return { message: `Several Bitwarden items match ${fieldHost}; call fill_login again with \`item\` set to one id:\n` +
      candidates.map((c) => `- ${describeItem(c)}`).join("\n") };
  }
  return { item: candidates[0], matches: itemMatchesHost(candidates[0], fieldHost) };
}

/** fill_login for a pending HTTP auth challenge (Basic/Digest/NTLM), not a form. */
async function fillHttpAuth(page: Page, ch: AuthChallenge, opts: FillOptions): Promise<string> {
  const u = new URL(ch.url);
  const h = u.hostname;
  if (u.protocol === "http:" && !["localhost", "127.0.0.1"].includes(h)) {
    throw new Error(`Refusing to send HTTP credentials over unencrypted http to ${h}.`);
  }
  const picked = await pickItem(ch.url, h, opts.item);
  if ("message" in picked) return picked.message;
  const { item, matches } = picked;
  const warning = matches
    ? ""
    : `\n\n⚠ ACHTUNG: Der Eintrag ist NICHT für ${h} hinterlegt (${item.uris.join(", ") || "keine URL"}). Nur bestätigen, wenn das wirklich richtig ist!`;
  const ok = await authorize(h, item, matches, false, "browser-mcp: Login ausfüllen?",
    `Seite: ${h}\nHTTP-Anmeldung (${ch.scheme}), Bereich: ${ch.realm || "-"}\nEintrag: ${item.name}${item.username ? ` (${item.username})` : ""}${warning}`);
  if (!ok) return "The user declined the login in the confirmation dialog. Do not retry unless they ask.";
  const secrets = await secretsFor(item.id);
  if (!secrets.username || !secrets.password) return `Item ${item.name} has no username and password.`;
  const result = await answerAuth(page, secrets.username, secrets.password);
  if (result === "gone") return "The login request is no longer pending. Call navigate again, then fill_login.";
  if (result === "rejected") {
    return `The server rejected the credentials from Bitwarden item "${item.name}" (HTTP ${ch.scheme}, realm "${ch.realm}"). Ask the user whether the item is up to date.`;
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => undefined);
  return `Answered the HTTP ${ch.scheme} login for ${h} (realm "${ch.realm}") with Bitwarden item "${item.name}".\n` +
    `Now at: ${page.url()} (${await page.title().catch(() => "")}). Call snapshot to see the page.`;
}

export interface FillOptions {
  item?: string;
  submit: boolean;
}

export async function fillLogin(page: Page, opts: FillOptions): Promise<string> {
  const challenge = pendingAuth(page);
  if (challenge) return fillHttpAuth(page, challenge, opts);
  const url = page.url();
  const h = host(url);
  if (!/^https?:$/.test(new URL(url).protocol)) throw new Error("fill_login only works on http(s) pages.");
  if (new URL(url).protocol === "http:" && !["localhost", "127.0.0.1"].includes(h)) {
    throw new Error(`Refusing to fill credentials over unencrypted http on ${h}.`);
  }

  // Find the fields first, in any frame.
  let target: Frame | undefined;
  let found = { user: false, pass: false, otp: false };
  for (const f of page.frames()) {
    try {
      const r = await f.evaluate(markFields);
      if (r.user || r.pass || r.otp) {
        target = f;
        found = r;
        if (r.pass) break;
      }
    } catch {
      // cross-origin or detached frame
    }
  }
  if (!target) return `No login fields found on ${url}. Take a snapshot: maybe a "Login" button has to be clicked first.`;
  const fieldHost = host(target.url()) || h;

  const picked = await pickItem(target.url() || url, fieldHost, opts.item);
  if ("message" in picked) return picked.message;
  const { item, matches } = picked;

  const what = found.otp ? "Einmal-Code (TOTP)" : [found.user && "Benutzername", found.pass && "Passwort"].filter(Boolean).join(" + ");
  const warning = matches
    ? ""
    : `\n\n⚠ ACHTUNG: Der Eintrag ist NICHT für ${fieldHost} hinterlegt (${item.uris.join(", ") || "keine URL"}). Nur bestätigen, wenn das wirklich richtig ist!`;
  const ok = await authorize(fieldHost, item, matches, found.otp, "browser-mcp: Login ausfüllen?",
    `Seite: ${fieldHost}\nEintrag: ${item.name}${item.username ? ` (${item.username})` : ""}\nFelder: ${what}${opts.submit ? "\nDanach absenden." : ""}${warning}`);
  if (!ok) return "The user declined the login in the confirmation dialog. Do not retry unless they ask.";

  const secrets = await secretsFor(item.id);
  const field = (k: string): Locator => target!.locator(`[${LOGIN_ATTR}="${k}"]`).first();
  let last: Locator | undefined;
  const filled: string[] = [];
  if (found.otp) {
    if (!secrets.totp) return `Item ${item.name} has no TOTP secret. The user has to enter the code in the browser window.`;
    last = field("otp");
    await last.fill(await secrets.totp());
    filled.push("one-time code");
  } else {
    if (found.user && secrets.username) {
      last = field("user");
      await last.fill(secrets.username);
      filled.push("username");
    }
    if (found.pass && secrets.password) {
      last = field("pass");
      await last.fill(secrets.password);
      filled.push("password");
    }
  }
  if (!last) return `Item ${item.name} has no username/password for the fields found.`;

  if (opts.submit) {
    const before = page.url();
    await last.press("Enter");
    await page.waitForURL((u) => u.toString() !== before, { timeout: 10000 }).catch(() => undefined);
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => undefined);
  }
  const title = await page.title().catch(() => "");
  return `Filled ${filled.join(" + ")} from Bitwarden item "${item.name}" on ${fieldHost}${opts.submit ? " and submitted" : ""}.\n` +
    `Now at: ${page.url()} (${title}).\n` +
    `If the page asks for another step (password on a second page, one-time code), call fill_login again.`;
}
