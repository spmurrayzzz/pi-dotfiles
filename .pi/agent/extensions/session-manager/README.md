# Session manager extension

Adds an interactive session picker for resuming project sessions.

## Usage

Run:

```text
/sessions
```

In the TUI, type to filter sessions, use the configured select navigation keys,
and press enter to resume the highlighted session. The current session is marked
with `●`.

You can also resume a known session path directly:

```text
/sessions /path/to/session.jsonl
```

In non-interactive modes, `/sessions` prints matching project session paths.

## How it works

The extension registers the `/sessions` command. It asks pi's `SessionManager`
for sessions in the current project, sorts them by modification time, and builds
labels from the session name or first message. In the TUI it renders a custom
overlay component with filtering, paging, and keybinding-aware navigation.

When a session is selected, the extension waits for pi to become idle and then
calls `ctx.switchSession()` to resume the selected session safely.
