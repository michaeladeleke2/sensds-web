// SensAV's line icons (app/ui/icons.py): 24x24 SVG paths drawn with a round
// 1.8 px stroke in the current text colour.

export const ICONS = {
  collect: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14v7M14 17.5h7"/>',
  train: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2.5v3.5M15 2.5v3.5M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>',
  test: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5l5.5 3.5-5.5 3.5z"/>',
  robot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 8V5"/><circle cx="12" cy="3.8" r="1.2"/><circle cx="9" cy="13.5" r="1.2"/><circle cx="15" cy="13.5" r="1.2"/><path d="M1.8 12v3.5M22.2 12v3.5"/>',
  data: '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  check_circle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  save: '<path d="M5 3h11l4 4v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a1 1 0 0 1 1-1z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  sliders: '<path d="M4 7h9M19 7h1M4 17h3M13 17h7"/><circle cx="16" cy="7" r="2.5"/><circle cx="10" cy="17" r="2.5"/>',
  chart: '<path d="M4 4v16h16"/><path d="M7.5 15l4-4 3 3 5-6"/>',
  wifi: '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0"/><path d="M12 19.5h.01"/>',
  stop: '<path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z"/><path d="M9 9h6v6H9z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12h.01"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 15.5l-5-5L7 20"/>',
  wave: '<path d="M3 12h1.5M7 8.5v7M11 4.5v15M15 7.5v9M19 10v4M21 12h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6L6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',
  chevron_down: '<path d="M6 9l6 6 6-6"/>',
  chevron_right: '<path d="M9 6l6 6-6 6"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  record: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>',
  arrow_up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  arrow_down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  arrow_left: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  arrow_right: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  rotate_left: '<path d="M3.5 12a8.5 8.5 0 1 0 2.8-6.3"/><path d="M3 3.5v5h5"/>',
  rotate_right: '<path d="M20.5 12a8.5 8.5 0 1 1-2.8-6.3"/><path d="M21 3.5v5h-5"/>',
  minus: '<path d="M5 12h14"/>',
  battery: '<rect x="2.5" y="7" width="17" height="10" rx="2"/><path d="M22 10.5v3"/><path d="M5.5 10v4"/>',
  gauge: '<path d="M4.5 18a9 9 0 1 1 15 0"/><path d="M12 14l4-5"/><circle cx="12" cy="14" r="1.5"/>',
};

const STROKE_WIDTH = { more: 3.0, wifi: 2.0 };

export function icon(name, size = 18, stroke = 1.8) {
  const width = STROKE_WIDTH[name] ?? stroke;
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
}

// Fills every <span data-icon="name" data-size="18"> below root
export function fillIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    el.innerHTML = icon(el.dataset.icon, Number(el.dataset.size) || 18);
  }
}
