---
name: ideation
description: "Turns vague product or implementation goals into concise pre-build alignment checks by surfacing desired behavior, hidden assumptions, design choices, disappointment risks, and the smallest validation slice. Use when the user is ideating, has a vague goal, asks not to write code yet, wants hidden decisions surfaced, or needs alignment before building."
---

# Ideation

## Quick start
When the user has a vague implementation goal, do not write code yet. Surface the
choices that would otherwise be made implicitly, then ask for alignment.

Return exactly:

1. The product behavior you think the user wants.
2. The architectural assumptions you are making.
3. The UX/API/design choices you would otherwise decide yourself.
4. The parts most likely to disappoint the user.
5. The smallest concrete slice to build to test alignment.

Keep it concise. Do not propose a full project plan.

## Workflow
1. Restate the intended behavior in concrete user-facing terms.
2. Separate facts from assumptions.
3. List decisions that need user preference, especially defaults, edge cases,
   data model, persistence, errors, naming, scope, and non-goals.
4. Identify likely disappointment risks from ambiguity, tradeoffs, missing
   polish, migration burden, or surprising behavior.
5. Propose one small buildable slice that exercises the riskiest assumptions.

## Response style
Use short bullets under the five required headings. Ask only the highest-value
clarifying questions after the five sections, if needed. Stay pre-implementation
unless the user explicitly approves building.
