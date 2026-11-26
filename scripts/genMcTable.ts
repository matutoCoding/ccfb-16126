// 从 three.js MarchingCubes.js 抽取权威 edgeTable/triTable，生成项目用 TS 模块
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('./threeMC.js', import.meta.url), 'utf8');

function extractArray(name: string): number[] {
  const start = src.indexOf(`const ${name} = new Int32Array( [`);
  if (start < 0) throw new Error(`找不到 ${name}`);
  const bracket = src.indexOf('[', start);
  const end = src.indexOf('] );', bracket);
  const body = src.slice(bracket + 1, end);
  const nums = body
    .replace(/\s+/g, '')
    .split(',')
    .filter(Boolean)
    .map((t) => parseInt(t, 16));
  return nums;
}

const edgeTable = extractArray('edgeTable');
const triTable = extractArray('triTable');
const log = (s: string) => process.stdout.write(s + '\n');
log(`edgeTable ${edgeTable.length} 项（应 256）`);
log(`triTable 原始 ${triTable.length} 项（应 4096 = 256*16 固定槽位）`);
if (triTable.length !== 4096) throw new Error(`triTable 长度 ${triTable.length} 非 4096`);

// 校验每个 case：首个 -1 之后全是 -1
for (let c = 0; c < 256; c++) {
  const row = triTable.slice(c * 16, c * 16 + 16);
  const firstNeg = row.indexOf(-1);
  if (firstNeg < 0) throw new Error(`case ${c} 无 -1 哨兵`);
  for (let i = firstNeg + 1; i < 16; i++) {
    if (row[i] !== -1) throw new Error(`case ${c} 哨兵后存在数据`);
  }
  // 哨兵前必须是 3 的倍数（完整三角形）
  if (firstNeg % 3 !== 0) throw new Error(`case ${c} 三角形不完整`);
}
log('triTable 256x16 结构校验通过');

const out: string[] = [];
out.push('// 权威 Marching Cubes 查找表，抽取自 three.js（源自 Paul Bourke 标准表）');
out.push('// 由 scripts/genMcTable.ts 自动生成，勿手改。triTable 为 256 case x 16 固定槽位。');
out.push(`export const EDGE_TABLE: number[] = [`);
for (let i = 0; i < 256; i += 8) {
  out.push('  ' + edgeTable.slice(i, i + 8).map((n) => `0x${n.toString(16)}`).join(', ') + ',');
}
out.push('];');
out.push('');
out.push('export const TRI_TABLE: number[] = [');
for (let c = 0; c < 256; c++) {
  const row = triTable.slice(c * 16, c * 16 + 16);
  out.push('  ' + row.join(', ') + ',');
}
out.push('];');
out.push('');
out.push('export const TRI_ROW = 16;');
writeFileSync(new URL('../src/core/mcTables.ts', import.meta.url), out.join('\n'));
log('已写入 src/core/mcTables.ts');
