# pi-dotfiles

Source-controlled pi configuration.

## Contents

- [`exa.ts`](.pi/agent/extensions/exa.ts): Exa web search and page content tools.
- [`message-history.ts`](.pi/agent/extensions/message-history.ts): Up/down
  prompt history from prior sessions.
- [`voice/`](.pi/agent/extensions/voice/): macOS voice dictation commands and
  shortcut support.
- [`build-pi-extension`](.pi/agent/skills/build-pi-extension/SKILL.md):
  guidance for building pi extensions.

## Install

```sh
make install
```

This copies everything under this repo's `.pi/` directory into `~/.pi/`.
Existing changed files are backed up under:

```text
~/.pi/.install-backups/<timestamp>/
```

JSON config files are merged instead of blindly overwritten.

To install into a different pi home:

```sh
make install PI_HOME=/path/to/.pi
```

## Test

```sh
make test
```
