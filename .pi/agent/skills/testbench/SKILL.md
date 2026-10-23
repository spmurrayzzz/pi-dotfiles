---
name: testbench
description: Manual-only skill for task, model, and program eval creation, instruction tests, and conversation replay. Use only after explicit /skill:testbench invocation.
disable-model-invocation: true
---

# Testbench

Invoke manually with `/skill:testbench`. Do not select this skill automatically.
Read [references/format.md](references/format.md) before you create or run a suite.
Resolve bundled paths from this skill directory.

## Workflow

1. Agree on the behavior contract and budget first. Define required actions, forbidden actions, failure criteria, models, repetitions, spend, and execution limits.
2. Inspect `examples/file-task/suite.json` for file and program tasks, or `examples/push-permission/` for behavior replay. Choose structured mocks or a real sandbox to match the contract.
3. Construct positive and negative cases. Supply exact instructions, initial state, optional conversation history, and a final prompt. Include authorized success cases so refusal alone cannot satisfy the suite.
4. Self-check fixtures and graders with known passing, failing, modeled-error, and unsupported outcomes. Check semantic events before rejection and negative invariants after interruption. Keep fixture execution inside the sandbox. Use the validation and deterministic self-test helpers below.
5. Freeze the suite, instructions, adapter, installed SDK, dependency versions, and guest image before the run. Keep scoring checks and answer keys out of model-visible inputs. Select an explicit new local output directory. Run sequential trials within the agreed budget.
6. Analyze actual evidence: requested actions, tool results, events, final state, response, usage, and execution problems. Separate behavioral failures from inconclusive trials. Do not infer actions from an assistant's claims alone.
7. Report counts, case-level evidence, cost, and limitations. Review reports for private data before sharing. Model sampling is nondeterministic. One passing run does not prove future safety.

## Choose the execution boundary

- Use `mock` for bounded domain actions with structured, stateful tools. Never provide a generic fake shell.
- Use `sandbox` for real `read`, `write`, `edit`, and `bash` tools, or a program case with command argv.
- Both modes use a fresh QEMU Linux VM. The full evaluated Pi session, agent loop, tool dispatch, and interpretation of tool requests run there. Guest checks precede adapter import and task execution. There is no unsandboxed fallback.
- Host `run.mjs` creates no `AgentSession` and executes no guest tool calls. It manages fixed-model provider transport, VM lifecycle, bounded data-only traces, and deterministic grading.
- The inference-only broker binds the selected model, provider, and endpoint. Pi handles generation settings and transport normally. Token usage is reported, not used to restrict provider support.
- Credentials stay on the host. The guest loads no host skills, extensions, settings, or credentials. Supply every evaluated rule explicitly.
- This authoring chat remains a host agent, outside evaluated-child isolation.
- Every host uses a Linux guest. This does not test native macOS applications.
- The VM has a RAM-only root, 96 MiB `/workspace` tmpfs, 32 MiB `/tmp` tmpfs, 2 vCPUs, and 768 MiB RAM.
- A host RSS polling watchdog terminates QEMU above 2 GiB. This is not a hard kernel memory cap.
- No NICs, host mounts, QMP, or monitor are exposed. Host control uses dedicated serial JSON-RPC. Guest-local loopback remains available.
- The guest agent controller runs as root. Actual shell and program commands run as UID 1000 with CPU, file-size, open-file, and process limits.
- Timeout/limit cleanup kills the whole VM and removes temporary host copies. Graceful SIGINT/SIGTERM closes tracked VMs and removes scratch before exit 130/143. Close is idempotent. SIGKILL and power loss have no cleanup guarantee. Reports remain.
- Keep tests sandboxed and results local. Do not use live remotes or real deployments. Use portable names and paths without private infrastructure details.

## Prepare the guest

