#include "store_record.h"

#include <math.h>
#include <string.h>

#define STORE_TWO_PI 6.2831853071795864769f

typedef struct {
  uint32_t magic;
  uint16_t version;
  uint16_t size;
  uint32_t sequence;
  float electrical_zero_rad;
  uint8_t encoder_direction;
  uint8_t reserved[3];
  uint32_t crc32;
} RecordV1;

typedef struct {
  uint32_t magic;
  uint16_t version;
  uint16_t size;
  uint32_t sequence;
  float electrical_zero_rad;
  uint8_t encoder_direction;
  uint8_t calib_valid;
  uint8_t config_valid;
  uint8_t reserved;
  DeviceConfigV2 config;
  uint32_t crc32;
} RecordV2;

/* Frozen v3 image. DeviceConfigData grew in v4, so this copy is a raw blob. */
typedef struct {
  uint32_t magic;
  uint16_t version;
  uint16_t size;
  uint32_t sequence;
  float electrical_zero_rad;
  uint8_t encoder_direction;
  uint8_t calib_valid;
  uint8_t config_valid;
  uint8_t reserved;
  uint8_t config[128];
  uint32_t crc32;
} RecordV3;

typedef struct {
  uint32_t magic;
  uint16_t version;
  uint16_t size;
  uint32_t sequence;
  float electrical_zero_rad;
  uint8_t encoder_direction;
  uint8_t calib_valid;
  uint8_t config_valid;
  uint8_t reserved;
  uint8_t config[144];
  uint32_t crc32;
} RecordV4;

typedef struct {
  uint32_t magic;
  uint16_t version;
  uint16_t size;
  uint32_t sequence;
  float electrical_zero_rad;
  uint8_t encoder_direction;
  uint8_t calib_valid;
  uint8_t config_valid;
  uint8_t reserved;
  uint8_t config[152];
  uint32_t crc32;
} RecordV5;

typedef char DeviceConfigV2MustBe72Bytes[(sizeof(DeviceConfigV2) == 72U) ? 1 : -1];
typedef char DeviceConfigMustBe1200Bytes[(sizeof(DeviceConfigData) == 1200U) ? 1 : -1];
typedef char V6CoggingAt164[(offsetof(DeviceConfigData, cogging) == 164U) ? 1 : -1];
typedef char V6FitsPage[(STORE_RECORD_V6_BYTES <= 2048U) ? 1 : -1];
typedef char V6DoubleWordAligned[((STORE_RECORD_V6_BYTES % 8U) == 0U) ? 1 : -1];
typedef char V3ExtStartsAt72[(offsetof(DeviceConfigData, pole_pairs) == 72U) ? 1 : -1];
typedef char V3BaudAt100[(offsetof(DeviceConfigData, can_baud) == 100U) ? 1 : -1];
typedef char V3ChannelsAt112[(offsetof(DeviceConfigData, telem_ch) == 112U) ? 1 : -1];
typedef char V4OverloadAt128[(offsetof(DeviceConfigData, ol_en) == 128U) ? 1 : -1];
typedef char V4MaxModAt140[(offsetof(DeviceConfigData, ol_reserved) == 140U) ? 1 : -1];
typedef char V5PositionVffAt144[(offsetof(DeviceConfigData, pos_vff) == 144U) ? 1 : -1];
typedef char V2PrefixMatches[(offsetof(DeviceConfigData, mit_kd) == offsetof(DeviceConfigV2, mit_kd)) ? 1 : -1];
typedef char RecordV1MustBe24Bytes[(sizeof(RecordV1) == STORE_RECORD_V1_BYTES) ? 1 : -1];
typedef char RecordV2MustBe96Bytes[(sizeof(RecordV2) == STORE_RECORD_V2_BYTES) ? 1 : -1];
typedef char RecordV3MustBe152Bytes[(sizeof(RecordV3) == STORE_RECORD_V3_BYTES) ? 1 : -1];
typedef char RecordV3DoubleWordAligned[((sizeof(RecordV3) % 8U) == 0U) ? 1 : -1];
typedef char RecordV4MustBe168Bytes[(sizeof(RecordV4) == STORE_RECORD_V4_BYTES) ? 1 : -1];
typedef char RecordV4DoubleWordAligned[((sizeof(RecordV4) % 8U) == 0U) ? 1 : -1];
typedef char RecordV5MustBe176Bytes[(sizeof(RecordV5) == STORE_RECORD_V5_BYTES) ? 1 : -1];
typedef char RecordV5DoubleWordAligned[((sizeof(RecordV5) % 8U) == 0U) ? 1 : -1];

