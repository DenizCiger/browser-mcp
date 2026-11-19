// MCP clients often start servers with a stripped environment (no DISPLAY,
// WAYLAND_DISPLAY or D-Bus address). Chrome, zenity and the keyring need those, so
// fill any missing ones from the systemd user session (where Wayland compositors
// and desktop environments export them).

import { execFileSync } from "node:child_process";

const WANTED = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "XAUTHORITY",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_TYPE",
];

export function importSessionEnv(): void {
  if (WANTED.every((k) => process.env[k])) return;
  // systemctl --user finds the user bus through XDG_RUNTIME_DIR.
  const uid = process.getuid?.();
  if (!process.env.XDG_RUNTIME_DIR && uid !== undefined) process.env.XDG_RUNTIME_DIR = `/run/user/${uid}`;
  let out = "";
  try {
    out = execFileSync("systemctl", ["--user", "show-environment"], { encoding: "utf8", timeout: 3000, env: process.env });
  } catch {
    return;
  }
  for (const line of out.split("\n")) {
    const i = line.indexOf("=");
    if (i < 0) continue;
    const k = line.slice(0, i);
    if (WANTED.includes(k) && !process.env[k]) process.env[k] = line.slice(i + 1);
  }
}
