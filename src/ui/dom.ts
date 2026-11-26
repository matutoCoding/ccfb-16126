export type HProps = Record<string, unknown> & {
  class?: string;
  text?: string;
  html?: string;
  style?: string;
};

export function h(tag: string, props: HProps = {}, ...children: Array<Node | string | number | false | null | undefined>): HTMLElement {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'html') el.innerHTML = String(value);
    else if (key === 'style') el.setAttribute('style', String(value));
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'dataset' && typeof value === 'object') {
      Object.assign(el.dataset, value as Record<string, string>);
    } else {
      (el as unknown as Record<string, unknown>)[key] = value;
    }
  }
  for (const child of children.flat()) {
    if (child === false || child === null || child === undefined) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el: HTMLElement) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function fmt(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function statusPill(ok: boolean, okText: string, badText: string): HTMLElement {
  return h('span', { class: `pill ${ok ? 'ok' : 'bad'}`, text: ok ? okText : badText });
}
