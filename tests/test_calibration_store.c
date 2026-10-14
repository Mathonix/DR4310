/* Actual redundant-page code, with flash emulated in process-local memory. */
#if defined(_WIN32) || defined(__CYGWIN__)
#include <windows.h>
#else
#include <sys/mman.h>
#endif
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "stm32g4xx_hal.h"
#include "calibration_store.h"

static int fail_program_at = -1, program_count;
HAL_StatusTypeDef HAL_FLASH_Unlock(void) { return HAL_OK; }
HAL_StatusTypeDef HAL_FLASH_Lock(void) { return HAL_OK; }
HAL_StatusTypeDef HAL_FLASHEx_Erase(FLASH_EraseInitTypeDef *erase, uint32_t *error) {
  const uintptr_t address = FLASH_BASE + erase->Page * FLASH_PAGE_SIZE;
  assert(erase->NbPages == 1);
  assert(address == CALIBRATION_STORE_SLOT0_ADDRESS || address == CALIBRATION_STORE_SLOT1_ADDRESS);
  memset((void *)address, 0xff, FLASH_PAGE_SIZE);
  *error = 0; program_count = 0;
  return HAL_OK;
}
HAL_StatusTypeDef HAL_FLASH_Program(uint32_t type, uint32_t address, uint64_t data) {
  (void)type;
  assert(address >= CALIBRATION_STORE_SLOT0_ADDRESS && address + 8 <= CALIBRATION_STORE_SLOT1_ADDRESS + FLASH_PAGE_SIZE);
  assert((address % 8) == 0);
  if (program_count++ == fail_program_at) return HAL_ERROR;
  memcpy((void *)(uintptr_t)address, &data, 8);
  return HAL_OK;
}
int main(void) {
  void *const requested = (void *)(uintptr_t)0x08010000;
#if defined(_WIN32) || defined(__CYGWIN__)
  void *memory = VirtualAlloc(requested, 0x10000, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
#else
  void *memory = mmap(requested, 0x10000, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
#endif
  assert(memory == requested); // Allocation must not overlay an occupied mapping.
  memset(memory, 0xff, 0x10000);
  StoreImage in = {0}, out;
  uint32_t sequence;
  assert(!StoreImage_Load(&out));
  in.calib_valid = 1; in.config_valid = 1;
  in.electrical_zero_rad = .13f; in.encoder_direction = 1;
  in.config.can_id = 5; in.config.pos_vff = .5f; in.config.cog_en = 1;
  in.config.cogging.valid = 1; in.config.cogging.encoder_direction = 1;
  in.config.cogging.pole_pairs = 14; in.config.cogging.electrical_zero_rad = .13f;
  for (int i = 0; i < (int)COGGING_TABLE_SIZE; ++i) in.config.cogging.current_ma[i] = (int16_t)(i - 256);
  assert(StoreImage_Save(&in, &sequence) && sequence == 1);
  assert(StoreImage_Load(&out) && out.version == 6 && out.sequence == 1);
  assert(!memcmp(&out.config, &in.config, sizeof(in.config)));
  in.config.cog_gain = .5f;
  assert(StoreImage_Save(&in, &sequence) && sequence == 2);
  assert(StoreImage_Load(&out) && out.sequence == 2 && out.config.cog_gain == .5f);
  fail_program_at = 17; in.config.cog_gain = .2f;
  assert(!StoreImage_Save(&in, &sequence));
  assert(StoreImage_Load(&out) && out.sequence == 2 && out.config.cog_gain == .5f);
  fail_program_at = -1;
  assert(StoreImage_Save(&in, &sequence) && sequence == 3);
  assert(StoreImage_Load(&out) && out.sequence == 3 && out.config.cog_gain == .2f);
  CalibrationStoreData calibration = {.electrical_zero_rad = .15f, .encoder_direction = 0};
  assert(CalibrationStore_Save(&calibration, &sequence) && sequence == 4);
  assert(StoreImage_Load(&out) && out.electrical_zero_rad == .15f && out.encoder_direction == 0);
  assert(out.config.can_id == 5 && out.config.pos_vff == .5f && out.config.enc_dir == 0);
  assert(out.config.cog_en == 0 && out.config.cogging.valid == 0);
#if defined(_WIN32) || defined(__CYGWIN__)
  assert(VirtualFree(memory, 0, MEM_RELEASE));
#else
  assert(munmap(memory, 0x10000) == 0);
#endif
  puts("real flash-store round trip, interrupted programming and recalibration invalidation passed");
}
