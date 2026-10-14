#ifndef STORE_RECORD_H
#define STORE_RECORD_H

/*
 * Pure (HAL-free) encode/decode of the persistent flash record.
 * Kept separate from calibration_store.c so it can be unit-tested on a PC.
 *
 * Record history (same magic "CAL1", two redundant 2 KiB pages, little-endian):
 *   v1, 24 bytes: calibration only (electrical zero + encoder direction).
 *   v2, 96 bytes: calibration + 72-byte device config.
 *   v3, 152 bytes: v2 config plus motor/protection/zero/CAN baud/telemetry
 *                  map and command ramps. v1 and v2 still decode: calibration
 *                  is kept and the v3 fields are left zero for the caller to
 *                  fill with defaults.
 *   v4, 168 bytes: v3 plus overload mode (OL_EN, OL_IQ, OL_TIME_S). v1..v3
 *                  still decode. Their overload bytes stay zero; device_config
 *                  then sets OL_EN=0, OL_IQ=IQ_LIM and OL_TIME_S to the default.
 *                  From 3.1.1 the last 4 bytes (ol_reserved) hold MAX_MOD as a
 *                  float. Length and version stay v4. 0 means unset.
 *   v5, 176 bytes: v4 plus POS_VFF (0..1) and 4 reserved bytes. Older
 *                  records decode with POS_VFF=1; v5 preserves an explicit 0.
 *   v6, 1224 bytes: v5 plus COG_EN/GAIN/LIM and a 512-point int16 mA map.
 *                  Legacy v1..v5 maps are invalid/disabled, gain=1, limit=.2 A.
 */

#include <stddef.h>
#include <stdint.h>
#include "cogging_types.h"

#ifdef __cplusplus
extern "C" {
#endif

#define STORE_RECORD_MAGIC 0x43414C31UL /* "CAL1" */
#define STORE_RECORD_V1 1U
#define STORE_RECORD_V2 2U
#define STORE_RECORD_V3 3U
#define STORE_RECORD_V4 4U
#define STORE_RECORD_V5 5U
#define STORE_RECORD_V6 6U
#define STORE_RECORD_V1_BYTES 24U
#define STORE_RECORD_V2_BYTES 96U
#define STORE_RECORD_V3_BYTES 152U
#define STORE_RECORD_V4_BYTES 168U
#define STORE_RECORD_V5_BYTES 176U
#define STORE_RECORD_V6_BYTES 1224U
#define STORE_RECORD_MAX_BYTES STORE_RECORD_V6_BYTES

/* First 72 bytes are the v2 config image. Do not reorder or insert fields. */
typedef struct {
  uint8_t can_id;           /* 1..7, applied at boot */
  uint8_t boot_mode;        /* 0 idle, 1 current, 2 speed, 3 position */
  uint8_t boot_auto_enable; /* 0/1 */
  uint8_t telemetry;        /* 0/1: VOFA JustFloat stream on UART */
  uint16_t cmd_timeout_ms;  /* 0 = off */
  uint16_t reserved0;
  float boot_target;        /* A / rpm / rad depending on boot_mode */
  float cur_kp;
  float cur_ki;
  float cur_vlim;
  float iq_limit;
  float spd_kp;
  float spd_ki;
  float spd_kd;
  float accel;
  float pos_kp;
  float pos_ki;
  float pos_kd;
  float pos_isep;
  float pos_vlim;
  float mit_kp;
  float mit_kd;
} DeviceConfigV2;

/* 1200 bytes. Preserve the complete 152-byte v5 prefix. */
typedef struct {
  uint8_t can_id;
  uint8_t boot_mode;
  uint8_t boot_auto_enable;
  uint8_t telemetry;
  uint16_t cmd_timeout_ms;
  uint16_t reserved0;
  float boot_target;
  float cur_kp;
  float cur_ki;
  float cur_vlim;
  float iq_limit;
  float spd_kp;
  float spd_ki;
  float spd_kd;
  float accel;
  float pos_kp;
  float pos_ki;
  float pos_kd;
  float pos_isep;
  float pos_vlim;
  float mit_kp;
  float mit_kd;
  uint8_t pole_pairs;     /* 1..40, applied at boot */
  uint8_t enc_dir;        /* 0/1, applied at boot */
  uint8_t gear_ratio;     /* 1..100, host-side scale only */
  uint8_t zero_valid;     /* 0 = legacy unwrapped position, 1 = zeroed */
  float kt_nm_per_a;
  float rs_ohm;
  float ls_h;
  float vbus_min_v;
  float vbus_max_v;
  float zero_offset_rad;  /* mechanical angle that reads as position 0 */
  uint32_t can_baud;      /* 125k/250k/500k/1M, applied at boot */
  uint16_t spd_ramp_ms;
  uint16_t pos_ramp_ms;
  uint16_t cur_ramp_ms;
  uint16_t telem_hz;
  uint8_t telem_ch[16];
  /* v4 extension. Do not insert fields above this line. */
  float ol_en;             /* 0 or 1 */
  float ol_iq;             /* A, >= iq_limit, <= IQ_HARD_MAX_A */
  float ol_time_s;         /* s, 0..10. 0 disables overload */
  uint8_t ol_reserved[4]; /* MAX_MOD float since 3.1.1; 0 means unset */
  /* v5 extension. The v4 prefix remains exactly 144 bytes. */
  float pos_vff;           /* position trajectory velocity feedforward gain, 0..1 */
  uint8_t pos_reserved[4];
  /* v6: absolute encoder cogging table and independent feedforward limits. */
  float cog_en;
  float cog_gain;
  float cog_limit_a;
  CoggingMap cogging;
  uint8_t cog_reserved[4];
} DeviceConfigData;

typedef struct {
  uint16_t version;      /* version of the decoded record */
  uint32_t sequence;
  uint8_t calib_valid;   /* electrical_zero/encoder_direction are meaningful */
  uint8_t config_valid;  /* config prefix is meaningful (v2..v6) */
  float electrical_zero_rad;
  uint8_t encoder_direction;
  DeviceConfigData config;
} StoreImage;

uint32_t StoreRecord_Crc32(const uint8_t *data, size_t length);
/* Returns 1 if buf holds a valid v1..v6 record; fills *out.
 * v1/v2 leave the v3 extension zeroed. v1..v3 leave the v4 overload bytes zero.
 * v1..v4 default pos_vff to 1, including calibration-only record rewrites. */
int StoreRecord_Decode(const uint8_t *buf, size_t len, StoreImage *out);
/* Always writes v6, STORE_RECORD_V6_BYTES. Returns bytes written or 0. */
size_t StoreRecord_Encode(const StoreImage *in, uint32_t sequence,
                          uint8_t *buf, size_t len);

#ifdef __cplusplus
}
#endif

#endif
