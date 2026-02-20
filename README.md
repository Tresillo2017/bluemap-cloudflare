# BlueMap Cloudflare Worker (R2 Storage)

A Cloudflare Worker that serves [BlueMap](https://bluemap.bluecolored.de/) map data from a Cloudflare R2 bucket — replacing the need for NGINX, Apache, or any traditional webserver.

## How It Works

BlueMap renders your Minecraft world into many small **tiles**. High-res tiles are stored as GZip-compressed `.prbm.gz` files, while low-res tiles are plain `.png` images. Map configuration files like `textures.json` and `settings.json` are also stored compressed as `.gz`.

The [BlueMapS3Storage](https://github.com/TheMeinerLP/BlueMapS3Storage) plugin connects BlueMap to your Cloudflare R2 bucket (via S3-compatible API), so all rendered map data is uploaded directly from your Minecraft server — no manual file transfers needed.

This Cloudflare Worker then serves that data to the BlueMap web viewer by:

1. **Decompressing `.gz` files on the fly** — when the browser asks for `something.prbm` or `textures.json`, the worker fetches the `.gz` version from R2, decompresses it, and serves the result.
2. **Returning 204 for missing tiles** — instead of 404, which would flood the browser console with errors.
3. **Serving static assets normally** — `index.html`, JS/CSS bundles, language files, and global `settings.json` are served from Cloudflare's static asset hosting.

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Node.js](https://nodejs.org/) (v18+)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- A Minecraft server with:
  - [BlueMap](https://bluemap.bluecolored.de/) mod or plugin installed
  - [BlueMapS3Storage](https://github.com/TheMeinerLP/BlueMapS3Storage) plugin installed and configured to upload to your R2 bucket

## Quick Start

### 1. Set Up BlueMap + S3 Storage on Your Server

Install the [BlueMap](https://bluemap.bluecolored.de/) mod/plugin and the [BlueMapS3Storage](https://github.com/TheMeinerLP/BlueMapS3Storage) plugin on your Minecraft server.

Configure BlueMapS3Storage to point at your Cloudflare R2 bucket using R2's [S3-compatible API credentials](https://developers.cloudflare.com/r2/api/s3/tokens/). Once configured, BlueMap will render tiles
 and upload them directly to R2.

### 2. Clone / Download

```sh
git clone https://github.com/Tresillo2017/bluemap-cloudflare
cd bluemap-cloudflare
```

### 3. Install Dependencies

```sh
npm install
```

### 4. Authenticate Wrangler

```sh
npx wrangler login
```

### 5. Create an R2 Bucket

```sh
npx wrangler r2 bucket create bluemap
```

> If you want a different bucket name, update `bucket_name` in `wrangler.toml`.

### 6. Copy BlueMap Static Assets

Copy the BlueMap web app files into the `public/` directory:

- `public/index.html` — BlueMap web app entry point
- `public/assets/` — JS/CSS bundles
- `public/lang/` — Language files
- `public/settings.json` — Global BlueMap settings (lists your maps, UI config, etc.)

These are served as static assets by Cloudflare and do **not** go into R2. The R2 bucket is populated automatically by BlueMapS3Storage with the map data (tiles, per-map settings, textures, etc.).

### 7. Deploy the Worker

```sh
npm run deploy
```

Your BlueMap is now live at the URL Wrangler prints (e.g. `https://bluemap-worker.<your-subdomain>.workers.dev`).

### 8. (Optional) Custom Domain

You can attach a custom domain to the worker via the Cloudflare dashboard or by uncommenting and editing the route configuration in `wrangler.toml`:

```toml
[env.production]
routes = [{ pattern = "map.example.com/*", zone_name = "example.com" }]
```

## Configuration

### `wrangler.toml`

| Setting | Description |
|---|---|
| `name` | Worker name (appears in dashboard) |
| `[[r2_buckets]]` | R2 bucket binding — set `bucket_name` to your bucket |
| `LIVE_SERVER_ORIGIN` | (Optional) URL of your Minecraft server's BlueMap webserver for live player markers |

### Live Player Markers

If you run BlueMap as a server plugin/mod with the integrated webserver enabled, you can proxy live data through the worker. Uncomment the `[vars]` section in `wrangler.toml`:

```toml
[vars]
LIVE_SERVER_ORIGIN = "http://your-minecraft-server-ip:8100"
```

> **Note:** Your Minecraft server must be reachable from Cloudflare's network. If it's behind a firewall, you may need to use [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to expose the BlueMap port securely.

## Project Structure

```
bluemap-cloudflare/
├── src/
│   └── index.ts          # Cloudflare Worker source code
├── public/               # Static assets (served by Cloudflare, NOT from R2)
│   ├── index.html        # BlueMap web app entry point
│   ├── settings.json     # BlueMap global settings
│   ├── assets/           # JS/CSS bundles
│   └── lang/             # Language files
├── wrangler.toml         # Cloudflare Worker configuration
├── package.json
└── tsconfig.json
```

The R2 bucket (populated by BlueMapS3Storage) contains:

```
world/
├── tiles/                # Map tile files (.prbm.gz, .png)
├── live/                 # Live marker/player data
├── textures.json.gz      # Texture atlas (compressed)
└── settings.json         # Per-map settings
world_the_nether/
└── ...
world_the_end/
└── ...
```

## How the Worker Resolves Requests

```
Request: GET /maps/world/tiles/0/x0/z0.prbm
  1. Matches .prbm → try compressed version first
  2. Fetch R2 key: world/tiles/0/x0/z0.prbm.gz → FOUND
  3. Decompress gzip and respond with plain body
  ✅ 200 OK

Request: GET /maps/world/tiles/0/x99/z99.prbm
  1. Matches .prbm → try compressed version first
  2. Fetch R2 key: world/tiles/0/x99/z99.prbm.gz → NOT FOUND
  3. Fetch R2 key: world/tiles/0/x99/z99.prbm → NOT FOUND
  4. Path is a tile path → return 204
  ✅ 204 No Content

Request: GET /maps/world/textures.json
  1. Matches textures.json → try compressed version first
  2. Fetch R2 key: world/textures.json.gz → FOUND
  3. Decompress gzip and respond with plain body
  ✅ 200 OK

Request: GET /assets/index-b72fc5a8.js
  1. Served by Cloudflare static assets from public/
  ✅ 200 OK
```

## Development

Run the worker locally with a real R2 bucket binding (using remote mode):

```sh
npm run dev
```

This starts a local dev server (usually at `http://localhost:8787`) using Wrangler's dev mode with access to your R2 bucket.

### Debug Endpoint

The worker exposes a `/debug` endpoint to inspect R2 bucket contents:

```
http://localhost:8787/debug?prefix=world/&max=20
```

This returns a JSON list of R2 object keys and sizes, useful for verifying the bucket is populated correctly.

## Troubleshooting

### Tiles not loading / 404 errors in browser console
- Verify BlueMapS3Storage is configured and has uploaded data to R2.
- Use the `/debug` endpoint to check that R2 keys exist (e.g. `world/tiles/...`).
- Make sure R2 keys do **not** have a `maps/` prefix — the worker strips this from URL paths before looking up keys.

### `textures.json` or `settings.json` fails to load
- Check the `/debug` endpoint to confirm the file exists in R2 (e.g. `world/textures.json.gz`).
- These files are typically stored compressed (`.gz`) by BlueMapS3Storage. The worker automatically tries the `.gz` version first, then falls back to the plain key.

### CORS errors
- The worker sets `Access-Control-Allow-Origin: *` on all responses. If you still see CORS errors, make sure you're not hitting a different origin by mistake.

### Live markers not working
- Set `LIVE_SERVER_ORIGIN` in `wrangler.toml`.
- Ensure the Minecraft server's BlueMap webserver port is reachable from Cloudflare's network.

## Tested With

| Component | Version |
|---|---|
| Datapack | JJThunder 0.6.0 |
| Mod Loader | Neoforge 1.21.1 |

## License

This worker configuration is provided as-is for use with [BlueMap](https://github.com/BlueMap-Minecraft/BlueMap). BlueMap itself is licensed under the MIT License.