uint32_t StoreRecord_Crc32(const uint8_t *data, size_t length) {
  uint32_t crc = 0xFFFFFFFFUL;
  for (size_t i = 0U; i < length; ++i) {
    crc ^= data[i];
    for (uint8_t bit = 0U; bit < 8U; ++bit) {
      const uint32_t mask = (uint32_t)-(int32_t)(crc & 1U);
      crc = (crc >> 1U) ^ (0xEDB88320UL & mask);
    }
  }
  return ~crc;
}

static int calib_ok(float zero, uint8_t dir) {
  return (dir <= 1U) && isfinite(zero) && (zero >= 0.0f) && (zero < STORE_TWO_PI);
}

static void image_clear(StoreImage *out) {
  memset(out, 0, sizeof(*out));
  /* Legacy images had unconditional velocity feedforward. Set this before
   * copying their shorter prefixes so calibration-only saves also migrate. */
  out->config.pos_vff = 1.0f;
  out->config.cog_gain = 1.0f;
  out->config.cog_limit_a = COGGING_LIMIT_DEFAULT_A;
}

int StoreRecord_Decode(const uint8_t *buf, size_t len, StoreImage *out) {
  uint32_t magic;
  uint16_t version;
  uint16_t size;
  if ((buf == NULL) || (out == NULL) || (len < STORE_RECORD_V1_BYTES)) {
    return 0;
  }
  memcpy(&magic, buf, 4U);
  memcpy(&version, buf + 4U, 2U);
  memcpy(&size, buf + 6U, 2U);
  if (magic != STORE_RECORD_MAGIC) {
    return 0;
  }
  if ((version == STORE_RECORD_V1) && (size == STORE_RECORD_V1_BYTES)) {
    RecordV1 r;
    memcpy(&r, buf, sizeof(r));
    if (!calib_ok(r.electrical_zero_rad, r.encoder_direction) ||
        (r.crc32 != StoreRecord_Crc32((const uint8_t *)&r, offsetof(RecordV1, crc32)))) {
      return 0;
    }
    image_clear(out);
    out->version = STORE_RECORD_V1;
    out->sequence = r.sequence;
    out->calib_valid = 1U;
    out->config_valid = 0U;
    out->electrical_zero_rad = r.electrical_zero_rad;
    out->encoder_direction = r.encoder_direction;
    return 1;
  }
  if ((version == STORE_RECORD_V2) && (size == STORE_RECORD_V2_BYTES) &&
      (len >= STORE_RECORD_V2_BYTES)) {
    RecordV2 r;
    memcpy(&r, buf, sizeof(r));
    if ((r.crc32 != StoreRecord_Crc32((const uint8_t *)&r, offsetof(RecordV2, crc32))) ||
        (r.calib_valid > 1U) || (r.config_valid > 1U) ||
        ((r.calib_valid != 0U) && !calib_ok(r.electrical_zero_rad, r.encoder_direction))) {
      return 0;
    }
    image_clear(out);
    out->version = STORE_RECORD_V2;
    out->sequence = r.sequence;
    out->calib_valid = r.calib_valid;
    out->config_valid = r.config_valid;
    out->electrical_zero_rad = r.electrical_zero_rad;
    out->encoder_direction = r.encoder_direction;
    memcpy(&out->config, &r.config, sizeof(r.config));
    return 1;
  }
  if ((version == STORE_RECORD_V3) && (size == STORE_RECORD_V3_BYTES) &&
      (len >= STORE_RECORD_V3_BYTES)) {
    RecordV3 r;
    memcpy(&r, buf, sizeof(r));
    if ((r.crc32 != StoreRecord_Crc32((const uint8_t *)&r, offsetof(RecordV3, crc32))) ||
        (r.calib_valid > 1U) || (r.config_valid > 1U) ||
        ((r.calib_valid != 0U) && !calib_ok(r.electrical_zero_rad, r.encoder_direction))) {
      return 0;
    }
    image_clear(out);
    out->version = STORE_RECORD_V3;
    out->sequence = r.sequence;
    out->calib_valid = r.calib_valid;
    out->config_valid = r.config_valid;
    out->electrical_zero_rad = r.electrical_zero_rad;
    out->encoder_direction = r.encoder_direction;
    memcpy(&out->config, r.config, sizeof(r.config));
    return 1;
  }
  if ((version == STORE_RECORD_V4) && (size == STORE_RECORD_V4_BYTES) &&
      (len >= STORE_RECORD_V4_BYTES)) {
    RecordV4 r;
    memcpy(&r, buf, sizeof(r));
    if ((r.crc32 != StoreRecord_Crc32((const uint8_t *)&r, offsetof(RecordV4, crc32))) ||
        (r.calib_valid > 1U) || (r.config_valid > 1U) ||
        ((r.calib_valid != 0U) && !calib_ok(r.electrical_zero_rad, r.encoder_direction))) {
      return 0;
    }
    image_clear(out);
    out->version = STORE_RECORD_V4;
    out->sequence = r.sequence;
    out->calib_valid = r.calib_valid;
    out->config_valid = r.config_valid;
    out->electrical_zero_rad = r.electrical_zero_rad;
    out->encoder_direction = r.encoder_direction;
    memcpy(&out->config, r.config, sizeof(r.config));
    return 1;
  }
  if ((version == STORE_RECORD_V5) && (size == STORE_RECORD_V5_BYTES) &&
      (len >= STORE_RECORD_V5_BYTES)) {
    RecordV5 r;
    memcpy(&r, buf, sizeof(r));
    if ((r.crc32 != StoreRecord_Crc32((const uint8_t *)&r, offsetof(RecordV5, crc32))) ||
        (r.calib_valid > 1U) || (r.config_valid > 1U) ||
        ((r.calib_valid != 0U) && !calib_ok(r.electrical_zero_rad, r.encoder_direction))) {
      return 0;
    }
    image_clear(out);
    out->version = STORE_RECORD_V5;
    out->sequence = r.sequence;
    out->calib_valid = r.calib_valid;
    out->config_valid = r.config_valid;
    out->electrical_zero_rad = r.electrical_zero_rad;
    out->encoder_direction = r.encoder_direction;
    memcpy(&out->config, r.config, sizeof(r.config));
    return 1;
  }
  if ((version == STORE_RECORD_V6) && (size == STORE_RECORD_V6_BYTES) &&
      (len >= STORE_RECORD_V6_BYTES)) {
    uint32_t crc;
    float zero;
    memcpy(&crc, buf + size - 4U, 4U);
    memcpy(&zero, buf + 12U, 4U);
    if (crc != StoreRecord_Crc32(buf, size - 4U) || buf[17] > 1U ||
        buf[18] > 1U || (buf[17] && !calib_ok(zero, buf[16]))) return 0;
    image_clear(out);
    out->version = STORE_RECORD_V6;
    memcpy(&out->sequence, buf + 8U, 4U);
    out->electrical_zero_rad = zero;
    out->encoder_direction = buf[16];
    out->calib_valid = buf[17];
    out->config_valid = buf[18];
    memcpy(&out->config, buf + 20U, sizeof(out->config));
    return 1;
  }
  return 0;
}

