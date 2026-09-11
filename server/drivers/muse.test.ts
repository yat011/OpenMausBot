// Muse Code driver contract tests, run against the scripted fake CLI in
// server/testing/fake-muse-cli.ts — the driver must normalize the
// `exec --json` JSONL protocol into canonical events, keep argv hygiene
// (prompt via --prompt-file, no parent-process key leak), resume sessions
// by id, and retry a dead session once with the recovery replay.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { buildMuseExecArgs, MuseDriver, parseMuseLine, type MuseConfig } from "./muse.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-muse-cli.ts");

interface DumpLine {
  argv: string[];
  prompt: string;
  sessionId?: string;
  metaKey: string | null;
}

function readDump(path: string): DumpLine[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as DumpLine);
}

describe("MuseDriver turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;
  let dump: string;
  let savedEnv: Record<string, string | undefined>;

  const create = async (mode?: string, environment: Record<string, string> = {}, config: Partial<MuseConfig> = {}) => {
    if (mode) process.env.FAKE_MUSE_MODE = mode;
    process.env.FAKE_MUSE_DUMP = dump;
    instance = await MuseDriver.create({
      instanceId: "muse-test",
      displayName: "Muse Test",
      environment,
      enabled: true,
      config: { cli: FAKE_CLI, ...config },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-muse-test-"));
    dump = join(scratch, "dump.jsonl");
    savedEnv = {};
    for (const key of ["FAKE_MUSE_MODE", "FAKE_MUSE_DUMP", "FAKE_MUSE_TEXT", "FAKE_MUSE_DEAD_SESSION", "META_API_KEY", "XDG_CONFIG_HOME"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeTempDir(scratch);
  });

  it("streams deltas then settles with the terminal text", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-stream", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(done).toMatchObject({ ok: true });

    expect(recorder.events.map((e) => e.type)).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["Hello from Muse"]);
  });

  it("reuses the session id, maps full to never, and prepends the persona", async () => {
    await create();
    const firstTurn = await instance.adapter.sendTurn({
      threadId: "t-argv",
      text: "do the thing",
      system: "You are Maus.",
      model: "muse-spark-1.2",
      approvalMode: "full",
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === firstTurn.turnId);
    const secondTurn = await instance.adapter.sendTurn({ threadId: "t-argv", text: "again" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === secondTurn.turnId);

    const launches = readDump(dump);
    expect(launches).toHaveLength(2);
    const [first, second] = launches as [DumpLine, DumpLine];
    expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.sessionId).toBe(first.sessionId);
    expect(first.argv).toContain("--json");
    expect(first.argv).toEqual(expect.arrayContaining(["--approval-mode", "never", "--model", "muse-spark-1.2"]));
    expect(first.prompt).toBe("You are Maus.\n\ndo the thing");
  });

  it("retries a dead session once on a fresh id with the recovery replay", async () => {
    process.env.FAKE_MUSE_DEAD_SESSION = "dead-beef";
    await create("dead-session");
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-resume",
      text: "continue",
      resumeCursor: "dead-beef",
      recoveryText: "prior summary",
    });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(done).toMatchObject({ ok: true });

    const launches = readDump(dump);
    expect(launches).toHaveLength(2);
    expect(launches[0]?.sessionId).toBe("dead-beef");
    expect(launches[1]?.sessionId).not.toBe("dead-beef");
    expect(launches[1]?.prompt).toBe("prior summary\n\ncontinue");
  });

  it("fails a turn whose CLI exits before answering", async () => {
    await create("exit-early");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-early", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(done).toMatchObject({ ok: false });
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(true);
  });

  it("tolerates malformed lines before the terminal record", async () => {
    await create("malformed");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-malformed", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(done).toMatchObject({ ok: true });
    const texts = recorder.events
      .filter((e) => e.type === "item.completed" && (e as { itemType: string }).itemType === "assistant_text")
      .map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["Hello from Muse"]);
  });

  it("settles a hanging turn as interrupted", async () => {
    await create("hang");
    const send = instance.adapter.sendTurn({ threadId: "t-hang", text: "go" });
    const { turnId } = await send;
    await recorder.until((e) => e.type === "session.started" && e.turnId === turnId);
    await instance.adapter.interruptTurn("t-hang");
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(done).toMatchObject({ ok: false, stopReason: "interrupted" });
  });

  it("keeps a parent-process key out of the child unless the instance sets it", async () => {
    process.env.META_API_KEY = "parent-secret";
    await create();
    const firstTurn = await instance.adapter.sendTurn({ threadId: "t-hygiene", text: "go" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === firstTurn.turnId);
    expect(readDump(dump).at(-1)?.metaKey).toBeNull();
    recorder.stop();
    await instance.dispose();

    await create(undefined, { META_API_KEY: "instance-secret" });
    const secondTurn = await instance.adapter.sendTurn({ threadId: "t-hygiene-key", text: "go" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === secondTurn.turnId);
    expect(readDump(dump).at(-1)?.metaKey).toBe("instance-secret");
  });

  it("reports unavailable without a CLI, available on login or key", async () => {
    await create(undefined, {}, { cli: "/nonexistent/omb-muse-xyz" });
    const missing = await instance.snapshot();
    expect(missing.state).toBe("unavailable");
    await instance.dispose();

    await create();
    const signedOut = await instance.snapshot();
    expect(signedOut).toMatchObject({ state: "unavailable", authenticated: false });
    await instance.dispose();

    await create(undefined, { META_API_KEY: "test-key" });
    const keyed = await instance.snapshot();
    expect(keyed).toMatchObject({ state: "available", authenticated: true, version: "1.1.1" });
    expect(keyed.account).toEqual({ method: "api-key" });
    await instance.dispose();

    const configHome = mkdtempSync(join(tmpdir(), "omb-muse-config-"));
    try {
      mkdirSync(join(configHome, "muse"), { recursive: true });
      writeFileSync(
        join(configHome, "muse", "auth.json"),
        JSON.stringify({ providers: { meta: { mechanism: "oauth", access_token: "tok" } } }),
      );
      process.env.XDG_CONFIG_HOME = configHome;
      await create();
      const loggedIn = await instance.snapshot();
      expect(loggedIn).toMatchObject({ state: "available", authenticated: true, version: "1.1.1" });
      expect(loggedIn.account).toEqual({ method: "login" });
    } finally {
      await removeTempDir(configHome);
    }
  });

  it("decodes config with muse defaults", () => {
    expect(MuseDriver.decodeConfig({})).toEqual({ cli: "muse", provider: "meta", model: "", baseUrl: "" });
    expect(MuseDriver.models.default).toBe("muse-spark-1.3-contributor");
  });
});

