/**
 * BlueMap Cloudflare Worker
 *
 * Serves BlueMap web-app and map data from a Cloudflare R2 bucket,
 * implementing the same logic that NGINX/Apache configs do for the
 * file-based external webserver setup described at:
 * https://bluemap.bluecolored.de/wiki/webserver/ExternalWebserversFile.html
 *
 * Key behaviours:
 *  1. If the requested file doesn't exist but a `.gz` variant does,
 *     serve the `.gz` file with `Content-Encoding: gzip`.
 *  2. Certain files (`.prbm`, `textures.json`) are *always* stored as
 *     `.gz` in R2, so the worker transparently rewrites those requests.
 *  3. Missing map tiles return 204 (No Content) instead of 404 to
 *     prevent noisy errors in the browser console.
 *  4. (Optional) Requests to `/maps/*/live/*` can be proxied to the
 *     BlueMap integrated webserver for live player markers.
 */

export interface Env {
  BUCKET: R2Bucket;
  /** Optional origin URL of the BlueMap built-in webserver for live data */
  LIVE_SERVER_ORIGIN?: string;
}

// ---------------------------------------------------------------------------
// MIME types
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "text/xml; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  svg: "image/svg+xml",

  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  tif: "image/tiff",
  tiff: "image/tiff",

  ttf: "font/ttf",
  woff: "font/woff",
  woff2: "font/woff2",

  mp3: "audio/mpeg",
  wav: "audio/wav",
  oga: "audio/ogg",
  weba: "audio/webm",

  mp4: "video/mp4",
  mpeg: "video/mpeg",
  webm: "video/webm",

  prbm: "application/octet-stream",
};

function getMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Files that BlueMap always stores with a .gz extension */
const GZ_ONLY_EXTENSIONS = [".prbm"];
const GZ_ONLY_FILENAMES = ["textures.json"];

/** Returns true when the request path is inside a map tiles directory */
function isTilePath(path: string): boolean {
  // e.g. maps/world/tiles/0/x9/z-8.prbm
  return /^maps\/[^/]+\/tiles\//.test(path);
}

/** Returns true when the path targets the live-data endpoint */
function isLivePath(path: string): boolean {
  return /^maps\/[^/]+\/live\//.test(path);
}

/**
 * Should we automatically try appending `.gz` for this path?
 * We do this for files that BlueMap only stores compressed.
 */
function shouldTryGz(path: string): boolean {
  // Already requesting a .gz — no need to rewrite
  if (path.endsWith(".gz")) return false;

  for (const ext of GZ_ONLY_EXTENSIONS) {
    if (path.endsWith(ext)) return true;
  }
  for (const name of GZ_ONLY_FILENAMES) {
    if (path.endsWith(name)) return true;
  }
  return false;
}

/** Build a Response from an R2Object */
function r2Response(
  object: R2ObjectBody,
  contentType: string,
  gzipped: boolean,
  cacheSeconds: number = 86400,
  request?: Request
): Response {
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", `public, max-age=${cacheSeconds}`);
  headers.set("Access-Control-Allow-Origin", "*");

  if (gzipped) {
    headers.set("Content-Encoding", "gzip");
  }

  // Honour conditional requests (If-None-Match)
  if (request) {
    const ifNoneMatch = request.headers.get("If-None-Match");
    if (ifNoneMatch && ifNoneMatch === object.httpEtag) {
      return new Response(null, { status: 304, headers });
    }
  }

  return new Response(object.body, { headers });
}

// ---------------------------------------------------------------------------
// Worker entry
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let path = decodeURIComponent(url.pathname);

    // Strip leading slash so the R2 key matches the object tree
    if (path.startsWith("/")) {
      path = path.substring(1);
    }

    // Root → serve index.html
    if (path === "" || path === "/") {
      path = "index.html";
    }

    // -----------------------------------------------------------------------
    // CORS preflight
    // -----------------------------------------------------------------------
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

    // Only allow GET / HEAD
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // -----------------------------------------------------------------------
    // Optional: proxy live-data requests to the Minecraft server
    // -----------------------------------------------------------------------
    if (isLivePath(path) && env.LIVE_SERVER_ORIGIN) {
      const target = `${env.LIVE_SERVER_ORIGIN.replace(/\/+$/, "")}/${path}`;
      const proxyReq = new Request(target, {
        method: request.method,
        headers: request.headers,
      });
      try {
        const proxyRes = await fetch(proxyReq);
        const response = new Response(proxyRes.body, proxyRes);
        response.headers.set("Access-Control-Allow-Origin", "*");
        return response;
      } catch {
        // If the live server is unreachable, return 502
        return new Response("Live server unavailable", { status: 502 });
      }
    }

    // -----------------------------------------------------------------------
    // Serve from R2
    // -----------------------------------------------------------------------
    const contentType = getMimeType(path);
    const isMapTile = isTilePath(path);

    // Strategy 1: the file is known to be stored only as .gz in R2
    if (shouldTryGz(path)) {
      const gzKey = path + ".gz";
      const object = await env.BUCKET.get(gzKey);
      if (object) {
        return r2Response(object, contentType, true, 86400, request);
      }

      // If the .gz isn't found either, maybe the uncompressed version exists
      const fallback = await env.BUCKET.get(path);
      if (fallback) {
        return r2Response(fallback, contentType, false, 86400, request);
      }

      // Tile not found → 204
      if (isMapTile) {
        return new Response(null, {
          status: 204,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      return new Response("Not Found", {
        status: 404,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    // Strategy 2: try the exact key first, then fall back to .gz
    const object = await env.BUCKET.get(path);
    if (object) {
      return r2Response(object, contentType, false, 86400, request);
    }

    // Maybe it exists only as .gz (catch-all for any other compressed files)
    if (!path.endsWith(".gz")) {
      const gzObject = await env.BUCKET.get(path + ".gz");
      if (gzObject) {
        return r2Response(gzObject, contentType, true, 86400, request);
      }
    }

    // Map tile not found → 204 (No Content)
    if (isMapTile) {
      return new Response(null, {
        status: 204,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }

    // Everything else → 404
    return new Response("Not Found", {
      status: 404,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  },
};
