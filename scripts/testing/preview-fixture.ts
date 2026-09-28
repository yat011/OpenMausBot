// The one Vite preview every verify-* fixture mounts: an isolated page for a
// single entry module whose /api calls reach only the disposable fake-engine
// server. vite.config.ts is inherited on purpose (react, tailwind, the @ alias)
// so the page renders exactly what the app renders; only the host, the port
// and the /api target are pinned here.
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export interface PreviewRoute {
  /** Pathname to answer (the query string is ignored); a RegExp hands its match to the handler. */
  path: string | RegExp;
  /** Restrict to one HTTP method; any method when omitted. */
  method?: string;
  handler: (req: IncomingMessage, res: ServerResponse, match: RegExpExecArray | null) => void | Promise<void>;
}

export interface PreviewOptions {
  /** Root-relative URL of the module the page loads, e.g. "/scripts/testing/x.tsx". */
  entry: string;
  /** Pathname the isolated page is served at, e.g. "/__x.html". */
  route: string;
  title: string;
  /** Fixture-only endpoints beside the page: test pages, drift triggers, captured requests. */
  extraRoutes?: PreviewRoute[];
  /** Content of the viewport meta tag. */
  viewport?: string;
  /** Vite's log level. Its default prints port and dependency notes on stdout,
   * ahead of anything the fixture prints there. */
  logLevel?: "info" | "warn" | "error" | "silent";
}

export interface MountedPreview {
  previewUrl: string;
  close(): Promise<void>;
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);

const matchRoute = (route: PreviewRoute, pathname: string, method: string | undefined) => {
  if (route.method !== undefined && route.method !== method) return undefined;
  if (typeof route.path === "string") return route.path === pathname ? { match: null } : undefined;
  const match = route.path.exec(pathname);
  return match ? { match } : undefined;
};

/** Serve `entry` in an isolated page whose /api requests are proxied to `fixture`. */
export async function mountPreview(
  fixture: { info: { url: string } },
  options: PreviewOptions,
): Promise<MountedPreview> {
  const { entry, route, title, extraRoutes = [], viewport = "width=device-width, initial-scale=1", logLevel } = options;
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="${escapeHtml(viewport)}"><title>${escapeHtml(title)}</title></head><body><div id="root"></div><script type="module" src="${escapeHtml(entry)}"></script></body></html>`;
  const ui = await createServer({
    root: REPO_ROOT,
    ...(logLevel ? { logLevel } : {}),
    server: { host: "127.0.0.1", port: 0, proxy: {
      "/api": { target: fixture.info.url },
      "/.well-known/openmausbot/environment": { target: fixture.info.url },
    } },
    plugins: [{
      name: "isolated-preview",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const pathname = (req.url ?? "").split("?")[0]!;
          if (pathname === route) {
            void server.transformIndexHtml(route, page)
              .then((html) => { res.setHeader("content-type", "text/html"); res.end(html); })
              .catch(next);
            return;
          }
          for (const extra of extraRoutes) {
            const hit = matchRoute(extra, pathname, req.method);
            if (!hit) continue;
            void Promise.resolve().then(() => extra.handler(req, res, hit.match)).catch(next);
            return;
          }
          next();
        });
      },
    }],
  });
  await ui.listen();
  const base = ui.resolvedUrls?.local[0];
  if (!base) {
    await ui.close();
    throw new Error("the preview server did not report a local URL");
  }
  // A cold (or config-changed) optimizer holds the entry for ~2 minutes while
  // it re-bundles; no browser timeout may cover that. Warm the exact bytes
  // the browser will fetch so the returned URL is servable on arrival.
  const previewUrl = new URL(route, base).href;
  const warmed = Date.now();
  console.log("warming the isolated preview (a cold optimizer can take minutes)…");
  const warm = async (url: string) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (!response.ok) {
      await ui.close();
      throw new Error(`preview warmup fetched ${url}: ${response.status}`);
    }
    await response.arrayBuffer();
  };
  const entryUrl = new URL(entry, base).href;
  await warm(previewUrl);
  await warm(entryUrl);
  // The entry alone is not the page: the browser fetches every module before
  // load, and on a slow filesystem (a Windows bind mount reads ~100x slower
  // than native) the tailwind compile plus the graph costs tens of seconds —
  // past any page timeout. Walk the transformed graph and warm each module
  // so the browser arrives to cache hits. Prebundled deps are already
  // on-disk and fast; skip them.
  const key = (url: string) => new URL(url, base).pathname;
  const seen = new Set([key(previewUrl), key(entryUrl)]);
  const queue = [entryUrl];
  let warmedModules = 0;
  // @fs workspaces outside the served root (a docs app route leaks in via a
  // lazy edge) are never part of page load; the browser 500s past them the
  // same way, so warming them would fail a healthy page.
  const skippable = (url: string) => url.startsWith("/node_modules/.vite/") || url.startsWith("/@fs/") || url.includes("[[");
  while (queue.length > 0 && warmedModules < 1000) {
    const node = await ui.moduleGraph.getModuleByUrl(key(queue.shift()!));
    for (const imported of node?.importedModules ?? []) {
      if (seen.has(key(imported.url)) || skippable(imported.url)) continue;
      seen.add(key(imported.url));
      const url = new URL(imported.url, base).href;
      queue.push(url);
      await warm(url);
      warmedModules++;
    }
  }
  console.log(`isolated preview servable after ${((Date.now() - warmed) / 1000).toFixed(1)}s (${warmedModules} graph modules warmed)`);
  return {
    previewUrl,
    close: () => ui.close(),
  };
}

/** Resolve on the first SIGINT or SIGTERM: the "print the URL and wait" ending. */
export function parkUntilSignal(): Promise<void> {
  return new Promise<void>((resolve) => {
    const settle = () => {
      process.off("SIGINT", settle);
      process.off("SIGTERM", settle);
      resolve();
    };
    process.once("SIGINT", settle);
    process.once("SIGTERM", settle);
  });
}

export interface FixtureApiOptions {
  /** Sent with every call; `origin: fixture.info.url` marks a request as the app's own. */
  headers?: Record<string, string>;
  /** Sees every call that succeeded, e.g. to record mutation evidence. */
  observe?: (call: { method: string; path: string; status: number }) => void;
}

/** JSON fetch against the fixture server; a non-2xx status throws with the body. */
export function fixtureApi(baseUrl: string, options: FixtureApiOptions = {}) {
  return async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { "content-type": "application/json", ...options.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(result)}`);
    options.observe?.({ method, path, status: response.status });
    return result;
  };
}
