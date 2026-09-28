import { killCliTree, spawnCli } from "./procs.ts";
import { BROWSER_STATUS_TOOL, DEFAULT_BROWSER_RESULT_BUDGET, shapeBrowserToolResult, slimBrowserToolList, stripHarnessOwnedArguments } from "./browser-tool-shape.ts";

export interface BrowserSpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

/** Refusal text for a held browser. The wait matches the configured hold
 * idle timeout, so an OMB_BROWSER_HOLD_IDLE_MS override stays truthful. */
export function browserControlRefusal(holdIdleMs: number): string {
  const minutes = Math.max(1, Math.round(holdIdleMs / 60_000));
  return `Browser tools are paused while a person controls this browser. Check agent_browser_status, wait about 30 seconds, and retry the same action for ${minutes} minutes before reporting blocked; a hold with no input for ${minutes} minutes releases itself. Do not try another browser or execution tool.`;
}
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_RESPONSE_BYTES = 16_777_216;
/** Startup, not per-request work: a cold engine spawn can exceed a tight
 * per-request budget before anything has been accepted to guard. */
const HANDSHAKE_TIMEOUT_MS = 1_000;
const HOST_ENV = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATH", "Path", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"];

/** MCP, viewer commands, and cleanup must resolve the same HOME/socket paths.
 * Inherit OS plumbing, never the harness's model-provider credentials. */
export function browserRuntimeEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env = Object.fromEntries(HOST_ENV.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  return { ...env, ...overrides };
}

export class TransportError extends Error {}
type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** A server-owned JSONL client. Neither child stderr nor its environment is
 * returned to the agent. Reuse the existing cross-platform spawn/kill rules. */
class BrowserClient {
  readonly child: ReturnType<typeof spawnCli>;
  readonly ready: Promise<void>;
  private pending = new Map<number, Pending>();
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private stopped = false;
  private idleTimer?: NodeJS.Timeout;
  private stoppedPromise?: Promise<void>;
  private requestTimeoutMs: number;
  private idleMs: number;
  private maxPending: number;
  private onClose: () => void;
  private onRequestTimeout: () => void;
  private latchHandshakeUncertain: boolean;

