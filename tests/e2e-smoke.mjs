/**
 * 端到端冒烟：真实 UI 全流程走查
 *  新建客户 → 生成测试印模 → 外壳设计 → 内部排布 → 透视检查 → 工厂订单
 */
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vite = await createViteServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
await vite.listen();
const port = vite.httpServer.address().port;

const LAUNCH_ARGS = [
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-gpu-sandbox', '--disable-gpu-watchdog',
  '--disable-crash-reporter', '--no-sandbox',
];

async function runOnce() {
  const browser = await chromium.launch({ args: LAUNCH_ARGS });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  page.on('crash', () => errors.push('[PAGE CRASH]'));
  const steps = [];
  const step = (name, ok, detail = '') => { steps.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`); };

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForSelector('nav.sidebar');
step('应用启动', true);

// 1. 新建客户
await page.getByRole('button', { name: '+ 新建客户' }).click();
await page.waitForSelector('.customer-item.selected');
await page.waitForSelector('input[type="number"]');
await page.fill('input[type="number"]', '72');
const nameInput = page.locator('.card input').first();
await nameInput.fill('测试老人');
await page.getByRole('button', { name: '保存基本信息' }).first().click();
step('新建客户并保存', (await page.locator('.customer-item.selected').count()) === 1);

const clickForce = async (name, opts = {}) => {
  const loc = typeof name === 'string' && name.startsWith('/')
    ? page.getByRole('button', { name: new RegExp(name.slice(1, -1)), ...opts })
    : page.getByRole('button', { name, ...opts });
  for (let i = 0; i < 4; i++) {
    try { await loc.first().click({ force: true, timeout: 8000 }); return; }
    catch { await page.waitForTimeout(600); }
  }
  await loc.first().click({ force: true });
};

// 2. 耳印扫描：生成正常印模
await page.getByRole('button', { name: '耳印扫描' }).click();
await page.waitForSelector('.viewport-wrap canvas', { timeout: 10000 });
await page.waitForTimeout(1200);
await clickForce('正常印模');
await page.waitForFunction(() => document.querySelectorAll('.badge').length > 0, null, { timeout: 10000 });
step('生成正常测试印模', (await page.getByText(/水密网格/).count()) > 0);

// 3. 生成气泡缺损印模，验证缺陷检出
await clickForce('带气泡缺损');
await page.waitForTimeout(600);
step('气泡缺损检出', (await page.getByText(/气泡坑|材料缺损/).count()) > 0);

// 4. 外壳设计
await page.getByRole('button', { name: '外壳设计' }).click();
await page.waitForTimeout(1500);
step('壳体生成且水密', (await page.getByText(/水密闭合|水密/).count()) > 0);
step('壁厚测量有结果', (await page.getByText(/实测最小壁厚/).count()) > 0);

// 5. 内部排布
await page.getByRole('button', { name: '内部排布' }).click();
await page.waitForTimeout(1500);
const layoutText = await page.locator('.page').innerText().catch(() => '');
step('碰撞检查渲染', layoutText.includes('碰撞检查'));
step('过弯检查渲染', layoutText.includes('第二弯') || layoutText.includes('曲率半径'));

// 6. 透视检查
await page.getByRole('button', { name: '透视检查' }).click();
await page.waitForSelector('.viewport-wrap canvas', { timeout: 10000 });
await page.waitForTimeout(1500);
await clickForce(/打开壁厚热力图/);
await page.waitForTimeout(400);
step('壁厚热力图开启', (await page.getByRole('button', { name: /关闭壁厚热力图/ }).count()) > 0);
// 截面滑条
const sliders = page.locator('input[type="range"]');
const sliderCount = await sliders.count();
const slider = sliders.nth(Math.min(5, sliderCount - 1));
await slider.fill('0.7', { force: true });
await page.waitForTimeout(400);
step('截面滑条可调', true);

// 7. 工厂订单
await page.getByRole('button', { name: '工厂订单' }).click();
await page.waitForTimeout(800);
step('订单参数表渲染', (await page.getByText(/通气孔直径|声管长度/).count()) > 0);
await clickForce('拍摄三张透视截图');
let shots = 0;
for (let i = 0; i < 20; i++) {
  shots = await page.locator('img.snapshot-thumb').count();
  if (shots >= 3) break;
  await page.waitForTimeout(300);
}
step('三张透视截图', shots >= 3, `${shots} 张`);
const stlBtn = page.getByRole('button', { name: '下载壳体 STL' });
step('STL 导出可用', (await stlBtn.count()) === 1);
await page.getByRole('button', { name: '生成工厂订单' }).click({ force: true });
await page.waitForTimeout(400);
step('订单生成入库', (await page.getByText(/本客户本耳历次订单（1）/).count()) > 0);

// 8. 设置页
await page.getByRole('button', { name: '设置' }).click();
await page.waitForSelector('.card');
step('设置页渲染', (await page.getByText(/壁厚下限|A-buffer|深度剥离/).count()) > 0);

    const fatal = errors.filter((e) => !e.includes('favicon'));
    console.log(`\n页面未捕获异常：${fatal.length} 条`);
    for (const e of fatal) console.log(' -', e.slice(0, 200));
    const allOk = steps.every((s) => s.ok) && fatal.length === 0;
    console.log(`\n端到端结论：${allOk ? '全部通过' : '存在失败'}（${steps.filter((s) => s.ok).length}/${steps.length}）`);
    return { allOk, steps, fatal };
  } catch (e) {
    console.log('本轮异常（SwiftShader 偶发崩溃，将重试）：' + String(e).slice(0, 160));
    return { allOk: false, steps, fatal: [String(e)], crashed: true };
  } finally {
    await browser.close();
  }
}

// SwiftShader 软件渲染在长流程中可能偶发 GPU 进程崩溃，整轮最多重试 3 次
let finalResult = null;
for (let attempt = 1; attempt <= 3; attempt++) {
  console.log(`\n===== 第 ${attempt} 轮端到端 =====`);
  finalResult = await runOnce();
  if (finalResult.allOk) break;
  if (!finalResult.crashed) break; // 真实断言失败不重试
}
await vite.close();
process.exit(finalResult.allOk ? 0 : 1);
