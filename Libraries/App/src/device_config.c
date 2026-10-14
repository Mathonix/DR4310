#include "device_config.h"

#include "calibration_store.h"
#include "control_app.h"
#include "iq_limits.h"

#include <math.h>
#include <string.h>

#ifndef MOTOR_CAN_ID
#define MOTOR_CAN_ID 2
#endif

static DeviceConfigData g_defaults;
static DeviceConfigData g_live;
static uint8_t g_active_can_id = MOTOR_CAN_ID;
static DeviceConfigSource g_source = DEVCFG_SRC_DEFAULT;
static uint32_t g_sequence = 0U;
static uint8_t g_cog_written[COGGING_TABLE_SIZE / 8U];
static uint16_t g_cog_count;
static uint8_t g_cog_upload;

typedef enum { P_CFG_U8, P_CFG_U16, P_CFG_U32, P_CFG_F32, P_VAR_F32 } ParamKind;

typedef struct {
  DeviceParamInfo info;
  ParamKind kind;
  size_t offset;            /* into DeviceConfigData */
  volatile float *var;      /* for P_VAR_F32 */
  const float *choices;
  uint8_t n_choices;
} ParamDef;

#define CFG_OFF(field) offsetof(DeviceConfigData, field)
#define PINFO(key, lo, hi, is_int, reboot, choices) \
  {key, lo, hi, is_int, reboot, choices}

static const float kCanBaudChoices[] = {
    125000.0f, 250000.0f, 500000.0f, 1000000.0f};

/* Order here = order of GET output. Keys are upper-case.
 * The original v2 keys stay first so existing host scripts keep their order. */
