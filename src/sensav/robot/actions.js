// The moves a class can be mapped to (app/robot/actions.py)

export const ACTIONS = [
  ['forward', 'Forward', 'Drive straight ahead'],
  ['backward', 'Backward', 'Drive straight back'],
  ['turn_left', 'Turn Left', 'Spin in place to the left'],
  ['turn_right', 'Turn Right', 'Spin in place to the right'],
  ['strafe_left', 'Strafe Left', 'Slide sideways to the left'],
  ['strafe_right', 'Strafe Right', 'Slide sideways to the right'],
  ['kick', 'Kick', 'Kick once with the kicker'],
  ['stop', 'Stop', 'Stop all movement'],
  ['no_action', 'No Action', 'Keep doing the current command'],
].map(([key, label, description]) => ({ key, label, description }));

export const ACTIONS_BY_KEY = Object.fromEntries(ACTIONS.map(a => [a.key, a]));
export const DEFAULT_ACTION = 'no_action';
export const actionLabel = key => (ACTIONS_BY_KEY[key] ?? ACTIONS_BY_KEY[DEFAULT_ACTION]).label;
