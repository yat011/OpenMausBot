// Muse Code driver — Meta's `muse` CLI, one `muse exec --json` process per
// turn (JSONL events on stdout), verified against muse 1.1.1. Session
// continuity rides `--session-id`: the CLI persists the session under
// <data-home>/muse/sessions/<date>/<uuid>/session.jsonl, so reusing the id
// resumes it. `exec` takes no --system flag, so the bot persona is prepended
// to the prompt — the same codex-style prepend the Grok ACP driver uses for
// flags its CLI accepts but never delivers.
//
// Peer-agent comms, built-in browser, and workspace custom MCP (e.g.
// wanderlog) are a per-turn overlay: a temp XDG_CONFIG_HOME/muse/settings.json
// with mcpServers.*, auth.json copied in so login survives the overlay. The
// person's ~/.config/muse is not written. Muse's own web tools stay on
// (no --disable-web-tools).
//
// Auth is the CLI's own: `muse login` (Meta account, stored at
// $XDG_CONFIG_HOME/muse/auth.json as {providers:{meta:{mechanism:"oauth",
// access_token}}}) or META_API_KEY, which always takes priority over the
// login. An instance-level META_API_KEY is passed through; a key merely
// riding along in the parent environment is stripped so it cannot silently
// flip a subscription login to pay-as-you-go billing (the same reason the
// Grok ACP driver deletes XAI_API_KEY).
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { ApprovalMode } from "../../shared/approval-mode.ts";
import type {
  DriverCreateInput,
  EffortLevel,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "museAgent";

// Fallback when the CLI has not yet written its catalog cache. Prefer 1.2:
// 1.3-contributor is not on every account and the API then fails the turn
// with "does not exist or you lack access".
const FALLBACK_MODELS: ModelCatalog = {
  default: "muse-spark-1.2",
  options: [
    { id: "muse-spark-1.2", label: "Muse Spark 1.2", contextWindow: 1_007_997 },
    { id: "muse-spark-1.2-contributor", label: "Muse Spark 1.2 Contributor", contextWindow: 1_007_997 },
    { id: "muse-spark-1.3", label: "Muse Spark 1.3", contextWindow: 1_007_997 },
    { id: "muse-spark-1.3-contributor", label: "Muse Spark 1.3 Contributor", contextWindow: 1_007_997 },
  ],
};

export function museDataHome(env: Record<string, string | undefined> = process.env): string {
  if (env.MUSE_DATA_HOME?.trim()) return env.MUSE_DATA_HOME.trim();
  const dataHome = env.XDG_DATA_HOME?.trim() || join(env.HOME || env.USERPROFILE || homedir(), ".local", "share");
  return join(dataHome, "muse");
}

/** Live rows from `<data-home>/muse/model-catalog/*.json`. Null when the CLI
 * has not cached a catalog yet. */
export function loadMuseCatalog(env: Record<string, string | undefined> = process.env): ModelCatalog | null {
  const dir = join(museDataHome(env), "model-catalog");
  if (!existsSync(dir)) return null;
  const byId = new Map<string, { id: string; label: string; contextWindow: number; isDefault: boolean }>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const doc = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
        rows?: Array<{
          model_id?: unknown;
          display_label?: unknown;
          context_limit?: unknown;
          is_default?: unknown;
          visibility?: unknown;
        }>;
      };
      for (const row of doc.rows ?? []) {
        if (typeof row.model_id !== "string" || !row.model_id.trim()) continue;
        if (typeof row.visibility === "string" && row.visibility !== "visible") continue;
        const id = row.model_id.trim();
        byId.set(id, {
          id,
          label: typeof row.display_label === "string" && row.display_label.trim() ? row.display_label.trim() : id,
          contextWindow: typeof row.context_limit === "number" ? row.context_limit : 1_007_997,
          isDefault: row.is_default === true,
        });
      }
    } catch {
      /* skip a corrupt cache file */
    }
  }
  if (byId.size === 0) return null;
  const options = [...byId.values()];
  return {
    default: options.find((row) => row.isDefault)?.id ?? options[0]!.id,
    options: options.map(({ id, label, contextWindow }) => ({ id, label, contextWindow })),
  };
}

