import './styles.css';
import { seedScansIfNeeded } from './seed';
import { loadState } from './state';
import { App } from './ui/App';

async function bootstrap() {
  await seedScansIfNeeded();
  const state = await loadState();
  const app = new App(state);
  app.rerender();
  (window as unknown as { __EAR_APP__?: App }).__EAR_APP__ = app;

  if (new URLSearchParams(location.search).has('verify')) {
    const { runBrowserVerificationPage } = await import('./verify/harness');
    await runBrowserVerificationPage(app);
  }
}

bootstrap().catch(err => {
  console.error(err);
  const el = document.getElementById('app');
  if (el) el.innerHTML = `<div style="padding:40px;color:#fecaca;font-family:sans-serif">启动失败：${String(err?.message ?? err)}</div>`;
});
