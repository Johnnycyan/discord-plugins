// Packages every built plugin into dist/pool/<id>@<version>.zip and writes dist/index.json,
// the plugin repository users add in Valenced.
// Usage: npm run build && node package.mjs
// VALENCED_BASE_URL sets where dist/ is served (default: this repo's GitHub Pages path).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { zipSync } from "fflate";

const baseUrl = (process.env.VALENCED_BASE_URL ?? "https://johnnycyan.github.io/discord-plugins/valenced").replace(/\/$/, "");
// Fixed timestamp so an unchanged plugin always zips to the same bytes and digest
const mtime = new Date("2020-01-01T00:00:00Z");

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/pool", { recursive: true });

const names = readdirSync("plugins", { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
let count = 0;

names.forEach(name => {
    const dir = `plugins/${name}`;
    if (!existsSync(`${dir}/manifest.json`)) return;

    const manifestText = readFileSync(`${dir}/manifest.json`, "utf8");
    const manifest = JSON.parse(manifestText);
    const script = manifest.dist?.script;
    if (!script) return;

    const bundle = `${dir}/build/js/index.js`;
    if (!existsSync(bundle)) throw new Error(`${name}: ${bundle} is missing, run npm run build first`);

    const zip = zipSync({
        "manifest.json": [new TextEncoder().encode(manifestText), { mtime }],
        [script]: [readFileSync(bundle), { mtime }],
    });
    const file = `${manifest.id}@${manifest.version}.zip`;
    writeFileSync(`dist/pool/${file}`, zip);
    console.log(`packaged dist/pool/${file} (${zip.length} bytes)`);
    count++;
});

if (count === 0) throw new Error("No plugins to package");

execFileSync("node_modules/.bin/valenced-plugin", [
    "generate-index",
    "--dist", "dist/pool",
    "--base-url", `${baseUrl}/pool`,
    "--out", "dist/index.json",
], { stdio: "inherit" });

console.log(`Repository URL: ${baseUrl}/index.json`);
