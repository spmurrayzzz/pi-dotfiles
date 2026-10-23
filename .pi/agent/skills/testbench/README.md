# Testbench

Create and run repeatable evaluations with pi. Testbench supports agent tasks,
conversation replay, structured mock tools, and ordinary command-line programs.

Evaluated pi sessions run inside fresh QEMU Linux guests. The host handles model
transport, VM lifecycle, and grading of returned data. It does not dispatch the
evaluated agent's tools.

## Invocation

Install through this repository's normal `make install` workflow, then use
`/reload` in an existing pi session.

This skill is manual-only. Invoke it explicitly:

```text
/skill:testbench Create an evaluation for this task with positive and negative cases.
/skill:testbench Replay this conversation and check whether the agent requests permission before publishing.
/skill:testbench Compare these models using the same saved cases and checks.
```

The skill instructions are in [SKILL.md](SKILL.md).

## Requirements

- Node.js 22.19 or newer and an installed pi SDK.
- A maintained, security-patched QEMU 9.2 or newer.
- A macOS host with HVF or a Linux host with KVM for hardware acceleration.
- An `arm64` or `x64` host and a matching guest image.
- A configured pi provider for model evaluations. Codex uses pi's
  `openai-codex` provider, not a standalone Codex CLI.

Linux requires access to `/dev/kvm` and a QEMU build with seccomp support.
Testbench does not install QEMU or change host permissions automatically.
There is no software-emulation or unsandboxed fallback.

## Prepare a guest

Run the following commands from this skill directory:

```sh
node scripts/prepare-guest.mjs
```

The optional helper downloads and verifies Alpine inputs, then caches a Linux
kernel and initramfs with Node.js and Bash. Setup uses the network; evaluation
does not download guest assets.

To use an existing compatible image, pass `--guest-dir directory` to the runner.
The required image format is described in the [format reference](references/format.md).

## Run saved cases

Validate a suite without calling a model or starting a VM:

```sh
node scripts/run.mjs --suite examples/push-permission/suite.json --validate
```

Run a model evaluation. Replace `provider/model` with a configured pi model:

```sh
node scripts/run.mjs --suite examples/push-permission/suite.json --model provider/model
```

Repeat `--model` to compare models. Use `--case case-id` to select cases and
`--repeat n` for repeated trials.

Run the included program case without a model:

```sh
node scripts/run.mjs --suite examples/file-task/suite.json --case sort-program
```

Results go to a new temporary directory by default. Use `--out directory` to
choose a new output directory. It must not already exist.

## Cases and results

Each case supplies its inputs, optional conversation history, fixture state,
and deterministic assertions. Mock fixtures expose structured tools with
persistent state. Real command cases operate on files inside the guest.

A run records the input manifest, per-trial tool traces and state, model usage,
and aggregate results. Status is `pass`, `fail`, or `inconclusive`; an execution
error is not automatically a behavioral failure.

Pi handles generation settings and transport normally. Cases can explicitly
supply `thinkingLevel` or a `pi` settings object. Token usage is telemetry,
not a provider restriction or billing guarantee.

See [references/format.md](references/format.md) for the suite schema, mock
adapter interface, assertions, options, and artifact fields.

## Checks and limitations

Run the deterministic harness checks after preparing the guest:

```sh
node scripts/self-test.mjs
```

These checks use QEMU but make no external model calls. Repository installer
checks run separately with `make test` from the repository root.

Guests have no external network interface or host filesystem mounts. Model
credentials remain on the host. Guest-local loopback is available for tests.
This boundary covers evaluated agents, not the authoring pi session.

All guests run Linux, so this does not test native macOS applications.
Runtime validation currently covers macOS on Apple Silicon. Linux and Intel macOS
launch paths still need runtime validation. Model outputs remain nondeterministic,
and passing cases do not prove behavior outside the tested contract.

Keep generated results and cached guest images outside the repository. Review
result files for private data before sharing them.
