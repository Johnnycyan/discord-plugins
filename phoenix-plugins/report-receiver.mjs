// Receives spike reports from a phone on the same network and saves them to reports/.
// Phoenix plugins can't write files, so they POST their report here with phoenix.fetch.
// usage: npm run receive   (then put the printed URL in the plugin's "Report URL" setting)
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";

const PORT = Number(process.env.PORT ?? 8787);
const MAX_BYTES = 20 * 1024 * 1024;
const dir = new URL("./reports/", import.meta.url);
mkdirSync(dir, { recursive: true });

createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/report") {
        res.writeHead(404).end();
        return;
    }

    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) {
            res.writeHead(413).end("too large");
            req.destroy();
            return;
        }
        chunks.push(chunk);
    });
    req.on("end", () => {
        if (res.writableEnded) return;
        const name = `report-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
        writeFileSync(new URL(name, dir), Buffer.concat(chunks));
        console.log(`saved reports/${name} (${size} bytes)`);
        res.writeHead(200, { "content-type": "text/plain" }).end(`saved ${name}`);
    });
}).listen(PORT, "0.0.0.0", () => {
    const ips = Object.values(networkInterfaces()).flat()
        .filter(a => a && a.family === "IPv4" && !a.internal)
        .map(a => a.address);
    console.log("Waiting for reports. Report URL to put in the plugin:");
    for (const ip of ips) console.log(`  http://${ip}:${PORT}/report`);
});
