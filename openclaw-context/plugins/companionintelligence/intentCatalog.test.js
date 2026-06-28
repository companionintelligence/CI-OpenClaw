import test from "node:test";
import assert from "node:assert";

import { fetchIntentManifest, describeCatalogForPrompt, manifestToToolSpecs } from "./intentCatalog.js";

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

test("fetchIntentManifest returns the manifest when valid", async () => {
  const manifest = await fetchIntentManifest(async (path) => {
    assert.equal(path, "/api/intents");
    return MANIFEST;
  });
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

test("describeCatalogForPrompt groups by domain and flags destructive/external", () => {
  const text = describeCatalogForPrompt(MANIFEST);
  assert.match(text, /### memory/);
  assert.match(text, /### media/);
  assert.match(text, /`memory_recall`/);
  assert.ok(text.includes("destructive"), "marks the destructive intent");
  assert.ok(text.includes("external"), "marks the external intent");
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
