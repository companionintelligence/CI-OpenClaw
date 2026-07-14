import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The Dockerfile copies app files ONE BY ONE (no `COPY . /app`), and says so in a comment:
 *
 *   "Copied file-by-file (no COPY . /app), so a new module that is not listed here is missing
 *    from the image and the container dies at boot with MODULE_NOT_FOUND — while working fine
 *    in local dev."
 *
 * That warning is exactly the kind that gets read after the outage. Every local `require()` in
 * server.cjs is a file the image MUST contain; the unit tests all pass without it, and so does
 * `node --check`. Only a real boot would catch it. This test does instead.
 */
describe("every module server.cjs requires is copied into the image", () => {
  const serverSrc = readFileSync(join(ROOT, "server.cjs"), "utf8");
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");

  const required = [...serverSrc.matchAll(/require\("\.\/([^"]+)"\)/g)].map((m) => m[1]);

  test("server.cjs has local requires to check (guards against a vacuous test)", () => {
    assert.ok(required.length > 0, "found no local requires — has the require style changed?");
  });

  for (const mod of required) {
    test(`${mod} exists on disk`, () => {
      assert.ok(existsSync(join(ROOT, mod)), `server.cjs requires ./${mod}, which does not exist`);
    });

    test(`${mod} has a COPY line in the Dockerfile`, () => {
      // The container resolves these __dirname-relative to /app, so the destination must land
      // beside /app/setup-server.cjs.
      const copied = new RegExp(`^COPY\\b.*\\b${mod.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`, "m").test(dockerfile);
      assert.ok(
        copied,
        `server.cjs requires ./${mod}, but no COPY line in the Dockerfile puts it in the image.\n` +
          "The container will die at boot with MODULE_NOT_FOUND, while local dev works fine.",
      );
    });
  }
});
