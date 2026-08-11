#include "current_sense.h"
#include "FOCBridge.h"

#define ADC_VREF_V              3.3f
#define ADC_FULL_SCALE_F        4095.0f
/* INA240 bidirectional mid-rail (REF1/REF2 = 3.3 V / 2 on this board). */
#define INA240_ZERO_DEFAULT_V   1.65f
/*
 * Board: INA240A2 + low-side shunt.
 *   A2 gain = 50 V/V  (TI datasheet)
 *   Rshunt  = 10 mΩ
 *   V/A     = Rshunt * Gain = 0.010 * 50 = 0.5 V/A
 * Bench @24V 300rpm: with QDrive phase map, measured iq had opposite sign to
 * iq_ref while shaft followed speed command → current PI saturated & bus sagged.
 * Invert sense polarity so Park iq matches the torque command axis.
 */
#define INA240_AMP_GAIN_V_PER_V 50.0f
#define INA240_SHUNT_OHM        0.010f
#define INA240_GAIN_V_PER_A     (INA240_SHUNT_OHM * INA240_AMP_GAIN_V_PER_V)
/* +1 = datasheet polarity; -1 = invert both phases (this board/FOC axis). */
#define CURRENT_SENSE_SIGN      (-1.0f)
#define BUS_DIVIDER_GAIN        11.0f
#define ADC_DMA_RANK_COUNT      3U


DMA_HandleTypeDef hdma_adc1;

static ADC_HandleTypeDef *current_adc;
/* DMA circular buffer: [0]=Ia, [1]=Ib, [2]=Vbus. Keep 4-byte aligned. */
static volatile uint16_t adc_dma_buf[4] __attribute__((aligned(4)));
static float ia_zero_v = INA240_ZERO_DEFAULT_V;
static float ib_zero_v = INA240_ZERO_DEFAULT_V;
static uint8_t configured;
static uint8_t hw_running;
static float inv_gain = 1.0f / INA240_GAIN_V_PER_A;
static float raw_to_v_scale = ADC_VREF_V / ADC_FULL_SCALE_F;
/* Count completed DMA sequences so FOC can reject stale/zero boot data. */
static volatile uint32_t sample_seq;

static void link_adc_dma(void)
{
  hdma_adc1.Instance = DMA1_Channel1;
  __HAL_LINKDMA(current_adc, DMA_Handle, hdma_adc1);
}

static float raw_to_adc_v(uint16_t raw)
{
  return ((float)raw) * raw_to_v_scale;
}

static void fill_from_raw(CurrentSenseSample_t *sample, uint16_t raw_a, uint16_t raw_b, uint16_t raw_bus)
{
  float va = raw_to_adc_v(raw_a);
  float vb = raw_to_adc_v(raw_b);

  sample->raw_a = raw_a;
  sample->raw_b = raw_b;
  sample->raw_bus = raw_bus;
  sample->ia_a = CURRENT_SENSE_SIGN * (va - ia_zero_v) * inv_gain;
  sample->ib_a = CURRENT_SENSE_SIGN * (vb - ib_zero_v) * inv_gain;
  sample->ic_a = -sample->ia_a - sample->ib_a;
  sample->bus_v = raw_to_adc_v(raw_bus) * BUS_DIVIDER_GAIN;
}

/* Reject uninitialised / stuck DMA (all zero) or impossible bus codes. */
static uint8_t raw_sample_plausible(uint16_t raw_a, uint16_t raw_b, uint16_t raw_bus)
{
  /* All-zero means DMA never filled the buffer (boot / misconfig). */
  if ((raw_a == 0U) && (raw_b == 0U) && (raw_bus == 0U))
  {
    return 0U;
  }
  /* 12-bit codes; INA mid-rail idle is ~2048, bus divider idle depends on Vbus. */
  if ((raw_a > 4095U) || (raw_b > 4095U) || (raw_bus > 4095U))
  {
    return 0U;
  }
  /* Bus sense with 11x divider: 6 V bus → ~0.545 V → raw≈677; 40 V → ~3.64 V saturates. */
  if (raw_bus < 200U)
  {
    return 0U;
  }
  return 1U;
}

static HAL_StatusTypeDef config_ranks(void)
{
  ADC_ChannelConfTypeDef config = {0};

  config.Channel = ADC_CHANNEL_1;
  config.Rank = ADC_REGULAR_RANK_1;
  config.SamplingTime = ADC_SAMPLETIME_12CYCLES_5;
  config.SingleDiff = ADC_SINGLE_ENDED;
  config.OffsetNumber = ADC_OFFSET_NONE;
  config.Offset = 0;
  if (HAL_ADC_ConfigChannel(current_adc, &config) != HAL_OK)
  {
    return HAL_ERROR;
  }

  config.Channel = ADC_CHANNEL_2;
  config.Rank = ADC_REGULAR_RANK_2;
  if (HAL_ADC_ConfigChannel(current_adc, &config) != HAL_OK)
  {
    return HAL_ERROR;
  }

  config.Channel = ADC_CHANNEL_3;
  config.Rank = ADC_REGULAR_RANK_3;
  if (HAL_ADC_ConfigChannel(current_adc, &config) != HAL_OK)
  {
    return HAL_ERROR;
  }

  return HAL_OK;
}

