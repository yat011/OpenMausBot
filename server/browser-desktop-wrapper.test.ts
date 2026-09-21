import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";

const posix = process.platform !== "win32";
const WRAPPER = fileURLToPath(new URL("../deploy/local/browser/agent-browser-omb", import.meta.url));

function fixtureReal(dir: string): string {
  const path = join(dir, "fake-agent-browser.mjs");
  writeFileSync(path, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n');
  chmodSync(path, 0o755);
  return path;
}

function runWrapper(args: string[], env: NodeJS.ProcessEnv): Promise<string[]> {
  return new Promise((done, fail) => {
    execFile(WRAPPER, args, { env, timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) fail(new Error(`wrapper failed: ${String(stderr || error.message)}`));
      else {
        try { done(JSON.parse(stdout)); }
        catch { fail(new Error(`wrapper printed non-JSON: ${stdout}`)); }
      }
    });
  });
}

async function withCdpServer(run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer((socket) => { socket.destroy(); });
  await new Promise<void>((done) => { server.listen(0, "127.0.0.1", done); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no loopback port");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
  }
}

describe.skipIf(!posix)("desktop sidecar browser wrapper", () => {
  it("passes through to the bundled engine when CDP is down", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-wrapper-"));
    try {
      const args = await runWrapper(["open", "https://example.com"], {
        ...process.env,
        OMB_AGENT_BROWSER_REAL: fixtureReal(dir),
        OMB_DESKTOP_CDP: "http://127.0.0.1:9",
      });
      expect(args).toEqual(["open", "https://example.com"]);
    } finally {
      removeTempDir(dir);
    }
  });

  it("injects --cdp for page commands when the sidecar is up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-wrapper-"));
    try {
      await withCdpServer(async (url) => {
        const args = await runWrapper(["open", "https://example.com"], {
          ...process.env,
          OMB_AGENT_BROWSER_REAL: fixtureReal(dir),
          OMB_DESKTOP_CDP: url,
        });
        expect(args).toEqual(["--cdp", url, "open", "https://example.com"]);
      });
    } finally {
      removeTempDir(dir);
    }
  });

  it("never attaches session management to the shared Chrome", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-wrapper-"));
    try {
      await withCdpServer(async (url) => {
        const args = await runWrapper(["close", "--all"], {
          ...process.env,
          OMB_AGENT_BROWSER_REAL: fixtureReal(dir),
          OMB_DESKTOP_CDP: url,
        });
        expect(args).toEqual(["close", "--all"]);
      });
    } finally {
      removeTempDir(dir);
    }
  });
});
