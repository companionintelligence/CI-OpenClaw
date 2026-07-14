#!/usr/bin/env node
// Schema gate: validate the config we ACTUALLY generate against OpenClaw's OWN schema.
//
// This is the check that generalizes. The unit suite asserts the mistakes we thought to
// assert; this one catches any unrecognized key, including ones nobody anticipated and
// ones a future openclaw release starts rejecting. OpenClaw's schema is strict — a
// single unknown key invalidates the ENTIRE openclaw.json, after which `doctor --repair`
// quarantines the file and restores last-known-good, silently reverting the model
// catalog, memory wiring and gateway token written in the same pass.
//
// Every config below comes from the REAL reconcileConfig() run against a temp data dir
// and a stub Ollama — never a hand-written fixture, which would only catch drift someone
// remembered to encode.
//
// The gate does not take its own correctness on faith. It validates two deliberately
// corrupted CANARIES and requires them to be REJECTED. If a canary comes back clean the
// gate is not gating (wrong flag, silent no-op, OPENCLAW_CONFIG_PATH ignored) and the
// run fails loudly rather than passing green forever.
//
// Run: npm run test:schema      (needs the `openclaw` binary on PATH)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  makeDataDir,
  makeReconciler,
  withOllama,
  readCfg,
  rmDir,
  CATALOG,
  OLLAMA_DOWN,
} from "./helpers/reconcile-fixture.mjs";

const OUT =
  process.env.SCHEMA_GATE_OUTDIR ||
  fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "schema-gate-"));
fs.mkdirSync(OUT, { recursive: true });

// A HOME the CLI can scribble state into without touching the developer's own.
const FAKE_HOME = path.join(OUT, "home");
fs.mkdirSync(FAKE_HOME, { recursive: true });

function haveOpenclaw() {
  return spawnSync("openclaw", ["--version"], { encoding: "utf8" }).status === 0;
}

if (!haveOpenclaw()) {
  const hint =
    "install it with:\n" +
    "  npm i -g \"openclaw@$(grep -oE 'openclaw@[0-9]+(\\.[0-9]+)*' Dockerfile | head -n1 | cut -d'@' -f2)\"";
  if (process.env.CI) {
    // CI must never silently skip the only check that catches an unrecognized key.
    console.error(`FATAL: the openclaw binary is not on PATH and CI is set.\n${hint}`);
    process.exit(2);
  }
  console.log(`SKIPPED: the openclaw binary is not on PATH.\n${hint}`);
  process.exit(0);
}

// doctor --lint runs RUNTIME checks alongside the schema check — it will, for example,
// try to dial mcp.servers.ci-hub and enumerate its tools. In CI there is no Hub to dial,
// and an unreachable endpoint is not a malformed config. Only the schema check is a
// verdict on the shape of the file, so only its findings gate.
const SCHEMA_CHECK_ID = "core/doctor/final-config-validation";

/**
 * Ask OpenClaw whether a config file is schema-valid.
 *
 * Two independent commands, because neither alone is quite the right oracle:
 *   - `config validate` is the direct schema verdict: {valid, issues}. Authoritative.
 *   - `doctor --lint` is read-only (no prompts, no repair, no rewrites — it cannot
 *     quarantine our fixture) and has a documented exit contract (0 clean / 1 finding /
 *     2 runtime failure). Its findings are filtered to the schema check, so a Hub we
 *     cannot reach from CI does not masquerade as an invalid config.
 *
 * A config is rejected if EITHER oracle finds a schema problem.
 */
function validate(file) {
  const run = (args) => {
    const r = spawnSync("openclaw", args, {
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        OPENCLAW_CONFIG_PATH: file,
        HOME: FAKE_HOME,
        NO_COLOR: "1",
      },
    });
    let parsed = null;
    try {
      parsed = JSON.parse(r.stdout);
    } catch {
      /* not JSON — the text scan below still applies */
    }
    return { status: r.status, blob: `${r.stdout ?? ""}\n${r.stderr ?? ""}`, parsed };
  };

  const check = run(["config", "validate", "--json"]);
  const lint = run(["doctor", "--lint", "--severity-min", "error", "--json"]);

  // Guard with Array.isArray, not just `?? []`: a future CLI that emits one of these
  // fields as a non-array object would make the spread/filter throw an opaque
  // TypeError instead of producing a verdict.
  const asArray = (v) => (Array.isArray(v) ? v : []);
  const schemaFindings = asArray(lint.parsed?.findings).filter(
    (f) => f.checkId === SCHEMA_CHECK_ID,
  );
  const issues = [...asArray(check.parsed?.issues), ...asArray(check.parsed?.errors)];
  const findings = [...issues, ...schemaFindings];

  // `config validate` exiting non-zero, or saying valid:false, is decisive. doctor's
  // exit code is NOT — it also trips on runtime findings we deliberately ignore.
  const rejected =
    check.status !== 0 ||
    check.parsed?.valid === false ||
    findings.length > 0 ||
    /invalid config|unrecogni[sz]ed key|unknown key/i.test(check.blob);

  return { rejected, findings, blob: `${check.blob}\n${lint.blob}`.trim() };
}

// --- scenarios: every env permutation that switches a whole config block on ---------
const MEM = {
  CI_SERVER_URL: "http://ci-server:3030",
  CI_SERVER_TOKEN: "mem-token",
  EMBEDDINGS_MODEL: "nomic-embed-text",
};
// The Hub mints these three together (app.helpers.ts) and injects them as one set, so the
// fixture carries all three. HUB_WAKE_SECRET is what turns on the native wake hook
// (hooks.enabled + hooks.token) — keeping it here is what puts those keys in front of
// OpenClaw's schema rather than trusting the type defs. CI-Hub#897.
const HUB = {
  HUB_URL: "https://hub.example",
  HUB_MCP_API_KEY: "hub-key",
  HUB_WAKE_SECRET: "hub-wake-secret",
};
const SMALL_MODEL = { "llava:7b": { capabilities: ["vision"], contextLength: 4096 } };

