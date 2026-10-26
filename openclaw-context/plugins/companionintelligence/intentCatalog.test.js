import test from "node:test";
import assert from "node:assert";

import {
  fetchIntentManifest,
  describeCatalogForPrompt,
  manifestToToolSpecs,
  executePathCandidates,
} from "./intentCatalog.js";

const MANIFEST = {
  version: "1.0.0",
  domains: [
    { key: "memory", title: "Memory", description: "Recall/remember/forget." },
    { key: "media", title: "Media", description: "Photos and entertainment." },
  ],
  entities: [],
  intents: [
    {
      name: "memory.recall",
      tool: "memory_recall",
      domain: "memory",
      title: "Recall knowledge",
      description: "Recall stored facts.",
      parameters: { type: "object", properties: { personName: { type: "string" } } },
      privacy: { access: "read", sensitivity: "personal", destructive: false, external: false },
      consumes: [],
      produces: ["concept"],
      phrases: [],
    },
    {
      name: "memory.forget",
      tool: "memory_forget",
      domain: "memory",
      title: "Forget knowledge",
      description: "Archive or delete knowledge.",
      parameters: { type: "object" },
      privacy: { access: "delete", sensitivity: "personal", destructive: true, external: false },
      consumes: [],
      produces: [],
      phrases: [],
    },
    {
      name: "media.streamingAvailability",
      tool: "media_streamingAvailability",
      domain: "media",
      title: "Find where to stream",
      description: "Resolve streaming availability.",
      parameters: { type: "object" },
      privacy: { access: "read", sensitivity: "low", destructive: false, external: true },
      consumes: [],
      produces: [],
      phrases: [],
    },
  ],
};

test("fetchIntentManifest prefers the canonical /api/agent/intents path", async () => {
  const seen = [];
  const manifest = await fetchIntentManifest(async (path) => {
    seen.push(path);
    return MANIFEST;
  });
  assert.deepEqual(seen, ["/api/agent/intents"]);
  assert.equal(manifest.intents.length, 3);
});

test("fetchIntentManifest falls back to /api/intents when the agent path 404s", async () => {
  const seen = [];
  const manifest = await fetchIntentManifest(async (path) => {
    seen.push(path);
    if (path === "/api/agent/intents") throw new Error("HTTP 404"); // older CI-Server
    return MANIFEST;
  });
  assert.deepEqual(seen, ["/api/agent/intents", "/api/intents"]);
  assert.equal(manifest.intents.length, 3);
});

test("fetchIntentManifest degrades to null on error or malformed body", async () => {
  assert.equal(
    await fetchIntentManifest(async () => {
      throw new Error("CI-Server down");
    }),
    null,
  );
  assert.equal(await fetchIntentManifest(async () => ({})), null);
  assert.equal(await fetchIntentManifest(async () => null), null);
});

test("fetchIntentManifest reports every failed path when no candidate yields a manifest", async () => {
  // The regression guard for CI-Server#1684: both paths 404'd through the
  // gateway, this returned null, and nothing anywhere said so.
  const reported = [];
  const manifest = await fetchIntentManifest(
    async (path) => {
      throw new Error(`HTTP 404 for ${path}`);
    },
    (failures) => reported.push(...failures),
  );

  assert.equal(manifest, null);
  assert.equal(reported.length, 2);
  assert.match(reported[0], /\/api\/agent\/intents: HTTP 404/);
  assert.match(reported[1], /\/api\/intents: HTTP 404/);
});

test("fetchIntentManifest names a 200 that is not a manifest — the gateway-misroute shape", async () => {
  // nginx serves the SPA rather than 404ing for an unmatched /api path, so the
  // body parses fine and simply has no intents[]. "Malformed" must be a
  // distinguishable reason, not a silent null.
  const reported = [];
  assert.equal(
    await fetchIntentManifest(
      async () => ({ ok: true }),
      (failures) => reported.push(...failures),
    ),
    null,
  );
  assert.equal(reported.length, 2);
  assert.ok(reported.every((line) => line.includes("200 without an intents[] array")));
});

