#!/usr/bin/env node

/**
 * Upload BlueMap files to Cloudflare R2 bucket.
 *
 * Usage:
 *   node scripts/upload-to-r2.mjs [--bucket bluemap] [--webroot .]
 *
 * This script walks the BlueMap webroot directory and uploads every file
 * to the configured R2 bucket using `wrangler r2 object put`.
 *
 * Requirements:
 *   - wrangler must be installed and authenticated (`npx wrangler login`)
 *   - The R2 bucket must already exist in your Cloudflare dashboard
 */

import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, posix } from "node:path";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    bucket: { type: "string", default: "bluemap" },
    webroot: { type: "string", default: "." },
    "dry-run": { type: "boolean", default: false },
  },
  strict: false,
});

const BUCKET = args.bucket;
const WEBROOT = args.webroot;
const DRY_RUN = args["dry-run"];

// Directories / files that should NOT be uploaded (e.g. worker source, scripts)
const IGNORE = new Set([
  "node_modules",
  ".git",
  ".wrangler",
  "src",
  "scripts",
  "wrangler.toml",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "sql.php",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively collect all file paths under `dir` */
function walk(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(WEBROOT, full);
    const topLevel = rel.split(/[\\/]/)[0];

    if (IGNORE.has(topLevel) || IGNORE.has(entry)) continue;

    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walk(full));
    } else if (stat.isFile()) {
      results.push(full);
    }
  }
  return results;
}

/** Convert a Windows-style path to a POSIX key for R2 */
function toR2Key(filePath) {
  return relative(WEBROOT, filePath).split("\\").join("/");
}

/** Guess a content-type for wrangler upload */
function contentType(key) {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  const map = {
    html: "text/html",
    css: "text/css",
    js: "text/javascript",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    ttf: "font/ttf",
    woff: "font/woff",
    woff2: "font/woff2",
    gz: "application/gzip",
    prbm: "application/octet-stream",
    txt: "text/plain",
    xml: "text/xml",
  };
  return map[ext] ?? "application/octet-stream";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\n🗺️  BlueMap → R2 Uploader`);
console.log(`   Bucket:  ${BUCKET}`);
console.log(`   Webroot: ${WEBROOT}`);
if (DRY_RUN) console.log(`   ⚠️  DRY RUN — no files will be uploaded\n`);
else console.log();

const files = walk(WEBROOT);
console.log(`Found ${files.length} files to upload.\n`);

let uploaded = 0;
let failed = 0;

for (const file of files) {
  const key = toR2Key(file);
  const ct = contentType(key);

  const cmd = `npx wrangler r2 object put "${BUCKET}/${key}" --file="${file}" --content-type="${ct}"`;

  if (DRY_RUN) {
    console.log(`  [dry-run] ${key}  (${ct})`);
    uploaded++;
    continue;
  }

  try {
    process.stdout.write(`  Uploading: ${key} ...`);
    execSync(cmd, { stdio: "pipe" });
    console.log(" ✅");
    uploaded++;
  } catch (err) {
    console.log(" ❌");
    console.error(`    Error: ${err.message?.split("\n")[0]}`);
    failed++;
  }
}

console.log(`\n✅ Done! Uploaded: ${uploaded}, Failed: ${failed}\n`);

if (failed > 0) {
  process.exit(1);
}