  constructor(
    spec: BrowserSpawnSpec,
    requestTimeoutMs: number,
    idleMs: number,
    maxPending: number,
    onClose: () => void,
    onRequestTimeout: () => void,
    latchHandshakeUncertain = true,
  ) {
    this.requestTimeoutMs = requestTimeoutMs;
    this.idleMs = idleMs;
    this.maxPending = maxPending;
    this.onClose = onClose;
    this.onRequestTimeout = onRequestTimeout;
    this.latchHandshakeUncertain = latchHandshakeUncertain;
    this.child = spawnCli(spec.command, spec.args, {
      env: browserRuntimeEnv(spec.env), stdio: ["pipe", "pipe", "pipe"], shell: false,
    });
    this.child.stderr.resume();
    this.child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    this.child.stdin.on("error", () => { void this.stop(new TransportError("Browser connection closed.")); });
    this.child.on("error", () => { void this.stop(new TransportError("Could not start the browser engine.")); });
    this.child.on("close", () => { void this.stop(new TransportError("Browser connection closed.")); });
    this.ready = this.rpc("initialize", {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "openmausbot-browser", version: "1" },
    }, Math.max(this.requestTimeoutMs, HANDSHAKE_TIMEOUT_MS), this.latchHandshakeUncertain).then((result) => {
      if (!result || typeof result !== "object" || !("protocolVersion" in result)) {
        throw new TransportError("Browser engine returned an invalid handshake.");
      }
      this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    }).catch((error: unknown) => {
      void this.stop(error instanceof Error ? error : new TransportError("Browser handshake failed."));
      throw error;
    });
  }

  private read(chunk: Buffer): void {
    if (this.stopped) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline: number;
    while ((newline = this.buffer.indexOf(10)) !== -1) {
      if (newline > MAX_RESPONSE_BYTES) {
        void this.stop(new TransportError("Browser response exceeded the size limit."));
        return;
      }
      const line = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line.trim()) continue;
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line);
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error();
      } catch {
        void this.stop(new TransportError("Browser engine returned invalid JSON."));
        return;
      }
      const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (!pending) continue; // MCP notifications do not contain tool results.
      this.pending.delete(message.id!);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "Browser request failed."));
      else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
      else pending.reject(new TransportError("Browser response has no result."));
      this.armIdle();
    }
    if (this.buffer.length > MAX_RESPONSE_BYTES) {
      void this.stop(new TransportError("Browser response exceeded the size limit."));
    }
  }

  private write(message: unknown): void {
    if (this.stopped) throw new TransportError("Browser connection closed.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) void this.stop(new TransportError("Browser connection closed."));
    });
  }

  rpc(method: string, params: unknown, timeoutMs: number = this.requestTimeoutMs, latchUncertainOnTimeout = true): Promise<unknown> {
    if (this.stopped) return Promise.reject(new TransportError("Browser connection closed."));
    if (this.pending.size >= this.maxPending) return Promise.reject(new Error("Too many pending browser requests. Try again when the current action finishes."));
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    if (Buffer.byteLength(JSON.stringify(message)) > MAX_REQUEST_BYTES) return Promise.reject(new Error("Browser request exceeded the size limit."));
    if (this.idleTimer) clearTimeout(this.idleTimer);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Seal the gate synchronously with the timer, before stop() teardown:
        // the rejection can surface through the ready handshake, which sits
        // outside agentRpc's uncertainty classifier. A read-only tools/list
        // never accepts a browser action, so its timeouts kill only the
        // transport and must not wedge the gate into recovery.
        if (latchUncertainOnTimeout) this.onRequestTimeout();
        void this.stop(new TransportError("Browser request timed out; restart the browser before taking control."));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.write(message); }
      catch { void this.stop(new TransportError("Browser connection closed.")); }
    });
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.stopped && this.pending.size === 0) {
      // Only the stateless MCP transport expires; saved browser state and the
      // browser daemon itself belong to the profile, not this client.
      this.idleTimer = setTimeout(() => { void this.stop(undefined, "transport"); }, this.idleMs);
      this.idleTimer.unref();
    }
  }

  /** Upstream's MCP loop exits on stdin EOF without closing the daemon.
   * In particular, Windows taskkill /T would also kill that profile's Chrome,
   * even when the daemon created a new process group. Idle is not shutdown. */
  private retireTransport(): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.child.off("exit", finish);
        resolve();
      };
      const timer = setTimeout(() => {
        try { this.child.kill("SIGKILL"); } catch { /* transport already exited */ }
        finish();
      }, 1_000);
      this.child.once("exit", finish);
      if (this.child.exitCode !== null || this.child.signalCode !== null) finish();
      else this.child.stdin.end();
    });
  }

  stop(error = new TransportError("Browser connection closed."), scope: "transport" | "tree" = "tree"): Promise<void> {
    if (this.stoppedPromise) return this.stoppedPromise;
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.onClose();
    this.stoppedPromise = scope === "transport" ? this.retireTransport() : killCliTree(this.child, 1_000).then((stopped) => {
      if (stopped) return;
      try {
        if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, "SIGKILL");
        else this.child.kill("SIGKILL");
      } catch { /* owned process already exited */ }
    });
    return this.stoppedPromise;
  }
}

interface Gate {
  owner: string | null;
  ready: boolean;
  releasing: boolean;
  agents: number;
  humans: number;
  uncertain: boolean;
  closing: boolean;
  heldSince: number | null;
  lastActivityAt: number | null;
  changed: Set<() => void>;
}

/** Read-only gate state for agents: idle, a person's hold with its age,
 * an interrupted action that needs a restart, or a close in flight. */
export type BrowserGateState = "idle" | "held" | "uncertain" | "closing";
export interface BrowserGateStatus {
  state: BrowserGateState;
  heldByPerson: boolean;
  releasing: boolean;
  agents: number;
  humans: number;
  /** ms since take(); present while a person holds the browser. */
  heldMs?: number;
  /** ms since the last take/human action; present while held. */
  quietMs?: number;
}

export function isBrowserStatusCall(params: unknown): boolean {
  return !!params && typeof params === "object"
    && (params as { name?: unknown }).name === BROWSER_STATUS_TOOL;
}

function formatGateDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Agent `close --all` is the complete Chrome restart for this bot session. */
export function isCompleteBrowserClose(params: unknown): boolean {
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  const name = "name" in params && typeof params.name === "string" ? params.name : "";
  if (name !== "agent_browser_close" && name !== "close") return false;
  const args = "arguments" in params ? params.arguments : undefined;
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  return (args as { all?: unknown }).all === true;
}

