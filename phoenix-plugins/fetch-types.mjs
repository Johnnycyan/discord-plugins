// Downloads Sunbird's plugin API types. Sunbird has no license, so the file is not committed.
import { writeFileSync } from "node:fs";

const url = "https://raw.githubusercontent.com/sunbird-tools/sunbird/main/crates/runtime/phoenix.d.ts";
const res = await fetch(url);
if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
writeFileSync(new URL("./phoenix.d.ts", import.meta.url), await res.text());
console.log("wrote phoenix.d.ts");
