# read-skill

Adds a `read-skill` tool for reading pi skill files through the built-in
`read` implementation without exposing `offset` or `limit` arguments.

Use this when a model needs to inspect a `SKILL.md` file and should read from
the beginning rather than requesting a partial slice.
