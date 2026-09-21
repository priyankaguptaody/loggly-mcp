import {
  McpServer,
  ResourceTemplate
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { ContentLengthStdioServerTransport } from "./contentLengthStdioTransport.js";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnv() {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const text = readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

function normalizeLogLevel(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || LOG_LEVELS[raw] === undefined) {
    return "info";
  }
  return raw;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

function normalizeSubdomain(value) {
  if (!value || !String(value).trim()) {
    return undefined;
  }

  const raw = String(value).trim();
  let host = raw;

  if (/^https?:\/\//i.test(raw)) {
    try {
      host = new URL(raw).hostname;
    } catch {
      return undefined;
    }
  } else if (raw.includes("/")) {
    host = raw.split("/")[0];
  }

  host = host.toLowerCase().replace(/\.$/, "");

  if (host.endsWith(".loggly.com")) {
    host = host.slice(0, -".loggly.com".length);
  }

  if (host.includes(":")) {
    host = host.split(":")[0];
  }

  if (!/^[a-z0-9-]+$/.test(host)) {
    return undefined;
  }

  return host;
}

const config = {
  subdomainRaw: process.env.LOGGLY_SUBDOMAIN,
  subdomain: normalizeSubdomain(process.env.LOGGLY_SUBDOMAIN),
  token: process.env.LOGGLY_TOKEN,
  authMode: (process.env.LOGGLY_AUTH_MODE || "bearer").toLowerCase(),
  maxRetries: parseNonNegativeInt(process.env.LOGGLY_MAX_RETRIES, 2),
  requestTimeoutMs: parseNonNegativeInt(process.env.LOGGLY_REQUEST_TIMEOUT_MS, 15000),
  logLevel: normalizeLogLevel(process.env.LOGGLY_LOG_LEVEL || "info")
};

const SMOKE_TEST = process.env.LOGGLY_SMOKE_TEST === "1";
if (SMOKE_TEST) {
  console.log("Loggly MCP smoke test OK.");
  process.exit(0);
}

function log(level, message, meta) {
  const rank = LOG_LEVELS[level];
  if (rank === undefined || rank > LOG_LEVELS[config.logLevel]) {
    return;
  }

  const parts = ["[loggly-mcp]", level.toUpperCase(), message];
  if (meta !== undefined) {
    try {
      parts.push(JSON.stringify(meta));
    } catch {
      parts.push(String(meta));
    }
  }
  console.error(parts.join(" "));
}

function requireConfig() {
  if (!config.subdomainRaw || !config.token) {
    throw new Error(
      "Missing LOGGLY_SUBDOMAIN or LOGGLY_TOKEN. Set env vars before starting."
    );
  }

  if (!config.subdomain) {
    throw new Error(
      `Invalid LOGGLY_SUBDOMAIN value: "${config.subdomainRaw}". Use just the subdomain (for example "acme") or a *.loggly.com URL.`
    );
  }
}

function buildHeaders() {
  requireConfig();

  if (config.authMode === "basic") {
    const basic = Buffer.from(`${config.token}:`).toString("base64");
    return { Authorization: `Basic ${basic}` };
  }

  return { Authorization: `Bearer ${config.token}` };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringifyBody(body) {
  if (typeof body === "string") {
    return body;
  }

  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function bodyLooksLikeTimeout(body) {
  if (typeof body === "string") {
    return /timeout/i.test(body);
  }

  if (!body || typeof body !== "object") {
    return false;
  }

  const maybeText = [
    body.description,
    body.message,
    body.error,
    body.reason,
    body.detail
  ];

  return maybeText.some((value) => typeof value === "string" && /timeout/i.test(value));
}

function shouldRetry(statusCode, body) {
  if (statusCode === 503 || statusCode === 504) {
    return true;
  }

  if (statusCode === 500 && bodyLooksLikeTimeout(body)) {
    return true;
  }

  return false;
}

async function parseResponseBody(response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return await response.text();
    }
  }

  return await response.text();
}

function buildUrl(path, params = {}) {
  assertReadOnlyPath(path);
  const url = new URL(`https://${config.subdomain}.loggly.com${path}`);

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== "") {
          url.searchParams.append(key, String(item));
        }
      }
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url;
}

