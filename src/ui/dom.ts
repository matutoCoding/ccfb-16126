// 轻量 DOM 构建工具，无框架依赖
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | EventListener | null | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'value' || k === 'checked' || k === 'selected') {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else if (k === 'dataset') {
      Object.assign(el.dataset, v);
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el: HTMLElement): void {
  el.replaceChildren();
}

export function labelRow(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'form-row' },
    h('span', { class: 'form-label' }, label),
    control,
    hint ? h('em', { class: 'form-hint' }, hint) : null,
  );
}

export function numberInput(value: number, step: number, min: number, max: number, onInput: (v: number) => void): HTMLInputElement {
  const input = h('input', {
    type: 'number',
    step: String(step),
    min: String(min),
    max: String(max),
    value: String(Number(value.toFixed(3))),
  }) as HTMLInputElement;
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    if (!Number.isNaN(v)) onInput(v);
  });
  return input;
}

export function slider(value: number, min: number, max: number, step: number, onInput: (v: number) => void): HTMLInputElement {
  const input = h('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
  }) as HTMLInputElement;
  input.addEventListener('input', () => onInput(parseFloat(input.value)));
  return input;
}

export function selectInput<T extends string>(
  value: T,
  options: { value: T; label: string }[],
  onChange: (v: T) => void,
): HTMLSelectElement {
  const sel = h('select', {},
    ...options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)),
  ) as HTMLSelectElement;
  sel.addEventListener('change', () => onChange(sel.value as T));
  return sel;
}

export function button(label: string, onClick: EventListener, kind: 'primary' | 'danger' | 'ghost' = 'ghost'): HTMLButtonElement {
  return h('button', { class: `btn btn-${kind}`, onClick }, label);
}

export function badge(text: string, cls = 'badge'): HTMLElement {
  return h('span', { class: cls }, text);
}

export function toast(message: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
  const el = h('div', { class: `toast toast-${kind}` }, message);
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

export function modal(title: string, body: HTMLElement, footer?: HTMLElement): { close: () => void; el: HTMLElement } {
  const close = (): void => el.remove();
  const el = h('div', { class: 'modal-backdrop', onclick: (e: Event) => { if (e.target === el) close(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'modal-x', onclick: close }, '×')),
      h('div', { class: 'modal-body' }, body),
      footer ? h('div', { class: 'modal-foot' }, footer) : null,
    ),
  );
  document.body.append(el);
  return { close, el };
}

export function fmtDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}
