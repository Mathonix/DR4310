#include "calibration_store.h"

#include "stm32g4xx_hal.h"

#include <stddef.h>
#include <string.h>

static int sequence_after(uint32_t lhs, uint32_t rhs) {
  return (int32_t)(lhs - rhs) > 0;
}

static int read_slot(uint32_t address, StoreImage *image) {
  return StoreRecord_Decode((const uint8_t *)(uintptr_t)address, STORE_RECORD_MAX_BYTES, image);
}

static int newest_record(StoreImage *newest, uint32_t *newest_slot) {
  StoreImage candidate;
  const int valid0 = read_slot(CALIBRATION_STORE_SLOT0_ADDRESS, newest);
  const int valid1 = read_slot(CALIBRATION_STORE_SLOT1_ADDRESS, &candidate);
  if (!valid0 && !valid1) {
    return 0;
  }
  if (valid1 && (!valid0 || sequence_after(candidate.sequence, newest->sequence))) {
    *newest = candidate;
    *newest_slot = 1U;
  } else {
    *newest_slot = 0U;
  }
  return 1;
}

int StoreImage_Load(StoreImage *image) {
  uint32_t slot = 0U;
  if (image == NULL) {
    return 0;
  }
  return newest_record(image, &slot);
}

int StoreImage_Save(const StoreImage *image, uint32_t *saved_sequence) {
  StoreImage previous;
  uint8_t record[STORE_RECORD_MAX_BYTES];
  uint32_t previous_slot = 1U;
  uint32_t page_error = 0U;
  FLASH_EraseInitTypeDef erase = {0};

  if (image == NULL) {
    return 0;
  }
  const int have_previous = newest_record(&previous, &previous_slot);
  const uint32_t target_slot = have_previous ? (previous_slot ^ 1U) : 0U;
  const uint32_t target_address = target_slot ? CALIBRATION_STORE_SLOT1_ADDRESS
                                              : CALIBRATION_STORE_SLOT0_ADDRESS;
  const uint32_t sequence = have_previous ? previous.sequence + 1U : 1U;
  if (StoreRecord_Encode(image, sequence, record, sizeof(record)) != sizeof(record)) {
    return 0;
  }

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
    memcpy(&double_word, record + offset, 8U);
    if (HAL_FLASH_Program(FLASH_TYPEPROGRAM_DOUBLEWORD,
                          target_address + offset, double_word) != HAL_OK) {
      (void)HAL_FLASH_Lock();
      return 0;
    }
  }
  (void)HAL_FLASH_Lock();

  if ((memcmp((const void *)(uintptr_t)target_address, record, sizeof(record)) != 0) ||
      !read_slot(target_address, &previous) || (previous.sequence != sequence)) {
    return 0;
  }
  if (saved_sequence != NULL) {
    *saved_sequence = sequence;
  }
  return 1;
}

int CalibrationStore_Load(CalibrationStoreData *data) {
  StoreImage image;
  if ((data == NULL) || !StoreImage_Load(&image) || (image.calib_valid == 0U)) {
    return 0;
  }
  data->electrical_zero_rad = image.electrical_zero_rad;
  data->encoder_direction = image.encoder_direction;
  data->sequence = image.sequence;
  return 1;
}

int CalibrationStore_Save(const CalibrationStoreData *data,
                          uint32_t *saved_sequence) {
  StoreImage image;
  if (data == NULL) {
    return 0;
  }
  if (!StoreImage_Load(&image)) {
    memset(&image, 0, sizeof(image));
  }
  /* Keep whatever config is already persisted; only calibration changes. */
  image.calib_valid = 1U;
  image.electrical_zero_rad = data->electrical_zero_rad;
  image.encoder_direction = data->encoder_direction;
  /* Keep ENC_DIR in step with the measured direction so the next boot, which
   * applies ENC_DIR on top of this record, does not undo the calibration. */
  if (image.config_valid != 0U) {
    image.config.enc_dir = (data->encoder_direction != 0U) ? 1U : 0U;
    image.config.cog_en = 0.0f;
    image.config.cogging.valid = 0U;
  }
  return StoreImage_Save(&image, saved_sequence);
}
