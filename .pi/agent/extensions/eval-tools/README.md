# Eval tools extension

Runs native pi tool-call eval suites against the current model or multiple
models.

## Usage

Run the default suite against the active model:

```text
/eval-tools
```

Run a preset:

```text
/eval-tools quick
/eval-tools smoke
/eval-tools edit-stress
```

Override options with `key=value` pairs:

```text
/eval-tools smoke trials=5 concurrency=2 timeout=180000
/eval-tools cases=read,write export=reports/tool-eval.json html=reports/tool-eval.html
```

Compare two or more models:

```text
/eval-tools-compare anthropic/claude-sonnet-4-5 openai/gpt-5 trials=3
```

Supported options:

- `trials`: runs per case.
- `timeout`: per-run timeout in milliseconds.
- `cases`: comma-separated case names.
- `concurrency`: parallel eval workers.
- `suite`: path to a custom TOML suite.
- `export`: JSON report path.
- `html`: HTML report path.
- `keepFailures=true`: keep failed run temp directories.

## Suites

The bundled `native-tools.toml` suite covers basic `read`, `write`, `edit`, and
`bash` behavior, plus edit-focused stress cases.

Custom suites can define defaults, presets, cases, setup files, and expected
answer or file assertions. Pass them with `suite=/path/to/suite.toml`.

## How it works

The extension registers `/eval-tools` and `/eval-tools-compare`. Each eval run
spawns `pi --mode json` in a temporary directory with only the requested native
tools enabled, parses the emitted JSON events, validates the required tool use
and task result, then reports pass rates and failure categories. Interactive
runs show a cancellable progress UI; non-interactive runs emit a report message.
