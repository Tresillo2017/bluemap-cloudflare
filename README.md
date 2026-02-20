# BlueMap Cloudflare Worker (R2 Storage)

A Cloudflare Worker that serves [BlueMap](https://bluemap.bluecolored.de/) map data from a Cloudflare R2 bucket — replacing the need for NGINX, Apache, or any traditional webserver.

## How It Works

BlueMap renders your Minecraft world into many small **tiles**. High-res tiles are stored as GZip-compressed `.prbm.gz` files, while low-res tiles are plain `.png` images. The BlueMap web app requests uncompressed filenames (e.g. `/maps/world/tiles/0/x9/z-8.prbm`), so the webserver must:

1. **Transparently serve `.gz` files** — when the browser asks for `something.prbm`, find `something.prbm.gz` in R2 and serve it with the `Content-Encoding: gzip` header so the browser decompresses it automatically.
2. **Return 204 for missing tiles** — instead of 404, which would flood the browser console with errors.
3. **Serve everything else normally** — static assets, `index.html`, `settings.json`, etc.
4. **(Optional) Proxy live data** — forward `/maps/*/live/*` requests to your Minecraft server's built-in BlueMap webserver for real-time player markers.

This worker handles all of that.

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Node.js](https://nodejs.org/) (v18+)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- A BlueMap installation that has already rendered map tiles to a **file storage** directory

## Quick Start

### 1. Clone / Download

```sh
git clone https://github.com/Tresillo2017/bluemap-cloudflare
cd bluemap-cloudflare
```

### 2. Install Dependencies

```sh
npm install
```

### 3. Authenticate Wrangler

```sh
npx wrangler login
```

### 4. Create an R2 Bucket

```sh
npx wrangler r2 bucket create bluemap
```

> If you want a different bucket name, update `bucket_name` in `wrangler.toml` and use `--bucket <name>` when uploading.

### 5. Upload BlueMap Files to R2

Copy your BlueMap webroot files (the directory containing `index.html`, `assets/`, `maps/`, etc.) into this project directory, then run:

```sh
npm run upload
```

This walks all the BlueMap files and uploads them to R2 using `wrangler r2 object put`. You can preview what will be uploaded first with:

```sh
node scripts/upload-to-r2.mjs --dry-run
```

#### Custom webroot location

If your BlueMap files are in a different directory:

```sh
node scripts/upload-to-r2.mjs --webroot /path/to/bluemap/web
```

> **Tip:** You can also upload files to R2 via the Cloudflare dashboard, the S3-compatible API, or tools like `rclone`.

### 6. Deploy the Worker

```sh
npm run deploy
```

Your BlueMap is now live at the URL Wrangler prints (e.g. `https://bluemap-worker.<your-subdomain>.workers.dev`).

### 7. (Optional) Custom Domain

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
├── scripts/
│   └── upload-to-r2.mjs  # Helper script to upload files to R2
├── assets/                # BlueMap web app static assets
├── maps/                  # BlueMap rendered map data
│   ├── world/
│   │   ├── tiles/         # Map tile files (.prbm.gz, .png)
│   │   ├── live/          # Live marker/player data
│   │   ├── textures.json.gz
│   │   └── settings.json
│   ├── world_the_nether/
│   └── world_the_end/
├── index.html             # BlueMap web app entry point
├── settings.json          # BlueMap global settings
├── wrangler.toml          # Cloudflare Worker configuration
├── package.json
└── tsconfig.json
```

## How the Worker Resolves Requests

```
Request: GET /maps/world/tiles/0/x0/z0.prbm
  1. shouldTryGz(".prbm") → true
  2. Try R2 key: maps/world/tiles/0/x0/z0.prbm.gz → FOUND
  3. Respond with body + Content-Encoding: gzip
  ✅ 200 OK

Request: GET /maps/world/tiles/0/x99/z99.prbm
  1. shouldTryGz(".prbm") → true
  2. Try R2 key: maps/world/tiles/0/x99/z99.prbm.gz → NOT FOUND
  3. Try R2 key: maps/world/tiles/0/x99/z99.prbm → NOT FOUND
  4. Path is a tile path → return 204
  ✅ 204 No Content

Request: GET /maps/world/textures.json
  1. shouldTryGz("textures.json") → true
  2. Try R2 key: maps/world/textures.json.gz → FOUND
  3. Respond with body + Content-Encoding: gzip
  ✅ 200 OK

Request: GET /assets/index-b72fc5a8.js
  1. shouldTryGz → false
  2. Try R2 key: assets/index-b72fc5a8.js → FOUND
  3. Respond with body
  ✅ 200 OK
```

## Updating Map Data

When BlueMap re-renders tiles, you need to re-upload the changed files to R2. You can:

1. **Re-run the upload script** — it will overwrite existing objects:
   ```sh
   npm run upload
   ```

2. **Use `rclone`** with the [S3-compatible R2 API](https://developers.cloudflare.com/r2/api/s3/) to sync only changed files:
   ```sh
   rclone sync /path/to/bluemap/web r2:bluemap --progress
   ```

3. **Automate** with a cron job or CI/CD pipeline after each BlueMap render.

## Development

Run the worker locally with a real R2 bucket binding (using remote mode):

```sh
npm run dev
```

This starts a local dev server (usually at `http://localhost:8787`) using Wrangler's dev mode with access to your R2 bucket.

## Troubleshooting

### Tiles not loading / 404 errors in browser console
- Make sure the R2 object keys match the directory structure (no leading `/`).
- Verify `.prbm.gz` files were uploaded (not just `.prbm`).

### CORS errors
- The worker sets `Access-Control-Allow-Origin: *` on all responses. If you still see CORS errors, make sure you're not hitting a different origin by mistake.

### Live markers not working
- Set `LIVE_SERVER_ORIGIN` in `wrangler.toml`.
- Ensure the Minecraft server's BlueMap webserver port is reachable from Cloudflare's network.

### Large map / many files
- R2 has no per-object upload limit concern for BlueMap tiles (they're small).
- The upload script runs sequentially. For very large maps, consider using `rclone` with the S3 API for parallel uploads.

## License

This worker configuration is provided as-is for use with [BlueMap](https://github.com/BlueMap-Minecraft/BlueMap). BlueMap itself is licensed under the MIT License.
