---
name: modularize
description: Breaks large source files or shallow modules into cohesive modules while preserving behavior and public entry points. Use when refactoring a monolith file, splitting backend/API/UI glue, extracting adapters, reducing route/controller complexity, or when the user asks to modularize, split up, decompose, or untangle code.
---

# Modularize

## Quick start

1. Read the large file, direct callers, and project instructions.
2. Write a short plan with target modules, migration order, validation gates,
   and temporary files that must not be committed.
3. Preserve behavior first: keep public imports working with a shim or update
   every caller in the same change.
4. Extract lowest-risk modules first, validating after meaningful steps.
5. Move stateful orchestration last, behind a small interface.
6. Run build/test/smoke checks.
7. Audit the final tree against the plan before declaring done.

## Extraction order

Prefer this order unless the codebase gives a better seam:

1. Pure helpers: formatting, parsing, validation, DTO/projection helpers.
2. Isolated adapters: filesystem, terminal, network clients, export/rendering.
3. Event hubs: pub/sub, SSE/WebSocket broadcast, notification plumbing.
4. Route/controller dispatch, after helpers and adapters have stable names.
5. Stateful runtime/core: active handles, registries, caches, lifecycle.
6. Composition root: wires modules together and exposes the public entry.
7. Compatibility cleanup: remove shims only after all imports are updated.

## Design rules

- Keep the public interface stable until all callers are migrated.
- Do not let routers/controllers reach into internal maps, registries, or caches.
  Add a runtime/core method like `detail(id)`, `runAction(id, action)`, or
  `state()` instead.
- Do not create pass-through files just to satisfy a target layout. Each module
  should own behavior or a real seam.
- Keep shared mutable state in one module. Export operations, not the state.
- Prefer small extraction commits with passing validation over one large rewrite.
- Preserve error behavior, response shapes, headers, and side effects.
- Mark temporary planning files clearly and remove or leave them untracked before
  commit.

## Validation checklist

Before each extraction:

- Identify all imports/callers of the code being moved.
- Capture behavior that must remain identical: routes, status codes, events,
  file paths, exported names, environment variables, and cleanup/dispose paths.

After each extraction:

- Run the cheapest syntax/build check available.
- Grep for stale imports, duplicate implementations, and leaked internals.
- Smoke-check critical paths that the build cannot prove.

Final audit:

- Target files exist and old monolith is removed or intentionally a shim.
- Callers import the new composition root or retained shim.
- No route/controller module reaches into internal state containers.
- Build/test commands pass.
- Temporary plan files are not staged unless explicitly requested.

## Example module map

For a large HTTP/backend file:

```text
server/api/
  index.js
  router.js
  runtime.js
  sessions.js
  dtos.js
  events.js
  adapters/fs.js
  adapters/ws.js
  export.js
```

Bad router seam:

```js
const handle = runtimeHandles.get(id)
if (handle) return json(res, detailFromHandle(handle))
```

Better router seam:

```js
const detail = await runtime.sessionDetail(id, path)
if (!detail) return json(res, { error: 'Not found' }, 404)
return json(res, detail)
```
