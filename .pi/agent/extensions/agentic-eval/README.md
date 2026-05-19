# Agentic Eval

Evaluate a model by asking a fresh pi agent to recreate a single committed
change from a reviewed task spec.

The intended workflow is local and exploratory: point the extension at a commit
that already implements a feature, let it draft a fair spec from that commit,
review/edit the spec, then run a blind agent from the parent commit and inspect
whether it can recreate the behavior.

## Commands

```text
/agentic-eval commit <sha> [key=value...]
/agentic-eval run <eval.json|eval-dir> [key=value...]
```

`commit` generates a spec from a single non-merge commit, opens it for human
review, creates an isolated baseline checkout from the parent commit, runs a
fresh pi child agent, and optionally runs a verifier command.

`run` reuses a saved eval directory and approved `spec.md` to produce another
trial. This is the normal path for repeated stochastic runs.

## Examples

Generate a new eval from the latest commit:

```text
/agentic-eval commit HEAD
```

Generate an eval with a deterministic verifier:

```text
/agentic-eval commit abc123 verify="npm test"
```

Rerun the same approved spec/config:

```text
/agentic-eval run ~/.pi/agent/agentic-evals/my-repo-1234/run/eval.json
```

Try a different model for one rerun:

```text
/agentic-eval run ./eval.json model=anthropic/claude-sonnet-4-5
```

Keep the trial checkout for manual inspection:

```text
/agentic-eval run ./eval.json keepWorktree=true
```

## Options

```text
model=provider/model
verify="npm test"
tools=read,bash,edit,write,grep,find,ls
timeout=15m
verifyTimeout=2m
keepWorktree=true
out=/path/to/eval-dir
```

- `model`: model used by the blind child agent. Defaults to the active model
  when the eval is created.
- `verify`: optional shell command run after the agent finishes. Empty means
  manual-review/unscored.
- `tools`: comma-separated pi tools exposed to the child agent.
- `timeout`: max runtime for the child agent. Default: `15m`.
- `verifyTimeout`: max runtime for the verifier. Default: `2m`.
- `keepWorktree`: keep the isolated checkout after the run. Default: `false`.
- `out`: explicit eval directory for newly created evals.

Options passed to `run` apply to that trial without rewriting the saved eval
manifest defaults.

## Human review step

The generated spec is intentionally not trusted automatically. Before the blind
agent runs, pi opens the generated markdown in an editor. Use this step to:

- remove implementation details that make the task too easy,
- add missing behavior that the diff implies but does not explain well,
- clarify acceptance criteria,
- add or adjust verifier guidance,
- mark ambiguity or unfairness in the fairness notes.

The approved `spec.md` is the canonical eval input for future reruns.

## Scoring

A trial has one of these statuses:

- `passed`: the child agent exited successfully and the verifier exited `0`.
- `failed`: the child agent exited successfully but the verifier failed or timed
  out.
- `unscored`: no verifier was configured. Inspect artifacts manually.
- `agent_failed`: the child agent failed or timed out before verification.

Diff similarity is not used as a score. The generated patch is only an artifact
for human review.

## Safety model

The trial checkout is built from `git archive` at the parent commit, then
initialized as a fresh git repository with a single `baseline` commit. It is not
a git worktree and it does not share the original repository object database.
This is meant to reduce leakage from the hidden target commit.

This is still a local process with normal filesystem permissions. The prompt
instructs the child agent not to inspect parent directories, benchmark
artifacts, or hidden git history, but the extension is not a system sandbox.

## Output

Each eval directory contains:

- `spec.md`: approved task spec
- `eval.json`: saved eval metadata and trial records
- `trials/<id>/events.jsonl`: child agent JSON-mode events
- `trials/<id>/agent-stderr.txt`: child agent stderr
- `trials/<id>/attempt.patch`: resulting diff, including untracked files
- `trials/<id>/status.txt`: final git status
- `trials/<id>/final.txt`: final child-agent text, when available
- `trials/<id>/verifier.txt`: verifier output when configured
- `trials/<id>/summary.md`: trial summary

## Suggested workflow

For multi-commit features, create a temporary branch and squash the feature into
a single commit. Then run `agentic-eval commit <sha>` against that squashed
commit. This keeps v1 simple while still supporting realistic feature slices.

Use deterministic verifiers when possible, but do not overtrust weak tests. For
UI-heavy or under-tested changes, treat the result as `unscored` or supplement
with a custom smoke-test command.

## Limitations

- Only single non-merge commits are supported.
- PRs, file targets, and freeform descriptions are not supported yet.
- Verifier quality determines score quality.
- The generated spec can still be too revealing or too vague without review.
- Child agent and verifier output are currently buffered in memory.
- The isolated checkout is not a full OS-level sandbox.
