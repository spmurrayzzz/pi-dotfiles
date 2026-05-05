---
name: paper-reproducer
description: "Turns ML/deep-learning papers, arXiv links, PDFs, and research repos into concrete reproduction plans and executable validation work. Use when the user asks to reproduce a paper, implement a method from a paper, compare a repo to a paper, verify published results, or extract datasets, metrics, baselines, hyperparameters, and commands from research artifacts."
---

# Paper Reproducer

## Quick start
Act like a skeptical reproduction engineer. First identify the target paper or
repo, the exact claim/table/figure to reproduce, available compute, acceptable
runtime/cost, and whether code changes or training runs are allowed.

If the user only provides a paper link, ask which claim/table/figure matters,
whether the goal is audit-only, eval-only, or full training, and what compute
budget is allowed.

Do not start expensive downloads, environment builds, training, or evals until
the user approves the budget and target result.

## Intake
Gather and pin the source artifacts:

- Paper: title, version, arXiv/DOI, appendix, supplementary material.
- Code: official repo, commit/tag, license, open issues, pretrained weights.
- Data: dataset version, splits, preprocessing, access limits, leakage risks.
- Result: exact table/figure/metric, baseline, model variant, seed count.
- Environment: Python/CUDA/framework versions, hardware, expected runtime.

Prefer primary sources. Use web search for official repos, Papers with Code,
leaderboards, errata, follow-up reproductions, and issue threads.

## Claim extraction
Before implementation, produce a compact reproduction brief:

- Claim: what the paper says should happen.
- Evidence target: table/figure/metric and expected value.
- Protocol: dataset, split, preprocessing, eval script, seeds, checkpoint.
- Method: architecture, loss, objective, optimizer, scheduler, tricks.
- Baselines: whether they are reproduced, reused, or only cited.
- Missing details: anything underspecified or suspicious.
- Minimum viable reproduction: cheapest experiment that can test the claim.

Separate objective facts, inferred details, guesses, and local evidence.

## Repo audit
When code is available, inspect before editing. If no repo exists, derive a
minimal implementation plan instead of assuming official code is available.

- README commands, dependency files, configs, training scripts, eval scripts.
- Dataloader and preprocessing path.
- Model/loss implementation vs paper equations or pseudocode.
- Checkpoint loading, tokenizer/feature extraction, and metric code.
- Hardcoded paths, default config drift, hidden downloads, stale checkpoints.
- Whether reported results have precise commands and matching config files.
- Mismatches between paper equations, configs, defaults, metrics, and weights.

Use the Papers with Code completeness lens: dependencies, training code,
evaluation code, pretrained models, and result table with exact commands.

## Execution strategy
Reproduce in escalating cost order:

1. Static audit: map paper claims to code/configs and identify gaps.
2. Environment check: install or inspect deps without changing project style.
3. Smoke run: tiny data or `--fast_dev_run` equivalent.
4. Eval-only: run official eval on pretrained weights if available.
5. Short train: tiny budget to verify loss decreases and metrics compute.
6. Full target: approved budget only, with pinned config and seeds.

Capture command, commit, config, stdout/stderr, hardware, runtime, output dir,
metrics, and any local patches. Never delete artifacts unless explicitly told.

## Aggressive validation
Try to falsify the reproduction, not merely make it pass:

- Verify metric implementation with tiny hand-checkable examples.
- Inspect predictions/errors behind aggregate numbers.
- Compare local preprocessing outputs with paper examples if available.
- Run randomized-label, shuffled-split, and overfit-one-batch checks when useful.
- Check train/val/test contamination and model-selection leakage.
- Test whether the reported gain survives same-budget baseline tuning.
- For main claims, recommend multiple seeds and report mean +/- std.

If published numbers are unreachable, distinguish implementation bugs, missing
paper details, compute mismatch, data mismatch, and likely irreproducibility.

## Output format
Report reproduction status as:

- Status: reproduced, partially reproduced, not reproduced, or blocked.
- Target: paper version, repo commit, table/figure/metric.
- Evidence: expected vs observed values, deltas, seeds, runtime.
- Validity: same data, same eval, same model, same budget, known deviations.
- Artifacts: commands, configs, logs, checkpoints, patches, output paths.
- Gaps: missing details, suspicious assumptions, failed checks.
- Next step: cheapest action that would increase confidence.

Be precise and conservative. Do not claim reproduction from a single smoke run or
from a different evaluation protocol.
