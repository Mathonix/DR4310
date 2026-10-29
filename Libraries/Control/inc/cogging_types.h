#ifndef COGGING_TYPES_H
#define COGGING_TYPES_H

#include <stdint.h>

/* A full absolute encoder revolution; samples are signed compensating Iq,
 * not the cogging disturbance itself. Index zero is raw encoder angle zero. */
#define COGGING_TABLE_SIZE 512U
#define COGGING_SAMPLE_MAX_MA 1000
#define COGGING_LIMIT_MAX_A 1.0f
#define COGGING_LIMIT_DEFAULT_A 0.2f

typedef struct {
  uint8_t valid;
  uint8_t encoder_direction;
  uint8_t pole_pairs;
  uint8_t reserved;
  float electrical_zero_rad;
  int16_t current_ma[COGGING_TABLE_SIZE];
} CoggingMap;

#endif
