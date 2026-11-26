import { chromium } from 'playwright';
import { preview } from 'vite';

const port = 4317;
const url = `http://127.0.0.1:${port}/?verify=1`;

const server = await preview({
  preview: { port, host: '127.0.0.1', strictPort: true },
  logLevel: 'warn'
});

let browser;
const launchArgs = [
  '--headless=new',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--enable-webgl',
  '--no-sandbox'
];
try {
  browser = await chromium.launch({ headless: true, args: launchArgs });
} catch (err) {
  console.warn('Playwright Chromium 启动失败，尝试系统 Edge：', err?.message?.split('\n')[0]);
  try {
    browser = await chromium.launch({ headless: true, channel: 'msedge', args: launchArgs });
  } catch (edgeErr) {
    console.warn('Edge 启动失败，尝试系统 Chrome：', edgeErr?.message?.split('\n')[0]);
    browser = await chromium.launch({ headless: true, channel: 'chrome', args: launchArgs });
  }
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') console.log(`[browser:${msg.type()}]`, msg.text());
  });
  page.on('pageerror', err => console.error('[pageerror]', err.stack || err.message));

  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForFunction('window.__VERIFY_DONE__ === true', null, { timeout: 120000 });
  const results = await page.evaluate(() => window.__VERIFY_RESULTS__);
  console.log(JSON.stringify(results, null, 2));
  const pass = Array.isArray(results) && results.length >= 2 && results.every(r => r.pass);
  if (!pass) process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
