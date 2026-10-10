/* Host test: gcc -std=c11 -Wall -Wextra -Itests/stubs -ILibraries/App/inc -ILibraries/Control/inc -DMOTOR_CAN_ID=1 \
 *   tests/test_uart_config.c Libraries/App/src/store_record.c Libraries/App/src/ascii_util.c \
 *   Libraries/App/src/device_config.c -lm */
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "ascii_util.h"
#include "device_config.h"
#include "iq_limits.h"
#include "store_record.h"

/* ---- stubs for device_config.c dependencies ---- */
volatile float control_current_pi_kp = 12.0f, control_current_pi_ki = 1500.0f,
               control_current_pi_out_limit_v = 0.0f, control_iq_limit_a = 2.5f,
               control_speed_pi_kp = 0.25f, control_speed_pi_ki = 0.02f, control_speed_pi_kd = 0.0f,
               control_accel_ref_rad_s2 = 0.0f, control_position_kp = 3.5f, control_position_ki = 1.2f,
               control_position_kd = 2.6f, control_position_i_sep_rad = 0.35f,
               control_position_velocity_limit_rad_s = 100.0f, control_mit_kp = 10.0f,
               control_mit_kd = 0.5f, control_electrical_zero_rad = 0.12578f,
               control_vbus_min_v = DEVICE_DEFAULT_VBUS_MIN_V,
               control_vbus_max_v = DEVICE_DEFAULT_VBUS_MAX_V,
               control_zero_offset_rad = 0.0f,
               control_rs_ohm = DEVICE_DEFAULT_RS_OHM,
               control_ls_h = DEVICE_DEFAULT_LS_H,
               control_max_modulation = DEVICE_MAX_MOD_DEFAULT,
               control_ol_en = 0.0f,
               control_ol_iq_a = IQ_CONTINUOUS_MAX_A,
               control_ol_time_s = OL_TIME_DEFAULT_S;
volatile uint8_t control_encoder_direction = 1U;
static uint8_t g_flash[STORE_RECORD_MAX_BYTES];
static int g_flash_valid = 0;
static int g_saves = 0;
int StoreImage_Load(StoreImage *image) {
  return g_flash_valid && StoreRecord_Decode(g_flash, sizeof(g_flash), image);
}
int StoreImage_Save(const StoreImage *image, uint32_t *seq) {
  StoreImage prev;
  uint32_t s = StoreImage_Load(&prev) ? prev.sequence + 1U : 1U;
  if (StoreRecord_Encode(image, s, g_flash, sizeof(g_flash)) != STORE_RECORD_V4_BYTES) return 0;
  g_flash_valid = 1;
  g_saves++;
  if (seq) *seq = s;
  return 1;
}

static void put_v1(float zero, uint8_t dir, uint32_t seq) {
  uint8_t r[24] = {0};
  uint32_t magic = STORE_RECORD_MAGIC; uint16_t ver = 1, size = 24;
  memcpy(r, &magic, 4); memcpy(r + 4, &ver, 2); memcpy(r + 6, &size, 2); memcpy(r + 8, &seq, 4);
  memcpy(r + 12, &zero, 4); r[16] = dir;
  uint32_t crc = StoreRecord_Crc32(r, 20); memcpy(r + 20, &crc, 4);
  memset(g_flash, 0xFF, sizeof(g_flash)); memcpy(g_flash, r, 24); g_flash_valid = 1;
}

/* Hand-built v3 (152 bytes). Encode no longer writes v3, so this image is
 * assembled here. Config starts at byte 20. iq_limit is config offset 24. */
static void put_v3(float iq_limit, uint8_t can_id) {
  uint8_t r[STORE_RECORD_V3_BYTES];
  memset(r, 0, sizeof(r));
  uint32_t magic = STORE_RECORD_MAGIC;
  uint16_t ver = (uint16_t)STORE_RECORD_V3;
  uint16_t size = (uint16_t)STORE_RECORD_V3_BYTES;
  uint32_t seq = 11U;
  float rs = DEVICE_DEFAULT_RS_OHM;
  float ls = DEVICE_DEFAULT_LS_H;
  float vmin = 6.0f;
  float vmax = 40.0f;
  uint32_t baud = 1000000U;
  uint16_t hz = 100U;
  memcpy(r + 0, &magic, 4); memcpy(r + 4, &ver, 2); memcpy(r + 6, &size, 2);
  memcpy(r + 8, &seq, 4);
  r[18] = 1; /* config_valid, calibration left invalid */
  r[20] = can_id;
  r[23] = 1; /* telemetry */
  memcpy(r + 44, &iq_limit, 4);
  r[92] = 14; r[93] = 1; r[94] = 10; /* pole pairs, enc_dir, gear */
  memcpy(r + 100, &rs, 4); memcpy(r + 104, &ls, 4);
  memcpy(r + 108, &vmin, 4); memcpy(r + 112, &vmax, 4);
  memcpy(r + 120, &baud, 4); memcpy(r + 130, &hz, 2);
  for (uint8_t i = 0U; i < 16U; ++i) r[132U + i] = i;
  uint32_t crc = StoreRecord_Crc32(r, 148); memcpy(r + 148, &crc, 4);
  memset(g_flash, 0xFF, sizeof(g_flash)); memcpy(g_flash, r, sizeof(r)); g_flash_valid = 1;
}

static const char *fmt(float v) {
  static char b[32]; TextBuf t; Text_Init(&t, b, sizeof(b)); Text_Float(&t, v); return b;
}

