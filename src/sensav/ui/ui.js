// Small UI helpers shared by the SensAV tabs: chips, segmented controls,
// message and question dialogs, dates written the desktop's way, saving
// files, and device pickers.

import { icon, fillIcons } from './icons.js';

export const $ = id => document.getElementById(id);

export function setChip(el, text, kind = 'neutral') {
  el.textContent = text;
  el.className = `chip${kind === 'neutral' ? '' : ` ${kind}`}`;
}

export function setIcon(el, name, size) {
  el.dataset.icon = name;
  if (size) el.dataset.size = size;
  el.innerHTML = icon(name, Number(el.dataset.size) || 18);
}

// A .seg element of <button data-value>: returns { value, set(value), onChange }
export function segmented(el, onChange) {
  const ctl = {
    value: el.querySelector('[aria-pressed="true"]')?.dataset.value ?? el.querySelector('button')?.dataset.value,
    set(v) {
      ctl.value = v;
      for (const b of el.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.value === v));
    },
    setEnabled(on) { for (const b of el.querySelectorAll('button')) b.disabled = !on; },
    setOptions(options) {
      el.innerHTML = options.map(([v, label]) => `<button data-value="${v}" aria-pressed="false">${label}</button>`).join('');
      ctl.set(ctl.value);
    },
  };
  el.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled || b.dataset.value === ctl.value) return;
    ctl.set(b.dataset.value);
    onChange?.(b.dataset.value);
  });
  ctl.set(ctl.value);
  return ctl;
}

// ---------- dialogs ----------
const dlg = () => $('messageDialog');

function openMessage({ title, body, iconName = 'info', okText = 'OK', cancelText = null, destructive = false, input = null }) {
  return new Promise(resolve => {
    const d = dlg();
    $('messageTitle').textContent = title;
    $('messageBody').textContent = body;
    $('messageBody').hidden = !body;
    setIcon($('messageIcon'), iconName, 22);
    const ok = $('messageOk'), cancel = $('messageCancel'), field = $('messageInput');
    ok.textContent = okText;
    ok.className = destructive ? 'btn danger' : 'btn primary';
    cancel.hidden = cancelText === null;
    cancel.textContent = cancelText ?? 'Cancel';
    field.hidden = input === null;
    if (input !== null) { field.value = input.value ?? ''; field.maxLength = input.maxLength ?? 40; field.placeholder = input.placeholder ?? ''; }
    let result = null;
    const done = v => { result = v; d.close(); };
    ok.onclick = () => done(input !== null ? field.value.trim() : true);
    cancel.onclick = () => done(input !== null ? null : false);
    field.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); ok.click(); } };
    d.onclose = () => resolve(result ?? (input !== null ? null : false));
    d.showModal();
    if (input !== null) { field.focus(); field.select(); } else ok.focus();
  });
}

export const showError = (title, body) => openMessage({ title, body, iconName: 'info' });
export const showInfo = (title, body) => openMessage({ title, body, iconName: 'check_circle' });
export const confirm = (title, body, okText, destructive = false) => openMessage({ title, body, iconName: destructive ? 'trash' : 'info', okText, cancelText: 'Cancel', destructive });
export const askText = (title, body, value, okText, placeholder = '') => openMessage({ title, body, iconName: 'pencil', okText, cancelText: 'Cancel', input: { value, placeholder } });

// friendly_date: "Today at 3:40 PM" or "Oct 7, 2026"
export function friendlyDate(stamp) {
  const d = new Date(stamp);
  if (!stamp || Number.isNaN(d.getTime())) return stamp ?? '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    let h = d.getHours() % 12; if (h === 0) h = 12;
    return `Today at ${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  }
  return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}, ${d.getFullYear()}`;
}

// Save bytes as a file: a save dialog where the browser has one, else a download
export async function saveFile(suggestedName, bytes, description, extension, mime = 'application/octet-stream') {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime });
  if ('showSaveFilePicker' in window) {
    let handle;
    try {
      handle = await window.showSaveFilePicker({ suggestedName, types: [{ description, accept: { [mime]: [extension] } }] });
    } catch (e) {
      if (e.name === 'AbortError') return null;
      throw e;
    }
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
    return handle.name;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return suggestedName;
}

export async function openFile(description, extension) {
  if ('showOpenFilePicker' in window) {
    try {
      const [h] = await window.showOpenFilePicker({ types: [{ description, accept: { 'application/octet-stream': [extension] } }] });
      return await h.getFile();
    } catch (e) { if (e.name === 'AbortError') return null; throw e; }
  }
  return new Promise(resolve => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: extension });
    input.onchange = () => resolve(input.files[0] ?? null);
    input.click();
  });
}

// Fills a <select> with cameras or microphones, choosing the remembered one
export function fillDevices(select, devices, savedId) {
  const current = select.value;
  select.innerHTML = '';
  for (const d of devices) select.add(new Option(d.name, d.id));
  if (!devices.length) select.add(new Option('Default', ''));
  const wanted = devices.some(d => d.id === savedId) ? savedId : devices.some(d => d.id === current) ? current : devices[0]?.id ?? '';
  select.value = wanted;
}

export { icon, fillIcons };