function assertReadOnlyPath(path) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error("Loggly path must be an absolute API path starting with `/`.");
  }

  if (!path.startsWith("/apiv2/") && path !== "/apiv2") {
    throw new Error("Only read-only `/apiv2/*` endpoints are allowed.");
  }
}

function shouldRetryNetworkError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error);
  const causeCode =
    typeof error.cause === "object" && error.cause
      ? error.cause.code
      : undefined;

  if (
    causeCode &&
    [
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "EAI_AGAIN",
      "ENETUNREACH",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "UND_ERR_SOCKET"
    ].includes(causeCode)
  ) {
    return true;
  }

  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }

  return /(fetch failed|network|timeout|socket|dns|temporary failure)/i.test(message);
}

function formatNetworkError(url, error) {
  const message = error instanceof Error ? error.message : String(error);
  const causeCode =
    typeof error === "object" &&
    error &&
    typeof error.cause === "object" &&
    error.cause &&
    typeof error.cause.code === "string"
      ? error.cause.code
      : null;

  const details = [
    `Loggly network request failed for ${url.pathname}${url.search}`,
    `subdomain=${config.subdomain}`,
    `timeout_ms=${config.requestTimeoutMs}`
  ];

  if (causeCode) {
    details.push(`code=${causeCode}`);
  }

  details.push(`message=${message}`);
  return details.join(" | ");
}

function ensureTrustedIterateUrl(rawUrl) {
  requireConfig();
  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid `next_url`: unable to parse URL.");
  }

  const expectedHost = `${config.subdomain}.loggly.com`;
  if (url.protocol !== "https:" || url.host !== expectedHost) {
    throw new Error(
      `Refusing next_url outside expected Loggly host (${expectedHost}).`
    );
  }

  if (!url.pathname.startsWith("/apiv2/events/iterate")) {
    throw new Error(
      "Refusing next_url that does not target /apiv2/events/iterate."
    );
  }

  return url;
}

async function fetchWithRetry(url, options = {}) {
  const retryTransient = options.retryTransient !== false;
  const maxRetries = Number.isInteger(options.maxRetries)
    ? options.maxRetries
    : config.maxRetries;

  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    let response;
    try {
      response = await fetch(url, { headers: buildHeaders(), signal: controller.signal });
    } catch (error) {
      if (retryTransient && attempt < maxRetries && shouldRetryNetworkError(error)) {
        log("warn", "Retrying Loggly request after network error.", {
          attempt: attempt + 1,
          max_retries: maxRetries,
          path: url.pathname
        });
        const backoffMs = 300 * 2 ** attempt;
        await sleep(backoffMs);
        continue;
      }

      throw new Error(formatNetworkError(url, error));
    } finally {
      clearTimeout(timeout);
    }

    const body = await parseResponseBody(response);

    if (response.ok) {
      return body;
    }

    if (retryTransient && attempt < maxRetries && shouldRetry(response.status, body)) {
      log("warn", "Retrying Loggly request after transient response.", {
        attempt: attempt + 1,
        max_retries: maxRetries,
        status: response.status,
        path: url.pathname
      });
      const backoffMs = 300 * 2 ** attempt;
      await sleep(backoffMs);
      continue;
    }

    throw new Error(
      `Loggly request failed (${response.status} ${response.statusText}) for ${url.pathname}: ${stringifyBody(body)}`
    );
  }
}

async function logglyGet(path, params = {}, options = {}) {
  requireConfig();
  const url = buildUrl(path, params);
  return fetchWithRetry(url, options);
}

async function logglyGetAbsolute(url, options = {}) {
  requireConfig();
  return fetchWithRetry(url, options);
}

