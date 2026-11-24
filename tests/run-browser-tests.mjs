/**
 * Playwright 浏览器测试入口：
 *   node tests/run-browser-tests.mjs
 * 启动 vite dev server → 打开 #/selftest → 等待 window.__SELFTEST__ 结构化结果。
 * 首次运行需：npx playwright install chromium
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createServer as createViteServer } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const vite = await createViteServer({
  root,
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  logLevel: 'warn',
});
await vite.listen();
const server = vite.httpServer ?? createServer();
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 5199;

const browser = await chromium.launch({
  args: [
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--disable-gpu-sandbox', '--disable-gpu-watchdog', '--no-sandbox',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', (err) => consoleErrors.push(String(err)));

let result = null;
try {
  await page.goto(`http://127.0.0.1:${port}/#/selftest`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__SELFTEST__ && window.__SELFTEST__ !== 'running', null, { timeout: 60000 });
  result = await page.evaluate(() => window.__SELFTEST__);
} finally {
  await page.close();
  await browser.close();
  await new Promise((r) => server.close(r));
  await vite.close();
}

console.log('\n===== 浏览器自检结果 =====');
console.log('WebGL:', result?.webgl);
for (const c of result?.checks ?? []) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
}
console.log(`最大逐像素色阶差: ${result?.maxColorDiff}`);
console.log(`最大壁厚误差(mm): ${result?.maxWallDiffMm}`);
if (consoleErrors.length) {
  console.log('\n控制台错误:');
  for (const e of consoleErrors) console.log(' -', e);
}
if (result?.error) console.log('\n异常堆栈:\n' + result.error);

const ok = result?.pass && consoleErrors.filter((e) => !e.includes('favicon')).length === 0;
process.exit(ok ? 0 : 1);
