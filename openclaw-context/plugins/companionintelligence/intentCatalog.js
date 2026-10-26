/**
 * CI Intent catalog client (the reference harness consumer).
 *
 * Historically each CI harness re-implemented its own integration glue. CI-Server
 * now publishes ONE curated, typed, domain-organized capability catalog at
 * `GET /api/agent/intents` (legacy alias `/api/intents`; also an
 * `intents://catalog` MCP resource). This module lets
 * OpenClaw consume that shared catalog so the agent prefers the curated,
 * privacy-labelled intents over raw CRUD, and so adding capabilities upstream
 * automatically reaches the harness.
 *
 * Pure + dependency-free so it is unit-testable without the OpenClaw runtime:
 * `fetchIntentManifest` takes a `getJson(path)` function (the plugin passes its own
 * authenticated requestJson; tests pass a mock).
 */

/**
 * Fetch the CI Intent manifest. Returns the manifest object, or `null` if the
 * catalog is unavailable or malformed (never throws — discovery must degrade
 * gracefully when CI-Server is unreachable).
 *
 * Degrading quietly is what made CI-Server#1684 survive for months: every
 * CATALOG_PATH 404'd through the appliance gateway (which strips `/api` while
 * the controller had baked it in), this returned `null`, and the agent fell
 * back to raw CRUD with nothing logged anywhere. `onUnavailable` is how the
 * caller gets told — graceful degradation should still be *audible*. It fires
 * only when every candidate path failed, so a legacy-alias fallback that
 * succeeds stays silent.
 *
 * @param {(path: string) => Promise<any>} getJson
 * @param {(failures: string[]) => void} [onUnavailable] called with one
 *   `path: reason` line per candidate when no path yielded a manifest
 * @returns {Promise<object|null>}
 */
// Canonical path first, then the deprecated alias for older CI-Server builds
// that still serve the catalog from /api/intents.
const CATALOG_PATHS = ["/api/agent/intents", "/api/intents"];

export async function fetchIntentManifest(getJson, onUnavailable) {
  const failures = [];

  for (const path of CATALOG_PATHS) {
    try {
      const body = await getJson(path);
      if (body && Array.isArray(body.intents)) {
        return body;
      }
      // A 200 that is not a manifest is its own failure mode, and the one a
      // gateway misroute produces: nginx serves the SPA rather than 404ing,
      // so the body parses but has no intents[].
      failures.push(`${path}: 200 without an intents[] array`);
    } catch (error) {
      failures.push(`${path}: ${String(error?.message || error)}`);
    }
  }

  onUnavailable?.(failures);
  return null;
}

/**
 * Render the catalog as a compact prompt block grouped by schema domain, flagging
 * destructive and external intents so the agent treats them with care. Returns ""
 * for a null/empty manifest.
 *
 * @param {object|null} manifest
 * @returns {string}
 */
export function describeCatalogForPrompt(manifest) {
  if (!manifest || !Array.isArray(manifest.intents) || manifest.intents.length === 0) {
    return "";
  }

  const byDomain = new Map();
  for (const intent of manifest.intents) {
    const list = byDomain.get(intent.domain) || [];
    list.push(intent);
    byDomain.set(intent.domain, list);
  }

  const lines = [
    "## Companion Intelligence — Intent catalog",
    "",
    "Prefer these curated, typed actions over raw CRUD. Each intent is listed by its tool name (in backticks).",
    "",
  ];

  for (const [domain, intents] of byDomain) {
    lines.push(`### ${domain}`);
    for (const intent of intents) {
      const flags = [];
      if (intent.privacy && intent.privacy.destructive) flags.push("destructive");
      if (intent.privacy && intent.privacy.external) flags.push("external");
      const suffix = flags.length ? ` _(${flags.join(", ")})_` : "";
      const params = describeParams(intent.parameters);
      lines.push(`- \`${intent.tool}\` — ${intent.title}: ${intent.description}${suffix}${params}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * The parameters of one intent, for its catalog line, so an agent calling it by
 * name through a generic runner knows what to pass: each one's JSON type (an
 * array's item type too, since `entityIds: "<uuid>"` fails where `["<uuid>"]`
 * works), required ones marked and the allowed values of an enum listed. "" when
 * it takes none.
 *
 * @param {object|undefined} schema the intent's JSON-Schema `parameters`
 * @returns {string}
 */
function describeParams(schema) {
  const properties = (schema && schema.properties) || {};
  const names = Object.keys(properties);
  if (names.length === 0) return "";
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const describe = (name) => {
    const prop = properties[name] || {};
    const notes = [];
    if (typeof prop.type === "string") {
      const itemType = prop.type === "array" && prop.items && typeof prop.items.type === "string" ? prop.items.type : "";
      notes.push(itemType ? `array of ${itemType}` : prop.type);
    }
    if (required.has(name)) notes.push("required");
    if (Array.isArray(prop.enum) && prop.enum.length > 0) notes.push(`one of ${prop.enum.join(", ")}`);
    return notes.length ? `${name} (${notes.join("; ")})` : name;
  };
  return ` Params: ${names.map(describe).join(", ")}.`;
}

/**
 * REST execution path candidates for one intent, mirroring CATALOG_PATHS ordering
 * (canonical agent path first, then the legacy alias). The caller POSTs the tool
 * input JSON to the first path and falls back to the second when the route is
 * missing (HTTP 404 on older CI-Server builds). CI-Server accepts either the
 * dotted intent id (`predictions.forecast`) or the underscored tool name
 * (`predictions_forecast`) in the path.
 *
 * @param {string} intentName
 * @returns {string[]}
 */
export function executePathCandidates(intentName) {
  const name = encodeURIComponent(String(intentName ?? "").trim());
  return CATALOG_PATHS.map((base) => `${base}/${name}/execute`);
}