static const ParamDef kParams[] = {
  {PINFO("CAN_ID", 1.0f, 7.0f, 1U, 1U, NULL), P_CFG_U8, CFG_OFF(can_id), NULL, NULL, 0U},
  {PINFO("BOOT_MODE", 0.0f, 3.0f, 1U, 1U, NULL), P_CFG_U8, CFG_OFF(boot_mode), NULL, NULL, 0U},
  {PINFO("BOOT_TARGET", -1000.0f, 1000.0f, 0U, 1U, NULL), P_CFG_F32, CFG_OFF(boot_target), NULL, NULL, 0U},
  {PINFO("BOOT_AE", 0.0f, 1.0f, 1U, 1U, NULL), P_CFG_U8, CFG_OFF(boot_auto_enable), NULL, NULL, 0U},
  {PINFO("TELEM", 0.0f, 1.0f, 1U, 0U, NULL), P_CFG_U8, CFG_OFF(telemetry), NULL, NULL, 0U},
  {PINFO("TIMEOUT_MS", 0.0f, 60000.0f, 1U, 0U, NULL), P_CFG_U16, CFG_OFF(cmd_timeout_ms), NULL, NULL, 0U},
  {PINFO("CUR_KP", 0.0f, 100.0f, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(cur_kp), &control_current_pi_kp, NULL, 0U},
  {PINFO("CUR_KI", 0.0f, 100000.0f, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(cur_ki), &control_current_pi_ki, NULL, 0U},
  {PINFO("CUR_VLIM", 0.0f, 30.0f, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(cur_vlim), &control_current_pi_out_limit_v, NULL, 0U},
  {PINFO("IQ_LIM", 0.0f, IQ_CONTINUOUS_MAX_A, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(iq_limit), &control_iq_limit_a, NULL, 0U},
  {PINFO("SPD_KP", 0.0f, 10.0f, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(spd_kp), &control_speed_pi_kp, NULL, 0U},
  {PINFO("SPD_KI", 0.0f, 5.0f, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(spd_ki), &control_speed_pi_ki, NULL, 0U},
  {PINFO("SPD_KD", 0.0f, 1.0f, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(spd_kd), &control_speed_pi_kd, NULL, 0U},
  {PINFO("ACCEL", 0.0f, 100000.0f, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(accel), &control_accel_ref_rad_s2, NULL, 0U},
  {PINFO("POS_KP", 0.0f, 200.0f, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(pos_kp), &control_position_kp, NULL, 0U},
  {PINFO("POS_KI", 0.0f, 100.0f, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(pos_ki), &control_position_ki, NULL, 0U},
  {PINFO("POS_KD", 0.0f, 100.0f, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(pos_kd), &control_position_kd, NULL, 0U},
  {PINFO("POS_ISEP", 0.0f, 100.0f, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(pos_isep), &control_position_i_sep_rad, NULL, 0U},
  {PINFO("POS_VLIM", 0.0f, 500.0f, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(pos_vlim), &control_position_velocity_limit_rad_s, NULL, 0U},
  {PINFO("MIT_KP", 0.0f, 500.0f, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(mit_kp), &control_mit_kp, NULL, 0U},
  {PINFO("MIT_KD", 0.0f, 5.0f, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(mit_kd), &control_mit_kd, NULL, 0U},
  {PINFO("POLE_PAIRS", 1.0f, 40.0f, 1U, 1U, NULL), P_CFG_U8, CFG_OFF(pole_pairs), NULL, NULL, 0U},
  {PINFO("GEAR_RATIO", 1.0f, 100.0f, 1U, 0U, NULL), P_CFG_U8, CFG_OFF(gear_ratio), NULL, NULL, 0U},
  {PINFO("KT", 0.0f, 10.0f, 0U, 0U, NULL), P_CFG_F32, CFG_OFF(kt_nm_per_a), NULL, NULL, 0U},
  {PINFO("RS", 0.0f, 20.0f, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(rs_ohm), &control_rs_ohm, NULL, 0U},
  {PINFO("LS", 0.0f, 1.0f, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(ls_h), &control_ls_h, NULL, 0U},
  {PINFO("ENC_DIR", 0.0f, 1.0f, 1U, 1U, NULL), P_CFG_U8, CFG_OFF(enc_dir), NULL, NULL, 0U},
  {PINFO("VBUS_MIN", DEVICE_VBUS_HARD_MIN_V, DEVICE_VBUS_MIN_PARAM_MAX_V, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(vbus_min_v), &control_vbus_min_v, NULL, 0U},
  {PINFO("VBUS_MAX", 8.0f, DEVICE_VBUS_HARD_MAX_V, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(vbus_max_v), &control_vbus_max_v, NULL, 0U},
  {PINFO("ZERO_OFFSET", -100000.0f, 100000.0f, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(zero_offset_rad), &control_zero_offset_rad, NULL, 0U},
  {PINFO("CAN_BAUD", 125000.0f, 1000000.0f, 1U, 1U, "125000|250000|500000|1000000"), P_CFG_U32, CFG_OFF(can_baud), NULL, kCanBaudChoices, 4U},
  {PINFO("SPD_RAMP_MS", 0.0f, 60000.0f, 1U, 0U, NULL), P_CFG_U16, CFG_OFF(spd_ramp_ms), NULL, NULL, 0U},
  {PINFO("POS_RAMP_MS", 0.0f, 60000.0f, 1U, 0U, NULL), P_CFG_U16, CFG_OFF(pos_ramp_ms), NULL, NULL, 0U},
  {PINFO("CUR_RAMP_MS", 0.0f, 60000.0f, 1U, 0U, NULL), P_CFG_U16, CFG_OFF(cur_ramp_ms), NULL, NULL, 0U},
  /* Appended after the v3 keys so existing GET order is unchanged. */
  {PINFO("OL_EN", 0.0f, 1.0f, 1U, 0U, NULL), P_VAR_F32, CFG_OFF(ol_en), &control_ol_en, NULL, 0U},
  {PINFO("OL_IQ", 0.0f, IQ_HARD_MAX_A, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(ol_iq), &control_ol_iq_a, NULL, 0U},
  {PINFO("OL_TIME_S", 0.0f, OL_TIME_MAX_S, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(ol_time_s), &control_ol_time_s, NULL, 0U},
  /* Appended last so existing GET order is unchanged. The float reuses
   * ol_reserved[4]; a stored 0 is not a legal ratio and is repaired on load. */
  {PINFO("MAX_MOD", DEVICE_MAX_MOD_MIN, DEVICE_MAX_MOD_MAX, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(ol_reserved), &control_max_modulation, NULL, 0U},
  {PINFO("POS_VFF", 0.0f, 1.0f, 0U, 0U, NULL), P_VAR_F32, CFG_OFF(pos_vff), &control_position_velocity_ff_gain, NULL, 0U},
  {PINFO("COG_EN", 0.0f, 1.0f, 1U, 0U, NULL), P_CFG_F32, CFG_OFF(cog_en), NULL, NULL, 0U},
  {PINFO("COG_GAIN", 0.0f, 1.0f, 0U, 0U, NULL), P_CFG_F32, CFG_OFF(cog_gain), NULL, NULL, 0U},
  {PINFO("COG_LIM", 0.0f, COGGING_LIMIT_MAX_A, 0U, 0U, NULL), P_CFG_F32, CFG_OFF(cog_limit_a), NULL, NULL, 0U},
};
#define PARAM_COUNT (sizeof(kParams) / sizeof(kParams[0]))

static void telem_identity(uint8_t *channels) {
  for (uint8_t i = 0U; i < DEVICE_TELEM_SLOTS; ++i) {
    channels[i] = i;
  }
}

static int telem_map_ok(const uint8_t *channels) {
  for (uint8_t i = 0U; i < DEVICE_TELEM_SLOTS; ++i) {
    if (channels[i] >= DEVICE_TELEM_CHANNEL_COUNT) {
      return 0;
    }
  }
  return 1;
}

static float cfg_get(const DeviceConfigData *cfg, const ParamDef *p) {
  const uint8_t *base = (const uint8_t *)cfg + p->offset;
  switch (p->kind) {
    case P_CFG_U8:
      return (float)*base;
    case P_CFG_U16: {
      uint16_t v;
      memcpy(&v, base, sizeof(v));
      return (float)v;
    }
    case P_CFG_U32: {
      uint32_t v;
      memcpy(&v, base, sizeof(v));
      return (float)v;
    }
    case P_CFG_F32:
    case P_VAR_F32:
    default: {
      float v;
      memcpy(&v, base, sizeof(v));
      return v;
    }
  }
}

static void cfg_set(DeviceConfigData *cfg, const ParamDef *p, float value) {
  uint8_t *base = (uint8_t *)cfg + p->offset;
  switch (p->kind) {
    case P_CFG_U8:
      *base = (uint8_t)lroundf(value);
      break;
    case P_CFG_U16: {
      const uint16_t v = (uint16_t)lroundf(value);
      memcpy(base, &v, sizeof(v));
      break;
    }
    case P_CFG_U32: {
      const uint32_t v = (uint32_t)lroundf(value);
      memcpy(base, &v, sizeof(v));
      break;
    }
    case P_CFG_F32:
    case P_VAR_F32:
    default:
      memcpy(base, &value, sizeof(value));
      break;
  }
}

static int value_ok(const ParamDef *p, float v) {
  if (!isfinite(v) || (v < p->info.min) || (v > p->info.max)) {
    return 0;
  }
  if ((p->info.is_int != 0U) && (fabsf(v - roundf(v)) > 1e-4f)) {
    return 0;
  }
  if (p->n_choices != 0U) {
    const float rounded = (p->info.is_int != 0U) ? roundf(v) : v;
    uint8_t found = 0U;
    for (uint8_t i = 0U; i < p->n_choices; ++i) {
      if (rounded == p->choices[i]) {
        found = 1U;
        break;
      }
    }
    if (found == 0U) {
      return 0;
    }
  }
  return 1;
}

static int vbus_pair_ok(float vmin, float vmax) {
  return isfinite(vmin) && isfinite(vmax) && ((vmin + 1.0f) <= vmax);
}

int DeviceConfig_Validate(const DeviceConfigData *cfg) {
  if (cfg == NULL) {
    return 0;
  }
  for (size_t i = 0U; i < PARAM_COUNT; ++i) {
    if (!value_ok(&kParams[i], cfg_get(cfg, &kParams[i]))) {
      return 0;
    }
  }
  if (!vbus_pair_ok(cfg->vbus_min_v, cfg->vbus_max_v) || (cfg->zero_valid > 1U)) {
    return 0;
  }
  /* OL_IQ may not sit below the continuous limit. A v4 image that violates
   * the pair is rejected; legacy records are repaired before this check. */
  if (!(cfg->ol_iq >= cfg->iq_limit)) {
    return 0;
  }
  const CoggingMap *map = &cfg->cogging;
  if (map->valid > 1U || (cfg->cog_en != 0.0f && map->valid == 0U)) return 0;
  if (map->valid) {
    if (map->encoder_direction > 1U || map->pole_pairs < 1U ||
        map->pole_pairs > 40U || !isfinite(map->electrical_zero_rad) ||
        map->electrical_zero_rad < 0.0f || map->electrical_zero_rad >= 6.28318530718f) return 0;
    for (size_t i = 0U; i < COGGING_TABLE_SIZE; ++i) {
      if (map->current_ma[i] < -COGGING_SAMPLE_MAX_MA ||
          map->current_ma[i] > COGGING_SAMPLE_MAX_MA) return 0;
    }
  }
  return 1;
}

int DeviceConfig_FirstInvalidParam(void) {
  for (size_t i = 0U; i < PARAM_COUNT; ++i) {
    if (!value_ok(&kParams[i], DeviceConfig_GetParam(i))) {
      return (int)i;
    }
  }
  if (!vbus_pair_ok(control_vbus_min_v, control_vbus_max_v)) {
    return DeviceConfig_FindParam("VBUS_MAX");
  }
  {
    const int iq = DeviceConfig_FindParam("IQ_LIM");
    const int ol = DeviceConfig_FindParam("OL_IQ");
    if ((iq >= 0) && (ol >= 0) &&
        !(DeviceConfig_GetParam((size_t)ol) >= DeviceConfig_GetParam((size_t)iq))) {
      return ol;
    }
  }
  return -1;
}

void DeviceConfig_Capture(DeviceConfigData *cfg) {
  *cfg = g_live;
  for (size_t i = 0U; i < PARAM_COUNT; ++i) {
    if (kParams[i].kind == P_VAR_F32) {
      cfg_set(cfg, &kParams[i], *kParams[i].var);
    }
  }
  cfg->reserved0 = 0U;
  memset(cfg->pos_reserved, 0, sizeof(cfg->pos_reserved));
}

void DeviceConfig_Apply(const DeviceConfigData *cfg) {
  g_cog_upload = 0U;
  g_cog_count = 0U;
  g_live = *cfg;
  for (size_t i = 0U; i < PARAM_COUNT; ++i) {
    if (kParams[i].kind == P_VAR_F32) {
      *kParams[i].var = cfg_get(cfg, &kParams[i]);
    }
  }
}

static void fill_v3_extension(DeviceConfigData *cfg, const StoreImage *image) {
  uint8_t prefix[72];
  DeviceConfigData extended = g_defaults;
  memcpy(prefix, cfg, sizeof(prefix));
  extended.enc_dir = (image->calib_valid != 0U) ? image->encoder_direction
                                                : g_defaults.enc_dir;
  *cfg = extended;
  memcpy(cfg, prefix, sizeof(prefix));
}

/* v1..v3 have no overload fields (decode leaves them zero). Keep overload
 * off, copy the continuous limit into OL_IQ, and use the compile-time time.
 * An illegal stored IQ_LIM is not repaired: Validate still rejects it.
 * A non-finite or negative IQ_LIM becomes OL_IQ = 0. A stored IQ_LIM above
 * the hard cap is clamped only into OL_IQ, and only when IQ_LIM itself is
 * inside the hard cap is OL_IQ lifted back up to it. */
static void apply_legacy_overload(DeviceConfigData *cfg) {
  float ol_iq = cfg->iq_limit;
  cfg->ol_en = 0.0f;
  if (!(ol_iq >= 0.0f)) {
    ol_iq = 0.0f;
  }
  if (ol_iq > IQ_HARD_MAX_A) {
    ol_iq = IQ_HARD_MAX_A;
  }
  if ((ol_iq < cfg->iq_limit) && (cfg->iq_limit <= IQ_HARD_MAX_A)) {
    ol_iq = cfg->iq_limit;
  }
  cfg->ol_iq = ol_iq;
  cfg->ol_time_s = OL_TIME_DEFAULT_S;
  memset(cfg->ol_reserved, 0, sizeof(cfg->ol_reserved));
}

/* ol_reserved held zeros in every image written before MAX_MOD. 0 is outside
 * 0.5..0.99, so leaving it would make Validate reject the whole config.
 * Repair 0, non-finite, and out-of-range values to the default before that
 * check. In-range values are kept. Applies to v1..v3 (after the memset above)
 * and to existing v4 images. */
static void sanitize_max_mod(DeviceConfigData *cfg) {
  float v = 0.0f;
  memcpy(&v, cfg->ol_reserved, sizeof(v));
  if (!isfinite(v) || (v < DEVICE_MAX_MOD_MIN) || (v > DEVICE_MAX_MOD_MAX)) {
    v = DEVICE_MAX_MOD_DEFAULT;
    memcpy(cfg->ol_reserved, &v, sizeof(v));
  }
}

static void sanitize_telem(DeviceConfigData *cfg) {
  uint32_t period = 0U;
  if ((cfg->telem_hz < 10U) ||
      !DeviceConfig_TelemPeriodMs(cfg->telem_hz, &period)) {
    cfg->telem_hz = DEVICE_DEFAULT_TELEM_HZ;
  }
  if (!telem_map_ok(cfg->telem_ch)) {
    telem_identity(cfg->telem_ch);
  }
  cfg->zero_valid = (cfg->zero_valid != 0U) ? 1U : 0U;
}

/* A record saved before the 6 V / 40 V window is pulled back into that
 * window so the rest of the config still loads. SET itself rejects the
 * out-of-window value. Non-finite values fail the comparisons and are
 * replaced. The pair rule is restored inside the same window. */
static void clamp_vbus_window(DeviceConfigData *cfg) {
  if (!(cfg->vbus_min_v >= DEVICE_VBUS_HARD_MIN_V)) {
    cfg->vbus_min_v = DEVICE_VBUS_HARD_MIN_V;
  }
  if (!(cfg->vbus_min_v <= DEVICE_VBUS_MIN_PARAM_MAX_V)) {
    cfg->vbus_min_v = DEVICE_VBUS_MIN_PARAM_MAX_V;
  }
  if (!(cfg->vbus_max_v >= 8.0f)) {
    cfg->vbus_max_v = 8.0f;
  }
  if (!(cfg->vbus_max_v <= DEVICE_VBUS_HARD_MAX_V)) {
    cfg->vbus_max_v = DEVICE_VBUS_HARD_MAX_V;
  }
  if (!vbus_pair_ok(cfg->vbus_min_v, cfg->vbus_max_v)) {
    cfg->vbus_max_v = cfg->vbus_min_v + 1.0f;
    if (!(cfg->vbus_max_v <= DEVICE_VBUS_HARD_MAX_V)) {
      cfg->vbus_min_v = DEVICE_VBUS_MIN_PARAM_MAX_V;
      cfg->vbus_max_v = DEVICE_VBUS_HARD_MAX_V;
    }
  }
}

static DeviceConfigSource load_from_flash(void) {
  StoreImage image;
  g_sequence = 0U;
  if (!StoreImage_Load(&image)) {
    DeviceConfig_Apply(&g_defaults);
    return DEVCFG_SRC_DEFAULT;
  }
  g_sequence = image.sequence;
  if ((image.version < STORE_RECORD_V3) && (image.config_valid != 0U)) {
    fill_v3_extension(&image.config, &image);
  }
  if (image.config_valid == 0U) {
    DeviceConfig_Apply(&g_defaults);
    /* v1, or a record without config: commutation direction follows calibration. */
    if (image.calib_valid != 0U) {
      g_live.enc_dir = image.encoder_direction;
    }
    return DEVCFG_SRC_FLASH_V1;
  }
  if (image.version < STORE_RECORD_V4) {
    apply_legacy_overload(&image.config);
  }
  if (image.version < STORE_RECORD_V5) {
    image.config.pos_vff = DEVICE_POS_VFF_DEFAULT;
  }
  sanitize_telem(&image.config);
  clamp_vbus_window(&image.config);
  sanitize_max_mod(&image.config);
  if (!DeviceConfig_Validate(&image.config)) {
    DeviceConfig_Apply(&g_defaults);
    return DEVCFG_SRC_INVALID;
  }
  DeviceConfig_Apply(&image.config);
  return DEVCFG_SRC_FLASH;
}

void DeviceConfig_Init(void) {
  memset(&g_defaults, 0, sizeof(g_defaults));
  g_defaults.can_id = (uint8_t)MOTOR_CAN_ID;
  g_defaults.boot_mode = 0U;
  g_defaults.boot_auto_enable = 0U;
  g_defaults.telemetry = 1U;
  g_defaults.cmd_timeout_ms = 0U;
  g_defaults.boot_target = 0.0f;
  g_defaults.pole_pairs = (uint8_t)DEVICE_DEFAULT_POLE_PAIRS;
  g_defaults.enc_dir = (uint8_t)DEVICE_DEFAULT_ENC_DIR;
  g_defaults.gear_ratio = (uint8_t)DEVICE_DEFAULT_GEAR_RATIO;
  g_defaults.zero_valid = 0U;
  g_defaults.kt_nm_per_a = DEVICE_DEFAULT_KT;
  g_defaults.rs_ohm = DEVICE_DEFAULT_RS_OHM;
  g_defaults.ls_h = DEVICE_DEFAULT_LS_H;
  g_defaults.vbus_min_v = DEVICE_DEFAULT_VBUS_MIN_V;
  g_defaults.vbus_max_v = DEVICE_DEFAULT_VBUS_MAX_V;
  g_defaults.zero_offset_rad = 0.0f;
  g_defaults.can_baud = DEVICE_DEFAULT_CAN_BAUD;
  g_defaults.spd_ramp_ms = 0U;
  g_defaults.pos_ramp_ms = 0U;
  g_defaults.cur_ramp_ms = 0U;
  g_defaults.ol_en = 0.0f;
  g_defaults.ol_iq = IQ_CONTINUOUS_MAX_A;
  g_defaults.ol_time_s = OL_TIME_DEFAULT_S;
  g_defaults.cog_gain = 1.0f;
  g_defaults.cog_limit_a = COGGING_LIMIT_DEFAULT_A;
  g_defaults.telem_hz = DEVICE_DEFAULT_TELEM_HZ;
  telem_identity(g_defaults.telem_ch);
  g_live = g_defaults;
  /* Tunable defaults = the compile-time initialisers of the control_* globals. */
  DeviceConfig_Capture(&g_defaults);
  g_source = load_from_flash();
  g_active_can_id = g_live.can_id;
  if ((g_active_can_id < DEVICE_CAN_ID_MIN) || (g_active_can_id > DEVICE_CAN_ID_MAX)) {
    g_active_can_id = (uint8_t)MOTOR_CAN_ID;
  }
}

const DeviceConfigData *DeviceConfig_Live(void) { return &g_live; }
uint8_t DeviceConfig_ActiveCanId(void) { return g_active_can_id; }
DeviceConfigSource DeviceConfig_Source(void) { return g_source; }
uint32_t DeviceConfig_Sequence(void) { return g_sequence; }
uint8_t DeviceConfig_ZeroIsSet(void) { return g_live.zero_valid; }

const char *DeviceConfig_SourceName(void) {
  switch (g_source) {
    case DEVCFG_SRC_FLASH:
      return "flash";
    case DEVCFG_SRC_FLASH_V1:
      return "flash-v1";
    case DEVCFG_SRC_INVALID:
      return "invalid";
    case DEVCFG_SRC_DEFAULT:
    default:
      return "default";
  }
}

size_t DeviceConfig_ParamCount(void) { return PARAM_COUNT; }

const DeviceParamInfo *DeviceConfig_ParamInfo(size_t index) {
  return (index < PARAM_COUNT) ? &kParams[index].info : NULL;
}

int DeviceConfig_FindParam(const char *key) {
  if (key == NULL) {
    return -1;
  }
  for (size_t i = 0U; i < PARAM_COUNT; ++i) {
    if (strcmp(key, kParams[i].info.key) == 0) {
      return (int)i;
    }
  }
  return -1;
}

float DeviceConfig_GetParam(size_t index) {
  if (index >= PARAM_COUNT) {
    return NAN;
  }
  if (kParams[index].kind == P_VAR_F32) {
    return *kParams[index].var;
  }
  return cfg_get(&g_live, &kParams[index]);
}

DeviceConfigStatus DeviceConfig_SetParam(size_t index, float value) {
  if (index >= PARAM_COUNT) {
    return DEVCFG_ERR_KEY;
  }
  const ParamDef *p = &kParams[index];
  if (!value_ok(p, value)) {
    return DEVCFG_ERR_RANGE;
  }
  if (strcmp(p->info.key, "COG_EN") == 0 && value != 0.0f &&
      (!g_live.cogging.valid || g_cog_upload)) return DEVCFG_ERR_RANGE;
  if (strcmp(p->info.key, "VBUS_MIN") == 0) {
    if (!vbus_pair_ok(value, control_vbus_max_v)) {
      return DEVCFG_ERR_RANGE;
    }
  } else if (strcmp(p->info.key, "VBUS_MAX") == 0) {
    if (!vbus_pair_ok(control_vbus_min_v, value)) {
      return DEVCFG_ERR_RANGE;
    }
  } else if (strcmp(p->info.key, "OL_IQ") == 0) {
    /* Static max is the hard cap. The pair rule is extra: OL_IQ >= IQ_LIM.
     * The SET error text still prints the static min..max. */
    if (!(value >= control_iq_limit_a)) {
      return DEVCFG_ERR_RANGE;
    }
  }
  if (p->kind == P_VAR_F32) {
    *p->var = value;
  }
  cfg_set(&g_live, p, value);
  if (strcmp(p->info.key, "IQ_LIM") == 0) {
    /* Raising the continuous limit past OL_IQ lifts OL_IQ with it.
     * The reply still echoes only IQ_LIM. Lowering IQ_LIM leaves OL_IQ. */
    if (!(control_ol_iq_a >= value)) {
      control_ol_iq_a = value;
      g_live.ol_iq = value;
    }
  }
  if (strcmp(p->info.key, "ZERO_OFFSET") == 0) {
    g_live.zero_valid = 1U;
  }
  return DEVCFG_OK;
}

void DeviceConfig_RestoreDefaults(void) { DeviceConfig_Apply(&g_defaults); }

DeviceConfigSource DeviceConfig_Reload(void) {
  g_source = load_from_flash();
  return g_source;
}

int DeviceConfig_Save(uint32_t *saved_sequence) {
  if (g_cog_upload) return 0;
  StoreImage image;
  if (!StoreImage_Load(&image)) {
    memset(&image, 0, sizeof(image));
    /* No calibration in flash yet: store RAM values but mark them invalid so
     * a later boot keeps using the compiled-in defaults. */
    image.calib_valid = 0U;
    image.electrical_zero_rad = control_electrical_zero_rad;
    image.encoder_direction = control_encoder_direction;
  }
  DeviceConfig_Capture(&image.config);
  if (!DeviceConfig_Validate(&image.config)) {
    return 0;
  }
  image.config_valid = 1U;
  uint32_t seq = 0U;
  if (!StoreImage_Save(&image, &seq)) {
    return 0;
  }
  g_sequence = seq;
  g_source = DEVCFG_SRC_FLASH;
  if (saved_sequence != NULL) {
    *saved_sequence = seq;
  }
  return 1;
}

void DeviceConfig_OnCalibrationSaved(uint8_t encoder_direction, uint32_t sequence) {
  /* Every commutation recalibration invalidates the old motor-specific map. */
  DeviceConfig_CoggingClear();
  g_live.enc_dir = (encoder_direction != 0U) ? 1U : 0U;
  g_sequence = sequence;
}

void DeviceConfig_CoggingClear(void) {
  g_live.cog_en = 0.0f;
  g_live.cogging.valid = 0U;
  g_cog_upload = 0U;
  g_cog_count = 0U;
  memset(g_cog_written, 0, sizeof(g_cog_written));
}

void DeviceConfig_CoggingBegin(void) {
  DeviceConfig_CoggingClear();
  memset(&g_live.cogging, 0, sizeof(g_live.cogging));
  g_cog_upload = 1U;
}

int DeviceConfig_CoggingSet(uint16_t start, const int16_t *ma, size_t count) {
  if (!g_cog_upload || !ma || count == 0U || start >= COGGING_TABLE_SIZE ||
      count > COGGING_TABLE_SIZE - start) return 0;
  for (size_t i = 0U; i < count; ++i) {
    if (ma[i] < -COGGING_SAMPLE_MAX_MA || ma[i] > COGGING_SAMPLE_MAX_MA) return 0;
  }
  for (size_t i = 0U; i < count; ++i) {
    const size_t index = start + i;
    const uint8_t mask = (uint8_t)(1U << (index % 8U));
    g_live.cogging.current_ma[index] = ma[i];
    if (!(g_cog_written[index / 8U] & mask)) {
      g_cog_written[index / 8U] |= mask;
      ++g_cog_count;
    }
  }
  return 1;
}

int DeviceConfig_CoggingCommit(float zero, uint8_t direction, uint8_t poles) {
  if (!g_cog_upload || g_cog_count != COGGING_TABLE_SIZE || direction > 1U ||
      poles < 1U || poles > 40U || !isfinite(zero) ||
      zero < 0.0f || zero >= 6.28318530718f) return 0;
  g_live.cogging.electrical_zero_rad = zero;
  g_live.cogging.encoder_direction = direction;
  g_live.cogging.pole_pairs = poles;
  g_live.cogging.valid = 1U;
  g_cog_upload = 0U;
  return 1;
}

uint16_t DeviceConfig_CoggingWritten(void) { return g_cog_count; }
int DeviceConfig_CoggingUploading(void) { return g_cog_upload != 0U; }

const uint8_t *DeviceConfig_TelemChannels(void) { return g_live.telem_ch; }

int DeviceConfig_SetTelemChannels(const uint8_t *channels, size_t count) {
  if ((channels == NULL) || (count != DEVICE_TELEM_SLOTS) || !telem_map_ok(channels)) {
    return 0;
  }
  memcpy(g_live.telem_ch, channels, DEVICE_TELEM_SLOTS);
  return 1;
}

uint16_t DeviceConfig_TelemHz(void) { return g_live.telem_hz; }

float DeviceConfig_EffectiveVbusMin(float configured) {
  return (configured > DEVICE_VBUS_HARD_MIN_V) ? configured
                                               : DEVICE_VBUS_HARD_MIN_V;
}

float DeviceConfig_SlewToward(float applied, float toward, float max_step) {
  float delta;
  if (!(max_step >= 0.0f)) {
    max_step = 0.0f;
  }
  delta = toward - applied;
  if (delta > max_step) {
    return applied + max_step;
  }
  if (delta < -max_step) {
    return applied - max_step;
  }
  return toward;
}

int DeviceConfig_SetRequiresIdle(const char *key) {
  if (key == NULL) {
    return 0;
  }
  return (strcmp(key, "ZERO_OFFSET") == 0) ||
         (strcmp(key, "ENC_DIR") == 0) ||
         (strcmp(key, "POLE_PAIRS") == 0) ||
         (strcmp(key, "RS") == 0) ||
         (strcmp(key, "LS") == 0);
}

static uint8_t g_can_baud_fallback = 0U;

void DeviceConfig_NoteCanBaudFallback(void) { g_can_baud_fallback = 1U; }

uint8_t DeviceConfig_CanBaudFallback(void) { return g_can_baud_fallback; }

int DeviceConfig_SetTelemHz(uint16_t hz) {
  uint32_t period = 0U;
  if (!DeviceConfig_TelemPeriodMs(hz, &period)) {
    return 0;
  }
  g_live.telem_hz = hz;
  return 1;
}

uint16_t DeviceConfig_MaxTelemHz(void) {
  /* 16 float32 + 4-byte JustFloat tail. Leave 20% of UART 8N1 for replies. */
  const uint32_t budget = (DEVICE_UART_BAUD / 10U) * 4U / 5U;
  const uint32_t hz = budget / 68U;
  if (hz > 1000U) {
    return 1000U;
  }
  if (hz < 10U) {
    return 10U;
  }
  return (uint16_t)hz;
}

int DeviceConfig_TelemPeriodMs(uint16_t hz, uint32_t *period_ms) {
  uint32_t period;
  uint32_t actual;
  const uint32_t budget = (DEVICE_UART_BAUD / 10U) * 4U / 5U;
  if ((hz < 10U) || (hz > 1000U) || (period_ms == NULL)) {
    return 0;
  }
  period = (1000U + (uint32_t)hz - 1U) / (uint32_t)hz; /* ceil, so actual <= request */
  if (period < 1U) {
    period = 1U;
  }
  actual = 1000U / period;
  if ((actual < 10U) || ((68U * actual) > budget)) {
    return 0;
  }
  *period_ms = period;
  return 1;
}