// A config an older build would have left behind, to prove an upgrade in place stays
// valid: a token we must reuse, a primary model that is no longer installed, and a stale
// ci-hub entry in the model map. (No `wizard` block — that is written by `openclaw
// onboard`, never by us, and inventing a shape for it would only test the fixture.)
const LEGACY = {
  gateway: { auth: { token: "0".repeat(48), mode: "token" }, mode: "local" },
  agents: {
    defaults: {
      model: { primary: "ci-hub/gone:7b" },
      models: { "ci-hub/gone:7b": {}, "anthropic/claude": {} },
    },
  },
};

const SCENARIOS = [
  { name: "minimal", env: {} },
  { name: "memory", env: MEM },
  { name: "hub-mcp", env: HUB },
  {
    name: "everything",
    env: { ...MEM, ...HUB, DEFAULT_MODEL: "llama3.1:8b", CI_LLM_NUM_CTX: "16384" },
  },
  // num_ctx must get clamped DOWN to the small model's window; an over-large num_ctx is
  // exactly the kind of value the schema (or the model) rejects.
  { name: "capped-num-ctx", env: { CI_LLM_NUM_CTX: "131072" }, catalog: SMALL_MODEL },
  { name: "ollama-offline", env: MEM, offline: true },
  { name: "upgrade-from-legacy", env: { ...MEM, ...HUB }, seed: LEGACY },
  // A hand-edited config with malformed nodes on paths that are INACTIVE here (Ollama
  // down, no creds), so nothing coerces them via a feature path. The reconciler's
  // safety net must still produce a schema-valid file; without it these scalars survive
  // and openclaw quarantines the whole config at boot.
  {
    name: "malformed-inactive-paths",
    env: {},
    offline: true,
    seed: { agents: "legacy-string", tools: "x", hooks: "x", mcp: "nope", plugins: { slots: [] } },
  },
];

/** Produce a config with the real reconciler, and return where it was written. */
async function generate(scenario) {
  const catalog = scenario.catalog ?? CATALOG;
  const run = async (baseUrl) => {
    const dir = makeDataDir({
      config: scenario.seed ?? {},
      env: { OLLAMA_HOST: baseUrl, ...scenario.env },
    });
    try {
      const { cfg } = makeReconciler(dir);
      await cfg.reconcileConfig();
      const config = readCfg(dir);
      const file = path.join(OUT, `${scenario.name}.json`);
      fs.writeFileSync(file, JSON.stringify(config, null, 2));
      return { file, config };
    } finally {
      rmDir(dir);
    }
  };
  return scenario.offline ? run(OLLAMA_DOWN) : withOllama(catalog, run);
}

// --- run ---------------------------------------------------------------------------
console.log(`openclaw: ${spawnSync("openclaw", ["--version"], { encoding: "utf8" }).stdout.trim()}`);
console.log(`configs:  ${OUT}\n`);

let failures = 0;
let richest = null;

for (const scenario of SCENARIOS) {
  const { file, config } = await generate(scenario);
  const result = validate(file);
  if (scenario.name === "everything") richest = config;

  if (result.rejected) {
    failures++;
    console.log(`  ✗ ${scenario.name}`);
    for (const f of result.findings) {
      console.log(`      ${f.path ?? f.instancePath ?? "?"}: ${f.message ?? JSON.stringify(f)}`);
    }
    if (!result.findings.length) console.log(`      ${result.blob.slice(0, 400)}`);
  } else {
    console.log(`  ✓ ${scenario.name}`);
  }
}

// --- canaries: prove the detector actually fires -------------------------------------
// Without this, a gate that silently stopped validating (wrong flag, ignored
// OPENCLAW_CONFIG_PATH, a CLI that no longer errors) would pass green forever and we
// would trust it.
function canary(label, mutate) {
  if (!richest?.models?.providers?.["ci-hub"]?.models?.length) {
    console.error(
      `\nFATAL: cannot run the "${label}" canary — the "everything" scenario did not ` +
        "produce a ci-hub model catalog to corrupt, so the self-test base is missing.",
    );
    process.exit(2);
  }
  const config = structuredClone(richest);
  mutate(config);
  const file = path.join(OUT, `canary-${label}.json`);
  fs.writeFileSync(file, JSON.stringify(config, null, 2));

  const result = validate(file);
  if (!result.rejected) {
    console.error(
      `\nFATAL: the schema gate is not actually validating — the "${label}" canary passed.\n` +
        "A config we KNOW is invalid was accepted, so a green run here proves nothing.\n" +
        result.blob.slice(0, 600),
    );
    process.exit(2);
  }
  console.log(`  ✓ canary "${label}" correctly rejected`);
}

console.log("\ncanaries (a green gate must reject these):");
// The exact regression that shipped: `options` where the schema says `params`.
canary("options-instead-of-params", (config) => {
  const model = config.models.providers["ci-hub"].models[0];
  model.options = { num_ctx: model.params?.num_ctx ?? 4096 };
  delete model.params;
});
canary("unrecognized-gateway-key", (config) => {
  config.gateway.totallyBogusKey = true;
});

console.log(
  `\n${SCENARIOS.length - failures}/${SCENARIOS.length} generated configs valid` +
    (failures ? ` — ${failures} REJECTED by openclaw's schema` : ""),
);
process.exit(failures === 0 ? 0 : 1);
