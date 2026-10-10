#ifndef DEVICE_CONFIG_H
#define DEVICE_CONFIG_H

/*
 * Persistent device configuration.
 *
 * - Tunables take effect immediately; SAVE snapshots them into flash.
 * - CAN_ID / CAN_BAUD / BOOT_* / POLE_PAIRS / ENC_DIR take effect at the next
 *   boot (after SAVE + REBOOT). The CAN filter and FDCAN bit timing are never
 *   changed while the controller is running.
 * - Flash writes are refused unless the motor is IDLE and the driver is off.
 *   v1 (calibration only) and v2 records still load: calibration is kept and
 *   every v3 field takes its compile-time default. v3 records load with
 *   OL_EN=0, OL_IQ=the stored IQ_LIM and OL_TIME_S at its compile-time default.
 * - MAX_MOD lives in the v4 record's ol_reserved[4] as a float. Length and
 *   version stay v4. A stored 0 (older images) loads as DEVICE_MAX_MOD_DEFAULT.
 */

#include <stddef.h>
#include <stdint.h>

#include "store_record.h"

#ifdef __cplusplus
extern "C" {
#endif

#define DEVICE_CAN_ID_MIN 1U
#define DEVICE_CAN_ID_MAX 7U /* GM6020-compatible mapping covers IDs 1..7 */

#define DEVICE_DEFAULT_POLE_PAIRS 14U
#define DEVICE_DEFAULT_ENC_DIR 1U
#define DEVICE_DEFAULT_GEAR_RATIO 10U
#define DEVICE_DEFAULT_CAN_BAUD 1000000UL
#define DEVICE_DEFAULT_TELEM_HZ 100U
#define DEVICE_DEFAULT_VBUS_MIN_V 6.0f
#define DEVICE_DEFAULT_VBUS_MAX_V 40.0f
/* Hard enable floor (open-loop, FOC ISR, ident) and the original board
 * overvoltage gate. DRV8313 is rated to 60 V; this firmware does not raise
 * the gate above the 40 V constant the power stage already used.
 * VBUS_MIN cannot be set below the floor. VBUS_MAX cannot be set above the
 * gate. Every enable path uses max(floor, VBUS_MIN). The highest VBUS_MIN
 * that still leaves a 1 V gap under the gate is gate - 1. */
#define DEVICE_VBUS_HARD_MIN_V 6.0f
#define DEVICE_VBUS_HARD_MAX_V 40.0f
#define DEVICE_VBUS_MIN_PARAM_MAX_V (DEVICE_VBUS_HARD_MAX_V - 1.0f)
#define DEVICE_DEFAULT_RS_OHM 1.97f
/* Voltage-circle ratio, vmax = MAX_MOD * Vbus / sqrt(3). Stored in ol_reserved. */
#define DEVICE_MAX_MOD_MIN 0.5f
#define DEVICE_MAX_MOD_MAX 0.99f
#define DEVICE_MAX_MOD_DEFAULT 0.99f
#define DEVICE_DEFAULT_LS_H 0.005f
#define DEVICE_DEFAULT_KT 0.0f
#define DEVICE_TELEM_SLOTS 16U
#define DEVICE_TELEM_CHANNEL_COUNT 29U

/* 170 MHz FDCAN kernel, 17 time quanta (sync + seg1 13 + seg2 3). */
#define DEVICE_CAN_TQ 17U
#define DEVICE_CAN_CLOCK_HZ 170000000UL

typedef enum {
  DEVCFG_SRC_DEFAULT = 0, /* no valid flash record */
  DEVCFG_SRC_FLASH_V1 = 1, /* calibration-only record: config = defaults */
  DEVCFG_SRC_FLASH = 2,    /* v2, v3, or v4 record with valid config */
  DEVCFG_SRC_INVALID = 3,  /* record whose config failed range checks */
} DeviceConfigSource;

typedef enum {
  DEVCFG_OK = 0,
  DEVCFG_ERR_KEY = -1,
  DEVCFG_ERR_RANGE = -2,
  DEVCFG_ERR_READONLY = -3,
} DeviceConfigStatus;

typedef struct {
  const char *key;
  float min;
  float max;
  uint8_t is_int;
  uint8_t reboot_required;
  const char *choices; /* optional discrete list, e.g. "125000|250000|..." */
} DeviceParamInfo;

/* Prescaler for a supported baud, or 0. 170e6 / (prescaler * 17) == baud. */
static inline uint32_t DeviceConfig_CanPrescaler(uint32_t baud) {
  if ((baud != 125000U) && (baud != 250000U) && (baud != 500000U) &&
      (baud != 1000000U)) {
    return 0U;
  }
  return (DEVICE_CAN_CLOCK_HZ / DEVICE_CAN_TQ) / baud;
}

/* Captures compile-time defaults, loads flash, applies config. Call once,
 * before CAN init and before ControlApp_Init. */
void DeviceConfig_Init(void);

const DeviceConfigData *DeviceConfig_Live(void);
uint8_t DeviceConfig_ActiveCanId(void); /* the ID the CAN side runs with */
DeviceConfigSource DeviceConfig_Source(void);
const char *DeviceConfig_SourceName(void);
uint32_t DeviceConfig_Sequence(void);
uint8_t DeviceConfig_ZeroIsSet(void);

size_t DeviceConfig_ParamCount(void);
const DeviceParamInfo *DeviceConfig_ParamInfo(size_t index);
int DeviceConfig_FindParam(const char *key); /* index or -1, key upper-case */
float DeviceConfig_GetParam(size_t index);
DeviceConfigStatus DeviceConfig_SetParam(size_t index, float value);

int DeviceConfig_FirstInvalidParam(void);
int DeviceConfig_Validate(const DeviceConfigData *cfg);
void DeviceConfig_Capture(DeviceConfigData *cfg);
void DeviceConfig_Apply(const DeviceConfigData *cfg);

void DeviceConfig_RestoreDefaults(void);
DeviceConfigSource DeviceConfig_Reload(void);
/* Persist calibration (as stored in flash) + current config. 1 on success.
 * Caller must already be IDLE with the driver off. */
int DeviceConfig_Save(uint32_t *saved_sequence);
/* CALIB saved a new direction. Keep RAM ENC_DIR and the sequence in step
 * with the record CalibrationStore just wrote. */
void DeviceConfig_OnCalibrationSaved(uint8_t encoder_direction, uint32_t sequence);

/* Telemetry map / rate live in the same record and are included in SAVE. */
const uint8_t *DeviceConfig_TelemChannels(void);
int DeviceConfig_SetTelemChannels(const uint8_t *channels, size_t count);
uint16_t DeviceConfig_TelemHz(void);
int DeviceConfig_SetTelemHz(uint16_t hz);
/* Highest requested rate whose 68-byte frames fit in 80% of 115200 8N1. */
uint16_t DeviceConfig_MaxTelemHz(void);
/* 1 if hz is 10..1000 and the quantized 1 ms period fits the UART budget. */
int DeviceConfig_TelemPeriodMs(uint16_t hz, uint32_t *period_ms);

/* 1 for SET keys that move the position frame or the live/next-boot motor
 * model. The UART layer rejects them unless the motor is IDLE. */
int DeviceConfig_SetRequiresIdle(const char *key);

/* max(hard floor, configured). Non-finite or low values return the floor. */
float DeviceConfig_EffectiveVbusMin(float configured);

/* Step `applied` toward `toward` by at most `max_step` (the slower of a
 * timed ramp and the legacy slew). A negative max_step is treated as 0. */
float DeviceConfig_SlewToward(float applied, float toward, float max_step);

/* HAL_FDCAN_Init of a stored baud failed; the controller fell back to 1 Mbps. */
void DeviceConfig_NoteCanBaudFallback(void);
uint8_t DeviceConfig_CanBaudFallback(void);

#ifdef __cplusplus
}
#endif

#endif
