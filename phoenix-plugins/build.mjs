// Bundles plugins/<Name>/index.ts into dist/<Name>.js the way Sunbird bundles its own plugins:
// an esbuild IIFE for es2023, with the leading `// @` metadata lines kept as a banner.
import { context } from "esbuild";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const watch = process.argv.includes("--watch");

for (const name of readdirSync("plugins")) {
    const entry = `plugins/${name}/index.ts`;
    if (!existsSync(entry)) continue;

    const lines = readFileSync(entry, "utf8").split(/\r?\n/);
    const end = lines.findIndex(line => !line.startsWith("// @"));
    const header = lines.slice(0, end === -1 ? lines.length : end).join("\n");

    const ctx = await context({
        entryPoints: [entry],
        bundle: true,
        format: "iife",
        target: "es2023",
        banner: { js: header },
        outfile: `dist/${name}.js`,
        logLevel: "info",
    });

    if (watch) {
        await ctx.watch();
    } else {
        await ctx.rebuild();
        await ctx.dispose();
    }
}
