# Exa extension

Adds Exa-powered web search tools for the agent.

## Setup

Set an Exa API key before starting pi:

```sh
export EXA_API_KEY=...
```

## Usage

The agent gets two tools:

- `exa_search`: searches the web with Exa. It supports auto, neural, and
  keyword search, result limits, domain filters, date filters, and optional
  page text or highlights.
- `exa_contents`: fetches extracted contents for Exa result IDs or URLs when
  search snippets are not enough.

Ask pi questions that need current web information, or explicitly ask it to
search with Exa.

## How it works

The extension registers both tools with typebox schemas. Tool calls are POSTed
to the Exa `/search` or `/contents` API using `EXA_API_KEY`. Responses are
returned as formatted JSON. Large responses are truncated to pi's standard tool
limits, and the full JSON is saved to a temporary file when truncation happens.
