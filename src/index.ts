// BlueMap Cloudflare Worker
//
// Static files (index.html, assets/, lang/, settings.json)
// are served automatically by Cloudflare Worker static assets from public/.
//
// This worker handles ALL requests under /maps/* from R2.
// R2 keys do NOT have the "maps/" prefix, so we strip it.
//
// For .prbm tiles (LOD 0): stored as .prbm.gz in R2, served compressed with Content-Encoding: gzip
// For .png tiles (LOD 1+): stored as .png in R2, served directly
// For settings.json: may be stored as settings.json.gz in R2, served compressed with Content-Encoding: gzip
// For textures.json: stored as textures.json.gz in R2, served compressed with Content-Encoding: gzip
// Missing tiles return 204 (No Content) instead of 404

export interface Env {
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  LIVE_SERVER_ORIGIN?: string;
}

function getMimeType(path: string): string {
  if (path.endsWith(".prbm") || path.endsWith(".prbm.gz")) {
    return "application/octet-stream";
  }
  if (path.endsWith(".png")) {
    return "image/png";
  }
  if (path.endsWith(".json") || path.endsWith(".json.gz")) {
    return "application/json";
  }
  return "application/octet-stream";
}

function r2Response(
  object: R2ObjectBody,
  contentType: string,
  request: Request,
): Response {
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=86400");
  headers.set("Access-Control-Allow-Origin", "*");

  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch && ifNoneMatch === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(object.body, { headers });
}

function compressedR2Response(
  object: R2ObjectBody,
  contentType: string,
  request: Request,
): Response {
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Content-Encoding", "gzip");
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=86400");
  headers.set("Access-Control-Allow-Origin", "*");

  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch && ifNoneMatch === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  // @ts-expect-error: encodeBody is a Cloudflare Workers specific option
  return new Response(object.body, { headers, encodeBody: "manual" });
}

function emptyResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Debug endpoint: test live server proxy connection
    // Usage: /debug/live
    if (url.pathname === "/debug/live") {
      if (!env.LIVE_SERVER_ORIGIN) {
        return new Response(
          JSON.stringify({ error: "LIVE_SERVER_ORIGIN is not set" }, null, 2),
          { status: 500, headers: { "Content-Type": "application/json" } },
        );
      }
      const origin = env.LIVE_SERVER_ORIGIN.replace(/\/+$/, "");
      const testUrl = `${origin}/maps/world/live/players.json`;
      try {
        const start = Date.now();
        const res = await fetch(testUrl, {
          method: "GET",
          headers: {
            Accept: "*/*",
            "User-Agent": "bluemap-cloudflare-worker",
          },
        });
        const elapsed = Date.now() - start;
        const body = await res.text();
        const resHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          resHeaders[k] = v;
        });
        return new Response(
          JSON.stringify(
            {
              testUrl,
              status: res.status,
              statusText: res.statusText,
              elapsedMs: elapsed,
              responseHeaders: resHeaders,
              bodyPreview: body.substring(0, 2000),
            },
            null,
            2,
          ),
          { headers: { "Content-Type": "application/json" } },
        );
      } catch (err: unknown) {
        return new Response(
          JSON.stringify(
            {
              testUrl,
              error: err instanceof Error ? err.message : String(err),
            },
            null,
            2,
          ),
          { status: 502, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // Debug endpoint: list R2 objects to diagnose key structure
    // Usage: /debug?prefix=world/&max=20
    if (url.pathname === "/debug") {
      const prefix = url.searchParams.get("prefix") ?? undefined;
      const max = parseInt(url.searchParams.get("max") ?? "50");
      const listed = await env.BUCKET.list({ prefix, limit: max });
      const keys = listed.objects.map((o) => ({
        key: o.key,
        size: o.size,
      }));
      return new Response(
        JSON.stringify(
          { truncated: listed.truncated, count: keys.length, objects: keys },
          null,
          2,
        ),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let path = decodeURIComponent(url.pathname);

    // Strip leading slash
    if (path.startsWith("/")) {
      path = path.substring(1);
    }

    // Only handle maps/* paths — anything else should have been
    // caught by static assets already, so return 404
    if (!path.startsWith("maps/")) {
      return emptyResponse(404);
    }

    // Live player markers: proxy /maps/*/live/* to the integrated webserver
    if (env.LIVE_SERVER_ORIGIN && /^maps\/[^/]+\/live\//.test(path)) {
      const origin = env.LIVE_SERVER_ORIGIN.replace(/\/+$/, "");
      const proxyUrl = `${origin}/${path}`;
      try {
        const proxyResponse = await fetch(proxyUrl, {
          method: request.method,
          headers: {
            Accept: request.headers.get("Accept") ?? "*/*",
            "User-Agent": "bluemap-cloudflare-worker",
          },
        });
        const responseHeaders = new Headers(proxyResponse.headers);
        responseHeaders.set("Access-Control-Allow-Origin", "*");
        // Don't cache live data for long — players move around
        responseHeaders.set("Cache-Control", "public, max-age=5");
        return new Response(proxyResponse.body, {
          status: proxyResponse.status,
          headers: responseHeaders,
        });
      } catch {
        return emptyResponse(502);
      }
    }

    // Strip "maps/" prefix since R2 keys don't include it.
    // e.g. URL path "maps/world/tiles/0/x0/z0.prbm" -> R2 key "world/tiles/0/x0/z0.prbm"
    const r2Key = path.substring("maps/".length);

    const contentType = getMimeType(r2Key);
    const isTile = /^[^/]+\/tiles\//.test(r2Key);

    // .prbm files and map config (settings.json, textures.json) are
    // typically stored as .gz in R2. Try the compressed version first
    // and serve it as-is with Content-Encoding: gzip.
    if (
      r2Key.endsWith(".prbm") ||
      r2Key.endsWith("textures.json") ||
      r2Key.endsWith("settings.json")
    ) {
      const gzObject = await env.BUCKET.get(r2Key + ".gz");
      if (gzObject) {
        return compressedR2Response(gzObject, contentType, request);
      }
      // Not found as .gz — fall through to try the plain key below
    }

    // Try exact key from R2
    const object = await env.BUCKET.get(r2Key);
    if (object) {
      return r2Response(object, contentType, request);
    }

    // Maybe it only exists as .gz (catch-all for other compressed files)
    if (!r2Key.endsWith(".gz")) {
      const gzObject = await env.BUCKET.get(r2Key + ".gz");
      if (gzObject) {
        return compressedR2Response(gzObject, contentType, request);
      }
    }

    // Missing tile -> 204
    if (isTile) {
      return emptyResponse(204);
    }

    return emptyResponse(404);
  },
};