describe("muse protocol helpers", () => {
  it("parses deltas, completions, failures, and noise", () => {
    expect(parseMuseLine(JSON.stringify({ payload_type: "run.output.delta", payload: { text: "hi" } }))).toEqual({
      kind: "delta",
      text: "hi",
    });
    expect(parseMuseLine(JSON.stringify({ payload_type: "run.terminal.completed", payload: { text: "done" } }))).toEqual({
      kind: "completed",
      text: "done",
    });
    expect(
      parseMuseLine(JSON.stringify({ payload_type: "run.terminal.killed", payload: { terminal: "killed" } })),
    ).toEqual({ kind: "failed", reason: "killed" });
    expect(parseMuseLine(JSON.stringify({ payload_type: "task.lifecycle.started", payload: {} }))).toBeNull();
    expect(parseMuseLine("not json")).toBeNull();
  });

  it("builds the exec argv after the binary", () => {
    expect(
      buildMuseExecArgs({
        provider: "meta",
        approval: "on-request",
        sessionId: "sid",
        model: "muse-spark-1.2",
        effort: "high",
        promptFile: "/tmp/prompt.md",
      }),
    ).toEqual([
      "exec",
      "--json",
      "--provider",
      "meta",
      "--approval-mode",
      "on-request",
      "--session-id",
      "sid",
      "--model",
      "muse-spark-1.2",
      "--reasoning-effort",
      "high",
      "--prompt-file",
      "/tmp/prompt.md",
    ]);
  });
});
