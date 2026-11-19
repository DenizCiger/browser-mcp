#!/bin/sh
# Stops the shared browser-mcp Chrome (only processes using the browser-mcp profile).
for p in $(pgrep -x chrome); do
  if tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null | grep -q -- "--user-data-dir=$HOME/.local/share/browser-mcp/profile"; then
    kill "$p" 2>/dev/null
  fi
done
