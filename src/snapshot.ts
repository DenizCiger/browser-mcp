// Text snapshot of a page: readable text in document order, with interactive elements
// tagged by a ref (e.g. [e12 link "Prüfungen" -> /doku.php?id=exams]) that the
// click/type/select tools accept. Password field values are never included.

import type { Frame, Page } from "playwright-core";

export const REF_ATTR = "data-bmcp-ref";

// Runs inside the page. Must be self-contained.
function walk(prefix: string): string {
  const REF = "data-bmcp-ref";
  document.querySelectorAll(`[${REF}]`).forEach((el) => el.removeAttribute(REF));

  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "HEAD", "META", "LINK"]);
  const BLOCK = new Set([
    "P", "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "NAV", "ASIDE", "FORM",
    "UL", "OL", "LI", "TABLE", "TR", "BR", "HR", "PRE", "BLOCKQUOTE", "DL", "DT", "DD",
    "FIELDSET", "LEGEND", "FIGURE", "FIGCAPTION", "H1", "H2", "H3", "H4", "H5", "H6", "DETAILS",
  ]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "tab", "menuitem", "option", "switch", "textbox",
    "combobox", "searchbox", "treeitem", "menuitemcheckbox", "menuitemradio",
  ]);

  const lines: string[] = [];
  let line = "";
  let n = 0;
  const flush = () => {
    const t = line.replace(/\s+/g, " ").trim();
    if (t) lines.push(t);
    line = "";
  };
  const clean = (s: string | null | undefined, max = 120) => {
    const t = (s ?? "").replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max) + "…" : t;
  };

  const visible = (el: Element) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0 && s.position !== "fixed" && el.tagName !== "DETAILS") {
      // Zero-size elements may still contain visible overflow children.
      return el.children.length > 0;
    }
    return true;
  };

  const isInteractive = (el: Element): string | null => {
    const tag = el.tagName;
    const role = el.getAttribute("role");
    if (tag === "A" && el.hasAttribute("href")) return "link";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return "select";
    if (tag === "TEXTAREA") return "textarea";
    if (tag === "INPUT") {
      const type = (el as HTMLInputElement).type;
      if (type === "hidden") return null;
      if (["submit", "button", "reset", "image"].includes(type)) return "button";
      return type === "text" ? "input" : `input:${type}`;
    }
    if (role && INTERACTIVE_ROLES.has(role)) return role;
    if ((el as HTMLElement).isContentEditable && el.getAttribute("contenteditable") !== null) return "editable";
    if (el.hasAttribute("onclick")) return "clickable";
    return null;
  };

  const nameOf = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const t = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      if (clean(t)) return clean(t);
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      const lbl = el.labels?.[0]?.textContent;
      if (clean(lbl)) return clean(lbl);
      if (el instanceof HTMLInputElement && ["submit", "button", "reset"].includes(el.type)) return clean(el.value);
      return clean(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name"));
    }
    const txt = clean((el as HTMLElement).innerText ?? el.textContent);
    if (txt) return txt;
    const img = el.querySelector("img[alt]");
    return clean(el.getAttribute("title") || img?.getAttribute("alt"));
  };

  const describe = (el: Element, kind: string, ref: string): string => {
    let s = `[${ref} ${kind}`;
    const name = nameOf(el);
    if (name) s += ` "${name}"`;
    if (el instanceof HTMLAnchorElement) {
      const href = el.getAttribute("href") ?? "";
      if (href && !href.startsWith("javascript:")) s += ` -> ${clean(href, 200)}`;
    } else if (el instanceof HTMLInputElement) {
      if (el.type === "password") s += el.value ? " (filled)" : " (empty)";
      else if (el.type === "checkbox" || el.type === "radio") s += el.checked ? " (checked)" : " (unchecked)";
      else if (el.value && !["submit", "button", "reset"].includes(el.type)) s += ` value="${clean(el.value, 80)}"`;
      if (el.disabled) s += " (disabled)";
    } else if (el instanceof HTMLTextAreaElement) {
      if (el.value) s += ` value="${clean(el.value, 200)}"`;
    } else if (el instanceof HTMLSelectElement) {
      const opts = Array.from(el.options).map((o) => (o.selected ? `*${clean(o.text, 40)}` : clean(o.text, 40)));
      s += ` options=[${opts.slice(0, 30).join(" | ")}${opts.length > 30 ? " | …" : ""}]`;
    } else {
      const expanded = el.getAttribute("aria-expanded");
      if (expanded) s += ` (expanded=${expanded})`;
      const checked = el.getAttribute("aria-checked") ?? el.getAttribute("aria-selected");
      if (checked) s += ` (selected=${checked})`;
    }
    return s + "]";
  };

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      line += " " + (node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (SKIP.has(el.tagName.toUpperCase()) || !visible(el)) return;

    const kind = isInteractive(el);
    if (kind) {
      const ref = `${prefix}${++n}`;
      el.setAttribute(REF, ref);
      line += " " + describe(el, kind, ref) + " ";
      return;
    }
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      flush();
      line = "#".repeat(Number(tag[1])) + " ";
      el.childNodes.forEach(visit);
      flush();
      return;
    }
    if (tag === "IFRAME") {
      flush();
      lines.push(`[iframe ${clean(el.getAttribute("title") || el.getAttribute("src"), 120)} – content listed separately]`);
      return;
    }
    if (tag === "IMG") {
      const alt = clean(el.getAttribute("alt"));
      if (alt) line += ` [img "${alt}"] `;
      return;
    }
    const block = BLOCK.has(tag);
    if (block) flush();
    if (tag === "LI") line = "- ";
    if (tag === "TD" || tag === "TH") line += " | ";
    if (el.shadowRoot) el.shadowRoot.childNodes.forEach(visit);
    el.childNodes.forEach(visit);
    if (block) flush();
  };

  visit(document.body ?? document.documentElement);
  flush();
  return lines.join("\n");
}

function framePrefix(i: number): string {
  return i === 0 ? "e" : `f${i}e`;
}

export async function snapshot(page: Page, maxChars = 40000): Promise<string> {
  const frames = page.frames();
  const parts: string[] = [`URL: ${page.url()}`, `Title: ${await page.title().catch(() => "")}`, ""];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    let text: string;
    try {
      text = await f.evaluate(walk, framePrefix(i));
    } catch {
      continue;
    }
    if (!text.trim()) continue;
    if (i > 0) parts.push("", `--- iframe ${f.url()} ---`);
    parts.push(text);
  }
  let out = parts.join("\n");
  if (out.length > maxChars) {
    out = out.slice(0, maxChars) + `\n\n[… truncated at ${maxChars} chars; call snapshot with a higher max_chars or use get_text]`;
  }
  return out;
}

/** Finds the element for a ref from the last snapshot, in whichever frame it lives. */
export async function locate(page: Page, ref: string) {
  const frames: Frame[] = page.frames();
  const m = /^f(\d+)e\d+$/.exec(ref);
  const candidates = m ? [frames[Number(m[1])]].filter(Boolean) : [page.mainFrame()];
  for (const f of candidates) {
    const loc = f.locator(`[${REF_ATTR}="${ref}"]`);
    if ((await loc.count()) > 0) return loc.first();
  }
  throw new Error(`Ref ${ref} not found. The page probably changed: take a new snapshot.`);
}
