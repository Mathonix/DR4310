#include "calibration_store.h"

#include "stm32g4xx_hal.h"

#include <math.h>
#include <stddef.h>
#include <string.h>

#define CALIBRATION_MAGIC 0x43414C31UL /* "CAL1" */
#define CALIBRATION_VERSION 1U
#define CALIBRATION_TWO_PI 6.2831853071795864769f

typedef struct {
  uint32_t magic;
  uint16_t version;
  uint16_t size;
  uint32_t sequence;
  float electrical_zero_rad;
  uint8_t encoder_direction;
  uint8_t reserved[3];
  uint32_t crc32;
} CalibrationRecord;

typedef char CalibrationRecordMustBe24Bytes[(sizeof(CalibrationRecord) == 24U) ? 1 : -1];

static uint32_t crc32_bytes(const uint8_t *data, size_t length) {
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

static void read_record(uint32_t address, CalibrationRecord *record) {
  memcpy(record, (const void *)address, sizeof(*record));
}

static int record_valid(const CalibrationRecord *record) {
  if ((record->magic != CALIBRATION_MAGIC) ||
      (record->version != CALIBRATION_VERSION) ||
      (record->size != sizeof(*record)) ||
      (record->encoder_direction > 1U) ||
      !isfinite(record->electrical_zero_rad) ||
      (record->electrical_zero_rad < 0.0f) ||
      (record->electrical_zero_rad >= CALIBRATION_TWO_PI)) {
    return 0;
  }
  return record->crc32 ==
         crc32_bytes((const uint8_t *)record, offsetof(CalibrationRecord, crc32));
}

static int sequence_after(uint32_t lhs, uint32_t rhs) {
  return (int32_t)(lhs - rhs) > 0;
}

static int newest_record(CalibrationRecord *newest, uint32_t *newest_slot) {
  CalibrationRecord slot0;
  CalibrationRecord slot1;
  read_record(CALIBRATION_STORE_SLOT0_ADDRESS, &slot0);
  read_record(CALIBRATION_STORE_SLOT1_ADDRESS, &slot1);
  const int valid0 = record_valid(&slot0);
  const int valid1 = record_valid(&slot1);
  if (!valid0 && !valid1) {
    return 0;
  }
  if (valid1 && (!valid0 || sequence_after(slot1.sequence, slot0.sequence))) {
    *newest = slot1;
    *newest_slot = 1U;
  } else {
    *newest = slot0;
    *newest_slot = 0U;
  }
  return 1;
}

int CalibrationStore_Load(CalibrationStoreData *data) {
  CalibrationRecord record;
  uint32_t slot = 0U;
  if ((data == NULL) || !newest_record(&record, &slot)) {
    return 0;
  }
  (void)slot;
  data->electrical_zero_rad = record.electrical_zero_rad;
  data->encoder_direction = record.encoder_direction;
  data->sequence = record.sequence;
  return 1;
}

int CalibrationStore_Save(const CalibrationStoreData *data,
                          uint32_t *saved_sequence) {
  CalibrationRecord previous;
  CalibrationRecord record;
  CalibrationRecord verify;
  uint32_t previous_slot = 1U;
  uint32_t target_slot;
  uint32_t target_address;
  uint32_t page_error = 0U;
  FLASH_EraseInitTypeDef erase = {0};

  if ((data == NULL) || !isfinite(data->electrical_zero_rad) ||
      (data->electrical_zero_rad < 0.0f) ||
      (data->electrical_zero_rad >= CALIBRATION_TWO_PI) ||
      (data->encoder_direction > 1U)) {
    return 0;
  }

  const int have_previous = newest_record(&previous, &previous_slot);
  target_slot = have_previous ? (previous_slot ^ 1U) : 0U;
  target_address = target_slot ? CALIBRATION_STORE_SLOT1_ADDRESS
                               : CALIBRATION_STORE_SLOT0_ADDRESS;

  memset(&record, 0, sizeof(record));
  record.magic = CALIBRATION_MAGIC;
  record.version = CALIBRATION_VERSION;
  record.size = sizeof(record);
  record.sequence = have_previous ? previous.sequence + 1U : 1U;
  record.electrical_zero_rad = data->electrical_zero_rad;
  record.encoder_direction = data->encoder_direction;
  record.crc32 =
      crc32_bytes((const uint8_t *)&record, offsetof(CalibrationRecord, crc32));

  if (HAL_FLASH_Unlock() != HAL_OK) {
    return 0;
  }
  __HAL_FLASH_CLEAR_FLAG(FLASH_FLAG_ALL_ERRORS);
  erase.TypeErase = FLASH_TYPEERASE_PAGES;
  erase.Banks = FLASH_BANK_1;
  erase.Page = (target_address - FLASH_BASE) / FLASH_PAGE_SIZE;
  erase.NbPages = 1U;
  if (HAL_FLASHEx_Erase(&erase, &page_error) != HAL_OK) {
    (void)HAL_FLASH_Lock();
    return 0;
  }

  for (uint32_t offset = 0U; offset < sizeof(record); offset += 8U) {
    uint64_t double_word = 0U;
    memcpy(&double_word, ((const uint8_t *)&record) + offset, 8U);
    if (HAL_FLASH_Program(FLASH_TYPEPROGRAM_DOUBLEWORD,
                          target_address + offset, double_word) != HAL_OK) {
      (void)HAL_FLASH_Lock();
      return 0;
    }
  }
  (void)HAL_FLASH_Lock();

  read_record(target_address, &verify);
  if (!record_valid(&verify) ||
      (memcmp(&verify, &record, sizeof(record)) != 0)) {
    return 0;
  }
  if (saved_sequence != NULL) {
    *saved_sequence = record.sequence;
  }
  return 1;
}