function formatToolResult(data) {
  if (typeof data === "string") {
    return {
      content: [
        {
          type: "text",
          text: data
        }
      ]
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

function getRsidId(searchResponse) {
  const rsid = searchResponse?.rsid;

  if (!rsid) {
    return null;
  }

  if (typeof rsid === "string") {
    return rsid;
  }

  if (typeof rsid === "object" && typeof rsid.id === "string") {
    return rsid.id;
  }

  return null;
}

function eventCountFromResponse(result) {
  return Array.isArray(result?.events) ? result.events.length : 0;
}

const RESOURCE_MIME_TYPE = "application/json";
const toolRegistry = new Map();
const SERVER_VERSION = "0.3.0";

const server = new McpServer({
  name: "loggly-api-mcp",
  version: SERVER_VERSION
});

function registerToolWithResource(name, config, handler) {
  toolRegistry.set(name, {
    name,
    title: config?.title || name,
    description: config?.description || "",
    inputSchema: config?.inputSchema || null,
    handler
  });

  return server.registerTool(name, config, handler);
}

const RESOURCE_TEMPLATES = [
  {
    name: "tool",
    title: "Loggly Tool",
    uriTemplate: "loggly://tool/{name}",
    description: "Metadata for a Loggly MCP tool.",
    mimeType: RESOURCE_MIME_TYPE
  },
  {
    name: "tool-call",
    title: "Loggly Tool Call",
    uriTemplate: "loggly://tool/{name}/call{?arguments_json}",
    description:
      "Call a Loggly MCP tool through resources/read. arguments_json must be a JSON-encoded object.",
    mimeType: RESOURCE_MIME_TYPE
  }
];

registerToolWithResource(
  "connection_test",
  {
    title: "Connection Test",
    description:
      "Validates Loggly credentials by creating a small search and returning the RSID.",
    inputSchema: {
      query: z.string().default("*"),
      from: z.string().default("-15m"),
      until: z.string().default("now"),
      size: z.number().int().min(1).max(5000).default(1)
    }
  },
  async ({ query, from, until, size }) => {
    const data = await logglyGet("/apiv2/search", {
      q: query,
      from,
      until,
      size
    });

    return formatToolResult({
      ok: true,
      subdomain: config.subdomain,
      authMode: config.authMode,
      rsid_id: getRsidId(data),
      search_response: data
    });
  }
);

registerToolWithResource(
  "create_search",
  {
    title: "Create Search",
    description: "Creates a Loggly search and returns its RSID metadata.",
    inputSchema: {
      query: z.string().default("*"),
      from: z.string().default("-24h"),
      until: z.string().default("now"),
      order: z.enum(["asc", "desc"]).default("desc"),
      size: z.number().int().min(1).max(5000).default(50)
    }
  },
  async ({ query, from, until, order, size }) => {
    const search = await logglyGet("/apiv2/search", {
      q: query,
      from,
      until,
      order,
      size
    });

    return formatToolResult({
      query,
      from,
      until,
      order,
      size,
      rsid_id: getRsidId(search),
      search
    });
  }
);

registerToolWithResource(
  "get_events",
  {
    title: "Get Events",
    description:
      "Retrieves event results for a previously-created RSID from /apiv2/events.",
    inputSchema: {
      rsid: z.string(),
      page: z.number().int().min(0).default(0),
      format: z.enum(["json", "raw", "csv"]).optional(),
      columns: z.string().optional()
    }
  },
  async ({ rsid, page, format, columns }) => {
    if (columns && format !== "csv") {
      throw new Error("`columns` requires `format=\"csv\"` per Loggly API behavior.");
    }

    const events = await logglyGet("/apiv2/events", {
      rsid,
      page,
      format,
      columns
    });

    if (typeof events === "string") {
      return formatToolResult(events);
    }

    return formatToolResult({
      rsid,
      page,
      format: format || "json",
      columns: columns || null,
      events
    });
  }
);

registerToolWithResource(
  "search_and_get_events",
  {
    title: "Search And Get Events",
    description:
      "Creates a search then fetches one page from legacy /apiv2/events using the returned RSID.",
    inputSchema: {
      query: z.string().default("*"),
      from: z.string().default("-2h"),
      until: z.string().default("now"),
      order: z.enum(["asc", "desc"]).default("desc"),
      size: z.number().int().min(1).max(5000).default(50),
      page: z.number().int().min(0).default(0),
      format: z.enum(["json", "raw", "csv"]).optional(),
      columns: z.string().optional()
    }
  },
  async ({ query, from, until, order, size, page, format, columns }) => {
    if (columns && format !== "csv") {
      throw new Error("`columns` requires `format=\"csv\"` per Loggly API behavior.");
    }

    const search = await logglyGet("/apiv2/search", {
      q: query,
      from,
      until,
      order,
      size
    });

    const rsid = getRsidId(search);

    if (!rsid) {
      return formatToolResult({
        query,
        from,
        until,
        order,
        size,
        page,
        error: "Search response did not include an RSID.",
        search
      });
    }

    const events = await logglyGet("/apiv2/events", {
      rsid,
      page,
      format,
      columns
    });

    return formatToolResult({
      query,
      from,
      until,
      order,
      size,
      page,
      rsid,
      format: format || "json",
      columns: columns || null,
      search,
      events
    });
  }
);

registerToolWithResource(
  "count_events",
  {
    title: "Count Events",
    description:
      "Calls /apiv2/events/count to return event count and optional volume.",
    inputSchema: {
      query: z.string().default("*"),
      from: z.string().default("-24h"),
      until: z.string().default("now"),
      include_volume: z.boolean().default(false)
    }
  },
  async ({ query, from, until, include_volume }) => {
    const result = await logglyGet("/apiv2/events/count", {
      q: query,
      from,
      until,
      include_volume: include_volume ? "true" : undefined
    });

    return formatToolResult({
      query,
      from,
      until,
      include_volume,
      result
    });
  }
);

registerToolWithResource(
  "iterate_events_page",
  {
    title: "Iterate Events Page",
    description:
      "Calls /apiv2/events/iterate with query parameters and returns the first page plus `next` URL.",
    inputSchema: {
      query: z.string().default("*"),
      from: z.string().default("-24h"),
      until: z.string().default("now"),
      size: z.number().int().min(1).max(1000).default(50),
      order: z.enum(["asc", "desc"]).default("desc")
    }
  },
  async ({ query, from, until, size, order }) => {
    const result = await logglyGet("/apiv2/events/iterate", {
      q: query,
      from,
      until,
      size,
      order
    });

    return formatToolResult({
      query,
      from,
      until,
      size,
      order,
      event_count: eventCountFromResponse(result),
      next_url: result?.next || null,
      result
    });
  }
);

registerToolWithResource(
  "iterate_events_next",
  {
    title: "Iterate Events Next",
    description:
      "Fetches the next page from /apiv2/events/iterate using the exact `next` URL returned by the previous page.",
    inputSchema: {
      next_url: z.string().url()
    }
  },
  async ({ next_url }) => {
    const trustedUrl = ensureTrustedIterateUrl(next_url);
    const result = await logglyGetAbsolute(trustedUrl);

    return formatToolResult({
      event_count: eventCountFromResponse(result),
      next_url: result?.next || null,
      result
    });
  }
);

registerToolWithResource(
  "volume_metrics",
  {
    title: "Volume Metrics",
    description:
      "Calls /apiv2/volume-metrics to retrieve count/volume grouped or filtered by host/app/log type/tag.",
    inputSchema: {
      from: z.string().default("-1h"),
      until: z.string().default("now"),
      group_by: z
        .array(z.enum(["host", "app", "log_type", "tag"]))
        .optional(),
      host: z.array(z.string()).optional(),
      app: z.array(z.string()).optional(),
      log_type: z.array(z.string()).optional(),
      measurement_types: z
        .array(z.enum(["volume_bytes", "count"]))
        .optional()
    }
  },
  async ({
    from,
    until,
    group_by,
    host,
    app,
    log_type,
    measurement_types
  }) => {
    const result = await logglyGet("/apiv2/volume-metrics", {
      from,
      until,
      group_by,
      host,
      app,
      log_type,
      measurement_types
    });

    return formatToolResult({
      from,
      until,
      group_by: group_by || [],
      host: host || [],
      app: app || [],
      log_type: log_type || [],
      measurement_types: measurement_types || ["volume_bytes", "count"],
      result
    });
  }
);

registerToolWithResource(
  "stats_query",
  {
    title: "Stats Query",
    description:
      "Calls /apiv2/stats/<stat_type>/<field> for numeric field statistics.",
    inputSchema: {
      stat_type: z.enum([
        "avg",
        "sum",
        "min",
        "max",
        "percentiles",
        "value_count",
        "cardinality",
        "stats",
        "all",
        "extended"
      ]),
      field: z.string(),
      query: z.string().default("*"),
      from: z.string().default("-24h"),
      until: z.string().default("now")
    }
  },
  async ({ stat_type, field, query, from, until }) => {
    const encodedField = encodeURIComponent(field);
    const result = await logglyGet(`/apiv2/stats/${stat_type}/${encodedField}`, {
      q: query,
      from,
      until
    });

    return formatToolResult({
      stat_type,
      field,
      query,
      from,
      until,
      result
    });
  }
);

registerToolWithResource(
  "list_fields",
  {
    title: "List Fields",
    description:
      "Calls /apiv2/fields/ to return parsed field names in the selected time range.",
    inputSchema: {
      query: z.string().optional(),
      from: z.string().default("-24h"),
      until: z.string().default("now"),
      facet_size: z.number().int().min(1).max(500).default(10)
    }
  },
  async ({ query, from, until, facet_size }) => {
    const result = await logglyGet("/apiv2/fields/", {
      q: query,
      from,
      until,
      facet_size
    });

    return formatToolResult({
      query: query || null,
      from,
      until,
      facet_size,
      result
    });
  }
);

registerToolWithResource(
  "field_facets",
  {
    title: "Field Facets",
    description:
      "Calls /apiv2/fields/<field>/ to return terms and counts for a specific field.",
    inputSchema: {
      field_name: z.string(),
      query: z.string().optional(),
      from: z.string().default("-24h"),
      until: z.string().default("now"),
      facet_size: z.number().int().min(1).max(300).default(10)
    }
  },
  async ({ field_name, query, from, until, facet_size }) => {
    const encodedField = encodeURIComponent(field_name);
    const result = await logglyGet(`/apiv2/fields/${encodedField}/`, {
      q: query,
      from,
      until,
      facet_size
    });

    return formatToolResult({
      field_name,
      query: query || null,
      from,
      until,
      facet_size,
      result
    });
  }
);

registerToolWithResource(
  "raw_api_call",
  {
    title: "Raw API Call",
    description:
      "Makes a GET request to a Loggly API path. Useful while discovering exact endpoint behavior.",
    inputSchema: {
      path: z.string().default("/apiv2/search"),
      paramsJson: z
        .string()
        .default("{\"q\":\"*\",\"from\":\"-15m\",\"until\":\"now\",\"size\":1}")
    }
  },
  async ({ path, paramsJson }) => {
    let params;
    try {
      params = JSON.parse(paramsJson);
    } catch (error) {
      throw new Error(`Invalid paramsJson: ${String(error)}`);
    }

    const data = await logglyGet(path, params);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ path, params, data }, null, 2)
        }
      ]
    };
  }
);