static HAL_StatusTypeDef apply_adc_common(uint32_t external_trig, uint32_t trig_edge,
                                          FunctionalState dma_cont, uint32_t eoc_selection)
{
  current_adc->Init.ClockPrescaler = ADC_CLOCK_SYNC_PCLK_DIV4;
  current_adc->Init.Resolution = ADC_RESOLUTION_12B;
  current_adc->Init.DataAlign = ADC_DATAALIGN_RIGHT;
  current_adc->Init.GainCompensation = 0;
  current_adc->Init.ScanConvMode = ADC_SCAN_ENABLE;
  /*
   * SINGLE_CONV: software rank-by-rank poll (calibrate).
   * SEQ_CONV: DMA one-TC-per-scan (runtime FOC).
   * Old code always used SEQ_CONV while software_read_sequence() polled 3x;
   * first poll waited for whole sequence, next two timed out, zeros stayed
   * at default 1.65 V and idle Ia looked like ~-2.8 A.
   */
  current_adc->Init.EOCSelection = eoc_selection;
  current_adc->Init.LowPowerAutoWait = DISABLE;
  current_adc->Init.ContinuousConvMode = DISABLE;
  current_adc->Init.NbrOfConversion = ADC_DMA_RANK_COUNT;
  current_adc->Init.DiscontinuousConvMode = DISABLE;
  current_adc->Init.ExternalTrigConv = external_trig;
  current_adc->Init.ExternalTrigConvEdge = trig_edge;
  current_adc->Init.DMAContinuousRequests = dma_cont;
  current_adc->Init.Overrun = ADC_OVR_DATA_OVERWRITTEN;
  current_adc->Init.OversamplingMode = DISABLE;

  if (HAL_ADC_Init(current_adc) != HAL_OK)
  {
    return HAL_ERROR;
  }
  return config_ranks();
}


static HAL_StatusTypeDef software_read_one_channel(uint32_t channel, uint16_t *raw)
{
  ADC_ChannelConfTypeDef config = {0};
  uint32_t old_nconv;

  if ((current_adc == NULL) || (raw == 0))
  {
    return HAL_ERROR;
  }

  old_nconv = current_adc->Init.NbrOfConversion;
  current_adc->Init.NbrOfConversion = 1U;
  current_adc->Init.ScanConvMode = ADC_SCAN_DISABLE;
  current_adc->Init.ContinuousConvMode = DISABLE;
  current_adc->Init.ExternalTrigConv = ADC_SOFTWARE_START;
  current_adc->Init.ExternalTrigConvEdge = ADC_EXTERNALTRIGCONVEDGE_NONE;
  current_adc->Init.DMAContinuousRequests = DISABLE;
  current_adc->Init.EOCSelection = ADC_EOC_SINGLE_CONV;
  if (HAL_ADC_Init(current_adc) != HAL_OK)
  {
    current_adc->Init.NbrOfConversion = old_nconv;
    return HAL_ERROR;
  }

  config.Channel = channel;
  config.Rank = ADC_REGULAR_RANK_1;
  config.SamplingTime = ADC_SAMPLETIME_47CYCLES_5;
  config.SingleDiff = ADC_SINGLE_ENDED;
  config.OffsetNumber = ADC_OFFSET_NONE;
  config.Offset = 0;
  if (HAL_ADC_ConfigChannel(current_adc, &config) != HAL_OK)
  {
    current_adc->Init.NbrOfConversion = old_nconv;
    return HAL_ERROR;
  }

  if (HAL_ADC_Start(current_adc) != HAL_OK)
  {
    current_adc->Init.NbrOfConversion = old_nconv;
    return HAL_ERROR;
  }

  if (HAL_ADC_PollForConversion(current_adc, 10U) != HAL_OK)
  {
    (void)HAL_ADC_Stop(current_adc);
    current_adc->Init.NbrOfConversion = old_nconv;
    return HAL_TIMEOUT;
  }

  *raw = (uint16_t)HAL_ADC_GetValue(current_adc);
  (void)HAL_ADC_Stop(current_adc);
  current_adc->Init.NbrOfConversion = old_nconv;
  return HAL_OK;
}

