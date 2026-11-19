// fill_login: fills a login form from Bitwarden without the secrets ever leaving this
// process. Every fill is confirmed by the user in a local dialog that names the site
// and the Bitwarden item.

import type { Frame, Locator, Page } from "playwright-core";
import { itemsForUrl, searchItems, secretsFor, type LoginItem } from "./bitwarden.ts";
import { confirm } from "./dialog.ts";

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

function describeItem(i: LoginItem): string {
  return `${i.name} (id ${i.id}${i.username ? `, user ${i.username}` : ""}${i.hasTotp ? ", has TOTP" : ""})`;
}

export interface FillOptions {
  item?: string;
  submit: boolean;
}

export async function fillLogin(page: Page, opts: FillOptions): Promise<string> {
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

  // Pick the Bitwarden item.
  let candidates = await itemsForUrl(target.url() || url);
  if (opts.item) {
    const byId = candidates.filter((c) => c.id === opts.item);
    const byName = candidates.filter((c) => c.name.toLowerCase().includes(opts.item!.toLowerCase()));
    candidates = byId.length ? byId : byName;
    if (!candidates.length) candidates = await searchItems(opts.item);
  }
  if (!candidates.length) {
    return `No Bitwarden login item matches ${fieldHost}. Ask the user which item to use and pass it as \`item\` (name or id), or have them add the site's URL to the item.`;
  }
  if (candidates.length > 1 && !opts.item) {
    // Bitwarden matches on the base domain by default; prefer items saved for this exact host.
    const exact = candidates.filter((c) =>
      c.uris.some((u) => host(/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`) === fieldHost),
    );
    if (exact.length >= 1) candidates = exact;
  }
  if (candidates.length > 1) {
    return `Several Bitwarden items match ${fieldHost}; call fill_login again with \`item\` set to one id:\n` +
      candidates.map((c) => `- ${describeItem(c)}`).join("\n");
  }
  const item = candidates[0];
  const matches = itemMatchesHost(item, fieldHost);

  const what = found.otp ? "Einmal-Code (TOTP)" : [found.user && "Benutzername", found.pass && "Passwort"].filter(Boolean).join(" + ");
  const warning = matches
    ? ""
    : `\n\n⚠ ACHTUNG: Der Eintrag ist NICHT für ${fieldHost} hinterlegt (${item.uris.join(", ") || "keine URL"}). Nur bestätigen, wenn das wirklich richtig ist!`;
  const ok = await confirm(
    "browser-mcp: Login ausfüllen?",
    `Seite: ${fieldHost}\nEintrag: ${item.name}${item.username ? ` (${item.username})` : ""}\nFelder: ${what}${opts.submit ? "\nDanach absenden." : ""}${warning}`,
  );
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
