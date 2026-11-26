import { chromium } from 'playwright';
import { preview } from 'vite';

const server = await preview({ preview: { port: 4319, host: '127.0.0.1', strictPort: true }, logLevel: 'warn' });
const errors = [];
let browser;
const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'];
try {
  browser = await chromium.launch({ headless: true, args });
} catch {
  browser = await chromium.launch({ headless: true, channel: 'msedge', args });
}
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', e => errors.push(`pageerror: ${e.stack || e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto('http://127.0.0.1:4319/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.app-shell', { timeout: 30000 });
  await page.waitForTimeout(1200);

  const pages = ['耳印扫描', '外壳设计', '内部排布', '透视检查', '设置', '客户档案'];
  for (const label of pages) {
    await page.getByRole('button', { name: new RegExp(label) }).first().click();
    await page.waitForTimeout(900);
    const canvasCount = await page.locator('canvas').count();
    console.log(`page ${label}: canvas=${canvasCount}`);
  }

  await page.getByRole('button', { name: /耳印扫描/ }).first().click();
  await page.waitForTimeout(500);
  await page.getByText(/耳道特别窄/).first().click();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: /用于外壳设计/ }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'smoke-shell.png', fullPage: false });

  await page.getByRole('button', { name: /透视检查/ }).first().click();
  await page.waitForTimeout(1800);
  await page.mouse.move(800, 420);
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'smoke-perspective.png' });

  await page.getByRole('button', { name: /客户档案/ }).first().click();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: /出工厂订单/ }).first().click();
  await page.waitForSelector('.modal', { timeout: 10000 });
  await page.getByRole('button', { name: /创建订单/ }).click();
  await page.waitForSelector('.shot-grid img', { timeout: 60000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'smoke-order.png' });
  console.log('order modal: screenshots rendered');

  console.log(errors.length ? errors.join('\n') : 'UI_SMOKE_OK');
  if (errors.some(e => !e.includes('EXT_color_buffer_float') && !e.includes('favicon'))) process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise(r => server.httpServer.close(r));
}
