import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";

const posix = process.platform !== "win32";
const SCRIPT = fileURLToPath(new URL("../deploy/local/repo-start.sh", import.meta.url));

interface Fixture {
  dir: string;
  src: string;
  env: NodeJS.ProcessEnv;
  pnpmLog: string;
}

function setup(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "omb-repo-start-"));
  const src = join(dir, "src");
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  const hostSsh = join(dir, "host-ssh");
  const home = join(dir, "home");
  const pnpmLog = join(dir, "pnpm.log");
  for (const d of [src, bin, state, hostSsh, home]) mkdirSync(d, { recursive: true });
  writeFileSync(join(src, "package.json"), "{}\n");
  writeFileSync(join(src, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n");
  writeFileSync(
    join(bin, "pnpm"),
    `#!/usr/bin/env bash\necho "$*" >> "${pnpmLog}"\n`
    + `if [ "$1" = "install" ]; then mkdir -p "${src}/node_modules"; fi\n`
    + `if [ "$1" = "build:server" ]; then mkdir -p "${src}/dist-server"; touch "${src}/dist-server/index.js"; fi\n`
    + `if [ "$1" = "exec" ]; then mkdir -p "${src}/dist"; touch "${src}/dist/index.html"; fi\n`,
  );
  writeFileSync(join(bin, "node"), '#!/usr/bin/env bash\necho "NODE_EXEC $1 GIT_SSH_COMMAND=${GIT_SSH_COMMAND:-unset}"\n');
  for (const f of ["pnpm", "node"]) chmodSync(join(bin, f), 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${process.env.PATH ? `:${process.env.PATH}` : ""}`,
    HOME: home,
    OMB_SRC_DIR: src,
    OMB_STATE_DIR: state,
    OMB_HOST_SSH: hostSsh,
    OMB_CONTAINER_SSH: join(dir, "ssh"),
  };
  return { dir, src, env, pnpmLog };
}

function git(commit: string, cwd: string, env: NodeJS.ProcessEnv): void {
  execFileSync("git", ["init", "-q"], { cwd, env });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd, env });
  execFileSync("git", ["config", "user.name", "test"], { cwd, env });
  execFileSync("git", ["add", "-A"], { cwd, env });
  execFileSync("git", ["commit", "-qm", commit], { cwd, env });
}

function run(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((done, fail) => {
    execFile(SCRIPT, [], { env, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) fail(new Error(`repo-start failed: ${String(stderr || error.message)}`));
      else done(stdout);
    });
  });
}

describe.skipIf(!posix)("repo-start boot script", () => {
  it("installs, builds and execs node on a fresh boot", async () => {
    const fx = setup();
    try {
      git("one", fx.src, fx.env);
      const out = await run(fx.env);
      expect(out).toContain(`NODE_EXEC ${fx.src}/dist-server/index.js`);
      expect(existsSync(join(fx.src, "node_modules"))).toBe(true);
      expect(existsSync(join(fx.src, "dist", "index.html"))).toBe(true);
    } finally {
      removeTempDir(fx.dir);
    }
  });

  it("skips install and build when nothing changed", async () => {
    const fx = setup();
    try {
      git("one", fx.src, fx.env);
      await run(fx.env);
      writeFileSync(fx.pnpmLog, "");
      const out = await run(fx.env);
      expect(out).toContain("NODE_EXEC");
      expect(execFileSync("wc", ["-c", fx.pnpmLog], { encoding: "utf8" }).trim()).toMatch(/^0\b/);
    } finally {
      removeTempDir(fx.dir);
    }
  });

  it("rebuilds on a new commit but does not reinstall", async () => {
    const fx = setup();
    try {
      git("one", fx.src, fx.env);
      await run(fx.env);
      writeFileSync(join(fx.src, "note.txt"), "two\n");
      execFileSync("git", ["add", "-A"], { cwd: fx.src, env: fx.env });
      execFileSync("git", ["commit", "-qm", "two"], { cwd: fx.src, env: fx.env });
      writeFileSync(fx.pnpmLog, "");
      await run(fx.env);
      const log = execFileSync("cat", [fx.pnpmLog], { encoding: "utf8" });
      expect(log).not.toContain("install");
      expect(log).toContain("build:server");
    } finally {
      removeTempDir(fx.dir);
    }
  });

  it("stages the host ssh key with mode 0600 and exports GIT_SSH_COMMAND", async () => {
    const fx = setup();
    try {
      git("one", fx.src, fx.env);
      const hostSsh = fx.env.OMB_HOST_SSH as string;
      writeFileSync(join(hostSsh, "id_ed25519"), "fake-private\n");
      writeFileSync(join(hostSsh, "id_ed25519.pub"), "fake-public\n");
      const out = await run(fx.env);
      const staged = join(fx.env.OMB_CONTAINER_SSH as string, "id_ed25519");
      expect(existsSync(staged)).toBe(true);
      expect(statSync(staged).mode & 0o777).toBe(0o600);
      expect(out).toContain(`GIT_SSH_COMMAND=ssh -i ${staged}`);
    } finally {
      removeTempDir(fx.dir);
    }
  });
});
