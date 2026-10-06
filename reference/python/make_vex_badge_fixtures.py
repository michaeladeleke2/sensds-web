"""
Dev-time oracle for the VEX AIM and badge ports. Not part of the web app.

Runs SensDSv2's vex/aim.py Robot methods (read only, with the WebSocket
threads replaced by a recorder) for the commands the VEX AIM tab sends, and
ui/gamification.py GamificationManager on a sequence of Test tab events.

    python3 reference/python/make_vex_badge_fixtures.py /Users/michaeladeleke/SensDSv2
"""
import sys
sys.dont_write_bytecode = True

import json
import pathlib
import types

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "tests" / "fixtures" / "vex_badges"


def robot_commands():
    from vex import aim
    from vex import vex_types as vex

    sent = []
    robot = object.__new__(aim.Robot)
    cmd_thread = types.SimpleNamespace(ws=types.SimpleNamespace(connected=True))
    status = types.SimpleNamespace(clear_is_moving_flag=lambda: None)
    object.__setattr__(robot, "_ws_cmd_thread", cmd_thread)
    object.__setattr__(robot, "_ws_status_thread", status)
    object.__setattr__(robot, "drive_speed", 100)
    object.__setattr__(robot, "turn_speed", 75)
    # robot_send serialises with json.dumps(separators=(',', ':')); record that
    object.__setattr__(robot, "robot_send", lambda cmd: sent.append(json.dumps(cmd, separators=(",", ":"))))
    object.__setattr__(robot, "kicker", aim.Kicker(robot))

    robot._program_init()
    robot.move_for(500, 0, wait=False)                      # DriveWorker
    robot.turn_for(vex.TurnType.LEFT, 30, wait=False)       # swipe_left
    robot.turn_for(vex.TurnType.RIGHT, 30, wait=False)      # swipe_right
    robot.kicker.kick(vex.KickType.HARD)                    # push
    robot.stop_all_movement()
    return sent


def badges():
    from ui.gamification import GamificationManager
    mgr = GamificationManager()
    log = []
    mgr.xp_changed.connect(lambda xp, lvl: log.append(["xp", xp, lvl]))
    mgr.badge_earned.connect(lambda key: log.append(["badge", key]))
    mgr.level_up.connect(lambda lvl: log.append(["level_up", lvl]))
    events = (
        [["prediction", "push", 0.55]] * 4 + [["prediction", "idle", 0.91]]
        + [["soccer", "swipe_left"]] * 10
        + [["maze", 3, 14], ["maze", 2, 9], ["maze", 1, 30], ["maze", 3, 10], ["maze", 2, 22]]
        + [["prediction", "push", 0.4]] * 16
    )
    states = []
    for e in events:
        if e[0] == "prediction":
            mgr.on_prediction(e[1], e[2])
        elif e[0] == "soccer":
            mgr.on_soccer_gesture(e[1])
        else:
            mgr.on_maze_solved(e[1], e[2])
        states.append({"xp": mgr.xp, "level": mgr.level_idx, "badges": sorted(mgr.badges), "range": list(mgr.level_xp_range)})
    return {"events": events, "states": states, "signals": log}


def main():
    sys.path.insert(0, sys.argv[1])
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "vex_badges.json").write_text(json.dumps({"commands": robot_commands(), "badges": badges()}, indent=1))
    print("wrote", OUT / "vex_badges.json")


if __name__ == "__main__":
    main()
