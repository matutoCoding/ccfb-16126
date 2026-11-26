// scripts/genMcTable.ts
import { readFileSync, writeFileSync } from "node:fs";
var src = readFileSync(new URL("./threeMC.js", import.meta.url), "utf8");
function extractArray(name) {
  const start = src.indexOf(`const ${name} = new Int32Array( [`);
  if (start < 0) throw new Error(`\u627E\u4E0D\u5230 ${name}`);
  const bracket = src.indexOf("[", start);
  const end = src.indexOf("] );", bracket);
  const body = src.slice(bracket + 1, end);
  const nums = body.replace(/\s+/g, "").split(",").filter(Boolean).map((t) => parseInt(t, 16));
  return nums;
}
var edgeTable = extractArray("edgeTable");
var triTable = extractArray("triTable");
var log = (s) => process.stdout.write(s + "\n");
log(`edgeTable ${edgeTable.length} \u9879\uFF08\u5E94 256\uFF09`);
log(`triTable \u539F\u59CB ${triTable.length} \u9879\uFF08\u5E94 4096 = 256*16 \u56FA\u5B9A\u69FD\u4F4D\uFF09`);
if (triTable.length !== 4096) throw new Error(`triTable \u957F\u5EA6 ${triTable.length} \u975E 4096`);
for (let c = 0; c < 256; c++) {
  const row = triTable.slice(c * 16, c * 16 + 16);
  const firstNeg = row.indexOf(-1);
  if (firstNeg < 0) throw new Error(`case ${c} \u65E0 -1 \u54E8\u5175`);
  for (let i = firstNeg + 1; i < 16; i++) {
    if (row[i] !== -1) throw new Error(`case ${c} \u54E8\u5175\u540E\u5B58\u5728\u6570\u636E`);
  }
  if (firstNeg % 3 !== 0) throw new Error(`case ${c} \u4E09\u89D2\u5F62\u4E0D\u5B8C\u6574`);
}
log("triTable 256x16 \u7ED3\u6784\u6821\u9A8C\u901A\u8FC7");
var out = [];
out.push("// \u6743\u5A01 Marching Cubes \u67E5\u627E\u8868\uFF0C\u62BD\u53D6\u81EA three.js\uFF08\u6E90\u81EA Paul Bourke \u6807\u51C6\u8868\uFF09");
out.push("// \u7531 scripts/genMcTable.ts \u81EA\u52A8\u751F\u6210\uFF0C\u52FF\u624B\u6539\u3002triTable \u4E3A 256 case x 16 \u56FA\u5B9A\u69FD\u4F4D\u3002");
out.push(`export const EDGE_TABLE: number[] = [`);
for (let i = 0; i < 256; i += 8) {
  out.push("  " + edgeTable.slice(i, i + 8).map((n) => `0x${n.toString(16)}`).join(", ") + ",");
}
out.push("];");
out.push("");
out.push("export const TRI_TABLE: number[] = [");
for (let c = 0; c < 256; c++) {
  const row = triTable.slice(c * 16, c * 16 + 16);
  out.push("  " + row.join(", ") + ",");
}
out.push("];");
out.push("");
out.push("export const TRI_ROW = 16;");
writeFileSync(new URL("../src/core/mcTables.ts", import.meta.url), out.join("\n"));
log("\u5DF2\u5199\u5165 src/core/mcTables.ts");
