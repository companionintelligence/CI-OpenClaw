// The repo's Dockerfile as the suites that check it want to read it: comment lines dropped and
// backslash continuations folded, so one instruction is one line however it is wrapped.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function flatDockerfile() {
  return readFileSync(join(REPO, "Dockerfile"), "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n")
    .replace(/\\\n\s*/g, " ");
}
