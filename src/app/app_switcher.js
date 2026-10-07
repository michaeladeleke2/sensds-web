// The logo opens a menu to switch between SensDS (this page) and SensAV
// (sensav/). Leaving while the radar streams asks first, since the new page
// closes the serial port.

export function initAppSwitcher() {
  const button = document.getElementById('brandButton'), menu = document.getElementById('appMenu');
  const close = () => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); };
  button.addEventListener('click', () => {
    const open = menu.hidden;
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('pointerdown', e => { if (!menu.hidden && !menu.contains(e.target) && !button.contains(e.target)) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  document.getElementById('sensavLink').addEventListener('click', e => {
    if (document.getElementById('radarChip')?.classList.contains('live') && !window.confirm('Switching to SensAV disconnects the radar. Continue?')) e.preventDefault();
  });
}