export function resolveMuseModels(env: Record<string, string | undefined> = process.env): ModelCatalog {
  return loadMuseCatalog(env) ?? FALLBACK_MODELS;
}

function applyCatalog(target: ModelCatalog, source: ModelCatalog): void {
  target.default = source.default;
  target.options = source.options;
}

function museModelOrDefault(requested: string | undefined, catalog: ModelCatalog): string | undefined {
  if (!requested) return catalog.default;
  if (requested === catalog.default || catalog.options.some((option) => option.id === requested)) return requested;
  return catalog.default;
}

// Every member of the harness EffortLevel union is a --reasoning-effort the
// CLI accepts (none|minimal|low|medium|high|xhigh|max|ultra per `muse exec
// --help`); minimal/ultra have no harness counterpart so they stay unset.
const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

export interface MuseConfig {
  cli: string;
  provider: string;
  model: string;
  baseUrl: string;
}

export function decodeMuseConfig(raw: unknown): MuseConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    cli: typeof o.cli === "string" && o.cli.trim() ? o.cli : "muse",
    provider: typeof o.provider === "string" && o.provider.trim() ? o.provider : "meta",
    model: typeof o.model === "string" ? o.model : "",
    baseUrl: typeof o.baseUrl === "string" ? o.baseUrl : "",
  };
}

/** Credential-store path the `muse` launcher itself reads: MUSE_AUTH_PATH,
 * else $XDG_CONFIG_HOME/muse/auth.json, else ~/.config/muse/auth.json. */
export function museAuthPath(env: Record<string, string | undefined> = process.env): string {
  if (env.MUSE_AUTH_PATH && env.MUSE_AUTH_PATH.trim()) return env.MUSE_AUTH_PATH;
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(env.HOME || env.USERPROFILE || homedir(), ".config");
  return join(configHome, "muse", "auth.json");
}

/** Whether the CLI holds a Meta login: providers.meta.mechanism === "oauth"
// with a non-empty access_token, the exact shape the launcher requires. */
export function museHasLogin(env: Record<string, string | undefined> = process.env): boolean {
  try {
    const doc = JSON.parse(readFileSync(museAuthPath(env), "utf8")) as {
      providers?: { meta?: { mechanism?: unknown; access_token?: unknown } };
    };
    const meta = doc?.providers?.meta;
    return meta?.mechanism === "oauth" && typeof meta?.access_token === "string" && meta.access_token.length > 0;
  } catch {
    return false;
  }
}

export function museApiKey(input: { environment: Record<string, string> }): string {
  return input.environment.META_API_KEY ?? process.env.META_API_KEY ?? "";
}

export function museConfigHome(env: Record<string, string | undefined> = process.env): string {
  return env.XDG_CONFIG_HOME?.trim() || join(env.HOME || env.USERPROFILE || homedir(), ".config");
}

export function museUserSettingsPath(env: Record<string, string | undefined> = process.env): string {
  return join(museConfigHome(env), "muse", "settings.json");
}

