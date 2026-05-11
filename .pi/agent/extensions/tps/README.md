# TPS extension

Shows token throughput after each agent turn.

## Behavior

When an agent turn finishes in the interactive UI, the extension displays a
notification with output tokens per second and token usage totals:

- output tokens per second
- output and input tokens
- cache read and write tokens
- total tokens
- elapsed turn time

The extension only reports turns with assistant output and does nothing in
non-UI modes.

## Attribution

The original source was taken from:

<https://github.com/earendil-works/pi/blob/3d9e14d7482f4a99d5224926099bec0d17ff86fd/.pi/extensions/tps.ts>