int main(void) {
  /* ---- Text_Float ---- */
  assert(!strcmp(fmt(0.0f), "0"));
  assert(!strcmp(fmt(1500.0f), "1500"));
  assert(!strcmp(fmt(0.35f), "0.35"));
  assert(!strcmp(fmt(-2.5f), "-2.5"));
  assert(!strcmp(fmt(0.12578f), "0.12578"));
  assert(!strcmp(fmt(12.0f), "12"));
  assert(!strcmp(fmt(100000.0f), "100000"));
  assert(!strcmp(fmt(NAN), "nan"));
  { char b[16]; TextBuf t; Text_Init(&t, b, sizeof(b)); Text_Str(&t, "0x"); Text_Hex(&t, 0x2A, 4); Text_Char(&t, ' '); Text_I32(&t, -42);
    assert(!strcmp(b, "0x002A -42")); }
  { char b[4]; TextBuf t; Text_Init(&t, b, sizeof(b)); Text_Str(&t, "abcdef"); assert(t.overflow && !strcmp(b, "abc")); }

  /* ---- tokenizer / parse ---- */
  { char line[] = "set cur_kp=12.5"; char *tk[7]; Ascii_Upper(line);
    size_t n = Ascii_Tokenize(line, tk, 7);
    assert(n == 3 && !strcmp(tk[0], "SET") && !strcmp(tk[1], "CUR_KP") && !strcmp(tk[2], "12.5")); }
  { char line[] = "  MIT 1, -2 5 0.1  0 "; char *tk[7]; size_t n = Ascii_Tokenize(line, tk, 7);
    assert(n == 6 && !strcmp(tk[5], "0")); }
  { char line[] = "A B C D E F G H I"; char *tk[7]; assert(Ascii_Tokenize(line, tk, 7) == 9); }
  { float v; assert(Ascii_ParseFloat("1e3", &v) && v == 1000.0f);
    assert(!Ascii_ParseFloat("12x", &v)); assert(!Ascii_ParseFloat("", &v)); assert(!Ascii_ParseFloat("inf", &v)); }

  /* ---- store record: v1 compat, v2 round trip, corruption ---- */
  put_v1(0.5f, 1, 7);
  { StoreImage im; assert(StoreRecord_Decode(g_flash, sizeof(g_flash), &im));
    assert(im.version == 1 && im.calib_valid && !im.config_valid && im.sequence == 7 && im.electrical_zero_rad == 0.5f); }
  { StoreImage im; memset(&im, 0, sizeof(im)); uint8_t buf[STORE_RECORD_V4_BYTES];
    im.calib_valid = 1; im.electrical_zero_rad = 1.0f; im.encoder_direction = 0; im.config_valid = 1; im.config.can_id = 5;
    im.config.spd_kp = 0.3f; im.config.pole_pairs = 14; im.config.can_baud = 1000000U;
    assert(StoreRecord_Encode(&im, 9, buf, sizeof(buf)) == STORE_RECORD_V4_BYTES);
    StoreImage out; assert(StoreRecord_Decode(buf, sizeof(buf), &out));
    assert(out.version == 4 && out.sequence == 9 && out.config.can_id == 5 && out.config.spd_kp == 0.3f && out.calib_valid);
    assert(out.config.pole_pairs == 14 && out.config.can_baud == 1000000U);
    buf[40] ^= 1; assert(!StoreRecord_Decode(buf, sizeof(buf), &out));
    im.electrical_zero_rad = 7.0f; assert(StoreRecord_Encode(&im, 1, buf, sizeof(buf)) == 0); }

  /* ---- device config: v1 flash keeps calibration, config defaults ---- */
  put_v1(0.5f, 1, 7);
  DeviceConfig_Init();
  assert(DeviceConfig_Source() == DEVCFG_SRC_FLASH_V1);
  assert(DeviceConfig_ActiveCanId() == MOTOR_CAN_ID && DeviceConfig_Live()->telemetry == 1);
  assert(DeviceConfig_ParamCount() == 38);
  assert(control_max_modulation == DEVICE_MAX_MOD_DEFAULT);
  assert(control_ol_en == 0.0f);
  assert(control_ol_iq_a == IQ_CONTINUOUS_MAX_A);
  assert(control_ol_time_s == OL_TIME_DEFAULT_S);
  assert(DeviceConfig_Live()->ol_en == 0.0f);
  assert(DeviceConfig_Live()->ol_iq == IQ_CONTINUOUS_MAX_A);
  assert(DeviceConfig_Live()->ol_time_s == OL_TIME_DEFAULT_S);
  assert(DeviceConfig_Live()->pole_pairs == DEVICE_DEFAULT_POLE_PAIRS);
  assert(DeviceConfig_Live()->gear_ratio == DEVICE_DEFAULT_GEAR_RATIO);
  assert(DeviceConfig_Live()->can_baud == DEVICE_DEFAULT_CAN_BAUD);
  assert(DeviceConfig_Live()->enc_dir == 1); /* v1 calibration direction is kept */
  assert(DeviceConfig_Live()->spd_ramp_ms == 0 && DeviceConfig_Live()->telem_hz == 100);
  assert(DeviceConfig_ZeroIsSet() == 0);
  assert(control_rs_ohm == DEVICE_DEFAULT_RS_OHM);
  assert(control_ls_h == DEVICE_DEFAULT_LS_H);
  assert(control_vbus_min_v == DEVICE_DEFAULT_VBUS_MIN_V);
  assert(control_vbus_max_v == DEVICE_DEFAULT_VBUS_MAX_V);
  assert(DeviceConfig_MaxTelemHz() == 135);
  assert(DeviceConfig_CanPrescaler(1000000U) == 10U);
  assert(DeviceConfig_CanPrescaler(500000U) == 20U);
  assert(DeviceConfig_CanPrescaler(250000U) == 40U);
  assert(DeviceConfig_CanPrescaler(125000U) == 80U);
  assert(DeviceConfig_CanPrescaler(115200U) == 0U);
  int ik = DeviceConfig_FindParam("CAN_ID"), isp = DeviceConfig_FindParam("SPD_KP"), it = DeviceConfig_FindParam("TIMEOUT_MS");
  assert(ik >= 0 && isp >= 0 && it >= 0 && DeviceConfig_FindParam("NOPE") == -1);
  assert(DeviceConfig_SetParam((size_t)ik, 8.0f) == DEVCFG_ERR_RANGE);
  assert(DeviceConfig_SetParam((size_t)ik, 3.5f) == DEVCFG_ERR_RANGE);
  assert(DeviceConfig_SetParam((size_t)ik, 5.0f) == DEVCFG_OK);
  assert(DeviceConfig_ActiveCanId() == MOTOR_CAN_ID); /* takes effect only after reboot */
  assert(DeviceConfig_SetParam((size_t)isp, 0.4f) == DEVCFG_OK && control_speed_pi_kp == 0.4f);
  assert(DeviceConfig_SetParam((size_t)it, 250.0f) == DEVCFG_OK && DeviceConfig_Live()->cmd_timeout_ms == 250);
  control_mit_kp = 600.0f; /* e.g. set via CAN 0x04 without range check */
  assert(DeviceConfig_FirstInvalidParam() == DeviceConfig_FindParam("MIT_KP"));
  control_mit_kp = 10.0f;
  assert(DeviceConfig_FirstInvalidParam() == -1);
  uint32_t seq = 0; assert(DeviceConfig_Save(&seq) && seq == 8);
  { StoreImage im; assert(StoreImage_Load(&im) && im.calib_valid && im.electrical_zero_rad == 0.5f && im.config_valid && im.config.can_id == 5); }

  /* defaults then reload from flash */
  DeviceConfig_RestoreDefaults();
  assert(control_speed_pi_kp == 0.25f && DeviceConfig_Live()->can_id == MOTOR_CAN_ID);
  assert(DeviceConfig_Reload() == DEVCFG_SRC_FLASH && control_speed_pi_kp == 0.4f && DeviceConfig_Live()->can_id == 5);

  /* simulated reboot: new ID becomes active */
  control_speed_pi_kp = 0.25f;
  DeviceConfig_Init();
  assert(DeviceConfig_Source() == DEVCFG_SRC_FLASH && DeviceConfig_ActiveCanId() == 5 && control_speed_pi_kp == 0.4f);

  /* out-of-range config in flash is rejected */
  { StoreImage im; assert(StoreImage_Load(&im)); im.config.iq_limit = 9.0f; assert(StoreImage_Save(&im, NULL)); }
  DeviceConfig_Init();
  assert(DeviceConfig_Source() == DEVCFG_SRC_INVALID && DeviceConfig_ActiveCanId() == MOTOR_CAN_ID);

  /* UART gain ranges == CAN 0x400+ID / 0x500+ID uint16 map ranges (same variables). */
  { static const struct { const char *k; float mx; float def; } R[] = {
      {"SPD_KP", 10.0f, 0.25f}, {"SPD_KI", 5.0f, 0.02f}, {"SPD_KD", 1.0f, 0.0f},
      {"POS_KP", 200.0f, 3.5f}, {"POS_KI", 100.0f, 1.2f}, {"POS_KD", 100.0f, 2.6f} };
    for (size_t i = 0; i < sizeof(R) / sizeof(R[0]); ++i) {
      int ix = DeviceConfig_FindParam(R[i].k); assert(ix >= 0);
      const DeviceParamInfo *pi = DeviceConfig_ParamInfo((size_t)ix);
      assert(pi->min == 0.0f && pi->max == R[i].mx);
      assert(DeviceConfig_SetParam((size_t)ix, R[i].mx) == DEVCFG_OK);
      assert(DeviceConfig_SetParam((size_t)ix, R[i].mx * 1.001f + 0.001f) == DEVCFG_ERR_RANGE);
    }
    /* simulated cold boot (defaults are captured from the compile-time initialisers once at boot) */
    control_speed_pi_kp = 0.25f; control_speed_pi_ki = 0.02f; control_speed_pi_kd = 0.0f;
    control_position_kp = 3.5f; control_position_ki = 1.2f; control_position_kd = 2.6f;
    DeviceConfig_Init();
    control_position_kp = 150.0f; /* e.g. a 0x501 frame */
    DeviceConfig_RestoreDefaults();
    for (size_t i = 0; i < sizeof(R) / sizeof(R[0]); ++i)
      assert(DeviceConfig_GetParam((size_t)DeviceConfig_FindParam(R[i].k)) == R[i].def);
    assert(control_speed_pi_kp == 0.25f && control_position_kd == 2.6f); }

  /* v3 key ranges, discrete CAN baud, bus-voltage pair, telemetry rate */
  {
    int ip = DeviceConfig_FindParam("POLE_PAIRS");
    int ig = DeviceConfig_FindParam("GEAR_RATIO");
    int ikt = DeviceConfig_FindParam("KT");
    int irs = DeviceConfig_FindParam("RS");
    int ils = DeviceConfig_FindParam("LS");
    int idir = DeviceConfig_FindParam("ENC_DIR");
    int ivn = DeviceConfig_FindParam("VBUS_MIN");
    int ivx = DeviceConfig_FindParam("VBUS_MAX");
    int iz = DeviceConfig_FindParam("ZERO_OFFSET");
    int ib = DeviceConfig_FindParam("CAN_BAUD");
    int isr = DeviceConfig_FindParam("SPD_RAMP_MS");
    int ipr = DeviceConfig_FindParam("POS_RAMP_MS");
    int icr = DeviceConfig_FindParam("CUR_RAMP_MS");
    assert(ip >= 0 && ig >= 0 && ikt >= 0 && irs >= 0 && ils >= 0 && idir >= 0);
    assert(ivn >= 0 && ivx >= 0 && iz >= 0 && ib >= 0 && isr >= 0 && ipr >= 0 && icr >= 0);
    assert(DeviceConfig_ParamInfo((size_t)ip)->reboot_required == 1);
    assert(DeviceConfig_ParamInfo((size_t)idir)->reboot_required == 1);
    assert(DeviceConfig_ParamInfo((size_t)ib)->reboot_required == 1);
    assert(DeviceConfig_ParamInfo((size_t)isr)->reboot_required == 0);
    assert(DeviceConfig_SetParam((size_t)ip, 0.0f) == DEVCFG_ERR_RANGE);
    assert(DeviceConfig_SetParam((size_t)ip, 41.0f) == DEVCFG_ERR_RANGE);
    assert(DeviceConfig_SetParam((size_t)ip, 14.5f) == DEVCFG_ERR_RANGE);
    assert(DeviceConfig_SetParam((size_t)ip, 14.0f) == DEVCFG_OK);
    assert(DeviceConfig_SetParam((size_t)ig, 0.0f) == DEVCFG_ERR_RANGE);
    assert(DeviceConfig_SetParam((size_t)ig, 101.0f) == DEVCFG_ERR_RANGE);
    assert(DeviceConfig_SetParam((size_t)ig, 10.0f) == DEVCFG_OK);
    assert(DeviceConfig_SetParam((size_t)ikt, -0.1f) == DEVCFG_ERR_RANGE);
    assert(DeviceConfig_SetParam((size_t)ikt, 10.0f) == DEVCFG_OK);
    assert(DeviceConfig_SetParam((size_t)irs, 20.0f) == DEVCFG_OK && control_rs_ohm == 20.0f);
    assert(DeviceConfig_SetParam((size_t)irs, 20.1f) == DEVCFG_ERR_RANGE);
    assert(DeviceConfig_SetParam((size_t)ils, 1.0f) == DEVCFG_OK);
    assert(DeviceConfig_SetParam((size_t)ils, 1.1f) == DEVCFG_ERR_RANGE);
    assert(DeviceConfig_SetParam((size_t)idir, 2.0f) == DEVCFG_ERR_RANGE);
    assert(DeviceConfig_SetParam((size_t)idir, 0.0f) == DEVCFG_OK);
    assert(DeviceConfig_SetParam((size_t)ib, 750000.0f) == DEVCFG_ERR_RANGE);
    assert(DeviceConfig_SetParam((size_t)ib, 250000.0f) == DEVCFG_OK);
    assert(DeviceConfig_Live()->can_baud == 250000U);
    assert(DeviceConfig_SetParam((size_t)isr, 60001.0f) == DEVCFG_ERR_RANGE);
    assert(DeviceConfig_SetParam((size_t)isr, -1.0f) == DEVCFG_ERR_RANGE);
    assert(DeviceConfig_SetParam((size_t)isr, 0.0f) == DEVCFG_OK);
    assert(DeviceConfig_SetParam((size_t)ipr, 60000.0f) == DEVCFG_OK);
    assert(DeviceConfig_SetParam((size_t)icr, 0.0f) == DEVCFG_OK);
    assert(DeviceConfig_SetParam((size_t)ivx, 40.0f) == DEVCFG_OK);
    assert(DeviceConfig_SetParam((size_t)ivn, 39.5f) == DEVCFG_ERR_RANGE); /* gap < 1 V */
    assert(DeviceConfig_SetParam((size_t)ivn, 39.0f) == DEVCFG_OK);
    assert(DeviceConfig_SetParam((size_t)ivn, 6.0f) == DEVCFG_OK);
    assert(DeviceConfig_ParamInfo((size_t)ivn)->min == DEVICE_VBUS_HARD_MIN_V);
    assert(DeviceConfig_ParamInfo((size_t)ivn)->max == DEVICE_VBUS_MIN_PARAM_MAX_V);
    assert(DeviceConfig_ParamInfo((size_t)ivx)->max == DEVICE_VBUS_HARD_MAX_V);
    assert(DeviceConfig_ParamInfo((size_t)ivx)->min == 8.0f);
    assert(DeviceConfig_SetParam((size_t)ivn, 0.0f) == DEVCFG_ERR_RANGE);
    assert(DeviceConfig_SetParam((size_t)ivn, 5.9f) == DEVCFG_ERR_RANGE);
    assert(control_vbus_min_v == 6.0f);
    assert(DeviceConfig_SetParam((size_t)ivx, 60.0f) == DEVCFG_ERR_RANGE);
    assert(DeviceConfig_SetParam((size_t)ivx, 40.1f) == DEVCFG_ERR_RANGE);
    assert(control_vbus_max_v == 40.0f);
    assert(DeviceConfig_EffectiveVbusMin(0.0f) == DEVICE_VBUS_HARD_MIN_V);
    assert(DeviceConfig_EffectiveVbusMin(5.0f) == DEVICE_VBUS_HARD_MIN_V);
    assert(DeviceConfig_EffectiveVbusMin(6.0f) == 6.0f);
    assert(DeviceConfig_EffectiveVbusMin(12.0f) == 12.0f);
    assert(DeviceConfig_EffectiveVbusMin(NAN) == DEVICE_VBUS_HARD_MIN_V);
    /* Keys that move the position frame or the motor model. UART SET/DEFAULTS/
     * RELOAD refuse these while the motor is not IDLE (see control_app.cpp). */
    assert(DeviceConfig_SetRequiresIdle("ZERO_OFFSET") == 1);
    assert(DeviceConfig_SetRequiresIdle("ENC_DIR") == 1);
    assert(DeviceConfig_SetRequiresIdle("POLE_PAIRS") == 1);
    assert(DeviceConfig_SetRequiresIdle("RS") == 1);
    assert(DeviceConfig_SetRequiresIdle("LS") == 1);
    assert(DeviceConfig_SetRequiresIdle("KT") == 0);
    assert(DeviceConfig_SetRequiresIdle("GEAR_RATIO") == 0);
    assert(DeviceConfig_SetRequiresIdle("VBUS_MIN") == 0);
    assert(DeviceConfig_SetRequiresIdle("VBUS_MAX") == 0);
    assert(DeviceConfig_SetRequiresIdle("CUR_KP") == 0);
    assert(DeviceConfig_SetRequiresIdle("SPD_RAMP_MS") == 0);
    assert(DeviceConfig_SetRequiresIdle(NULL) == 0);
    /* 1 ms timed ramp toward 100 must still obey the legacy 10-unit step
     * (10000 per second * 1 ms). A slower timed step is left unchanged.
     * Position uses the same helper with max_step = POS_VLIM * 1 ms. */
    {
      /* 10000/s * 1 ms = 10. 100 rad/s * 1 ms = 0.1 (POS_VLIM step). */
      const float max_step = 10.0f;
      const float pos_step = 0.1f;
      float applied = 0.0f;
      int step;
      for (step = 0; step < 9; ++step) {
        const float next = DeviceConfig_SlewToward(applied, 100.0f, max_step);
        assert(next == applied + max_step);
        applied = next;
      }
      assert(applied == 90.0f);
      assert(DeviceConfig_SlewToward(applied, 100.0f, max_step) == 100.0f);
      assert(DeviceConfig_SlewToward(0.0f, 0.25f, max_step) == 0.25f);
      assert(DeviceConfig_SlewToward(0.0f, -100.0f, max_step) == -max_step);
      assert(DeviceConfig_SlewToward(0.0f, 10.0f, pos_step) == pos_step);
      assert(DeviceConfig_SlewToward(1.0f, 2.0f, -1.0f) == 1.0f);
    }
    assert(DeviceConfig_SetParam((size_t)iz, 1.25f) == DEVCFG_OK);
    assert(DeviceConfig_ZeroIsSet() == 1 && control_zero_offset_rad == 1.25f);
    uint32_t period = 0;
    assert(DeviceConfig_TelemPeriodMs(100, &period) && period == 10U);
    assert(DeviceConfig_TelemPeriodMs(135, &period) && period == 8U);
    assert(DeviceConfig_SetTelemHz(142) == 1); /* quantizes to 125 Hz, still inside the budget */
    assert(DeviceConfig_TelemPeriodMs(142, &period) && period == 8U);
    assert(DeviceConfig_SetTelemHz(143) == 0);
    assert(DeviceConfig_SetTelemHz(1000) == 0);
    assert(DeviceConfig_SetTelemHz(9) == 0);
    assert(DeviceConfig_SetTelemHz(100) == 1);
    uint8_t bad_ch[16] = {0};
    bad_ch[0] = 29; /* one past OlBudget */
    assert(DeviceConfig_SetTelemChannels(bad_ch, 16) == 0);
    bad_ch[0] = 28; /* OlBudget is a valid optional channel */
    assert(DeviceConfig_SetTelemChannels(bad_ch, 16) == 1);
    uint8_t ok_ch[16];
    for (uint8_t i = 0; i < 16; ++i) ok_ch[i] = i;
    assert(DeviceConfig_SetTelemChannels(ok_ch, 16) == 1);
    control_rs_ohm = DEVICE_DEFAULT_RS_OHM;
    control_ls_h = DEVICE_DEFAULT_LS_H;
  }

  /* Hand-built v2 record: calibration kept, v3 fields take defaults. */
  {
    uint8_t r[96];
    memset(r, 0, sizeof(r));
    uint32_t magic = STORE_RECORD_MAGIC; uint16_t ver = 2, size = 96; uint32_t seq = 3;
    float zero = 0.25f; float spd = 0.5f;
    memcpy(r + 0, &magic, 4); memcpy(r + 4, &ver, 2); memcpy(r + 6, &size, 2);
    memcpy(r + 8, &seq, 4); memcpy(r + 12, &zero, 4);
    r[16] = 0; r[17] = 1; r[18] = 1; r[20] = 4; /* dir 0, calib+config valid, can_id 4 */
    r[23] = 1; /* telemetry */
    memcpy(r + 48, &spd, 4); /* spd_kp */
    uint32_t crc = StoreRecord_Crc32(r, 92); memcpy(r + 92, &crc, 4);
    memset(g_flash, 0xFF, sizeof(g_flash)); memcpy(g_flash, r, 96); g_flash_valid = 1;
    r[48] ^= 1; assert(!StoreRecord_Decode(r, sizeof(r), &(StoreImage){0}));
    control_speed_pi_kp = 0.25f; control_speed_pi_ki = 0.02f; control_speed_pi_kd = 0.0f;
    control_position_kp = 3.5f; control_position_ki = 1.2f; control_position_kd = 2.6f;
    control_vbus_min_v = DEVICE_DEFAULT_VBUS_MIN_V;
    control_vbus_max_v = DEVICE_DEFAULT_VBUS_MAX_V;
    control_rs_ohm = DEVICE_DEFAULT_RS_OHM; control_ls_h = DEVICE_DEFAULT_LS_H;
    control_zero_offset_rad = 0.0f;
    DeviceConfig_Init();
    assert(DeviceConfig_Source() == DEVCFG_SRC_FLASH);
    assert(DeviceConfig_ActiveCanId() == 4);
    assert(DeviceConfig_Live()->spd_kp == 0.5f && control_speed_pi_kp == 0.5f);
    assert(DeviceConfig_Live()->pole_pairs == 14);
    assert(DeviceConfig_Live()->gear_ratio == 10);
    assert(DeviceConfig_Live()->can_baud == 1000000U);
    assert(DeviceConfig_Live()->enc_dir == 0); /* migrated from the calibration direction */
    assert(DeviceConfig_Live()->zero_valid == 0);
    assert(DeviceConfig_Live()->vbus_min_v == DEVICE_DEFAULT_VBUS_MIN_V);
    assert(DeviceConfig_Live()->telem_hz == 100);
    assert(DeviceConfig_Live()->telem_ch[0] == 0 && DeviceConfig_Live()->telem_ch[15] == 15);
    /* iq_limit in this v2 image is zero, so the migrated overload ceiling is 0. */
    assert(DeviceConfig_Live()->iq_limit == 0.0f);
    assert(DeviceConfig_Live()->ol_en == 0.0f);
    assert(DeviceConfig_Live()->ol_iq == 0.0f);
    assert(DeviceConfig_Live()->ol_time_s == OL_TIME_DEFAULT_S);
    assert(control_ol_en == 0.0f && control_ol_iq_a == 0.0f);
    assert(control_ol_time_s == OL_TIME_DEFAULT_S);
    StoreImage decoded; assert(StoreImage_Load(&decoded));
    assert(decoded.version == 2 && decoded.calib_valid && decoded.electrical_zero_rad == 0.25f);
    assert(decoded.encoder_direction == 0);
  }

  /* v3 with an illegal pole count is rejected; the calibration bytes stay readable. */
  {
    StoreImage im; memset(&im, 0, sizeof(im));
    im.calib_valid = 1; im.electrical_zero_rad = 0.4f; im.encoder_direction = 1; im.config_valid = 1;
    im.config.can_id = 2; im.config.pole_pairs = 0; im.config.enc_dir = 1; im.config.gear_ratio = 10;
    im.config.can_baud = 1000000U; im.config.vbus_min_v = 6.0f; im.config.vbus_max_v = 40.0f;
    im.config.telem_hz = 100;
    assert(StoreImage_Save(&im, NULL));
    control_vbus_min_v = DEVICE_DEFAULT_VBUS_MIN_V;
    control_vbus_max_v = DEVICE_DEFAULT_VBUS_MAX_V;
    control_rs_ohm = DEVICE_DEFAULT_RS_OHM; control_ls_h = DEVICE_DEFAULT_LS_H;
    DeviceConfig_Init();
    assert(DeviceConfig_Source() == DEVCFG_SRC_INVALID);
    assert(DeviceConfig_ActiveCanId() == MOTOR_CAN_ID);
    StoreImage decoded; assert(StoreImage_Load(&decoded));
    assert(decoded.calib_valid && decoded.electrical_zero_rad == 0.4f && decoded.version == 4);
  }

  /* Old 0 V / 60 V (and a min above the new 39 V cap) load clamped, not invalid. */
  {
    StoreImage im; memset(&im, 0, sizeof(im));
    im.config_valid = 1;
    im.config.can_id = 3;
    im.config.pole_pairs = 14;
    im.config.gear_ratio = 10;
    im.config.enc_dir = 1;
    im.config.can_baud = 1000000U;
    im.config.telem_hz = 100;
    im.config.vbus_min_v = 0.0f;
    im.config.vbus_max_v = 60.0f;
    im.config.rs_ohm = DEVICE_DEFAULT_RS_OHM;
    im.config.ls_h = DEVICE_DEFAULT_LS_H;
    assert(StoreImage_Save(&im, NULL));
    control_vbus_min_v = 1.0f;
    control_vbus_max_v = 1.0f;
    control_rs_ohm = DEVICE_DEFAULT_RS_OHM;
    control_ls_h = DEVICE_DEFAULT_LS_H;
    DeviceConfig_Init();
    assert(DeviceConfig_Source() == DEVCFG_SRC_FLASH);
    assert(DeviceConfig_ActiveCanId() == 3);
    assert(DeviceConfig_Live()->vbus_min_v == DEVICE_VBUS_HARD_MIN_V);
    assert(DeviceConfig_Live()->vbus_max_v == DEVICE_VBUS_HARD_MAX_V);
    assert(control_vbus_min_v == DEVICE_VBUS_HARD_MIN_V);
    assert(control_vbus_max_v == DEVICE_VBUS_HARD_MAX_V);

    im.config.vbus_min_v = 50.0f;
    im.config.vbus_max_v = 60.0f;
    assert(StoreImage_Save(&im, NULL));
    control_vbus_min_v = DEVICE_DEFAULT_VBUS_MIN_V;
    control_vbus_max_v = DEVICE_DEFAULT_VBUS_MAX_V;
    DeviceConfig_Init();
    assert(DeviceConfig_Source() == DEVCFG_SRC_FLASH);
    assert(DeviceConfig_Live()->vbus_min_v == DEVICE_VBUS_MIN_PARAM_MAX_V);
    assert(DeviceConfig_Live()->vbus_max_v == DEVICE_VBUS_HARD_MAX_V);
    assert(control_vbus_min_v == DEVICE_VBUS_MIN_PARAM_MAX_V);
    assert(control_vbus_max_v == DEVICE_VBUS_HARD_MAX_V);
  }

  /* Hand-built v3: overload fields stay at the legacy defaults. */
  put_v3(1.5f, 2);
  {
    StoreImage raw; assert(StoreRecord_Decode(g_flash, sizeof(g_flash), &raw));
    assert(raw.version == 3 && raw.config.iq_limit == 1.5f && raw.config.ol_en == 0.0f);
    assert(raw.config.ol_iq == 0.0f && raw.config.ol_time_s == 0.0f);
  }
  control_iq_limit_a = 9.0f; control_ol_en = 1.0f; control_ol_iq_a = 9.0f; control_ol_time_s = 9.0f;
  control_max_modulation = 0.5f;
  DeviceConfig_Init();
  assert(DeviceConfig_Source() == DEVCFG_SRC_FLASH);
  assert(DeviceConfig_ActiveCanId() == 2);
  assert(control_iq_limit_a == 1.5f && DeviceConfig_Live()->iq_limit == 1.5f);
  assert(control_ol_en == 0.0f && DeviceConfig_Live()->ol_en == 0.0f);
  assert(control_ol_iq_a == 1.5f && DeviceConfig_Live()->ol_iq == 1.5f);
  assert(control_ol_time_s == OL_TIME_DEFAULT_S);
  assert(DeviceConfig_Live()->ol_time_s == OL_TIME_DEFAULT_S);
  assert(control_max_modulation == DEVICE_MAX_MOD_DEFAULT);

  /* Illegal v3 IQ_LIM is not clamped into a loadable record. */
  put_v3(9.0f, 2);
  control_iq_limit_a = IQ_CONTINUOUS_MAX_A;
  control_ol_en = 0.0f; control_ol_iq_a = IQ_CONTINUOUS_MAX_A; control_ol_time_s = OL_TIME_DEFAULT_S;
  DeviceConfig_Init();
  assert(DeviceConfig_Source() == DEVCFG_SRC_INVALID);
  assert(control_iq_limit_a == IQ_CONTINUOUS_MAX_A);
  assert(DeviceConfig_Live()->iq_limit == IQ_CONTINUOUS_MAX_A);

  /* SET rejects a bad overload pair and lifts OL_IQ when IQ_LIM passes it. */
  g_flash_valid = 0;
  control_iq_limit_a = IQ_CONTINUOUS_MAX_A;
  control_ol_en = 0.0f;
  control_ol_iq_a = IQ_CONTINUOUS_MAX_A;
  control_ol_time_s = OL_TIME_DEFAULT_S;
  control_speed_pi_kp = 0.25f; control_speed_pi_ki = 0.02f; control_speed_pi_kd = 0.0f;
  control_position_kp = 3.5f; control_position_ki = 1.2f; control_position_kd = 2.6f;
  control_mit_kp = 10.0f; control_mit_kd = 0.5f;
  control_vbus_min_v = DEVICE_DEFAULT_VBUS_MIN_V;
  control_vbus_max_v = DEVICE_DEFAULT_VBUS_MAX_V;
  control_rs_ohm = DEVICE_DEFAULT_RS_OHM; control_ls_h = DEVICE_DEFAULT_LS_H;
  DeviceConfig_Init();
  assert(DeviceConfig_Source() == DEVCFG_SRC_DEFAULT);
  assert(DeviceConfig_ParamCount() == 38);
  {
    const int iq = DeviceConfig_FindParam("IQ_LIM");
    const int en = DeviceConfig_FindParam("OL_EN");
    const int ol = DeviceConfig_FindParam("OL_IQ");
    const int tm = DeviceConfig_FindParam("OL_TIME_S");
    const int ramp = DeviceConfig_FindParam("CUR_RAMP_MS");
    assert(iq >= 0 && en > ramp && ol > en && tm > ol);
    assert(DeviceConfig_ParamInfo((size_t)iq)->max == IQ_CONTINUOUS_MAX_A);
    assert(DeviceConfig_ParamInfo((size_t)ol)->max == IQ_HARD_MAX_A);
    assert(DeviceConfig_ParamInfo((size_t)tm)->max == OL_TIME_MAX_S);
    assert(DeviceConfig_SetParam((size_t)ol, 2.0f) == DEVCFG_ERR_RANGE);
    assert(control_ol_iq_a == IQ_CONTINUOUS_MAX_A);
    assert(DeviceConfig_SetParam((size_t)ol, IQ_HARD_MAX_A + 0.01f) == DEVCFG_ERR_RANGE);
    assert(DeviceConfig_SetParam((size_t)ol, IQ_HARD_MAX_A) == DEVCFG_OK);
    assert(control_ol_iq_a == IQ_HARD_MAX_A);
    assert(DeviceConfig_SetParam((size_t)tm, -0.1f) == DEVCFG_ERR_RANGE);
    assert(DeviceConfig_SetParam((size_t)tm, 10.1f) == DEVCFG_ERR_RANGE);
    assert(DeviceConfig_SetParam((size_t)tm, 0.0f) == DEVCFG_OK);
    assert(DeviceConfig_SetParam((size_t)tm, 10.0f) == DEVCFG_OK);
    assert(DeviceConfig_SetParam((size_t)en, 2.0f) == DEVCFG_ERR_RANGE);
    assert(DeviceConfig_SetParam((size_t)en, 0.5f) == DEVCFG_ERR_RANGE);
    assert(DeviceConfig_SetParam((size_t)en, 1.0f) == DEVCFG_OK && control_ol_en == 1.0f);
    assert(DeviceConfig_SetParam((size_t)iq, 2.6f) == DEVCFG_ERR_RANGE);
    assert(control_iq_limit_a == IQ_CONTINUOUS_MAX_A);
    assert(DeviceConfig_SetParam((size_t)iq, 1.0f) == DEVCFG_OK);
    assert(DeviceConfig_SetParam((size_t)ol, 1.5f) == DEVCFG_OK);
    assert(DeviceConfig_SetParam((size_t)iq, 2.0f) == DEVCFG_OK);
    assert(control_iq_limit_a == 2.0f && control_ol_iq_a == 2.0f);
    assert(DeviceConfig_Live()->ol_iq == 2.0f);
    assert(DeviceConfig_GetParam((size_t)iq) == 2.0f);
    assert(DeviceConfig_SetParam((size_t)iq, 1.5f) == DEVCFG_OK);
    assert(control_ol_iq_a == 2.0f);
    assert(DeviceConfig_SetParam((size_t)ol, 1.4f) == DEVCFG_ERR_RANGE);
    assert(DeviceConfig_SetParam((size_t)ol, 1.5f) == DEVCFG_OK);
    control_ol_iq_a = 1.0f;
    assert(DeviceConfig_FirstInvalidParam() == ol);
    control_ol_iq_a = 1.5f;
    assert(DeviceConfig_FirstInvalidParam() == -1);
  }

  /* MAX_MOD is last. 0 / NaN / out of range in ol_reserved load as 0.99.
   * An in-range value round-trips. SET enforces 0.5..0.99. */
  {
    const int mod = DeviceConfig_FindParam("MAX_MOD");
    const int tm = DeviceConfig_FindParam("OL_TIME_S");
    assert(mod == (int)DeviceConfig_ParamCount() - 1);
    assert(tm >= 0 && mod > tm);
    assert(DeviceConfig_ParamInfo((size_t)mod)->min == DEVICE_MAX_MOD_MIN);
    assert(DeviceConfig_ParamInfo((size_t)mod)->max == DEVICE_MAX_MOD_MAX);
    assert(DeviceConfig_SetParam((size_t)mod, 0.49f) == DEVCFG_ERR_RANGE);
    assert(DeviceConfig_SetParam((size_t)mod, 1.0f) == DEVCFG_ERR_RANGE);
    assert(DeviceConfig_SetParam((size_t)mod, 0.5f) == DEVCFG_OK);
    assert(control_max_modulation == 0.5f);
    assert(DeviceConfig_SetParam((size_t)mod, DEVICE_MAX_MOD_DEFAULT) == DEVCFG_OK);
    assert(control_max_modulation == DEVICE_MAX_MOD_DEFAULT);

    StoreImage im;
    memset(&im, 0, sizeof(im));
    im.config_valid = 1;
    im.calib_valid = 1;
    im.electrical_zero_rad = 0.2f;
    im.encoder_direction = 1;
    im.config = *DeviceConfig_Live();
    im.config.rs_ohm = 1.97f;
    memset(im.config.ol_reserved, 0, sizeof(im.config.ol_reserved));
    assert(StoreRecord_Encode(&im, 4, g_flash, sizeof(g_flash)) == STORE_RECORD_V4_BYTES);
    g_flash_valid = 1;
    control_max_modulation = 0.5f;
    control_rs_ohm = 1.0f;
    DeviceConfig_Init();
    assert(DeviceConfig_Source() == DEVCFG_SRC_FLASH);
    assert(control_max_modulation == DEVICE_MAX_MOD_DEFAULT);
    assert(control_rs_ohm == 1.97f);

    float stored = 0.80f;
    im.config = *DeviceConfig_Live();
    memcpy(im.config.ol_reserved, &stored, sizeof(stored));
    assert(StoreRecord_Encode(&im, 5, g_flash, sizeof(g_flash)) == STORE_RECORD_V4_BYTES);
    control_max_modulation = DEVICE_MAX_MOD_DEFAULT;
    DeviceConfig_Init();
    assert(DeviceConfig_Source() == DEVCFG_SRC_FLASH);
    assert(control_max_modulation == 0.80f);

    stored = 1.5f;
    memcpy(im.config.ol_reserved, &stored, sizeof(stored));
    assert(StoreRecord_Encode(&im, 6, g_flash, sizeof(g_flash)) == STORE_RECORD_V4_BYTES);
    DeviceConfig_Init();
    assert(DeviceConfig_Source() == DEVCFG_SRC_FLASH);
    assert(control_max_modulation == DEVICE_MAX_MOD_DEFAULT);

    stored = nanf("");
    memcpy(im.config.ol_reserved, &stored, sizeof(stored));
    assert(StoreRecord_Encode(&im, 7, g_flash, sizeof(g_flash)) == STORE_RECORD_V4_BYTES);
    DeviceConfig_Init();
    assert(DeviceConfig_Source() == DEVCFG_SRC_FLASH);
    assert(control_max_modulation == DEVICE_MAX_MOD_DEFAULT);
  }

  printf("test_uart_config: all passed (%zu params)\n", DeviceConfig_ParamCount());
  return 0;
}