test("fetchIntentManifest stays silent when a fallback path succeeds", async () => {
  let called = false;
  const manifest = await fetchIntentManifest(
    async (path) => {
      if (path === "/api/agent/intents") throw new Error("HTTP 404");
      return MANIFEST;
    },
    () => {
      called = true;
    },
  );

  assert.equal(manifest.intents.length, 3);
  assert.equal(called, false, "a working legacy alias is not a failure worth warning about");
});

test("describeCatalogForPrompt groups by domain and flags destructive/external", () => {
  const text = describeCatalogForPrompt(MANIFEST);
  assert.match(text, /### memory/);
  assert.match(text, /### media/);
  assert.match(text, /`memory_recall`/);
  assert.ok(text.includes("destructive"), "marks the destructive intent");
  assert.ok(text.includes("external"), "marks the external intent");
});

test("describeCatalogForPrompt lists each intent's parameters, marking the required ones", () => {
  // An agent runs intents through one generic tool, so the catalog line is the only
  // place it learns what to pass.
  const text = describeCatalogForPrompt({
    intents: [
      {
        name: "places.find",
        tool: "places_find",
        domain: "places",
        title: "Find places",
        description: "Find places.",
        parameters: { type: "object", properties: { query: {}, maxResults: {} }, required: ["query"] },
      },
      {
        name: "memory.forget",
        tool: "memory_forget",
        domain: "memory",
        title: "Forget",
        description: "Forget.",
        parameters: { type: "object", properties: { entityIds: {}, mode: { enum: ["archive", "archive_and_delete"] } } },
      },
      { name: "a.b", tool: "a_b", domain: "a", title: "None", description: "Takes nothing.", parameters: { type: "object" } },
    ],
  });
  assert.ok(text.includes("`places_find` — Find places: Find places. Params: query (required), maxResults."), text);
  assert.ok(text.includes("Params: entityIds, mode (one of archive, archive_and_delete)."), text);
  assert.ok(text.includes("`a_b` — None: Takes nothing.\n") || text.endsWith("Takes nothing."), text);
  assert.ok(!text.includes("Takes nothing. Params"), text);
});

test("describeCatalogForPrompt returns empty string for a null/empty manifest", () => {
  assert.equal(describeCatalogForPrompt(null), "");
  assert.equal(describeCatalogForPrompt({ intents: [] }), "");
});

test("manifestToToolSpecs maps intents to executable tool specs", () => {
  const specs = manifestToToolSpecs(MANIFEST);
  assert.equal(specs.length, 3);
  assert.equal(specs[0].name, "memory_recall");
  assert.ok(specs[0].parameters);
  assert.deepEqual(manifestToToolSpecs(null), []);
});

test("manifestToToolSpecs carries the dotted intent id, title, and privacy for filtering", () => {
  const specs = manifestToToolSpecs(MANIFEST);
  assert.equal(specs[0].intent, "memory.recall");
  assert.equal(specs[0].title, "Recall knowledge");
  assert.deepEqual(specs[0].privacy, MANIFEST.intents[0].privacy);
  assert.equal(specs[1].privacy.destructive, true);
  assert.equal(specs[2].privacy.external, true);
  // A manifest intent missing privacy maps to null (caller must treat as unexecutable).
  const bare = manifestToToolSpecs({ intents: [{ name: "x.y", tool: "x_y" }] });
  assert.equal(bare[0].privacy, null);
  assert.deepEqual(bare[0].parameters, { type: "object", properties: {} });
});

test("executePathCandidates mirrors CATALOG_PATHS ordering (agent path first)", () => {
  assert.deepEqual(executePathCandidates("predictions.forecast"), [
    "/api/agent/intents/predictions.forecast/execute",
    "/api/intents/predictions.forecast/execute",
  ]);
  // The underscored executable form is an accepted alias on the server.
  assert.deepEqual(executePathCandidates("predictions_forecast"), [
    "/api/agent/intents/predictions_forecast/execute",
    "/api/intents/predictions_forecast/execute",
  ]);
});