export class BrowserRuntime {
  private gates = new Map<string, Gate>();
  private clients = new Map<string, { key: string; client: BrowserClient }>();
  // tools/list is static per engine: one slimmed snapshot per session. Served
  // while uncertain so the close-all recovery tool stays discoverable; close()
  // (engine replaced) clears it, restart() (spawn identity kept) does not.
  private toolListCache = new Map<string, unknown>();
  private options: { requestTimeoutMs: number; takeoverTimeoutMs: number; idleMs: number; maxPending: number; resultBudget: number; holdIdleMs: number };

  constructor(options: Partial<BrowserRuntime["options"]> = {}) {
    const budget = Number(process.env.OMB_BROWSER_RESULT_BUDGET);
    const holdIdle = Number(process.env.OMB_BROWSER_HOLD_IDLE_MS);
    this.options = { requestTimeoutMs: 120_000, takeoverTimeoutMs: 15_000, idleMs: 60_000, maxPending: 16, resultBudget: Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_BROWSER_RESULT_BUDGET, holdIdleMs: Number.isFinite(holdIdle) && holdIdle > 0 ? holdIdle : 300_000, ...options };
  }

  private gate(session: string): Gate {
    let gate = this.gates.get(session);
    if (!gate) {
      gate = { owner: null, ready: false, releasing: false, agents: 0, humans: 0, uncertain: false, closing: false, heldSince: null, lastActivityAt: null, changed: new Set() };
      this.gates.set(session, gate);
    }
    return gate;
  }

  private changed(gate: Gate): void {
    if (gate.releasing && gate.humans === 0) {
      gate.owner = null;
      gate.releasing = false;
      gate.ready = false;
      gate.heldSince = null;
      gate.lastActivityAt = null;
    }
    for (const notify of gate.changed) notify();
  }

  /** Release a forgotten hold: a person owns the gate, nothing is in flight,
   * nothing needs recovery, and no input arrived within holdIdleMs. Never
   * touches active control (humans > 0 or recent input), a hand-back in
   * progress, an uncertain latch, or a close. Lazy: callers reap before
   * refusing, so a stale morning-after hold never blocks the first retry. */
  reapStaleHold(session: string, now = Date.now()): boolean {
    const gate = this.gates.get(session);
    if (!gate || gate.owner === null || gate.releasing || gate.closing || gate.uncertain) return false;
    if (!Number.isFinite(now)) return false;
    if (gate.agents !== 0 || gate.humans !== 0) return false;
    const last = gate.lastActivityAt ?? gate.heldSince;
    if (last === null) return false;
    if (now - last < this.options.holdIdleMs) return false;
    gate.owner = null;
    gate.ready = false;
    gate.heldSince = null;
    gate.lastActivityAt = null;
    this.changed(gate);
    return true;
  }

  /** Read-only gate state for the agent status tool. Reaps a stale hold
   * first, so the reported state matches what the next action would see. */
  status(session: string, now = Date.now()): BrowserGateStatus {
    this.reapStaleHold(session, now);
    const gate = this.gates.get(session);
    const base = { releasing: gate?.releasing ?? false, agents: gate?.agents ?? 0, humans: gate?.humans ?? 0 };
    if (!gate) return { state: "idle", heldByPerson: false, ...base };
    if (gate.closing) return { state: "closing", heldByPerson: gate.owner !== null, ...base };
    if (gate.uncertain) return { state: "uncertain", heldByPerson: gate.owner !== null, ...base };
    if (gate.owner === null) return { state: "idle", heldByPerson: false, ...base };
    return {
      state: "held", heldByPerson: true, ...base,
      heldMs: gate.heldSince === null ? 0 : Math.max(0, now - gate.heldSince),
      quietMs: gate.lastActivityAt === null ? 0 : Math.max(0, now - gate.lastActivityAt),
    };
  }

