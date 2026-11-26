// Viewer 宿主：每个需要 3D 的页面创建一个 Viewer，页面切换时销毁释放 GL 资源
import { Viewer } from '../render/viewer';
import { h } from './dom';

export interface ViewerHost {
  wrap: HTMLElement;
  get: () => Viewer | null;
  ensure: () => Viewer;
  destroy: () => void;
}

export function createViewerHost(): ViewerHost {
  const wrap = h('div', { class: 'viewer-wrap' });
  let viewer: Viewer | null = null;
  return {
    wrap,
    get: () => viewer,
    ensure(): Viewer {
      if (!viewer) {
        const canvas = h('canvas') as HTMLCanvasElement;
        wrap.append(canvas);
        viewer = new Viewer(canvas);
        viewer.attachHoverTracking();
      }
      return viewer;
    },
    destroy(): void {
      viewer?.dispose();
      viewer = null;
      wrap.replaceChildren();
    },
  };
}