server.registerResource(
  "server-info",
  "loggly://server/info",
  {
    title: "Server Info",
    description: "Loggly MCP server configuration and capability summary.",
    mimeType: RESOURCE_MIME_TYPE
  },
  async (uri) => toReadResourceResult(uri.toString(), buildServerInfo())
);

server.registerResource(
  "tools",
  "loggly://tools",
  {
    title: "Tools",
    description: "All registered Loggly MCP tools and input metadata.",
    mimeType: RESOURCE_MIME_TYPE
  },
  async (uri) =>
    toReadResourceResult(uri.toString(), {
      tool_count: toolRegistry.size,
      tools: listToolMetadata()
    })
);

server.registerResource(
  "resource-templates",
  "loggly://resource-templates",
  {
    title: "Resource Templates",
    description: "Parameterized resource URI templates supported by this server.",
    mimeType: RESOURCE_MIME_TYPE
  },
  async (uri) =>
    toReadResourceResult(uri.toString(), {
      resource_template_count: RESOURCE_TEMPLATES.length,
      resource_templates: RESOURCE_TEMPLATES
    })
);

for (const meta of toolRegistry.values()) {
  const baseUri = `loggly://tool/${encodeURIComponent(meta.name)}`;

  server.registerResource(
    `tool-${meta.name}`,
    baseUri,
    {
      title: `${meta.name} Tool`,
      description: meta.description || "Loggly MCP tool metadata.",
      mimeType: RESOURCE_MIME_TYPE
    },
    async (uri) => toReadResourceResult(uri.toString(), sanitizeToolMetadata(meta))
  );

  server.registerResource(
    `tool-call-${meta.name}`,
    `${baseUri}/call`,
    {
      title: `${meta.name} Tool Call`,
      description:
        "Execute this tool via resources/read. Pass JSON object in ?arguments_json=...",
      mimeType: RESOURCE_MIME_TYPE
    },
    async (uri) => {
      const args = parseArgumentsJson(uri.searchParams.get("arguments_json"));
      const result = await executeToolByName(meta.name, args);
      return toReadResourceResult(uri.toString(), {
        tool: meta.name,
        arguments: args,
        result
      });
    }
  );
}