  /** One agent-facing paragraph for the reported status, including how long
   * to wait before treating the browser as blocked. */
  describeStatus(session: string, now = Date.now()): string {
    const observed = this.status(session, now);
    const releaseMinutes = Math.max(1, Math.round(this.options.holdIdleMs / 60_000));
    if (observed.state === "idle") return "Browser is idle: no person holds control and no recovery is needed. Proceed with browser actions.";
    if (observed.state === "closing") return "The browser is closing or restarting. Wait about 30 seconds and retry the same action.";
    if (observed.state === "uncertain" && !observed.heldByPerson) {
      return "A browser action was interrupted and the browser needs a restart. Restart it with agent_browser_close all=true before continuing; do not report success without restarting.";
    }
    if (observed.state === "uncertain") {
      return "A browser action was interrupted and a person holds control. Wait for them to hand control back or restart the browser from the panel, then restart it with agent_browser_close all=true before continuing.";
    }
    const held = formatGateDuration(observed.heldMs ?? 0);
    const quiet = formatGateDuration(observed.quietMs ?? 0);
    return `A person holds this browser (held ${held}, last input ${quiet} ago). Wait about 30 seconds and retry the same action; keep waiting and retrying for ${releaseMinutes} minutes before reporting blocked. A hold with no input for ${releaseMinutes} minutes releases itself. Do not try another browser or execution tool.`;
  }

  private refusal(): Error {
    return new Error(browserControlRefusal(this.options.holdIdleMs));
  }

  async withAgentAction<T>(session: string, fn: () => Promise<T>): Promise<T> {
    this.reapStaleHold(session);
    const gate = this.gate(session);
    if (gate.owner !== null) throw this.refusal();
    if (gate.uncertain) throw new Error("A browser action was interrupted. Restart this browser before continuing.");
    if (gate.closing) throw new Error("The browser is closing. Try again shortly.");
    gate.agents++;
    try {
      const result = await fn();
      // Discard observations completed after takeover was requested.
      if (gate.owner !== null) throw this.refusal();
      return result;
    } finally {
      gate.agents--;
      this.changed(gate);
    }
  }

