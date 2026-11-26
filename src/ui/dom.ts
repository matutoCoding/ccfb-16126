// 极简 DOM 构建辅助
export type Attrs = Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function h(tag: string, attrs: Attrs = {}, ...children: any[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'dataset' && typeof v === 'object') {
      Object.assign(el.dataset, v);
    } else if (k === 'html') el.innerHTML = String(v);
    else el.setAttribute(k, String(v));
  }
  const appendChild = (child: unknown): void => {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(appendChild); return; }
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  };
  children.forEach(appendChild);
  return el;
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function mount(el: HTMLElement, parent: HTMLElement): void {
  clear(parent);
  parent.append(el);
}

let toastTimer = 0;
export function toast(msg: string, ms = 2600): void {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = h('div', { class: 'toast' }, msg);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.remove(), ms);
}

// 标签 + 控件组合
export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h('div', { class: 'field' },
    h('label', {}, label),
    control,
    hint ? h('div', { class: 'muted', style: { marginTop: '3px' } }, hint) : null,
  );
}

export function slider(min: number, max: number, step: number, value: number, onInput: (v: number) => void): HTMLInputElement {
  const s = h('input', { type: 'range', min, max, step, value }) as HTMLInputElement;
  s.addEventListener('input', () => onInput(parseFloat(s.value)));
  return s;
}

export function numberInput(value: number, onInput: (v: number) => void, step = 0.1): HTMLInputElement {
  const i = h('input', { type: 'number', step, value }) as HTMLInputElement;
  i.addEventListener('input', () => onInput(parseFloat(i.value)));
  return i;
}

export function download(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename }) as HTMLAnchorElement;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}
