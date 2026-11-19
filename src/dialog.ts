// Local dialogs the user answers directly (zenity). The agent cannot answer these.

import { execFile } from "node:child_process";

const ZENITY = process.env.BROWSER_MCP_ZENITY ?? "zenity";

type Outcome = "ok" | "cancelled" | "timeout";

function zenity(args: string[], timeoutSec: number): Promise<{ outcome: Outcome; out: string }> {
  return new Promise((resolve, reject) => {
    // zenity rejects non-ASCII arguments without a UTF-8 locale, and MCP clients often drop LANG.
    const env = { ...process.env };
    if (!/utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || "")) env.LC_ALL = "C.UTF-8";
    execFile(ZENITY, [...args, `--timeout=${timeoutSec}`], { env }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
      // zenity: 0 = OK, 1 = Cancel/closed, 5 = timeout, anything else = could not show the dialog.
      if (code === 0) resolve({ outcome: "ok", out: stdout });
      else if (code === 1) resolve({ outcome: "cancelled", out: stdout }); // extra buttons print their label and exit 1
      else if (code === 5) resolve({ outcome: "timeout", out: "" });
      else {
        const why = stderr.split("\n").find((l) => l.trim() && !l.includes("Gtk-WARNING")) ?? err?.message;
        reject(new Error(`Could not show the local confirmation dialog (zenity exit ${code}: ${why}).`));
      }
    });
  });
}

function explain(o: Outcome, what: string): Error {
  return new Error(
    o === "timeout"
      ? `Nobody answered the ${what} dialog in time. Ask the user to watch for the dialog and try again.`
      : `The user cancelled the ${what} dialog. Do not retry unless they ask.`,
  );
}

/** Returns true if the user confirmed, false if they declined; throws on timeout/failure. */
export async function confirm(title: string, text: string): Promise<boolean> {
  const { outcome } = await zenity(
    ["--question", "--modal", `--title=${title}`, `--text=${text}`, "--ok-label=Einloggen", "--cancel-label=Abbrechen", "--no-markup", "--default-cancel"],
    120,
  );
  if (outcome === "timeout") throw explain(outcome, "login confirmation");
  return outcome === "ok";
}

export type Choice = "once" | "always" | "deny";

/** Like confirm, with an extra "always allow" button (only offered when `offerAlways`). */
export async function confirmChoice(title: string, text: string, offerAlways: boolean): Promise<Choice> {
  const ALWAYS = "Immer erlauben";
  const { outcome, out } = await zenity(
    [
      "--question", "--modal", `--title=${title}`, `--text=${text}`, "--ok-label=Einloggen", "--cancel-label=Abbrechen",
      ...(offerAlways ? [`--extra-button=${ALWAYS}`] : []), "--no-markup", "--default-cancel",
    ],
    120,
  );
  if (outcome === "timeout") throw explain(outcome, "login confirmation");
  if (outcome === "ok") return "once";
  return out.trim() === ALWAYS ? "always" : "deny";
}

export async function askPassword(title: string, text: string): Promise<string> {
  const { outcome, out } = await zenity(["--entry", "--hide-text", "--modal", `--title=${title}`, `--text=${text}`], 300);
  if (outcome !== "ok") throw explain(outcome, "Bitwarden unlock");
  const pw = out.replace(/\r?\n$/, "");
  if (!pw) throw new Error("Empty master password entered.");
  return pw;
}
