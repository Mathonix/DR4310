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
  DeviceConfigData config;
  uint32_t crc32;
} RecordV4;

typedef char DeviceConfigV2MustBe72Bytes[(sizeof(DeviceConfigV2) == 72U) ? 1 : -1];
typedef char DeviceConfigMustBe144Bytes[(sizeof(DeviceConfigData) == 144U) ? 1 : -1];
typedef char V3ExtStartsAt72[(offsetof(DeviceConfigData, pole_pairs) == 72U) ? 1 : -1];
typedef char V3BaudAt100[(offsetof(DeviceConfigData, can_baud) == 100U) ? 1 : -1];
typedef char V3ChannelsAt112[(offsetof(DeviceConfigData, telem_ch) == 112U) ? 1 : -1];
typedef char V4OverloadAt128[(offsetof(DeviceConfigData, ol_en) == 128U) ? 1 : -1];
typedef char V2PrefixMatches[(offsetof(DeviceConfigData, mit_kd) == offsetof(DeviceConfigV2, mit_kd)) ? 1 : -1];
typedef char RecordV1MustBe24Bytes[(sizeof(RecordV1) == STORE_RECORD_V1_BYTES) ? 1 : -1];
typedef char RecordV2MustBe96Bytes[(sizeof(RecordV2) == STORE_RECORD_V2_BYTES) ? 1 : -1];
typedef char RecordV3MustBe152Bytes[(sizeof(RecordV3) == STORE_RECORD_V3_BYTES) ? 1 : -1];
typedef char RecordV3DoubleWordAligned[((sizeof(RecordV3) % 8U) == 0U) ? 1 : -1];
typedef char RecordV4MustBe168Bytes[(sizeof(RecordV4) == STORE_RECORD_V4_BYTES) ? 1 : -1];
typedef char RecordV4DoubleWordAligned[((sizeof(RecordV4) % 8U) == 0U) ? 1 : -1];

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
    out->config = r.config;
    return 1;
  }
  return 0;
}

size_t StoreRecord_Encode(const StoreImage *in, uint32_t sequence,
                          uint8_t *buf, size_t len) {
  RecordV4 r;
  if ((in == NULL) || (buf == NULL) || (len < sizeof(r))) {
    return 0U;
  }
  if ((in->calib_valid != 0U) && !calib_ok(in->electrical_zero_rad, in->encoder_direction)) {
    return 0U;
  }
  memset(&r, 0, sizeof(r));
  r.magic = STORE_RECORD_MAGIC;
  r.version = STORE_RECORD_V4;
  r.size = (uint16_t)sizeof(r);
  r.sequence = sequence;
  r.electrical_zero_rad = in->electrical_zero_rad;
  r.encoder_direction = (in->encoder_direction != 0U) ? 1U : 0U;
  r.calib_valid = (in->calib_valid != 0U) ? 1U : 0U;
  r.config_valid = (in->config_valid != 0U) ? 1U : 0U;
  r.config = in->config;
  r.config.zero_valid = (in->config.zero_valid != 0U) ? 1U : 0U;
  r.config.ol_en = (in->config.ol_en != 0.0f) ? 1.0f : 0.0f;
  r.crc32 = StoreRecord_Crc32((const uint8_t *)&r, offsetof(RecordV4, crc32));
  memcpy(buf, &r, sizeof(r));
  return sizeof(r);
}
