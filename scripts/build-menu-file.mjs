import { readFile, writeFile } from "node:fs/promises";

const source = JSON.parse(await readFile(new URL("../menu.json", import.meta.url), "utf8"));
const output = `// Generated from menu.json by scripts/build-menu-file.mjs. Do not edit directly.\nwindow.DinerMenuData = ${JSON.stringify(source)};\n`;
await writeFile(new URL("../menu-file.js", import.meta.url), output);
