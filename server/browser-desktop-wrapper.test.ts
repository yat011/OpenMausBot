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
  writeFileSync(
    path,
    "#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2),cdp:process.env.AGENT_BROWSER_CDP??null,pinTab:process.env.AGENT_BROWSER_PIN_TAB??null}));\n",
  );
  chmodSync(path, 0o755);
  return path;
}

interface FixtureSeen {
  args: string[];
  cdp: string | null;
  pinTab: string | null;
}

function runWrapper(args: string[], env: NodeJS.ProcessEnv): Promise<FixtureSeen> {
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

function cleanEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  // Deterministic baseline: drop ambient values unless the test sets them.
  if (extra.AGENT_BROWSER_CDP === undefined) delete env.AGENT_BROWSER_CDP;
  if (extra.AGENT_BROWSER_PIN_TAB === undefined) delete env.AGENT_BROWSER_PIN_TAB;
  return env;
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
      const seen = await runWrapper(["open", "https://example.com"], cleanEnv({
        OMB_AGENT_BROWSER_REAL: fixtureReal(dir),
        OMB_DESKTOP_CDP: "http://127.0.0.1:9",
        OMB_DESKTOP_CDP_TRIES: "0",
      }));
      expect(seen.args).toEqual(["open", "https://example.com"]);
      expect(seen.cdp).toBeNull();
    } finally {
      removeTempDir(dir);
    }
  });

  it("injects --cdp for page commands when the sidecar is up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-wrapper-"));
    try {
      await withCdpServer(async (url) => {
        const seen = await runWrapper(["open", "https://example.com"], cleanEnv({
          OMB_AGENT_BROWSER_REAL: fixtureReal(dir),
          OMB_DESKTOP_CDP: url,
        }));
        expect(seen.args).toEqual(["--cdp", url, "open", "https://example.com"]);
      });
    } finally {
      removeTempDir(dir);
    }
  });

  it("exports AGENT_BROWSER_CDP so the daemon connects to the sidecar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-wrapper-"));
    try {
      await withCdpServer(async (url) => {
        const seen = await runWrapper(["open", "https://example.com"], cleanEnv({
          OMB_AGENT_BROWSER_REAL: fixtureReal(dir),
          OMB_DESKTOP_CDP: url,
        }));
        expect(seen.cdp).toBe(url);
        expect(seen.pinTab).toBe("1");
      });
    } finally {
      removeTempDir(dir);
    }
  });

  it("keeps a caller-set AGENT_BROWSER_CDP instead of overriding it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-wrapper-"));
    try {
      await withCdpServer(async (url) => {
        const seen = await runWrapper(["open", "https://example.com"], cleanEnv({
          OMB_AGENT_BROWSER_REAL: fixtureReal(dir),
          OMB_DESKTOP_CDP: url,
          AGENT_BROWSER_CDP: "http://127.0.0.1:9",
        }));
        expect(seen.args).toEqual(["--cdp", url, "open", "https://example.com"]);
        expect(seen.cdp).toBe("http://127.0.0.1:9");
      });
    } finally {
      removeTempDir(dir);
    }
  });

  it("waits for a late sidecar instead of falling back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-wrapper-"));
    try {
      const server = createServer((socket) => { socket.destroy(); });
      try {
        await new Promise<void>((done) => { server.listen(0, "127.0.0.1", done); });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("no loopback port");
        const url = `http://127.0.0.1:${address.port}`;
        await new Promise<void>((done) => { server.close(() => done()); });
        setTimeout(() => { server.listen(address.port, "127.0.0.1"); }, 1500);
        const seen = await runWrapper(["open", "https://example.com"], cleanEnv({
          OMB_AGENT_BROWSER_REAL: fixtureReal(dir),
          OMB_DESKTOP_CDP: url,
          OMB_DESKTOP_CDP_TRIES: "10",
        }));
        expect(seen.args).toEqual(["--cdp", url, "open", "https://example.com"]);
      } finally {
        server.close();
      }
    } finally {
      removeTempDir(dir);
    }
  });

  it("never attaches session management to the shared Chrome", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-wrapper-"));
    try {
      await withCdpServer(async (url) => {
        const seen = await runWrapper(["close", "--all"], cleanEnv({
          OMB_AGENT_BROWSER_REAL: fixtureReal(dir),
          OMB_DESKTOP_CDP: url,
        }));
        expect(seen.args).toEqual(["close", "--all"]);
        expect(seen.cdp).toBeNull();
      });
    } finally {
      removeTempDir(dir);
    }
  });
});
