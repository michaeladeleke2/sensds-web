// Chrome's Local Network Access permission. A page served over https (the
// hosted site) may only open a ws:// connection to a robot on the local
// network once the person allows "local network access" for the site. Until
// then Chrome refuses the connection at once (ERR_BLOCKED_BY_LOCAL_NETWORK_
// ACCESS_CHECKS), which looks the same to the page as an unreachable robot.
// The page can read the permission's state; when it is "prompt", Chrome shows
// the question while the connection waits, so callers wait longer.

const isLoopback = host => /^(localhost|127\.|\[?::1\]?)/i.test(host);

// Whether connecting from this page to `host` needs the permission
export function needsLocalNetwork(host) {
  if (typeof location === 'undefined' || location.protocol !== 'https:') return false;
  return !isLoopback(host);
}

// 'granted' | 'denied' | 'prompt' | 'unknown'
export async function localNetworkState() {
  for (const name of ['local-network', 'local-network-access']) {
    try { return (await navigator.permissions.query({ name })).state; } catch { /* not this name */ }
  }
  return 'unknown';
}

export const LOCAL_NETWORK_HELP = 'Chrome is not letting this site reach devices on your local network, so it cannot reach the robot. '
  + 'Click the icon just left of the web address, set "Local network access" to Allow (it may be under Site settings), then click Connect again.';

export const LOCAL_NETWORK_PROMPT = 'Chrome may ask to let this site look for and connect to devices on your local network. Choose Allow.';
