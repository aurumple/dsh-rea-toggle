# Changelog

## 1.1.0 — 2026-10-18

The switch becomes per conversation.

- **Each conversation has its own position**, keyed by session id, and **a new
  conversation starts off**. A conversation about anything else no longer pays
  for REA's 207 tool schemas because some other conversation needs them.
- Subagents **inherit the position of the conversation that created them**
  instead of taking the default, so delegating inside reverse-engineering work
  does not silently strip the subagent.
- `/rea` and the pill both act on the conversation they are in.
- `GET /rea-toggle/state` takes `?session=<id>`; `POST` requires `session` in the
  body. Without one, GET returns a summary of remembered conversations.
- Positions persist per conversation in `$DSH_HOME/rea-toggle.json`, capped at
  the 500 most recently changed. A v1 file (one process-wide position) is
  ignored rather than misread, so every conversation starts from the default.
- New optional `defaultEnabled: true` restores the pre-plugin behaviour: an
  untouched conversation behaves exactly as if the plugin were not installed.

Fixed:

- **One `tools/change` could wedge the whole Harness.** Lifting stale
  restrictions happened *outside* the reconcile latch, so the disposals they
  triggered re-entered the listener with the latch still open and each
  re-entry disposed again. Measured: one external event produced ~41,000
  register/dispose pairs and the UI stopped accepting messages. All lifting now
  happens inside the latch; the same event now costs 2 registrations per
  covered agent. A counting regression test pins it.

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
