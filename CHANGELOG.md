# Changelog

## 1.0.0 — 2026-10-18

First release.

- One switch over the REA MCP server's share of the model context: its 207 tool
  schemas and the `mcp:rea` server-instructions section both leave the context
  when the switch is off, and come back exactly when it is on.
- Coverage is per agent and applied live, including subagents created afterwards;
  no restart and no page reload.
- Three ways to drive it: a pill in the composer dock, the `/rea` slash command
  (`on` / `off` / `status` / `toggle`), and `GET`/`POST /rea-toggle/state`.
- The position is remembered in `$DSH_HOME/rea-toggle.json`.
- `server` / `servers` config governs any `dsh-mcp-client`-bridged MCP server by
  the same rules; the default is `rea`.
- Uninstalling the bundle lifts every registration, restoring the inherited
  context.