static HAL_StatusTypeDef software_read_sequence(uint16_t *raw_a, uint16_t *raw_b, uint16_t *raw_bus)
{
  /* Prefer independent single-channel conversions (robust on G4 scan+poll). */
  if (software_read_one_channel(ADC_CHANNEL_1, raw_a) != HAL_OK)
  {
    return HAL_ERROR;
  }
  if (software_read_one_channel(ADC_CHANNEL_2, raw_b) != HAL_OK)
  {
    return HAL_ERROR;
  }
  if (software_read_one_channel(ADC_CHANNEL_3, raw_bus) != HAL_OK)
  {
    return HAL_ERROR;
  }
  return HAL_OK;
}


void CurrentSense_Init(ADC_HandleTypeDef *hadc)
{
  current_adc = hadc;
  configured = 0U;
  hw_running = 0U;
  ia_zero_v = INA240_ZERO_DEFAULT_V;
  ib_zero_v = INA240_ZERO_DEFAULT_V;
  /* Recompute if shunt/gain macros change. */
  inv_gain = 1.0f / INA240_GAIN_V_PER_A;
  adc_dma_buf[0] = 0U;
  adc_dma_buf[1] = 0U;
  adc_dma_buf[2] = 0U;
  sample_seq = 0U;
}


ADC_HandleTypeDef *CurrentSense_GetAdcHandle(void)
{
  return current_adc;
}

HAL_StatusTypeDef CurrentSense_ConfigureScan(void)
{
  if (current_adc == NULL)
  {
    return HAL_ERROR;
  }

  __HAL_RCC_DMAMUX1_CLK_ENABLE();
  __HAL_RCC_DMA1_CLK_ENABLE();

  hdma_adc1.Instance = DMA1_Channel1;
  hdma_adc1.Init.Request = DMA_REQUEST_ADC1;
  hdma_adc1.Init.Direction = DMA_PERIPH_TO_MEMORY;
  hdma_adc1.Init.PeriphInc = DMA_PINC_DISABLE;
  hdma_adc1.Init.MemInc = DMA_MINC_ENABLE;
  hdma_adc1.Init.PeriphDataAlignment = DMA_PDATAALIGN_HALFWORD;
  hdma_adc1.Init.MemDataAlignment = DMA_MDATAALIGN_HALFWORD;
  hdma_adc1.Init.Mode = DMA_CIRCULAR;
  hdma_adc1.Init.Priority = DMA_PRIORITY_VERY_HIGH;
  if (HAL_DMA_Init(&hdma_adc1) != HAL_OK)
  {
    return HAL_ERROR;
  }
  link_adc_dma();

  /* DMA TC IRQ: fires once per completed 3-channel sequence. */
  HAL_NVIC_SetPriority(DMA1_Channel1_IRQn, 0, 0);
  HAL_NVIC_EnableIRQ(DMA1_Channel1_IRQn);

  if (apply_adc_common(ADC_SOFTWARE_START, ADC_EXTERNALTRIGCONVEDGE_NONE, DISABLE,
                       ADC_EOC_SINGLE_CONV) != HAL_OK)
  {
    return HAL_ERROR;
  }

  (void)HAL_ADCEx_Calibration_Start(current_adc, ADC_SINGLE_ENDED);
  configured = 1U;
  hw_running = 0U;
  return HAL_OK;
}

HAL_StatusTypeDef CurrentSense_Calibrate(uint16_t samples)
{
  uint32_t sum_a = 0;
  uint32_t sum_b = 0;
  uint16_t raw_a;
  uint16_t raw_b;
  uint16_t raw_bus;
  uint16_t ok = 0U;

  if ((current_adc == NULL) || (samples == 0U) || (configured == 0U))
  {
    return HAL_ERROR;
  }

  if (hw_running != 0U)
  {
    (void)HAL_ADC_Stop_DMA(current_adc);
    hw_running = 0U;
  }

  for (uint16_t i = 0; i < samples; ++i)
  {
    if (software_read_sequence(&raw_a, &raw_b, &raw_bus) != HAL_OK)
    {
      continue;
    }
    sum_a += raw_a;
    sum_b += raw_b;
    ok++;
  }

  if (ok == 0U)
  {
    return HAL_ERROR;
  }

  ia_zero_v = raw_to_adc_v((uint16_t)(sum_a / ok));
  ib_zero_v = raw_to_adc_v((uint16_t)(sum_b / ok));

  /* Guard against failed/shorted sense lines producing nonsense zeros. */
  if ((ia_zero_v < 0.5f) || (ia_zero_v > 2.8f))
  {
    ia_zero_v = INA240_ZERO_DEFAULT_V;
  }
  if ((ib_zero_v < 0.5f) || (ib_zero_v > 2.8f))
  {
    ib_zero_v = INA240_ZERO_DEFAULT_V;
  }

  /* Restore 3-rank software config (DMA path reconfigures again in StartHw). */
  (void)apply_adc_common(ADC_SOFTWARE_START, ADC_EXTERNALTRIGCONVEDGE_NONE, DISABLE,
                         ADC_EOC_SINGLE_CONV);
  return HAL_OK;
}


