import struct
import unittest

from tools import can_motor_gui


class CanMotorGuiProtocolTest(unittest.TestCase):
    def test_build_command_payload_uses_node_id_and_float_target(self):
        arbitration_id, data = can_motor_gui.build_command_frame(2, can_motor_gui.CMD_CURRENT, 0.125)
        self.assertEqual(arbitration_id, 0x102)
        self.assertEqual(data[0], can_motor_gui.CMD_CURRENT)
        self.assertEqual(data[1], 0)
        self.assertEqual(struct.unpack("<f", bytes(data[2:6]))[0], 0.125)

    def test_build_set_mode_frame(self):
        arbitration_id, data = can_motor_gui.build_command_frame(
            2, can_motor_gui.CMD_SET_MODE, 0.0, can_motor_gui.MODE_POSITION
        )
        self.assertEqual(arbitration_id, 0x102)
        self.assertEqual(data[0], can_motor_gui.CMD_SET_MODE)
        self.assertEqual(data[1], can_motor_gui.MODE_POSITION)

    def test_build_position_command(self):
        arbitration_id, data = can_motor_gui.build_command_frame(2, can_motor_gui.CMD_POSITION, 1.5)
        self.assertEqual(arbitration_id, 0x102)
        self.assertEqual(data[0], can_motor_gui.CMD_POSITION)
        self.assertAlmostEqual(struct.unpack("<f", bytes(data[2:6]))[0], 1.5)

    def test_decode_status_all_modes_with_speed(self):
        for mode, name, unit in (
            (can_motor_gui.MODE_DISABLED, "IDLE", "V"),
            (can_motor_gui.MODE_CURRENT, "CURRENT", "A"),
            (can_motor_gui.MODE_SPEED, "SPEED", "rpm"),
            (can_motor_gui.MODE_POSITION, "POSITION", "rad"),
            (can_motor_gui.MODE_MIT, "MIT", "rad"),
        ):
            payload = bytearray(8)
            payload[0] = mode
            payload[1] = 0
            primary = 50.0 if mode == can_motor_gui.MODE_SPEED else 1.25
            payload[2:6] = struct.pack("<f", primary)
            payload[6:8] = struct.pack("<h", 123)  # 12.3 rpm * 10
            decoded = can_motor_gui.decode_status_frame(0x182, payload, 2)
            self.assertIsNotNone(decoded)
            self.assertEqual(decoded.mode_name, name)
            self.assertEqual(decoded.unit, unit)
            if mode == can_motor_gui.MODE_SPEED:
                self.assertAlmostEqual(decoded.speed_rpm, 50.0, places=2)
            else:
                self.assertAlmostEqual(decoded.speed_rpm, 12.3, places=2)

    def test_build_pid_includes_pos_ki_isep(self):
        for param in (
            can_motor_gui.PID_POS_KI,
            can_motor_gui.PID_POS_ISEP,
            can_motor_gui.PID_POS_KP,
            can_motor_gui.PID_POS_KD,
            can_motor_gui.PID_CURRENT_KP,
            can_motor_gui.PID_MIT_KP,
        ):
            arbitration_id, data = can_motor_gui.build_pid_command_frame(2, param, 1.5)
            self.assertEqual(arbitration_id, 0x102)
            self.assertEqual(data[0], can_motor_gui.CMD_SET_PID)
            self.assertEqual(data[1], param)
            self.assertAlmostEqual(struct.unpack("<f", bytes(data[2:6]))[0], 1.5)

    def test_mit_pack_unpack_roundtrip(self):
        pos, vel, kp, kd, iq = 1.25, -2.5, 40.0, 1.0, 0.5
        packed = can_motor_gui.pack_mit(pos, vel, kp, kd, iq)
        up_pos, up_vel, up_kp, up_kd, up_iq = can_motor_gui.unpack_mit(packed)
        self.assertAlmostEqual(up_pos, pos, places=2)
        self.assertAlmostEqual(up_vel, vel, places=1)
        self.assertAlmostEqual(up_kp, kp, places=0)
        self.assertAlmostEqual(up_kd, kd, places=2)
        self.assertAlmostEqual(up_iq, iq, places=2)


if __name__ == "__main__":
    unittest.main()
