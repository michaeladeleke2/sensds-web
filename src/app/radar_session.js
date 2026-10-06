// One radar connection shared by every tab, like SensDSv2's RadarBridge:
// frames go to every subscriber as they arrive (raw_frame_ready).
//
// The radar code is loaded only on Connect Radar, so the page still works for
// recordings in a browser without Web Serial.

const subscribers = new Set();
const stateListeners = new Set();
const session = { port: null, device: null, running: false, drops: 0, frames: 0, mod: null, restarts: 0, goodSinceRestart: 0 };
const MAX_RESTARTS = 3;          // in a row, before giving up

export const isConnected = () => Boolean(session.device);
export const radarStats = () => ({ frames: session.frames, drops: session.drops });
export const hasWebSerial = () => 'serial' in navigator;

// fn(cube): cube is a Float32Array (3 x 128 x 256), the same as Python's
// get_next_frame()[0]. A new array every frame.
export function subscribeFrames(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }

// fn({ connected, message, restarted })
export function onRadarState(fn) { stateListeners.add(fn); }
const emit = (connected, message, restarted = false) => { for (const fn of stateListeners) fn({ connected, message, restarted }); };

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
  Object.assign(session, { port, device, running: true, drops: 0, frames: 0, restarts: 0, goodSinceRestart: 0 });
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
      if (++session.goodSinceRestart >= 50) session.restarts = 0;   // streaming fine again
      for (const fn of subscribers) fn(cube);
    } catch (e) {
      if (!session.running) break;
      // Dropped frames are skipped and streaming continues, as in SensDSv2.
      if (e instanceof mod.FrameAcquisitionFailed) { session.drops++; continue; }
      // A FIFO overflow or a gap in the data (the page was busy and the board's
      // buffer filled) does not need a new connection: restart the acquisition.
      // The desktop stops here; it reads the radar on its own thread, so it
      // rarely falls behind.
      const recoverable = e instanceof mod.FifoOverflow || e instanceof mod.FrameSizeNotSupported || /Timeout waiting for radar data/.test(e.message);
      if (recoverable && session.restarts < MAX_RESTARTS) {
        session.restarts++; session.goodSinceRestart = 0;
        console.warn('[radar] restarting acquisition after:', e.message);
        emit(true, `Radar restarted after: ${e.message} (${session.restarts}/${MAX_RESTARTS})`, true);
        try { await session.device.restart(); continue; }
        catch (err) {
          // The board did not take the restart: reopen the port and start
          // again, as Disconnect then Connect would, without asking for the port
          console.warn('[radar] restart failed, reconnecting:', err.message);
          if (await reconnect()) continue;
          await disconnectRadar(`Radar stopped: could not restart (${err.message})`);
          return;
        }
      }
      await disconnectRadar(`Radar stopped: ${e.message}`);
      return;
    }
  }
}

async function reconnect() {
  const { mod, port } = session;
  emit(true, 'Radar not answering. Reconnecting…', true);
  try { await session.device.close(); } catch { /* already gone */ }
  await new Promise(r => setTimeout(r, 500));
  const device = new mod.RadarDevice(port, { log: m => console.debug('[radar]', m) });
  try {
    await device.open();
    await device.start();
  } catch (e) {
    console.warn('[radar] reconnect failed:', e.message);
    try { await device.close(); } catch { /* nothing open */ }
    session.device = null;
    return false;
  }
  session.device = device;
  emit(true, 'Radar reconnected and streaming.', true);
  return true;
}

export async function disconnectRadar(message) {
  const device = session.device;
  session.running = false;
  session.device = null;
  if (device) await device.close();
  emit(false, message ?? `Radar disconnected after ${session.frames} frames.`);
}
