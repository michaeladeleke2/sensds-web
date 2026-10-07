// The VEX AIM commands SensAV sends (app/robot/protocol.py): drive at an
// angle and speed, turn at a rate, kick, and stop (drive 0 then turn 0).
// Speeds are a percentage of 200 mm/s and 180 degrees/s.

export const DRIVE_MAX_MMPS = 200;
export const TURN_MAX_DPS = 180;
export const SPEEDS = { slow: 30, medium: 50, fast: 80 };
export const SPEED_LABELS = { slow: 'Slow', medium: 'Medium', fast: 'Fast' };
const STACKING_OFF = 0;

export const programInit = () => ({ cmd_id: 'program_init' });
export const drive = (angle, speedMmps) => ({ cmd_id: 'drive', angle, speed: speedMmps, stacking_type: STACKING_OFF });
export const turn = rateDps => ({ cmd_id: 'turn', turn_rate: rateDps, stacking_type: STACKING_OFF });
export const stopMessages = () => [drive(0, 0), turn(0)];

export function actionMessages(action, speed = 'medium') {
  const percent = SPEEDS[speed] ?? SPEEDS.medium;
  const driveSpeed = Math.min(DRIVE_MAX_MMPS, Math.trunc(percent * DRIVE_MAX_MMPS / 100));
  const turnRate = Math.min(TURN_MAX_DPS, Math.trunc(percent * TURN_MAX_DPS / 100));
  switch (action) {
    case 'forward': return [turn(0), drive(0, driveSpeed)];
    case 'backward': return [turn(0), drive(180, driveSpeed)];
    case 'strafe_left': return [turn(0), drive(-90, driveSpeed)];
    case 'strafe_right': return [turn(0), drive(90, driveSpeed)];
    case 'turn_left': return [drive(0, 0), turn(-turnRate)];
    case 'turn_right': return [drive(0, 0), turn(turnRate)];
    case 'kick': return [{ cmd_id: 'kick_hard' }];
    case 'stop': return stopMessages();
    default: return [];
  }
}
