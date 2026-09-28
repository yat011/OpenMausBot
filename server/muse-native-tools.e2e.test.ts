// Muse keeps its native tools on every surface. The Muse CLI brings its
// own shell, file and workspace tools to every turn — the harness neither
// mounts nor removes them — so a Muse turn must never be told it has no
// shell (the browser-only paragraph) or no tools at all (the
// nothing-mounted paragraph). Real server, fake Muse CLI, disposable home:
// the dump carries the exact prompt the turn sent plus the MCP overlay the
// turn mounted.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { freePortBlock } from "./testing/ports.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("muse native tools across surfaces", () => {
  let home = "";
  let data = "";
  let ui = "";
  let dumpFile = "";
  let output = "";
  let child: ChildProcess | null = null;
  let base = "";

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const apiOk = async (method: string, path: string, body?: unknown) => {
    const result = await api(method, path, body);
    expect(result.status, `${method} ${path}: ${JSON.stringify(result.body)}`).toBeLessThan(400);
    return result.body;
  };
  async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
    const end = Date.now() + 20_000;
    for (;;) {
      const value = await read();
      if (accept(value)) return value;
      if (Date.now() >= end) throw new Error(`Fixture wait expired: ${JSON.stringify(value)}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  const threadState = (botId: string, threadId: string) =>
    api("GET", "/api/bots?messages=0").then(({ body }) =>
      body.bots.find((bot: any) => bot.id === botId)?.tasks.find((task: any) => task.threadId === threadId));
  const idle = (botId: string, threadId: string) => until(() => threadState(botId, threadId), task => !task?.busy);
  const dump = (): Promise<any> => until((): any => {
    if (!existsSync(dumpFile)) return null;
    try {
      const lines = readFileSync(dumpFile, "utf8").split("\n").filter(Boolean);
      return lines.length ? JSON.parse(lines[lines.length - 1]!) : null;
    } catch { return null; }
  }, Boolean);

  async function start() {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    output = "";
    const proc = spawn(process.execPath, [join(ROOT, "server/index.ts")], {
      cwd: ROOT, env: {
        PATH: dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home, USERPROFILE: home, OMB_DATA_DIR: data,
        APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
        TEMP: home, TMP: home, TMPDIR: home,
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: ui,
        OMB_USER_DATA: join(home, "user-data"),
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    proc.stdout!.on("data", chunk => { output += chunk; });
    proc.stderr!.on("data", chunk => { output += chunk; });
    await until(async () => {
      if (proc.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
      try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
    }, Boolean);
  }
  async function stop() {
    if (!child) return;
    const proc = child;
    child = null;
    await waitForExit(proc, { signal: "SIGTERM" });
  }

  afterAll(async () => {
    await stop();
    if (home) await removeTempDir(home);
  });

  it("tells a Muse turn about its native shell instead of disclaiming tools", async () => {
    home = mkdtempSync(join(tmpdir(), "omb-muse-native-"));
    data = join(home, "data");
    ui = join(home, "static");
    dumpFile = join(home, "muse-dump.jsonl");
    mkdirSync(data);
    mkdirSync(join(ui, "assets"), { recursive: true });
    writeFileSync(join(ui, "index.html"), "<title>Muse native</title>");
    writeFileSync(join(ui, "assets", "test.css"), "body{}");
    writeFileSync(join(data, "config.json"), JSON.stringify({ instances: { muse: {
      driver: "museAgent", config: { cli: join(ROOT, "server/testing/fake-muse-cli.ts") },
      environment: { FAKE_MUSE_DUMP: dumpFile },
    } } }));
    await start();
    try {
      const { bot } = await apiOk("POST", "/api/bots", { name: "Native Bot",
        modelSelection: { instanceId: "muse", model: "muse-spark-1.2" } });
      const { task } = await apiOk("POST", `/api/bots/${bot.id}/tasks`, {});
      await apiOk("POST", `/api/bots/${bot.id}/messages`, { text: "List the repo root.", threadId: task.threadId });
      await idle(bot.id, task.threadId);
      const sent = await dump();
      // The MCP overlay still mounts what the turn reached.
      expect(sent.settings?.mcpServers?.agents?.transport).toBe("stdio");
      // But the prompt must describe the engine's real toolset: native
      // shell, files and workspace are live on every surface, so neither
      // the browser-only nor the nothing-mounted disclaimer may ride along.
      expect(sent.prompt).not.toContain("there is no desktop, file or shell computer this turn");
      expect(sent.prompt).not.toContain("No computer or built-in browser tools are mounted this turn");
      expect(sent.prompt).toContain("native shell, file and workspace tools");
    } finally {
      await stop();
    }
  });
});