server.registerResource(
  "tool-call-template",
  new ResourceTemplate("loggly://tool/{name}/call{?arguments_json}", {}),
  {
    title: "Tool Call Template",
    description:
      "Generic Loggly tool call template. Use ?arguments_json=<JSON object> for tool inputs.",
    mimeType: RESOURCE_MIME_TYPE
  },
  async (uri, variables) => {
    const toolName = getTemplateVarString(variables, "name");
    if (!toolName) {
      throw new Error("Tool call template requires {name}");
    }
    const args = parseArgumentsJson(uri.searchParams.get("arguments_json"));
    const result = await executeToolByName(toolName, args);
    return toReadResourceResult(uri.toString(), {
      tool: toolName,
      arguments: args,
      result
    });
  }
);

function buildServerInfo() {
  return {
    name: "loggly-api-mcp",
    version: SERVER_VERSION,
    configured: Boolean(config.subdomain) && Boolean(config.token),
    subdomain: config.subdomain || null,
    auth_mode: config.authMode,
    log_level: config.logLevel,
    max_retries: config.maxRetries,
    request_timeout_ms: config.requestTimeoutMs,
    tool_count: toolRegistry.size,
    resource_template_count: RESOURCE_TEMPLATES.length
  };
}

function listToolMetadata() {
  return [...toolRegistry.values()]
    .map((meta) => sanitizeToolMetadata(meta))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function sanitizeToolMetadata(meta) {
  return {
    name: meta.name,
    title: meta.title || meta.name,
    description: meta.description || null,
    input_fields:
      meta.inputSchema && typeof meta.inputSchema === "object"
        ? Object.keys(meta.inputSchema).sort()
        : []
  };
}

async function executeToolByName(toolName, args) {
  const meta = toolRegistry.get(toolName);
  if (!meta) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const safeArgs =
    args && typeof args === "object" && !Array.isArray(args) ? args : {};
  return meta.handler(safeArgs);
}

function parseArgumentsJson(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    throw new Error("arguments_json must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("arguments_json must decode to a JSON object");
  }

  return parsed;
}

function getTemplateVarString(variables, key) {
  const value = variables?.[key];
  if (Array.isArray(value)) {
    return value.length > 0 ? String(value[0]) : "";
  }
  return value === undefined || value === null ? "" : String(value);
}

function toReadResourceResult(uri, payload) {
  let text;
  try {
    text = JSON.stringify(payload, null, 2);
  } catch {
    text = JSON.stringify({ value: String(payload) });
  }

  return {
    contents: [
      {
        uri,
        mimeType: RESOURCE_MIME_TYPE,
        text
      }
    ]
  };
}

const transport = new ContentLengthStdioServerTransport();
log("info", "Starting Loggly MCP server.", {
  version: SERVER_VERSION,
  configured: Boolean(config.subdomain) && Boolean(config.token),
  subdomain: config.subdomain || null
});
await server.connect(transport);
