#!/usr/bin/env node
// Fake of the muse CLI's `exec --json` surface, for driver contract tests
// of server/drivers/muse.ts. Emits the JSONL envelope the real CLI emits
// (payload_type run.output.delta / run.terminal.completed). Failure modes
// mirror how the real thing misbehaves:
//
//   FAKE_MUSE_MODE   happy (default) | exit-early | malformed |
//                    not-logged-in | dead-session (fails only when
//                    --session-id names FAKE_MUSE_DEAD_SESSION)
//   FAKE_MUSE_TEXT   assistant text for the happy turn (default
//                    "Hello from Muse")
//   FAKE_MUSE_DUMP   path to append {argv, prompt, sessionId} as JSON, so
//                    the test can assert argv shape and prompt assembly.
//                    prompt is read back from the --prompt-file the way the
//                    real CLI reads it.
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { appendFileSync, readFileSync } from "node:fs";

const mode = process.env.FAKE_MUSE_MODE ?? "happy";
const text = process.env.FAKE_MUSE_TEXT ?? "Hello from Muse";
const argv = process.argv.slice(2);

// The driver probes `<cli> --version` for snapshot(); answer and exit clean.
if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write("Muse Code 1.1.1 (fake)\n");
  process.exit(0);
}

const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const sessionId = flag("--session-id");
const promptFile = flag("--prompt-file");
let prompt = "";
if (promptFile) {
  try {
    prompt = readFileSync(promptFile, "utf8");
  } catch {
    prompt = "";
  }
}

if (process.env.FAKE_MUSE_DUMP) {
  try {
    appendFileSync(
      process.env.FAKE_MUSE_DUMP,
      JSON.stringify({ argv, prompt, sessionId, metaKey: process.env.META_API_KEY ?? null }) + "\n",
    );
  } catch {
    /* never let dumping break a run */
  }
}

// hang: never answer — interruptTurn must still settle the turn.
if (mode === "hang") {
  await new Promise(() => {});
}

// dead-session: a resume the CLI no longer knows fails before saying
// anything, the way an expired session id does.
if (mode === "dead-session" && sessionId && sessionId === process.env.FAKE_MUSE_DEAD_SESSION) {
  process.stderr.write(`muse: no such session: ${sessionId}\n`);
  process.exit(1);
}

// not-logged-in: the CLI refuses before the run starts.
if (mode === "not-logged-in") {
  process.stderr.write("muse: not logged in — run `muse login` in a terminal\n");
  process.exit(1);
}

// exit-early: die before saying anything — a failed spawn surfaces as a
// runtime.error + failed turn, never a hang.
if (mode === "exit-early") {
  process.exit(1);
}

const send = (payloadType: string, payload: unknown) =>
  process.stdout.write(JSON.stringify({ schema_version: 1, payload_type: payloadType, payload }) + "\n");

if (mode === "malformed") {
  process.stdout.write("this is not json\n{{\"broken\"\n");
}

// A faithful happy turn: text deltas, then the terminal record carrying the
// whole answer (the real CLI emits both).
const half = Math.ceil(text.length / 2);
send("run.output.delta", { kind: "run_output_delta", text: text.slice(0, half) });
send("task.lifecycle.started", { kind: "started" });
send("run.output.delta", { kind: "run_output_delta", text: text.slice(half) });
send("run.terminal.completed", { kind: "run_terminal", terminal: "completed", text });
