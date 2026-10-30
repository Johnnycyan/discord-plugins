// Bundles every plugins/<Name>/index.tsx into dist/<Name>/ as a Vendetta-style plugin (manifest.json + index.js).
// Usage: node build.mjs [--watch]
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";

import * as esbuild from "esbuild";

// Kettu evaluates the file as `vendetta => { return <file> }`, so it must be one expression
// whose value is the module's exports
const wrap = code => `(function(){var module={exports:{}};var exports=module.exports;\n${code}\nreturn module.exports;})()`;

function optionsFor(name, manifest) {
    return {
        entryPoints: [`plugins/${name}/index.tsx`],
        bundle: true,
        format: "cjs",
        platform: "neutral",
        target: "es2020",
        jsx: "transform",
        jsxFactory: "React.createElement",
        jsxFragment: "React.Fragment",
        // Plugins are standalone; don't pick up any tsconfig from folders above the repo
        tsconfigRaw: {},
        write: false,
        legalComments: "inline",
        logLevel: "info",
        plugins: [{
            name: "emit",
            setup(build) {
                build.onEnd(async result => {
                    if (result.errors.length) return;
                    const js = wrap(result.outputFiles[0].text);
                    const hash = createHash("sha256").update(js).digest("hex");
                    await mkdir(`dist/${name}`, { recursive: true });
                    await writeFile(`dist/${name}/index.js`, js);
                    await writeFile(`dist/${name}/manifest.json`, JSON.stringify({ ...manifest, hash }));
                    console.log(`built dist/${name} (${js.length} bytes, ${hash.slice(0, 8)})`);
                });
            },
        }],
    };
}

const names = (await readdir("plugins", { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);
const watch = process.argv.includes("--watch");

for (const name of names) {
    const manifest = JSON.parse(await readFile(`plugins/${name}/manifest.json`, "utf8"));
    const options = optionsFor(name, manifest);
    if (watch) await (await esbuild.context(options)).watch();
    else await esbuild.build(options);
}
