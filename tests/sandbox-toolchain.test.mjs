import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The agent runs its shell commands inside this image. The README's "Sandbox toolchain"
 * section promises python3 + pip + venv + uv with pytest/httpx preinstalled, and the apt shim
 * tells the agent to use them. A bare `python3` from Debian is the minimal split (no pip, no
 * ensurepip, `python3 -m venv` fails), which is how a real coding task ended with "unable to run
 * the tests (missing pip/python packages)". None of the unit tests would notice a package
 * dropping off the apt line; this one reads the Dockerfile the way that task read the sandbox.
 */
describe("the Dockerfile keeps the Python toolchain the README promises", () => {
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  // Fold backslash continuations and drop comment lines so package lists can be matched as one
  // string regardless of how they are wrapped.
  const flat = dockerfile
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n")
    .replace(/\\\n\s*/g, " ");
  const aptLine = flat.split("\n").find((line) => /^RUN apt-get update/.test(line));

  test("there is a single apt-get install line to inspect", () => {
    assert.ok(aptLine, "no `RUN apt-get update …` line found");
  });

  for (const pkg of ["python3", "python3-pip", "python3-venv", "python-is-python3", "python3-pytest", "python3-httpx"]) {
    test(`apt installs ${pkg}`, () => {
      assert.ok(new RegExp(`\\s${pkg}(\\s|$)`).test(aptLine), `${pkg} is missing from the apt-get install line`);
    });
  }

  test("Debian's PEP 668 marker is removed so `pip install` works as the node user", () => {
    assert.ok(/rm -f \/usr\/lib\/python3\*\/EXTERNALLY-MANAGED/.test(aptLine), "EXTERNALLY-MANAGED is not removed");
  });

  test("uv and uvx are copied from the official image, pinned by version and digest", () => {
    const copy = flat.match(/^COPY --from=ghcr\.io\/astral-sh\/uv:(\S+) \/uv \/uvx \/usr\/local\/bin\/$/m);
    assert.ok(copy, "no `COPY --from=ghcr.io/astral-sh/uv:… /uv /uvx /usr/local/bin/` line");
    assert.match(copy[1], /^\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/, `uv ref ${copy[1]} is not <version>@sha256:<digest>`);
  });

  test("/data/.local/bin (pip --user and uv tool entry points) is on PATH", () => {
    const path = flat.match(/^ENV PATH="([^"]+)"/m);
    assert.ok(path, "no `ENV PATH=…` line");
    assert.ok(path[1].split(":").includes("/data/.local/bin"), `PATH lacks /data/.local/bin: ${path[1]}`);
  });

  test("the apt shim tells the agent about pip/venv and uv, not only brew", () => {
    const shim = flat.match(/^RUN printf '([^']*)' \| sudo tee \/usr\/local\/bin\/use-brew/m);
    assert.ok(shim, "no use-brew shim line");
    for (const hint of ["brew install", "python3 -m venv", "pip install", "uv ", "npm install"]) {
      assert.ok(shim[1].includes(hint), `apt shim message does not mention \`${hint}\``);
    }
  });
});
