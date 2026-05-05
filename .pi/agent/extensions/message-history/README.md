# Message history extension

Adds shell-like prompt history to pi's input editor.

## Usage

Use the normal editor cursor bindings:

- Up: recall older user messages.
- Down: move back toward newer messages or your current draft.

History is available as soon as a session starts. It includes user messages
from this project's existing pi sessions, ordered newest first.

## How it works

On `session_start`, the extension lists project sessions, opens each session
file, extracts user text messages, and sorts them by timestamp. It then replaces
pi's editor component with a small `CustomEditor` subclass. That editor
intercepts the configured cursor up and down keybindings to swap the editor
text with matching history entries, while preserving any unsent draft.

New non-extension user input is added to the in-memory history during the
current run.
