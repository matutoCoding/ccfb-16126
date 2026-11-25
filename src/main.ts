import './styles.css';
import { store } from './core/state/store';
import { App } from './ui/App';
import { h } from './ui/dom';

async function bootstrap(): Promise<void> {
  const root = document.getElementById('app')!;
  try {
    await store.init();
  } catch (err) {
    root.append(h('div', { class: 'fatal' }, 'IndexedDB 初始化失败：' + (err as Error).message));
    return;
  }
  if (!window.WebGL2RenderingContext) {
    root.append(h('div', { class: 'fatal' }, '当前浏览器不支持 WebGL2，请使用最新版 Chrome/Edge。'));
    return;
  }
  const app = new App(root);
  app.start();
}

void bootstrap();