Use native, maintained, security-patched QEMU >= 9.2. The version floor is an API requirement, not a security-patch guarantee.
Hardware acceleration is mandatory: macOS HVF or Linux KVM with `/dev/kvm` access and QEMU seccomp.
Hosts must run macOS or Linux on `x64` or `arm64`. Guest architecture must match: `x86_64` or `aarch64`, respectively. Never fall back to TCG.
Execution has been verified on macOS arm64. Linux and macOS x64 lack runtime validation.
No container runtime is required.

Run explicit setup from this skill directory:

```sh
node scripts/prepare-guest.mjs
```

Syntax: `node scripts/prepare-guest.mjs [--arch aarch64|x86_64] [--directory path]`.
Setup downloads official Alpine 3.24.3 minirootfs/checksum files and verifies hardcoded release SHA256 pins. It verifies APKINDEX/APK RSA signatures and resolves Node.js >= 22 and Bash.
Signing keys come from the pinned rootfs. The guest manifest is authoritative for exact package versions and source/output hashes.
The default cache is `~/.cache/testbench/guests/3.24.3/<arch>/`, containing `kernel.bin`, `base.cpio.gz`, and `manifest.json`.
Setup needs network access for Alpine only. Evaluation never downloads guest assets or Pi. Each cache load checks image hashes.
Model cases use the installed Pi SDK bundle, not a standalone provider CLI. Each trial receives a read-only SDK copy.
You can supply an existing compatible image with `--guest-dir`; the Alpine preparation helper is optional.

## Validate and run

Run these commands from this skill directory after contract and budget approval.
The deterministic helper checks the harness. It does not measure model behavior.

```sh
node scripts/self-test.mjs
node scripts/run.mjs --suite examples/push-permission/suite.json --validate
```

`--validate` checks configuration without model execution, SDK packaging, or sandbox execution.
It does not prove startup compatibility or fixture/grader correctness.

Replace `provider/id` with a configured model. The output directory must not exist, and its parent must exist.

```sh
node scripts/run.mjs --suite examples/push-permission/suite.json --model provider/id --out ./push-permission-results-01
```

For another suite, use `node <skill>/scripts/run.mjs --suite <suite.json> --model provider/id --out <new-directory>`. Replace angle-bracket placeholders before execution. Models and cases run sequentially.

Supported controls include repeatable `--model`, `--case`, and `--instructions`, plus `--repeat`, `--thinking`, `--timeout`, `--max-tool-calls`, `--max-inference-calls`, `--sdk`, `--qemu`, and `--guest-dir`.
Use normal Pi defaults unless the suite explicitly supplies `thinkingLevel` or a `pi` settings object. Codex is supported through Pi's `openai-codex` provider.
Instruction files append in order. See the reference for settings, schema, adapter requirements, and evidence files.

## Interpret results

Checks select JSON pointers from snapshot properties plus `events`, `calls`, and `response`.
Use `equals`, `contains`, `exists`, `some`, and `none`. The last two use recursive object-subset matches against arrays.
Raw tool attempts enter `/calls` before validation or execution, including unknown/invalid calls. `executed` starts as `false` and becomes `true` at dispatch. Immutable raw `arguments` stays separate from `executionArguments`.
Forbidden `none` matches can fail for nonexecuted attempts, even after interruption. Host `createTraceRecorder` rejects request/completed-result rewrites and keeps events append-only. Final guest traces must agree.
Otherwise, execution errors, unsupported operations, timeouts, and tool/inference limits are inconclusive.
An ordinary modeled rejection uses `isError: true`. An unsupported operation uses `unsupported: true` and aborts execution.

Exit codes: `0` means all trials pass, `1` means behavioral failure without inconclusive trials, and `2` means inconclusive trials or configuration error.
Inspect `manifest.json` (`guestPiRuntime`), per-case JSON (`agentRuntime`, `inference`), and `results.json`. Report observed failures even when the aggregate exit code is `2`.
Report guest checks, actual QEMU acceleration, runtime/image hashes, and host-recorded provider usage. VM self-reports are evidence, not attestation. Host QEMU, provider client, and runner remain trusted. Preserve the guest image and manifest for comparisons.
A new setup can select different signed package versions. Matching Alpine release names alone do not establish identical images.
