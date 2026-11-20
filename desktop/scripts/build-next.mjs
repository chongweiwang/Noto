import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const supplied = process.env.NOTO_REVISION?.trim();
const specifiedRevision = supplied && supplied !== "dev" ? supplied : "";

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() : "";
}

const revision = specifiedRevision || git(["rev-parse", "HEAD"]);
const localChanges = !specifiedRevision && !!revision && !!git(["status", "--porcelain"]);
const result = spawnSync(process.execPath, [require.resolve("next/dist/bin/next"), "build"], {
  stdio: "inherit",
  env: {
    ...process.env,
    NEXT_PUBLIC_NOTO_VERSION: version,
    NEXT_PUBLIC_NOTO_REVISION: revision,
    NEXT_PUBLIC_NOTO_BUILT_AT: new Date().toISOString(),
    NEXT_PUBLIC_NOTO_LOCAL_CHANGES: localChanges ? "1" : "0",
  },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
