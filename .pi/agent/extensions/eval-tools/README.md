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
/eval-tools cases=read,write json=reports/tool-eval.json html=reports/tool-eval.html
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
- `json`: JSON report path.
- `html`: HTML report path.
- `keepFailures=true`: keep failed run temp directories.

## Suites

The bundled `native-tools.toml` suite covers basic `read`, `write`, `edit`, and
`bash` behavior, plus edit-focused stress cases.

Custom suites can define defaults, presets, cases, setup files, and expected
answer or file assertions. Pass them with `suite=/path/to/suite.toml`.

## Configuration

Suites are TOML files. Top-level fields describe the suite and default case
selection:

```toml
version = 1
name = "native-tool-basics"
defaultCases = ["read", "write", "edit", "bash"]
```

`[defaults]` sets command defaults used when the user does not pass an override:

```toml
[defaults]
trials = 1
timeoutMs = 120000
concurrency = 1
```

`[[presets]]` defines named option bundles. The first positional argument to
`/eval-tools` selects a preset, and explicit `key=value` arguments override it:

```toml
[[presets]]
name = "smoke"
trials = 3
cases = ["read", "write", "edit", "bash"]
```

Each `[[cases]]` entry defines one eval. `tool` is the required tool. `tools`
optionally widens the allowed tool set for that case, for example allowing
`read` before `edit`. `prompt` is sent to a fresh `pi --mode json` subprocess.

```toml
[[cases]]
name = "edit"
tool = "edit"
tools = ["read", "edit"]
prompt = "Use the edit tool to change beta to BETA in sample.txt."
```

`[[cases.setup]]` creates files in the temporary eval directory before the run:

```toml
[[cases.setup]]
file = "sample.txt"
content = """
alpha
beta
gamma
"""
```

`[[cases.expect]]` validates either the final answer or a file after the run:

```toml
[[cases.expect]]
file = "sample.txt"
equals = """
alpha
BETA
gamma
"""
```

Supported expectations are `answerContains`, `answerEquals`, `file` with
`contains`, `file` with `equals`, and `file` with `exists = true`.

Cases can set `expectedFailure` to a failure category when the desired result is
to verify a known failure mode, such as `tool_execution_error` for an ambiguous
edit replacement.

## How it works

The extension registers `/eval-tools` and `/eval-tools-compare`. Each eval run
spawns `pi --mode json` in a temporary directory with only the requested native
tools enabled, parses the emitted JSON events, validates the required tool use
and task result, then reports pass rates and failure categories. Interactive
runs show a cancellable progress UI; non-interactive runs emit a report message.
