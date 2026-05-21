# pi-dotfiles

Source-controlled pi configuration.

## Extensions

- [`agentic-eval/`](.pi/agent/extensions/agentic-eval/): Run blind
  child-agent evals against reviewed specs generated from committed changes.
- [`eval-tools/`](.pi/agent/extensions/eval-tools/): Native pi tool-call
  eval commands for the active model or model comparisons.
- [`exa/`](.pi/agent/extensions/exa/): Exa web search and page content tools.
- [`goal/`](.pi/agent/extensions/goal/): Codex-style `/goal` command for
  long-running autonomous work with optional token budgets.
- [`message-history/`](.pi/agent/extensions/message-history/): Up/down
  prompt history from prior sessions.
- [`session-manager/`](.pi/agent/extensions/session-manager/): Session naming
  and management commands.
- [`tps/`](.pi/agent/extensions/tps/): Token throughput notification after
  each agent turn.
- [`voice/`](.pi/agent/extensions/voice/): macOS voice dictation commands and
  shortcut support.

## Skills

- [`build-pi-extension`](.pi/agent/skills/build-pi-extension/SKILL.md):
  guidance for building pi extensions.
- [`deep-learning-researcher`](.pi/agent/skills/deep-learning-researcher/SKILL.md):
  deep learning research intern workflow for hypotheses, experiments,
  implementation, aggressive testing, and result analysis.
- [`ideation`](.pi/agent/skills/ideation/SKILL.md):
  concise pre-build alignment checks for vague goals, hidden decisions,
  assumptions, design choices, disappointment risks, and validation slices.
- [`paper-reproducer`](.pi/agent/skills/paper-reproducer/SKILL.md):
  skeptical ML paper reproduction workflow for claim extraction, repo audits,
  executable validation, and conservative reproduction reports.

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
