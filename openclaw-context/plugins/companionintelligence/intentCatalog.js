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
 * @param {(path: string) => Promise<any>} getJson
 * @returns {Promise<object|null>}
 */
// Canonical path first, then the deprecated alias for older CI-Server builds
// that still serve the catalog from /api/intents.
const CATALOG_PATHS = ["/api/agent/intents", "/api/intents"];

export async function fetchIntentManifest(getJson) {
  for (const path of CATALOG_PATHS) {
    try {
      const body = await getJson(path);
      if (body && Array.isArray(body.intents)) {
        return body;
      }
    } catch {
      // try the next path
    }
  }
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
    "Prefer these curated, typed actions over raw CRUD. Call an intent by its tool name (in backticks).",
    "",
  ];

  for (const [domain, intents] of byDomain) {
    lines.push(`### ${domain}`);
    for (const intent of intents) {
      const flags = [];
      if (intent.privacy && intent.privacy.destructive) flags.push("destructive");
      if (intent.privacy && intent.privacy.external) flags.push("external");
      const suffix = flags.length ? ` _(${flags.join(", ")})_` : "";
      lines.push(`- \`${intent.tool}\` — ${intent.title}: ${intent.description}${suffix}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
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

/**
 * Adapt the manifest intents into OpenClaw tool specs. The caller wires an
 * `execute` handler — e.g. POSTing to CI-Server's REST intent executor
 * (see {@link executePathCandidates}), which runs the same tools MCP exposes.
 * Each spec carries the executable tool name (`name`), the original dotted
 * intent id (`intent`), the JSON-Schema `parameters`, and the `privacy` labels
 * so the caller can filter destructive/external intents before registration.
 *
 * @param {object|null} manifest
 * @returns {Array<{name: string, intent: string, title: string, description: string, parameters: object, privacy: object|null}>}
 */
export function manifestToToolSpecs(manifest) {
  if (!manifest || !Array.isArray(manifest.intents)) {
    return [];
  }

  return manifest.intents.map((intent) => ({
    name: intent.tool,
    intent: intent.name,
    title: intent.title,
    description: intent.description,
    parameters: intent.parameters || { type: "object", properties: {} },
    privacy: intent.privacy && typeof intent.privacy === "object" ? intent.privacy : null,
  }));
}
