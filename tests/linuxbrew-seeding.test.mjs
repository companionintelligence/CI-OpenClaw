import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { flatDockerfile } from "./helpers/dockerfile.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(ROOT, file), "utf8");

/**
 * /home/linuxbrew is its own mount. On a Hub it comes from <app data>/data/linuxbrew, which used
 * to be the same host folder as /data/linuxbrew, so the setup server's copy of the skeleton into
 * $HOME filled it as a side effect. When /data is a named volume (a Windows Hub) the two are
 * separate: that copy landed in the volume and brew was missing. seed-linuxbrew.sh fills the
 * mount itself (tests/seed-linuxbrew.test.sh covers what it does). These checks make sure the
 * image runs it, and that the setup server no longer makes the second copy.
 */
describe("Homebrew is seeded into its own mount", () => {
  const flat = flatDockerfile();

  test("the Dockerfile copies seed-linuxbrew.sh into /app and makes it executable", () => {
    assert.match(flat, /^COPY\b[^\n]*\bseed-linuxbrew\.sh\b[^\n]* \/app\/$/m);
    assert.match(flat, /^RUN sudo chmod \+x [^\n]*\/app\/seed-linuxbrew\.sh\b/m);
  });

  test("the entrypoint seeds Homebrew before it hands over to the setup server", () => {
    const lines = read("entrypoint.sh").split("\n");
    const seed = lines.findIndex((line) => /^\/app\/seed-linuxbrew\.sh\b/.test(line));
    const exec = lines.findIndex((line) => /^exec node \/app\/setup-server\.cjs\b/.test(line));
    assert.ok(seed >= 0, "entrypoint.sh never runs /app/seed-linuxbrew.sh");
    assert.ok(exec > seed, "entrypoint.sh must run seed-linuxbrew.sh before exec'ing the setup server");
  });

  test("the setup server's home copy leaves linuxbrew to the seeding script", () => {
    const initializeHome = read("server.cjs").match(/async function initializeHome\(\) \{[\s\S]*?\n\}\n/);
    assert.ok(initializeHome, "initializeHome() not found in server.cjs");
    assert.match(initializeHome[0], /if \(entry\.name === "linuxbrew"\) continue;/);
  });
});