  async agentRpc(session: string, spec: BrowserSpawnSpec, method: "tools/list" | "tools/call", params: unknown, beforeDispatch?: () => void, recoverNative?: () => Promise<void>): Promise<unknown> {
    if (method !== "tools/list" && method !== "tools/call") throw new Error("Unsupported browser method.");
    // Read-only diagnostic: bypasses the gate, the capability checks, and
    // the turn resource claim, so a blocked agent can always inspect the wait.
    if (method === "tools/call" && isBrowserStatusCall(params)) {
      return { content: [{ type: "text", text: this.describeStatus(session) }] };
    }
    if (method === "tools/call" && isCompleteBrowserClose(params)) {
      if (!recoverNative) throw new Error("Browser recovery is not configured.");
      beforeDispatch?.();
      await this.agentRestart(session, recoverNative);
      beforeDispatch?.();
      return { content: [{ type: "text", text: "Browser restarted." }] };
    }
    // tools/list bypasses withAgentAction (a human may hold control), so it
    // must refuse the closing window itself or its client outlives restart().
    if (method !== "tools/call" && this.gate(session).closing) throw new Error("The browser is closing. Try again shortly.");
    // Uncertainty survives client replacement and never self-resolves: refuse
    // every new browser request until an explicit restart clears it. The
    // catalog is the exception: drivers re-discover it just before a recovery
    // close, so serve the last slimmed snapshot instead of hiding the recovery
    // tool itself behind the refusal.
    if (this.gate(session).uncertain) {
      if (method === "tools/list") {
        const cached = this.toolListCache.get(session);
        if (cached !== undefined) return cached;
      }
      throw new Error("A browser action was interrupted. Restart this browser before continuing.");
    }
    const invoke = async () => {
      const key = JSON.stringify([spec.command, spec.args, Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b))]);
      let entry = this.clients.get(session);
      if (entry && entry.key !== key) throw new Error("Browser launch settings changed. Close the browser before reconnecting.");
      if (!entry) {
        const client = new BrowserClient(spec, this.options.requestTimeoutMs, this.options.idleMs, this.options.maxPending, () => {
          if (this.clients.get(session)?.client === client) this.clients.delete(session);
        }, () => {
          const gate = this.gate(session);
          if (!gate.closing) gate.uncertain = true;
        }, method === "tools/call");
        entry = { key, client };
        this.clients.set(session, entry);
      }
      await entry.client.ready;
      beforeDispatch?.();
      if (method === "tools/call" && this.gate(session).owner !== null) throw this.refusal();
      try {
        // The model sees slimmed schemas and text-only, bounded results; the
        // launch/session parameters OMB owns never reach the engine from a call.
        const request = method === "tools/call" ? stripHarnessOwnedArguments(params) : params;
        let result = await entry.client.rpc(method, request, this.options.requestTimeoutMs, method === "tools/call");
        beforeDispatch?.(); // A turn revoked while the tool ran receives no result.
        if (method === "tools/list") {
          const slimmed = slimBrowserToolList(result);
          this.toolListCache.set(session, slimmed);
          return slimmed;
        }
        const toolName = request && typeof request === "object" && typeof (request as { name?: unknown }).name === "string" ? (request as { name: string }).name : undefined;
        if (toolName === "agent_browser_open" && result && typeof result === "object" &&
            (result as { isError?: boolean }).isError !== true) {
          // Navigation alone does not prove that the requested page loaded.
          // Observe in the same scoped session, without replaying the action.
          beforeDispatch?.();
          if (this.gate(session).owner !== null) throw this.refusal();
          let observation: unknown;
          try {
            observation = await entry.client.rpc("tools/call", {
              name: "agent_browser_snapshot", arguments: { compact: true },
            });
          } catch (error) {
            // A tool-level refusal does not undo the completed navigation.
            // Transport failures still engage the uncertainty/recovery gate.
            if (error instanceof TransportError) throw error;
            observation = { isError: true, content: [] };
          }
          beforeDispatch?.();
          const navigation = result as { content?: unknown[] };
          const page = observation as { content?: unknown[]; isError?: boolean } | null;
          const observed = page?.isError !== true && Array.isArray(page?.content) && page.content.some((item) =>
            item && typeof item === "object" && (item as { type?: unknown }).type === "text" &&
            typeof (item as { text?: unknown }).text === "string" && (item as { text: string }).text.trim().length > 0);
          result = {
            content: [
              ...(Array.isArray(navigation.content) ? navigation.content : []),
              { type: "text", text: !observed
                ? "Navigation returned, but page verification failed. Do not claim the requested page loaded and do not blindly repeat navigation."
                : "Page observed after navigation. Check this result for redirects, sign-in requirements or page errors before reporting task success:" },
              ...(Array.isArray(page?.content) ? page.content : []),
            ],
            ...(!observed ? { isError: true } : {}),
          };
        }
        return shapeBrowserToolResult(result, { toolName, budget: this.options.resultBudget });
      }
      catch (error) {
        // An MCP timeout cannot prove the independent daemon stopped an
        // accepted action. Recovery must close the browser, not just its pipe.
        // A stop from close()/restart() is intentional, not uncertainty.
        if (method === "tools/call" && error instanceof TransportError && !this.gate(session).closing) {
          const gate = this.gate(session);
          gate.uncertain = true;
        }
        throw error;
      }
    };
    return method === "tools/call" ? this.withAgentAction(session, invoke) : invoke();
  }

  async take(session: string, owner: string): Promise<void> {
    if (!owner) throw new Error("Browser control requires an owner.");
    this.reapStaleHold(session);
    const gate = this.gate(session);
    if (gate.closing || gate.releasing) throw new Error("Browser control is changing. Try again shortly.");
    if (gate.owner !== null && gate.owner !== owner) throw new Error("Another person controls this browser.");
    gate.owner = owner; // synchronous: no new agent work slips in while draining.
    gate.ready = false;
    gate.heldSince = Date.now();
    gate.lastActivityAt = Date.now();
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        gate.changed.delete(check);
        if (error) reject(error);
        else { gate.ready = true; resolve(); }
      };
      const check = () => {
        if (gate.owner !== owner || gate.releasing || gate.closing) finish(new Error("Browser control request was cancelled."));
        // Drain first, then report uncertainty: a timed-out tool RPC leaves
        // its in-flight action pending, and failing fast here would wedge the
        // 409 "may still be running" path even though the action usually lands.
        else if (gate.agents === 0 && gate.uncertain) {
          // A refused take must not leave a hold behind: ready stayed false
          // so nobody controls the browser, and an uncertain latch is never
          // reaped, so a retained owner would wedge every viewer on "paused
          // for human control" with no holder left to restart. Uncertainty
          // still bars agents and control until recovery. (No changed()
          // notify here: check() is itself a watcher; finish() unsubscribes.)
          if (gate.owner === owner) {
            gate.owner = null;
            gate.heldSince = null;
            gate.lastActivityAt = null;
          }
          finish(new Error("A browser action may still be running. Restart this browser before taking control."));
        }
        else if (gate.agents === 0) finish();
      };
      const timer = setTimeout(() => finish(new Error("Browser action is still finishing. Control remains paused; retry taking control or hand it back.")), this.options.takeoverTimeoutMs);
      timer.unref();
      gate.changed.add(check);
      check();
    });
  }

  canControl(session: string, owner: string): boolean {
    const gate = this.gates.get(session);
    return Boolean(owner && gate?.owner === owner && gate.ready && !gate.releasing && !gate.closing && !gate.uncertain && gate.agents === 0);
  }

  heldBy(session: string): string | null { return this.gates.get(session)?.owner ?? null; }

  /** A disconnected viewer may leave a physical key/button pressed. Never
   * let an agent inherit that input state; explicit restart clears it. */
  abandonHumanInput(session: string, owner: string): void {
    const gate = this.gates.get(session);
    if (!owner || !gate || gate.owner !== owner) return;
    gate.uncertain = true;
    gate.ready = false;
    this.changed(gate);
  }

  release(session: string, owner: string): void {
    const gate = this.gates.get(session);
    if (!owner || !gate || gate.owner !== owner) return;
    gate.ready = false;
    gate.releasing = true;
    this.changed(gate); // don't admit agents until pending human input drains.
  }

  async withHumanAction<T>(session: string, owner: string, fn: () => Promise<T>): Promise<T> {
    if (!this.canControl(session, owner)) throw new Error("Take control of this browser before interacting.");
    const gate = this.gate(session);
    gate.lastActivityAt = Date.now();
    gate.humans++;
    try { return await fn(); }
    catch (error) {
      // Validation happens before entry. A failed accepted command might still
      // be executing in the daemon; hand-back must not race its completion.
      gate.uncertain = true;
      gate.ready = false;
      throw error;
    }
    finally { gate.humans--; this.changed(gate); }
  }

  /** Agent recovery for `close --all`. Does not take human control; refuses
   * if a person already holds the panel. Native close is the safety barrier. */
  async agentRestart(session: string, closeBrowser: () => Promise<void>): Promise<void> {
    this.reapStaleHold(session);
    const gate = this.gate(session);
    if (gate.owner !== null && gate.owner !== "agent") throw this.refusal();
    await this.restart(session, "agent", closeBrowser);
  }

  /** Exclusive recovery. Unlike take(), this never waits through active work
   * or admits human input; a successful native close is its safety barrier. */
  async restart(session: string, owner: string, closeBrowser: () => Promise<void>): Promise<void> {
    if (!owner) throw new Error("Browser recovery requires an owner.");
    this.reapStaleHold(session);
    const gate = this.gate(session);
    if (gate.closing || gate.releasing || gate.agents || gate.humans) throw new Error("The browser is busy. Wait for current work to finish before restarting.");
    if (gate.owner !== null && gate.owner !== owner) throw new Error("Another person controls this browser.");
    gate.owner = owner;
    gate.ready = false;
    gate.closing = true;
    this.changed(gate);
    try {
      await closeBrowser();
      await this.clients.get(session)?.client.stop();
      // A tools/list admitted before closing set in can register a client
      // while that stop awaits; registration is synchronous, so one re-check
      // is deterministic and no stray transport survives to idle expiry.
      await this.clients.get(session)?.client.stop();
      gate.uncertain = false;
      gate.owner = null;
      gate.releasing = false;
      gate.heldSince = null;
      gate.lastActivityAt = null;
    } catch (error) {
      gate.owner = owner;
      gate.uncertain = true;
      throw error;
    } finally {
      gate.closing = false;
      this.changed(gate);
    }
  }

  /** Call after the underlying browser is closed when recovering an uncertain
   * action. This closes the MCP transport, not saved logins or profile files. */
  async close(session: string): Promise<void> {
    const gate = this.gate(session);
    gate.closing = true;
    gate.ready = false;
    // Clear before the awaited stop: any uncertain latch after this point must win.
    gate.uncertain = false;
    this.changed(gate);
    await this.clients.get(session)?.client.stop();
    gate.closing = false;
    this.changed(gate);
    // The catalog names tools on a replaced engine; drop the slimmed snapshot
    // so the next discovery lists the new engine instead of a stale copy.
    this.toolListCache.delete(session);
    if (!gate.owner && !gate.agents && !gate.humans) this.gates.delete(session);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...new Set([...this.clients.keys(), ...this.gates.keys()])].map((session) => this.close(session)));
  }
}
