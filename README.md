# Loggly MCP

Read-only **Model Context Protocol (MCP) server** for Loggly `/apiv2/*` APIs. This server exposes Loggly search, analytics, and field tools while blocking write endpoints.

---

# Skill Usage

For efficient log retrieval (less token use) and summarization, pair this server with a skill.

---

# Quickstart

```bash
git clone https://github.com/gsdktly/loggly-mcp.git
cd loggly-mcp
npm install
cp .env.example .env
```

Edit `.env` with your Loggly credentials, then run:

```bash
npm start
```

Once the repo is trusted in Codex, the MCP server can also be started automatically via `.codex/config.toml`.

---

# Configuration

The server loads `.env` from its working directory on startup.

## Required

- `LOGGLY_SUBDOMAIN`  
  Loggly account subdomain or full Loggly URL (e.g. `your-subdomain` or `https://your-subdomain.loggly.com`)
- `LOGGLY_TOKEN`  
  Loggly API token

## Optional

- `LOGGLY_AUTH_MODE`  
  `bearer` (default) or `basic`
- `LOGGLY_MAX_RETRIES`  
  Default: `2`
- `LOGGLY_REQUEST_TIMEOUT_MS`  
  Default: `15000`
- `LOGGLY_LOG_LEVEL`  
  `error`, `warn`, `info` (default), or `debug`

---

# Logging

Logs are written to **stderr** to avoid interfering with MCP stdio traffic.  
Use `LOGGLY_LOG_LEVEL` to control verbosity. Default is `info`.

---

# Timeouts & Retries

Requests enforce a per-call timeout of `LOGGLY_REQUEST_TIMEOUT_MS` (default `15000`).  
Transient failures (`500` with timeout-like body, `503`, `504`, or network timeouts) are retried up to `LOGGLY_MAX_RETRIES` times with exponential backoff.

---

# Tool Manifest

Tool metadata is stored in `tool-manifest.json` and verified against `src/index.js`.

```bash
npm run verify:manifest
```

---

# Smoke Test

Smoke test runs without Loggly credentials by setting `LOGGLY_SMOKE_TEST=1`.

```bash
npm run smoke
```

---

# Implemented MCP Tools

- `connection_test`
- `create_search`
- `get_events`
- `search_and_get_events`
- `iterate_events_page`
- `iterate_events_next`
- `count_events`
- `volume_metrics`
- `stats_query`
- `list_fields`
- `field_facets`
- `raw_api_call`

---

# Examples

Example tool argument payloads are in `examples/`.

---

# Development

```bash
npm test
```

`npm test` runs manifest verification and the smoke test. CI runs the same checks in `.github/workflows/ci.yml`.

---

# Versioning

- `VERSION` contains the current release version.
- `CHANGELOG.md` tracks changes by release.

---

# Security Notes

- `.env` files must never be committed.
- Tokens are treated as secrets.
- This server enforces **read-only** access to Loggly `/apiv2/*` endpoints.
