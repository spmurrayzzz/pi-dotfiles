---
name: build-pi-extension
description: Build, modify, or review pi coding-agent extensions. Use when creating TypeScript extensions that register tools, commands, event handlers, custom UI, shortcuts, flags, providers, or packageable pi extension bundles.
---

# Build Pi Extension

Use this skill when the user asks to build, modify, debug, or package a pi
coding-agent extension.

## Required Reading

Before implementing, read the relevant pi docs from the installed package:

- `docs/extensions.md` for the extension API, lifecycle, tools, commands,
  events, state, and rendering
- `docs/tui.md` when building custom UI, dialogs, overlays, editors, widgets,
  footers, or custom renderers
- `docs/keybindings.md` when adding keyboard shortcuts or handling keys
- `docs/packages.md` when making the extension shareable as a pi package
- `docs/custom-provider.md` when registering model providers

Installed docs are usually under the pi coding-agent package. If working in
`pi-mono`, prefer the project docs in `packages/coding-agent/docs/`.

Also inspect relevant examples in `packages/coding-agent/examples/extensions/`
or the installed `examples/extensions/` directory before coding.

## Placement

For reloadable extensions, place code in one of these locations:

- Project-local: `.pi/extensions/<name>.ts`
- Project-local directory: `.pi/extensions/<name>/index.ts`
- Global: `~/.pi/agent/extensions/<name>.ts`
- Global directory: `~/.pi/agent/extensions/<name>/index.ts`

Use `pi -e ./path/to/extension.ts` only for quick tests. Auto-discovered
extensions can be hot-reloaded with `/reload`.

## Extension Shape

Create a TypeScript module with a default factory:

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Extension loaded", "info");
  });
}
```

Use an async factory only for startup work that must finish before pi starts,
such as fetching provider models.

## Common APIs

- `pi.on(event, handler)` for lifecycle, input, model, message, tool, session,
  context, provider, and user bash events
- `pi.registerTool()` for LLM-callable tools
- `pi.registerCommand()` for slash commands
- `pi.registerShortcut()` for configurable shortcuts
- `pi.registerFlag()` for CLI flags
- `pi.sendMessage()` and `pi.sendUserMessage()` for injected messages
- `pi.appendEntry()` for persisted extension state outside LLM context
- `pi.registerMessageRenderer()` for custom message rendering
- `pi.registerProvider()` for custom model providers
- `ctx.ui` for dialogs, widgets, status, editor control, autocomplete,
  overlays, and custom components

## Implementation Rules

- Keep the extension as small as possible.
- Prefer a single file unless dependencies or complexity justify a directory.
- Import types and APIs at the top level. Do not use inline imports.
- Use `typebox` schemas for tool parameters.
- Use `StringEnum` from `@mariozechner/pi-ai` for string enums in tool
  schemas.
- Check `ctx.hasUI` before relying on interactive UI behavior in print, JSON,
  or RPC modes.
- Use `ctx.signal` for nested async work during active agent turns.
- Throw from tool `execute()` to mark tool execution as failed.
- Truncate large tool outputs with exported truncation utilities.
- If a custom tool mutates files, wrap the whole read-modify-write operation in
  `withFileMutationQueue()` using the resolved absolute target path.
- Store branch-sensitive tool state in tool result `details` and reconstruct it
  from `ctx.sessionManager.getBranch()` on `session_start`.
- For shortcuts and custom UI key handling, use documented configurable
  keybinding helpers and IDs instead of hardcoded app key checks.

## Testing Workflow

For quick manual testing:

```bash
pi -e ./path/to/extension.ts
```

For reloadable project testing:

1. Put the extension under `.pi/extensions/`.
2. Start pi normally.
3. Use `/reload` after edits.

If changing the pi codebase itself, follow the repository instructions for
checks after code changes.
