#include "HardwareBridge.h"

extern "C" void HAL_ADC_ConvCpltCallback(ADC_HandleTypeDef *hadc) {
  CurrentSense_OnAdcComplete(hadc);
}