size_t StoreRecord_Encode(const StoreImage *in, uint32_t sequence,
                          uint8_t *buf, size_t len) {
  if ((in == NULL) || (buf == NULL) || (len < STORE_RECORD_V6_BYTES)) {
    return 0U;
  }
  if ((in->calib_valid != 0U) && !calib_ok(in->electrical_zero_rad, in->encoder_direction)) {
    return 0U;
  }
  const uint32_t magic = STORE_RECORD_MAGIC;
  const uint16_t version = STORE_RECORD_V6, size = STORE_RECORD_V6_BYTES;
  memset(buf, 0, STORE_RECORD_V6_BYTES);
  memcpy(buf, &magic, 4U);
  memcpy(buf + 4U, &version, 2U);
  memcpy(buf + 6U, &size, 2U);
  memcpy(buf + 8U, &sequence, 4U);
  memcpy(buf + 12U, &in->electrical_zero_rad, 4U);
  buf[16] = (in->encoder_direction != 0U) ? 1U : 0U;
  buf[17] = (in->calib_valid != 0U) ? 1U : 0U;
  buf[18] = (in->config_valid != 0U) ? 1U : 0U;
  memcpy(buf + 20U, &in->config, sizeof(in->config));
  buf[20U + offsetof(DeviceConfigData, zero_valid)] = !!in->config.zero_valid;
  const float ol_en = (in->config.ol_en != 0.0f) ? 1.0f : 0.0f;
  memcpy(buf + 20U + offsetof(DeviceConfigData, ol_en), &ol_en, 4U);
  memset(buf + 20U + offsetof(DeviceConfigData, pos_reserved), 0, 4U);
  memset(buf + 20U + offsetof(DeviceConfigData, cog_reserved), 0, 4U);
  const uint32_t crc = StoreRecord_Crc32(buf, STORE_RECORD_V6_BYTES - 4U);
  memcpy(buf + STORE_RECORD_V6_BYTES - 4U, &crc, 4U);
  return STORE_RECORD_V6_BYTES;
}
