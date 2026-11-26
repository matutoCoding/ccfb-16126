import { h } from './dom';

export function sliderField(opts: {
  label: string;
  min: number; max: number; step: number; value: number;
  unit?: string;
  format?: (v: number) => string;
  onInput?: (value: number) => void;
  onChange?: (value: number) => void;
}) {
  const output = h('output', { text: opts.format ? opts.format(opts.value) : `${opts.value}${opts.unit ?? ''}` });
  const input = h('input', {
    type: 'range', min: String(opts.min), max: String(opts.max), step: String(opts.step), value: String(opts.value)
  }) as HTMLInputElement;
  input.addEventListener('input', () => {
    const v = Number(input.value);
    output.textContent = opts.format ? opts.format(v) : `${v}${opts.unit ?? ''}`;
    opts.onInput?.(v);
  });
  input.addEventListener('change', () => opts.onChange?.(Number(input.value)));
  const field = h('div', { class: 'field' }, h('label', {}, h('span', { text: opts.label }), output), input);
  return { field, input, output };
}

export function selectField(label: string, value: string, options: Array<[string, string]>, onChange: (value: string) => void) {
  const select = h('select', { class: 'input' }, ...options.map(([v, text]) => h('option', { value: v, selected: v === value, text }))) as HTMLSelectElement;
  select.addEventListener('change', () => onChange(select.value));
  return h('div', { class: 'field' }, h('label', { text: label }), select);
}
