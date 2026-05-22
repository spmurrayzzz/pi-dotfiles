---
name: code-review
description: Conducts code review for proposed code changes and returns discrete, actionable findings. Use when reviewing diffs, pull requests, branches, commits, or proposed patches for correctness, security, performance, or maintainability issues.
---

# Code Review

## Quick start

1. Read any user-provided review scope, base branch, priorities, or exclusions.
2. Compare the proposed change against the requested base branch, or `develop`
   when no base is specified.
3. Inspect the full affected context, not only the changed lines.
4. Return every finding the author would likely fix if made aware of it.
5. If there are no qualifying findings, say so briefly.

## Review standard

Flag an issue only when all of these are true:

- It meaningfully affects accuracy, performance, security, or maintainability.
- It is discrete and actionable.
- It was introduced by the proposed change, not pre-existing.
- The author would likely fix it if they knew.
- It does not rely on unstated assumptions about intent or the codebase.
- The affected scenario, environment, input, or call path can be identified.
- It is not merely an intentional behavior change.

Do not flag trivial style issues unless they obscure meaning or violate documented
project standards. Do not speculate about possible breakage without identifying
code or behavior that is provably affected.

## Workflow

- Determine the base with user instructions first, otherwise use `develop`.
- Use git commands such as `git diff develop...HEAD` or the user-specified
  comparison to identify changed files.
- Read surrounding code and relevant callers, tests, configuration, migrations,
  and docs needed to prove each finding.
- Keep reviewing after the first issue and report all qualifying findings.
- Prefer no findings over weak or speculative findings.

## Finding format

For each finding include:

- A title beginning with priority, for example
  `[P1] Reject expired tokens before refreshing session`.
- A short inline-review comment, at most one paragraph.
- The shortest useful line range, normally one line and rarely over 5-10 lines.

Priority levels:

- `[P0]`: Drop everything. Blocks release, operations, or major usage; use only
  for universal issues that do not depend on assumptions.
- `[P1]`: Urgent. Should be addressed in the next cycle.
- `[P2]`: Normal. Should be fixed eventually.
- `[P3]`: Low. Nice to have, but still a real bug.

## Comment guidelines

- Explain why the issue is a bug and when it arises.
- Be matter-of-fact, concise, and non-accusatory.
- Do not include unnecessary location details in the comment body.
- Avoid praise, filler, and phrasing like "Great job" or "Thanks for".
- Use one comment per distinct issue.
- Use markdown `suggestion` blocks only for concrete replacement code.
- Keep suggestion blocks minimal and preserve exact leading whitespace.
- Do not change outer indentation in a suggestion unless that is the fix.
