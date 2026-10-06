// One radar connection shared by every tab, like SensDSv2's RadarBridge:
// frames go to every subscriber as they arrive (raw_frame_ready).
//
// The radar code is loaded only on Connect Radar, so the page still works for
// recordings in a browser without Web Serial.

const subscribers = new Set();
const stateListeners = new Set();
const session = { device: null, running: false, drops: 0, frames: 0, mod: null };

export const isConnected = () => Boolean(session.device);
export const radarStats = () => ({ frames: session.frames, drops: session.drops });
export const hasWebSerial = () => 'serial' in navigator;

// fn(cube): cube is a Float32Array (3 x 128 x 256), the same as Python's
// get_next_frame()[0]. A new array every frame.
export function subscribeFrames(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }

// fn({ connected, message })
export function onRadarState(fn) { stateListeners.add(fn); }
const emit = (connected, message) => { for (const fn of stateListeners) fn({ connected, message }); };

export async function connectRadar() {
  try { session.mod = await import('../avian/device.js'); }
  catch { emit(false, 'Live radar is not included in this website build. Open a recording instead.'); return false; }

  let port;
  try { port = await navigator.serial.requestPort({ filters: [{ usbVendorId: session.mod.INFINEON_VID }] }); }
  catch { emit(false, 'No radar selected.'); return false; }

  emit(false, 'Connecting to the radar…');
  const device = new session.mod.RadarDevice(port, { log: m => console.debug('[radar]', m) });
  try {
    const { firmware } = await device.open();
    emit(false, `Radar found: BGT60TR13C, firmware ${firmware}. Starting…`);
    await device.start();
  } catch (e) {
    await device.close().catch(() => {});
    emit(false, `Could not start the radar: ${e.message}`);
    return false;
  }
  Object.assign(session, { device, running: true, drops: 0, frames: 0 });
  emit(true, 'Radar streaming: BGT60TR13C, 3 antennas, 10 frames per second.');
  loop();
  return true;
}

async function loop() {
  const { mod } = session;
  while (session.running) {
    try {
      const cube = await session.device.nextFrame();
      if (!session.running) break;
      session.frames++;
      for (const fn of subscribers) fn(cube);
    } catch (e) {
      if (!session.running) break;
      // Dropped frames are skipped and streaming continues, as in SensDSv2.
      if (e instanceof mod.FrameAcquisitionFailed) { session.drops++; continue; }
      await disconnectRadar(`Radar stopped: ${e.message}`);
      return;
    }
  }
}

export async function disconnectRadar(message) {
  const device = session.device;
  session.running = false;
  session.device = null;
  if (device) await device.close();
  emit(false, message ?? `Radar disconnected after ${session.frames} frames.`);
}
