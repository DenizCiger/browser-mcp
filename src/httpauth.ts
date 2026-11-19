// HTTP authentication (Basic / Digest / NTLM). These are not login forms: the server answers
// 401 and the browser would show a native credentials prompt. We intercept the challenge over
// CDP (Fetch.authRequired), keep the request paused, and let fill_login answer it from
// Bitwarden. All other requests are passed straight through.

import type { BrowserContext, CDPSession, Page } from "playwright-core";

export interface AuthChallenge {
  requestId: string;
  url: string;
  origin: string;
  scheme: string;
  realm: string;
}

interface State {
  cdp: CDPSession;
  pending?: AuthChallenge;
  provided: Set<string>;
  rejected?: string;
  listeners: Set<() => void>;
}

const states = new WeakMap<Page, State>();

const notify = (s: State) => s.listeners.forEach((l) => l());

/** Start watching a page for HTTP auth challenges (idempotent). */
export async function watchAuth(ctx: BrowserContext, page: Page): Promise<void> {
  if (states.has(page)) return;
  const cdp = await ctx.newCDPSession(page);
  const s: State = { cdp, provided: new Set(), listeners: new Set() };
  states.set(page, s);
  const c = cdp as any;
  c.on("Fetch.requestPaused", (e: any) => {
    cdp.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => undefined);
  });
  c.on("Fetch.authRequired", (e: any) => {
    const ch = e.authChallenge ?? {};
    if (ch.source === "Proxy") {
      cdp.send("Fetch.continueWithAuth", { requestId: e.requestId, authChallengeResponse: { response: "Default" } })
        .catch(() => undefined);
      return;
    }
    if (s.provided.has(e.requestId)) {
      // Credentials were sent and refused: stop here instead of looping.
      s.provided.delete(e.requestId);
      s.rejected = e.request?.url ?? "";
      cdp.send("Fetch.continueWithAuth", { requestId: e.requestId, authChallengeResponse: { response: "CancelAuth" } })
        .catch(() => undefined);
      notify(s);
      return;
    }
    s.pending = {
      requestId: e.requestId,
      url: e.request?.url ?? "",
      origin: ch.origin ?? "",
      scheme: ch.scheme ?? "",
      realm: ch.realm ?? "",
    };
    notify(s);
  });
  page.once("close", () => states.delete(page));
  await cdp.send("Fetch.enable", { handleAuthRequests: true, patterns: [{ urlPattern: "*", requestStage: "Request" }] });
}

export function pendingAuth(page: Page): AuthChallenge | undefined {
  return states.get(page)?.pending;
}

export function resetAuth(page: Page): void {
  const s = states.get(page);
  if (s) {
    s.pending = undefined;
    s.rejected = undefined;
  }
}

export const AUTH = Symbol("auth-required");

/** Resolves with `work`'s result, or AUTH as soon as the page is blocked on an auth challenge. */
export async function raceAuth<T>(page: Page, work: Promise<T>): Promise<T | typeof AUTH> {
  const s = states.get(page);
  if (!s) return work;
  let listener!: () => void;
  const blocked = new Promise<typeof AUTH>((resolve) => {
    listener = () => s.pending && resolve(AUTH);
    s.listeners.add(listener);
  });
  try {
    return await Promise.race([work, blocked]);
  } finally {
    s.listeners.delete(listener);
  }
}

/** Answer the pending challenge. Returns "ok", "rejected" (server refused) or "gone" (request no longer exists). */
export async function answerAuth(
  page: Page,
  username: string,
  password: string,
): Promise<"ok" | "rejected" | "gone"> {
  const s = states.get(page);
  const ch = s?.pending;
  if (!s || !ch) return "gone";
  s.pending = undefined;
  s.rejected = undefined;
  s.provided.add(ch.requestId);
  try {
    await s.cdp.send("Fetch.continueWithAuth", {
      requestId: ch.requestId,
      authChallengeResponse: { response: "ProvideCredentials", username, password },
    });
  } catch {
    s.provided.delete(ch.requestId);
    return "gone";
  }
  // Wait for either a refusal (a second challenge for the same request) or a committed load.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (s.rejected !== undefined) return "rejected";
    if (!s.provided.has(ch.requestId)) break;
    await new Promise<void>((resolve) => {
      const l = () => {
        s.listeners.delete(l);
        resolve();
      };
      s.listeners.add(l);
      setTimeout(l, 400);
    });
    if (s.provided.has(ch.requestId) && s.rejected === undefined) {
      // Success shows as the page leaving the blank/previous state at the challenged origin.
      try {
        if (new URL(page.url()).origin === new URL(ch.url).origin) break;
      } catch {
        // ignore
      }
    }
  }
  return s.rejected !== undefined ? "rejected" : "ok";
}

export function describeChallenge(ch: AuthChallenge): string {
  return `${ch.origin || ch.url} asks for HTTP ${ch.scheme || "authentication"} login (realm "${ch.realm}")`;
}
