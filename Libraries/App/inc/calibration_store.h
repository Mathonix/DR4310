#ifndef CALIBRATION_STORE_H
#define CALIBRATION_STORE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* The linker reserves the last two 2-KiB flash pages for redundant records. */
#define CALIBRATION_STORE_SLOT0_ADDRESS 0x0801F000UL
#define CALIBRATION_STORE_SLOT1_ADDRESS 0x0801F800UL
#define CALIBRATION_STORE_RESERVED_BYTES 0x1000UL

typedef struct {
  float electrical_zero_rad;
  uint8_t encoder_direction;
  uint32_t sequence;
} CalibrationStoreData;

/* Returns 1 only for a versioned, CRC-valid, physically valid record. */
int CalibrationStore_Load(CalibrationStoreData *data);
/* Alternates pages and verifies the newly programmed record before returning. */
int CalibrationStore_Save(const CalibrationStoreData *data,
                          uint32_t *saved_sequence);

#ifdef __cplusplus
}
#endif

#endif