export interface MuseStdioMcpSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    return asPlainObject(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/** Muse settings.json stdio MCP entry. `mode` is optional so a browser-proxy
 * glitch still leaves Muse's own web tools on the turn. */
export function museStdioMcpServer(spec: MuseStdioMcpSpec): Record<string, unknown> {
  return {
    transport: "stdio",
    command: spec.command,
    args: spec.args,
    env: spec.env,
    enabled: true,
    mode: "optional",
  };
}

export interface MuseMcpMounts {
  agents?: MuseStdioMcpSpec;
  browser?: MuseStdioMcpSpec;
  custom?: Record<string, MuseStdioMcpSpec>;
}

export function museMcpMountsFromTurn(turn: {
  integrations?: { agents?: MuseStdioMcpSpec; browser?: MuseStdioMcpSpec; custom?: Record<string, MuseStdioMcpSpec> };
}): MuseMcpMounts | null {
  const agents = turn.integrations?.agents;
  const browser = turn.integrations?.browser;
  const custom = turn.integrations?.custom;
  const customEntries = custom && Object.keys(custom).length ? custom : undefined;
  if (!agents && !browser && !customEntries) return null;
  return {
    ...(agents ? { agents } : {}),
    ...(browser ? { browser } : {}),
    ...(customEntries ? { custom: customEntries } : {}),
  };
}

/** Merge harness MCP servers into a copy of the person's Muse settings.
 * CamelCase `mcpServers` is canonical; a legacy `mcp_servers` key is folded
 * in and dropped so Muse does not see both. Built-ins (`agents`, `browser`)
 * win over a custom server of the same name. */
export function buildMuseSettingsWithMcp(
  base: Record<string, unknown> | null,
  mounts: MuseMcpMounts,
): Record<string, unknown> {
  const settings: Record<string, unknown> = { ...(base ?? {}) };
  settings.schema_version = 1;
  const fromCamel = asPlainObject(settings.mcpServers) ?? {};
  const fromSnake = asPlainObject(settings.mcp_servers) ?? {};
  delete settings.mcp_servers;
  const servers: Record<string, unknown> = { ...fromSnake, ...fromCamel };
  if (mounts.custom) {
    for (const [name, spec] of Object.entries(mounts.custom)) {
      servers[name] = museStdioMcpServer(spec);
    }
  }
  if (mounts.browser) servers.browser = museStdioMcpServer(mounts.browser);
  if (mounts.agents) servers.agents = museStdioMcpServer(mounts.agents);
  settings.mcpServers = servers;
  return settings;
}

/** @deprecated use buildMuseSettingsWithMcp */
export function buildMuseSettingsWithBrowser(
  base: Record<string, unknown> | null,
  browser: MuseStdioMcpSpec,
): Record<string, unknown> {
  return buildMuseSettingsWithMcp(base, { browser });
}

/** Per-turn config dir: settings.json with harness MCP, auth.json copied from
 * the real Muse login so overlaying XDG_CONFIG_HOME does not sign the child out. */
export function writeMuseMcpOverlay(
  dir: string,
  env: NodeJS.ProcessEnv,
  mounts: MuseMcpMounts,
): { xdgConfigHome: string; settingsPath: string } {
  const xdgConfigHome = join(dir, "config");
  const museDir = join(xdgConfigHome, "muse");
  mkdirSync(museDir, { recursive: true });
  const settings = buildMuseSettingsWithMcp(readJsonObject(museUserSettingsPath(env)), mounts);
  const settingsPath = join(museDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  const authSrc = museAuthPath(env);
  const authDest = join(museDir, "auth.json");
  if (existsSync(authSrc)) {
    copyFileSync(authSrc, authDest);
    chmodSync(authDest, 0o600);
  }
  return { xdgConfigHome, settingsPath };
}

/** OpenMausBot ask|auto|full|custom onto Muse exec safety flags.
 * Full is encoded as approval `"never"` and emitted as `muse exec --yolo`
 * (disable approval, disable sandbox, trust this workspace). Muse's
 * `--approval-mode never` only closes prompts: the sandbox stays on and
 * the workspace stays untrusted, so Full would still fail socket/spool
 * work. Other levels stay `--approval-mode on-request`. */
export function museApprovalFlag(mode: ApprovalMode | undefined): string {
  return mode === "full" ? "never" : "on-request";
}

/** argv fragment after `muse exec` for the mapped approval level. */
export function museSafetyArgs(approval: string): string[] {
  return approval === "never" ? ["--yolo"] : ["--approval-mode", approval];
}

/** Token window for `OMB_MUSE_AUTOCOMPACT`, mirroring the Claude driver's
 * `--autocompact` default: compact the native session once it approaches
 * this size, so a long thread stops re-reading its whole past every turn.
 * The Muse CLI takes the threshold as a fraction of the model context, so
 * the window below is converted per model (200k of a ~1M window ≈ 0.2). */
export const DEFAULT_MUSE_AUTOCOMPACT_TOKENS = 200_000;
const MIN_MUSE_AUTOCOMPACT_TOKENS = 100_000;
const MAX_MUSE_AUTOCOMPACT_TOKENS = 1_000_000;
const FALLBACK_CONTEXT_WINDOW = 1_007_997;

/** Token window from the environment, or null when the CLI should decide
 * (`"auto"`) or compaction is off. Mirrors `autoCompactWindow` semantics:
 * a number names the window, anything unparsable falls back to the
 * default, and the window is clamped rather than passed through. */
export function museAutoCompactTokens(env: Record<string, string | undefined>): number | null {
  const raw = (env.OMB_MUSE_AUTOCOMPACT ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "auto") return null;
  const parsed = raw ? Number(raw) : DEFAULT_MUSE_AUTOCOMPACT_TOKENS;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MUSE_AUTOCOMPACT_TOKENS;
  return Math.min(MAX_MUSE_AUTOCOMPACT_TOKENS, Math.max(MIN_MUSE_AUTOCOMPACT_TOKENS, Math.floor(parsed)));
}

/** `--context-compaction-hard-threshold` value for this turn: the window as
 * a fraction of the model's context, or null when no flag should ride. */
export function museCompactionThreshold(
  env: Record<string, string | undefined>,
  contextWindow: number,
): string | null {
  const tokens = museAutoCompactTokens(env);
  if (tokens === null) return null;
  const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : FALLBACK_CONTEXT_WINDOW;
  return String(Math.round((tokens / window) * 1000) / 1000);
}

/** Soft starts this far below the hard stop. Muse 1.3.0 rejects the run
 * unless soft < hard, both fractions, and its built-in soft default is
 * 0.75 — below a 200k window (~0.2 of a 1M context) that default makes
 * every turn exit 2. */
const MUSE_SOFT_FRACTION_OF_HARD = 0.8;

export interface MuseCompactionBounds {
  soft: string;
  hard: string;
}

/** Soft/hard pair the CLI will accept. The token window stays the hard
 * stop; soft leads it so compaction starts as the session approaches that
 * window. Hard is clamped into (0, 1], which is the range `muse exec` allows. */
export function museCompactionBounds(
  env: Record<string, string | undefined>,
  contextWindow: number,
): MuseCompactionBounds | null {
  const hardText = museCompactionThreshold(env, contextWindow);
  if (hardText === null) return null;
  const parsed = Number(hardText);
  if (!Number.isFinite(parsed)) return null;
  const hard = Math.min(1, Math.max(0.002, parsed));
  let soft = Math.round(hard * MUSE_SOFT_FRACTION_OF_HARD * 1000) / 1000;
  if (!(soft > 0 && soft < hard)) soft = Math.round((hard - 0.001) * 1000) / 1000;
  return { soft: String(soft), hard: String(hard) };
}

/** The oldest CLI verified to accept `--context-compaction-hard-threshold`
 * (checked against `muse exec --help` on 1.3.0, the version pinned in this
 * image). An unknown flag is a hard argument error, so older CLIs get no
 * flag at all rather than a turn that fails the same way every time. */
export const MUSE_COMPACTION_MIN_VERSION = [1, 3, 0] as const;

export function museCliSupportsCompaction(version: string | null | undefined): boolean {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  const [minMajor, minMinor, minPatch] = MUSE_COMPACTION_MIN_VERSION;
  if (major !== minMajor) return major > minMajor;
  if (minor !== minMinor) return minor > minMinor;
  return patch >= minPatch;
}

export interface MuseExecOpts {
  provider: string;
  approval: string;
  sessionId?: string;
  model?: string;
  effort?: EffortLevel;
  baseUrl?: string;
  workspace?: string;
  images?: string[];
  promptFile: string;
  compaction?: MuseCompactionBounds | null;
}

/** argv after the binary for `muse exec --json`. Exported so contract tests
 * can assert the shape without parsing a dump file. */
export function buildMuseExecArgs(opts: MuseExecOpts): string[] {
  const args = [
    "exec",
    "--json",
    "--provider",
    opts.provider,
    ...museSafetyArgs(opts.approval),
    ...(opts.sessionId ? ["--session-id", opts.sessionId] : []),
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.effort ? ["--reasoning-effort", opts.effort] : []),
    ...(opts.baseUrl ? ["--base-url", opts.baseUrl] : []),
    ...(opts.workspace ? ["--workspace", opts.workspace] : []),
    ...(opts.images ?? []).flatMap((image) => ["--image", image]),
    ...(opts.compaction
      ? [
          "--context-compaction-soft-threshold",
          opts.compaction.soft,
          "--context-compaction-hard-threshold",
          opts.compaction.hard,
        ]
      : []),
    "--prompt-file",
    opts.promptFile,
  ];
  return args;
}

/** One parsed stdout line: a text delta, a terminal completion, a terminal
 * failure, or null for anything the turn does not consume (lifecycle and
 * reminder-task noise the echo of a real run is full of). Unknown shapes
 * are ignored — protocol-drift armor, same as every other driver. */
export function parseMuseLine(line: string):
  | { kind: "delta"; text: string }
  | { kind: "completed"; text: string }
  | { kind: "failed"; reason: string }
  | null {
  let event: { payload_type?: unknown; payload?: Record<string, unknown> };
  try {
    event = JSON.parse(line) as typeof event;
  } catch {
    return null;
  }
  if (!event || typeof event !== "object" || typeof event.payload_type !== "string") return null;
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  if (event.payload_type === "run.output.delta" && typeof payload.text === "string") {
    return payload.text ? { kind: "delta", text: payload.text } : null;
  }
  if (event.payload_type === "run.terminal.completed") {
    return { kind: "completed", text: typeof payload.text === "string" ? payload.text : "" };
  }
  // Any other run.terminal.* with a non-completed terminal state fails the
  // turn instead of hanging on a completion that never comes.
  if (event.payload_type.startsWith("run.terminal.")) {
    const terminal = typeof payload.terminal === "string" ? payload.terminal : event.payload_type;
    if (terminal !== "completed") {
      const reason = typeof payload.reason === "string" && payload.reason ? payload.reason : String(terminal);
      return { kind: "failed", reason };
    }
  }
  return null;
}

const SESSION_ERROR = /no such session|unknown session|session .* not found|invalid session|session .* expir|resume/i;
const AUTH_ERROR = /not (signed|logged) in|no .* (login|credential|auth)|unauthori[sz]ed|\b401\b|api.?key|forbidden/i;

function museVersion(cli: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execCli(cli, ["--version"], { timeout: 10_000, maxBuffer: 65_536, env }, (error, stdout) => {
      if (error) return resolve(null);
      const match = /(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/.exec(stdout);
      resolve(match ? match[1] : null);
    });
  });
}

