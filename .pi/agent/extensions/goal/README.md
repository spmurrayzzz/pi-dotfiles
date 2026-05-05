# Goal Extension

Adds a Codex-style `/goal` command for long-running autonomous work.

## Commands

```text
/goal <objective>
```

Starts a goal and immediately begins working toward it.

```text
/goal --tokens 80K <objective>
```

Starts a goal with a loop budget. The budget is not a hard provider limit: the
current turn finishes, then the extension marks the goal `budget_limited` and
queues one wrap-up turn.

```text
/goal
```

Shows the current goal, status, elapsed time, and token usage.

```text
/goal pause
/goal resume
/goal clear
```

Pauses, resumes, or clears the current goal.

## Model tools

The extension exposes these tools to the agent:

- `get_goal`: read the current goal and budget usage.
- `create_goal`: create a goal only when explicitly requested.
- `update_goal`: mark the goal `complete` only after the objective is achieved.

## Behavior

While a goal is active, the extension queues hidden continuation turns after the
agent becomes idle. Continuations ask the agent to choose the next concrete
action, audit completion against real evidence, and call `update_goal` only when
all requirements are satisfied.

If a continuation turn makes no tool calls, automatic continuation is suppressed
so the agent does not spin indefinitely.

Goal state is persisted in the pi session via `appendEntry`, so it survives
reloads and resumes.

## Examples

```text
/goal --tokens 20K create /tmp/pi-goal-test.txt containing success, verify it exists, then mark complete
```

```text
/goal --tokens 60K audit .pi/agent/extensions/goal/index.ts against ./codex, implement the smallest high-value gap, validate it, then mark complete
```
