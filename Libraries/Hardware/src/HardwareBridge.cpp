#include "HardwareBridge.h"

#include "MT6701.hpp"

extern "C" void HAL_ADC_ConvCpltCallback(ADC_HandleTypeDef *hadc) {
  CurrentSense_OnAdcComplete(hadc);
}

extern "C" void HAL_SPI_TxRxCpltCallback(SPI_HandleTypeDef *hspi) {
  hardware::MT6701::NotifyDmaComplete(hspi);
}

extern "C" void HAL_SPI_ErrorCallback(SPI_HandleTypeDef *hspi) {
  hardware::MT6701::NotifyDmaError(hspi);
}