export const MuseDriver: ProviderDriver<MuseConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Muse Code", supportsMultipleInstances: true },
  models: FALLBACK_MODELS,
  decodeConfig: decodeMuseConfig,
  defaultConfig: () => decodeMuseConfig({}),

  async create(input: DriverCreateInput<MuseConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { kill: () => void; turnId: string }>();
    const sessions = new Map<string, string>();

    const emit = (event: RuntimeEvent) => {
      for (const l of Array.from(listeners)) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      providerInstanceId: instanceId,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const childEnv = (): NodeJS.ProcessEnv => {
      const env: NodeJS.ProcessEnv = { ...process.env, ...input.environment };
      // The CLI owns its login; a parent-process key would silently flip the
      // subscription to pay-as-you-go (login help: META_API_KEY always takes
      // priority). Only an instance-level key is deliberate enough to keep.
      if (!input.environment.META_API_KEY) delete env.META_API_KEY;
      return env;
    };

    const models: ModelCatalog = { default: "", options: [] };
    const syncModels = () => applyCatalog(models, resolveMuseModels(childEnv()));
    syncModels();
    // One `--version` probe per instance: the compaction flags below are a
    // hard error on CLIs that predate them, so turns on an old CLI omit
    // them instead of failing identically every time.
    const compactionSupported = museCliSupportsCompaction(await museVersion(config.cli, childEnv()));

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const env = childEnv();
      syncModels();
      const version = await museVersion(config.cli, env);
      if (!version) {
        return {
          state: "unavailable",
          reason: `\`${config.cli}\` isn't installed, or isn't on this app's PATH — install Muse Code, then run \`muse login\` in a terminal`,
        };
      }
      const apiKey = museApiKey(input);
      if (apiKey) return { state: "available", authenticated: true, version, account: { method: "api-key" } };
      if (museHasLogin(env)) return { state: "available", authenticated: true, version, account: { method: "login" } };
      return {
        state: "unavailable",
        reason: "Muse CLI is not signed in — run `muse login` in a terminal (or set META_API_KEY)",
        authenticated: false,
        version,
      };
    };

    const runExec = (
      threadId: string,
      turnId: string,
      turn: SendTurnInput,
      sessionId: string,
      prompt: string,
    ): Promise<{ ok: boolean; stopReason: string | null; sessionError: boolean; cancelled: boolean; reported: boolean }> =>
      new Promise((resolve) => {
        const dir = mkdtempSync(join(tmpdir(), "omb-muse-"));
        const promptFile = join(dir, "prompt.md");
        writeFileSync(promptFile, prompt);
        const cleanup = () => {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            /* best effort */
          }
        };
        const env = childEnv();
        const catalog = resolveMuseModels(env);
        const model = museModelOrDefault(turn.model || config.model || undefined, catalog);
        const mounts = museMcpMountsFromTurn(turn);
        if (mounts) {
          try {
            const overlay = writeMuseMcpOverlay(dir, env, mounts);
            env.XDG_CONFIG_HOME = overlay.xdgConfigHome;
          } catch (error) {
            cleanup();
            resolve({ ok: false, stopReason: (error as Error).message, sessionError: false, cancelled: false, reported: false });
            return;
          }
        }
        const args = buildMuseExecArgs({
          provider: config.provider,
          approval: museApprovalFlag(turn.approvalMode),
          sessionId,
          model,
          effort: turn.effort,
          baseUrl: config.baseUrl || undefined,
          workspace: turn.cwd,
          images: turn.images?.map((image) => image.path),
          promptFile,
          compaction: compactionSupported
            ? museCompactionBounds(
                env,
                catalog.options.find((option) => option.id === model)?.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
              )
            : null,
        });
        appendNative(threadId, { dir: "out", source: "muse.exec", msg: { argv: [config.cli, ...args], model } });
        let child;
        try {
          child = spawnCli(config.cli, args, { env, cwd: turn.cwd ?? process.cwd() });
        } catch (error) {
          cleanup();
          resolve({ ok: false, stopReason: (error as Error).message, sessionError: false, cancelled: false, reported: false });
          return;
        }
        const state = { cancelled: false };
        active.set(threadId, {
          turnId,
          kill: () => {
            state.cancelled = true;
            void killCliTree(child).catch(() => {});
          },
        });
        emit({
          ...base(threadId, turnId),
          type: "session.started",
          sessionId,
          model: museModelOrDefault(turn.model || config.model || undefined, models),
        });

        let streamed = "";
        let pending = "";
        let settled = false;
        let stderr = "";
        let reported = false;
        const flushAssistantText = () => {
          const text = pending;
          pending = "";
          if (!text.trim()) return;
          emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
        };
        const finish = (result: { ok: boolean; stopReason: string | null; sessionError: boolean }) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (active.get(threadId)?.turnId === turnId) active.delete(threadId);
          // An interrupt that lands mid-flight wins over whatever the child
          // was about to report, and must never trigger the resume retry.
          if (state.cancelled) {
            return resolve({ ok: false, stopReason: "interrupted", sessionError: false, cancelled: true, reported });
          }
          resolve({ ...result, cancelled: false, reported });
        };

        child.stdout.on("data", (chunk: Buffer) => {
          for (const line of String(chunk).split(/\r?\n/)) {
            if (!line.trim()) continue;
            const parsed = parseMuseLine(line);
            appendNative(threadId, { dir: "in", source: "muse.exec", msg: line.slice(0, 4000) });
            if (!parsed) continue;
            if (parsed.kind === "delta") {
              streamed += parsed.text;
              pending += parsed.text;
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: parsed.text });
            } else if (parsed.kind === "completed") {
              // The terminal record carries the whole answer; the stream
              // carried it in pieces. Trust the stream's growth and only
              // top up what it never delivered (echo-style runs emit both).
              const tail = parsed.text.startsWith(streamed) ? parsed.text.slice(streamed.length) : "";
              if (tail) {
                streamed += tail;
                pending += tail;
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: tail });
              }
              if (!streamed.trim() && parsed.text.trim()) pending += parsed.text;
              flushAssistantText();
              finish({ ok: true, stopReason: null, sessionError: false });
            } else {
              flushAssistantText();
              finish({ ok: false, stopReason: parsed.reason, sessionError: SESSION_ERROR.test(parsed.reason) });
            }
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += String(chunk);
          if (stderr.length > 8192) stderr = stderr.slice(-8192);
        });
        child.on("error", (error) => {
          const { message, setup } = describeSpawnFailure(error as NodeJS.ErrnoException, config.cli);
          reported = true;
          emit({ ...base(threadId, turnId), type: "runtime.error", message, setup });
          flushAssistantText();
          finish({ ok: false, stopReason: message, sessionError: false });
        });
        child.on("close", (code, signal) => {
          if (settled) return;
          flushAssistantText();
          // The CLI prints the real error first, then a full help page.
          // The tail of that page is flag documentation, which is what a
          // rejected compaction pair used to surface as the turn error.
          const detail = stderr
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(0, 2)
            .join(" ")
            .slice(0, 500);
          if (code === 0) {
            // Clean exit with no terminal record (a killed-early run): the
            // flushed stream is the whole answer.
            if (streamed.trim()) return finish({ ok: true, stopReason: null, sessionError: false });
            return finish({ ok: false, stopReason: "the Muse CLI exited without answering", sessionError: false });
          }
          let stopReason = `the Muse CLI exited (${signal ?? `code ${code}`})${detail ? `: ${detail}` : ""}`;
          if (AUTH_ERROR.test(`${stopReason} ${stderr}`)) {
            stopReason += " — run `muse login` in a terminal (or set META_API_KEY)";
          }
          finish({ ok: false, stopReason, sessionError: SESSION_ERROR.test(`${stopReason} ${stderr}`) });
        });
      });

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      const resume = typeof turn.resumeCursor === "string" && turn.resumeCursor ? turn.resumeCursor : sessions.get(threadId);
      const promptOf = (recovery: string | undefined) =>
        [turn.system, recovery, turn.text].filter((s) => typeof s === "string" && s.trim()).join("\n\n");

      emit({ ...base(threadId, turnId), type: "turn.started" });
      // Resolve on spawn, like the other CLI drivers: the turn settles
      // through events while the caller keeps the turnId for steering and
      // interrupts.
      void (async () => {
        const firstId = resume ?? randomUUID();
        const first = await runExec(threadId, turnId, turn, firstId, promptOf(undefined));
        if (first.ok) {
          sessions.set(threadId, firstId);
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
          return;
        }
        // A resume the CLI no longer knows must not brick the thread: retry
        // once on a fresh session carrying the recovery replay, the same
        // shape server/resume-recovery.ts asks cursor-resuming drivers for.
        // (runExec already reports session.started per attempt, so the retry
        // re-announces itself with the fresh id.)
        if (first.sessionError && resume && !first.cancelled) {
          const freshId = randomUUID();
          const retry = await runExec(threadId, turnId, turn, freshId, promptOf(turn.recoveryText));
          if (retry.ok) {
            sessions.set(threadId, freshId);
            emit({ ...base(threadId, turnId), type: "turn.completed", ok: true, stopReason: null, cost: null });
            return;
          }
          emit({ ...base(threadId, turnId), type: "runtime.error", message: retry.stopReason ?? "the Muse turn failed" });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: retry.stopReason, cost: null });
          return;
        }
        // runExec reports spawn failures itself; anything else gets a
        // runtime.error here so a failed turn is never silent.
        if (first.stopReason && !first.reported) {
          emit({ ...base(threadId, turnId), type: "runtime.error", message: first.stopReason });
        }
        emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: first.stopReason, cost: null });
      })();
      return { turnId };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models,
      refreshModels: async () => {
        syncModels();
      },
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: {
          sessionModelSwitch: "unsupported",
          images: true,
          nativeImageInput: true,
          effortLevels: EFFORT_LEVELS,
          agentsMcp: true,
          browserMcp: true,
          customMcp: true,
        },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.kill(),
        respondToRequest: async () => "unavailable" as const, // headless exec auto-resolves prompts; there is no ask channel
        hasSession: (threadId) => active.has(threadId) || sessions.has(threadId),
        stopAll: async () => {
          for (const { kill } of active.values()) kill();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        for (const { kill } of active.values()) kill();
        listeners.clear();
      },
    };
  },
};