HAL_StatusTypeDef CurrentSense_StartHw(void)
{
  if ((current_adc == NULL) || (configured == 0U))
  {
    return HAL_ERROR;
  }

  if (hw_running != 0U)
  {
    return HAL_OK;
  }

  /*
   * TIM1 CH4 (PWM1, small CCR) → OC4REF rising near PWM valley once/period
   * → TRGO2=OC4REF → ADC regular sequence → DMA circular → ConvCplt → FOC.
   * SEQ_CONV is correct for DMA (one TC per full scan).
   */
  if (apply_adc_common(ADC_EXTERNALTRIG_T1_TRGO2, ADC_EXTERNALTRIGCONVEDGE_RISING, ENABLE,
                       ADC_EOC_SEQ_CONV) != HAL_OK)
  {
    return HAL_ERROR;
  }

  /* ADC_Init can leave DMA linkage stale — re-bind every StartHw. */
  link_adc_dma();

  adc_dma_buf[0] = 0U;
  adc_dma_buf[1] = 0U;
  adc_dma_buf[2] = 0U;
  adc_dma_buf[3] = 0U;
  sample_seq = 0U;

  if (current_adc->DMA_Handle != &hdma_adc1)
  {
    return HAL_ERROR;
  }

  if (HAL_ADC_Start_DMA(current_adc, (uint32_t *)(void *)adc_dma_buf, ADC_DMA_RANK_COUNT) != HAL_OK)
  {
    return HAL_ERROR;
  }

  /*
   * Force destination address. Observed field failure: CMAR pointed into
   * hdma_adc1 (.bss) instead of adc_dma_buf, so FOC always saw zero current
   * while PI saturated → violent jitter / no rotation.
   */
  hdma_adc1.Instance->CMAR = (uint32_t)(void *)adc_dma_buf;
  if (hdma_adc1.Instance->CMAR != (uint32_t)(void *)adc_dma_buf)
  {
    (void)HAL_ADC_Stop_DMA(current_adc);
    return HAL_ERROR;
  }

  hw_running = 1U;
  return HAL_OK;
}

HAL_StatusTypeDef CurrentSense_GetLatest(CurrentSenseSample_t *sample)
{
  uint16_t raw_a;
  uint16_t raw_b;
  uint16_t raw_bus;

  if ((sample == NULL) || (configured == 0U) || (hw_running == 0U))
  {
    return HAL_ERROR;
  }

  /* Need at least one completed DMA sequence after StartHw. */
  if (sample_seq == 0U)
  {
    return HAL_ERROR;
  }

  raw_a = adc_dma_buf[0];
  raw_b = adc_dma_buf[1];
  raw_bus = adc_dma_buf[2];
  if (raw_sample_plausible(raw_a, raw_b, raw_bus) == 0U)
  {
    return HAL_ERROR;
  }

  fill_from_raw(sample, raw_a, raw_b, raw_bus);
  return HAL_OK;
}

HAL_StatusTypeDef CurrentSense_StartScan(void)
{
  if (configured == 0U)
  {
    return HAL_ERROR;
  }
  return HAL_OK;
}

HAL_StatusTypeDef CurrentSense_ReadScanResult(CurrentSenseSample_t *sample)
{
  if (hw_running != 0U)
  {
    return CurrentSense_GetLatest(sample);
  }

  {
    uint16_t raw_a = 0;
    uint16_t raw_b = 0;
    uint16_t raw_bus = 0;
    if (software_read_sequence(&raw_a, &raw_b, &raw_bus) != HAL_OK)
    {
      return HAL_ERROR;
    }
    fill_from_raw(sample, raw_a, raw_b, raw_bus);
    return HAL_OK;
  }
}

HAL_StatusTypeDef CurrentSense_Read(CurrentSenseSample_t *sample)
{
  return CurrentSense_ReadScanResult(sample);
}

/*
 * DMA sequence complete = fresh Ia/Ib/Vbus available.
 * Run FOC immediately after conversion (more phase-aligned than TIM Update).
 */
void HAL_ADC_ConvCpltCallback(ADC_HandleTypeDef *hadc)
{
  if ((current_adc != 0) && (hadc == current_adc) && (hw_running != 0U))
  {
    sample_seq++;
    FOC_OnPwmUpdate();
  }
}
