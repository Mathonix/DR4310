/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file           : main.c
  * @brief          : Main program body
  ******************************************************************************
  * @attention
  *
  * Copyright (c) 2026 STMicroelectronics.
  * All rights reserved.
  *
  * This software is licensed under terms that can be found in the LICENSE file
  * in the root directory of this software component.
  * If no LICENSE file comes with this software, it is provided AS-IS.
  *
  ******************************************************************************
  */
/* USER CODE END Header */
/* Includes ------------------------------------------------------------------*/
#include "main.h"

/* Private includes ----------------------------------------------------------*/
/* USER CODE BEGIN Includes */
#include "control_app.h"
#include <string.h>

/* USER CODE END Includes */

/* Private typedef -----------------------------------------------------------*/
/* USER CODE BEGIN PTD */

/* USER CODE END PTD */

/* Private define ------------------------------------------------------------*/
/* USER CODE BEGIN PD */
#define WS2812_LED_COUNT        1U
#define WS2812_BITS_PER_LED     24U
#define WS2812_SPI_BITS_PER_BIT 3U
#define WS2812_FRAME_BYTES      ((WS2812_LED_COUNT * WS2812_BITS_PER_LED * WS2812_SPI_BITS_PER_BIT) / 8U)
#define WS2812_RESET_BYTES      80U
#define WS2812_CODE_0           0x4U
#define WS2812_CODE_1           0x6U
#define INA240_CHANNEL_COUNT    3U
#define ADC_VREF_MV             3300U
#define ADC_FULL_SCALE          4095U
#define INA240_A_INDEX          0U
#define INA240_B_INDEX          1U
#define VSUPPLY_INDEX           2U
#define MT6701_CS_GPIO_Port     GPIOA
#define MT6701_CS_Pin           GPIO_PIN_15
#define MT6701_FRAME_BYTES      3U
#define MT6701_RESOLUTION       16384U
#define VOFA_JUSTFLOAT_TAIL_0   0x00U
#define VOFA_JUSTFLOAT_TAIL_1   0x00U
#define VOFA_JUSTFLOAT_TAIL_2   0x80U
#define VOFA_JUSTFLOAT_TAIL_3   0x7FU
#define CAN_TEST_ID             0x001U
#define CAN_CONTROL_BASE_ID     0x100U
#define CAN_STATUS_BASE_ID      0x180U
#define CAN_TEST_TX_PERIOD_MS   100U
#define CAN_TEST_DLC            FDCAN_DLC_BYTES_8
#define CAN_CMD_DISABLE         0x00U
#define CAN_CMD_CURRENT         0x01U
#define CAN_CMD_SPEED           0x02U
#define CAN_CMD_ESTOP           0x03U
#define CAN_CMD_SET_PID         0x04U
#define CAN_CMD_POSITION        0x05U
#define CAN_CMD_MIT             0x06U
#define CAN_CMD_SET_MODE        0x07U
#define CAN_PID_CURRENT_KP      0x01U
#define CAN_PID_CURRENT_KI      0x02U
#define CAN_PID_CURRENT_LIMIT   0x03U
#define CAN_PID_POS_KP          0x04U
#define CAN_PID_POS_KD          0x05U
#define CAN_PID_MIT_KP          0x06U
#define CAN_PID_MIT_KD          0x07U
#define CAN_PID_POS_KI          0x08U
#define CAN_PID_POS_ISEP        0x09U
#define CAN_MODE_DISABLED       0x00U
#define CAN_MODE_CURRENT        0x01U
#define CAN_MODE_SPEED          0x02U
#define CAN_MODE_POSITION       0x03U
#define CAN_MODE_MIT            0x04U
#define CAN_CURRENT_LIMIT_A     2.50f
#define CAN_SPEED_LIMIT_RPM     500.0f
#define CAN_POSITION_LIMIT_RAD  500.0f
/* Cheetah-style MIT packed ranges (shared with host tools). */
#define MIT_P_MIN               (-50.0f)
#define MIT_P_MAX               (50.0f)
#define MIT_V_MIN               (-50.0f)
#define MIT_V_MAX               (50.0f)
#define MIT_KP_MIN              (0.0f)
#define MIT_KP_MAX              (500.0f)
#define MIT_KD_MIN              (0.0f)
#define MIT_KD_MAX              (5.0f)
#define MIT_T_MIN               (-2.50f)
#define MIT_T_MAX               (2.50f)
#define RPM_TO_RAD_S            0.10471975512f
#define RAD_S_TO_RPM            9.54929658551f
#define FAULT_BUS_UNDERVOLT     0x00000008UL
#define LED_BLINK_STEP_MS       500U
#define LED_GROUP_PAUSE_MS      1000U
#define LED_ON_TIME_MS          120U
#define LED_MAX_BLINK_ID        10U
#define BOARD_TEST_MODE         0U
#define BOARD_TEST_REPORT_MS    100U
#define BOARD_TEST_SAMPLE_MS    100U
#define BOARD_TEST_FLAG_WS2812  0x00000001UL
#define BOARD_TEST_FLAG_DRV     0x00000002UL
#define BOARD_TEST_FLAG_INA240  0x00000004UL
#define BOARD_TEST_FLAG_MT6701  0x00000008UL
#define BOARD_TEST_FLAG_CAN     0x00000010UL
#define BOARD_TEST_FLAG_PWM     0x00000020UL
#define CAN_RX_GPIO_DIAG_MODE   0U

/* USER CODE END PD */

/* Private macro -------------------------------------------------------------*/
/* USER CODE BEGIN PM */

/* USER CODE END PM */

/* Private variables ---------------------------------------------------------*/
ADC_HandleTypeDef hadc1;

FDCAN_HandleTypeDef hfdcan1;

SPI_HandleTypeDef hspi1;
SPI_HandleTypeDef hspi3;

TIM_HandleTypeDef htim1;

UART_HandleTypeDef huart1;

/* USER CODE BEGIN PV */
static uint8_t ws2812_frame[WS2812_FRAME_BYTES];
static uint8_t ws2812_reset[WS2812_RESET_BYTES];
volatile uint16_t ina240_adc_raw[INA240_CHANNEL_COUNT];
volatile uint16_t ina240_adc_mv[INA240_CHANNEL_COUNT];
volatile uint32_t ina240_sample_count;
volatile HAL_StatusTypeDef ina240_last_status;
volatile uint16_t ina240_a_mv;
volatile uint16_t ina240_b_mv;
volatile uint16_t vsupply_sense_mv;
volatile uint8_t mt6701_rx[MT6701_FRAME_BYTES];
volatile uint16_t mt6701_angle_raw;
volatile uint16_t mt6701_angle_cdeg;
volatile uint8_t mt6701_status;
volatile uint8_t mt6701_crc;
volatile uint32_t mt6701_sample_count;
volatile HAL_StatusTypeDef mt6701_last_status;
volatile float mt6701_angle_deg;
volatile uint32_t vofa_tx_count;
volatile HAL_StatusTypeDef vofa_last_status;
volatile HAL_StatusTypeDef can_test_status;
volatile uint32_t can_test_tx_count;
volatile uint32_t can_test_rx_count;
volatile uint32_t can_test_error;
volatile uint32_t can_test_rx_id;
volatile uint8_t can_test_rx_data[8];
volatile uint32_t can_test_last_tick;
volatile uint32_t can_test_rx_dlc;
volatile uint32_t can_test_protocol_lec;
volatile uint32_t can_test_protocol_activity;
volatile uint32_t can_test_protocol_bus_off;
volatile uint32_t can_test_protocol_error_warning;
volatile uint32_t can_test_protocol_error_passive;
volatile uint32_t can_test_tx_error_count;
volatile uint32_t can_test_rx_error_count;
volatile uint8_t can_node_id = 2U;
volatile uint8_t can_control_mode;
volatile uint8_t can_control_last_cmd;
volatile uint32_t can_control_rx_count;
volatile float can_control_target;
volatile HAL_StatusTypeDef ws2812_last_status;
volatile uint32_t ws2812_update_count;
volatile uint32_t board_test_pass_flags;
volatile uint32_t board_test_fail_flags;
volatile uint32_t board_test_run_count;
volatile uint32_t board_test_report_count;
volatile uint8_t board_test_motor_position_step_enable;
volatile uint16_t board_test_vbus_mv;
volatile uint8_t board_test_mt6701_magnet_warning;
volatile uint32_t can_rx_gpio_diag_samples;
volatile uint32_t can_rx_gpio_diag_edges;
volatile uint8_t can_rx_gpio_diag_level;

/* USER CODE END PV */

/* Private function prototypes -----------------------------------------------*/
void SystemClock_Config(void);
static void MX_GPIO_Init(void);
static void MX_ADC1_Init(void);
static void MX_FDCAN1_Init(void);
static void MX_SPI1_Init(void);
static void MX_TIM1_Init(void);
static void MX_USART1_UART_Init(void);
static void MX_SPI3_Init(void);
/* USER CODE BEGIN PFP */
static void Board_SelfTest(void);
static void DRV8313_StartSafe(void);
static GPIO_PinState DRV8313_ReadFault(void);
static void INA240_SampleAll(void);
static HAL_StatusTypeDef INA240_ReadChannel(uint32_t channel, uint16_t *raw);
static void MT6701_CS_Init(void);
static void MT6701_Sample(void);
static HAL_StatusTypeDef MT6701_ReadSSI(uint16_t *angle_raw, uint8_t *status);
static void VOFA_SendMT6701Angle(void);
static HAL_StatusTypeDef VOFA_SendJustFloat1(float value);
static void CAN_ExternalDebugInit(void);
static void CAN_ExternalDebugUpdate(void);
static void CAN_ApplyControlFrame(uint32_t id, const uint8_t *data);
static void CAN_SendStatusFrame(uint8_t mode, uint8_t fault_flags);
static float CAN_UintToFloat(uint16_t x_int, float x_min, float x_max, uint8_t bits);
static void CAN_UnpackMit(const uint8_t *data, float *pos, float *vel, float *kp, float *kd, float *iq_ff);
static void LED_BootRainbow(void);
static void LED_StatusUpdate(void);
static HAL_StatusTypeDef WS2812_SetRGB(uint8_t red, uint8_t green, uint8_t blue);
static void BoardTest_Init(void);
static void BoardTest_Update(void);
static void BoardTest_Report(void);
static HAL_StatusTypeDef BoardTest_SendVofa(void);
static void BoardTest_SetPass(uint32_t flag, uint8_t passed);
static void CAN_RxGpioDiagInit(void);
static void CAN_RxGpioDiagUpdate(void);

/* USER CODE END PFP */

/* Private user code ---------------------------------------------------------*/
/* USER CODE BEGIN 0 */

/* USER CODE END 0 */

/**
  * @brief  The application entry point.
  * @retval int
  */
int main(void)
{

  /* USER CODE BEGIN 1 */

  /* USER CODE END 1 */

  /* MCU Configuration--------------------------------------------------------*/

  /* Reset of all peripherals, Initializes the Flash interface and the Systick. */
  HAL_Init();

  /* USER CODE BEGIN Init */

  /* USER CODE END Init */

  /* Configure the system clock */
  SystemClock_Config();

  /* USER CODE BEGIN SysInit */

  /* USER CODE END SysInit */

  /* Initialize all configured peripherals */
  MX_GPIO_Init();
  MX_ADC1_Init();
  MX_FDCAN1_Init();
  MX_SPI1_Init();
  MX_TIM1_Init();
  MX_USART1_UART_Init();
  MX_SPI3_Init();
  /* USER CODE BEGIN 2 */
  // if (can_node_id == 0U)
  // {
  //   can_node_id = 2U;
  // }
  if (control_open_loop_voltage_v <= 0.0f)
  {
    control_open_loop_voltage_v = 0.8f;
  }
#if CAN_RX_GPIO_DIAG_MODE
  CAN_RxGpioDiagInit();
#elif BOARD_TEST_MODE
  BoardTest_Init();
#else
  CAN_ExternalDebugInit();
  ControlApp_Init(&hadc1, &hspi3, &htim1, &huart1);
#endif
  LED_BootRainbow();
  LED_StatusUpdate();

  /* USER CODE END 2 */

  /* Infinite loop */
  /* USER CODE BEGIN WHILE */
  while (1)
  {
    /* USER CODE END WHILE */

    /* USER CODE BEGIN 3 */
#if CAN_RX_GPIO_DIAG_MODE
    CAN_RxGpioDiagUpdate();
#elif BOARD_TEST_MODE
    BoardTest_Update();
#else
    CAN_ExternalDebugUpdate();
    ControlApp_Update();
    LED_StatusUpdate();
#endif
  }
  /* USER CODE END 3 */
}

/**
  * @brief System Clock Configuration
  * @retval None
  */
void SystemClock_Config(void)
{
  RCC_OscInitTypeDef RCC_OscInitStruct = {0};
  RCC_ClkInitTypeDef RCC_ClkInitStruct = {0};

  /** Configure the main internal regulator output voltage
  */
  HAL_PWREx_ControlVoltageScaling(PWR_REGULATOR_VOLTAGE_SCALE1_BOOST);

  /** Initializes the RCC Oscillators according to the specified parameters
  * in the RCC_OscInitTypeDef structure.
  */
  RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_HSI;
  RCC_OscInitStruct.HSIState = RCC_HSI_ON;
  RCC_OscInitStruct.HSICalibrationValue = RCC_HSICALIBRATION_DEFAULT;
  RCC_OscInitStruct.PLL.PLLState = RCC_PLL_ON;
  RCC_OscInitStruct.PLL.PLLSource = RCC_PLLSOURCE_HSI;
  RCC_OscInitStruct.PLL.PLLM = RCC_PLLM_DIV4;
  RCC_OscInitStruct.PLL.PLLN = 85;
  RCC_OscInitStruct.PLL.PLLP = RCC_PLLP_DIV2;
  RCC_OscInitStruct.PLL.PLLQ = RCC_PLLQ_DIV2;
  RCC_OscInitStruct.PLL.PLLR = RCC_PLLR_DIV2;
  if (HAL_RCC_OscConfig(&RCC_OscInitStruct) != HAL_OK)
  {
    Error_Handler();
  }

  /** Initializes the CPU, AHB and APB buses clocks
  */
  RCC_ClkInitStruct.ClockType = RCC_CLOCKTYPE_HCLK|RCC_CLOCKTYPE_SYSCLK
                              |RCC_CLOCKTYPE_PCLK1|RCC_CLOCKTYPE_PCLK2;
  RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
  RCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV1;
  RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV1;
  RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV1;

  if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_4) != HAL_OK)
  {
    Error_Handler();
  }
}

/**
  * @brief ADC1 Initialization Function
  * @param None
  * @retval None
  */
static void MX_ADC1_Init(void)
{

  /* USER CODE BEGIN ADC1_Init 0 */

  /* USER CODE END ADC1_Init 0 */

  ADC_MultiModeTypeDef multimode = {0};
  ADC_ChannelConfTypeDef sConfig = {0};

  /* USER CODE BEGIN ADC1_Init 1 */

  /* USER CODE END ADC1_Init 1 */

  /** Common config
  */
  hadc1.Instance = ADC1;
  hadc1.Init.ClockPrescaler = ADC_CLOCK_SYNC_PCLK_DIV4;
  hadc1.Init.Resolution = ADC_RESOLUTION_12B;
  hadc1.Init.DataAlign = ADC_DATAALIGN_RIGHT;
  hadc1.Init.GainCompensation = 0;
  /* Initial Cube config; CurrentSense_ConfigureScan/StartHw reconfigures for DMA+TRGO. */
  hadc1.Init.ScanConvMode = ADC_SCAN_ENABLE;
  hadc1.Init.EOCSelection = ADC_EOC_SEQ_CONV;
  hadc1.Init.LowPowerAutoWait = DISABLE;
  hadc1.Init.ContinuousConvMode = DISABLE;
  hadc1.Init.NbrOfConversion = 3;
  hadc1.Init.DiscontinuousConvMode = DISABLE;
  hadc1.Init.ExternalTrigConv = ADC_SOFTWARE_START;
  hadc1.Init.ExternalTrigConvEdge = ADC_EXTERNALTRIGCONVEDGE_NONE;
  hadc1.Init.DMAContinuousRequests = DISABLE;
  hadc1.Init.Overrun = ADC_OVR_DATA_OVERWRITTEN;
  hadc1.Init.OversamplingMode = DISABLE;
  if (HAL_ADC_Init(&hadc1) != HAL_OK)
  {
    Error_Handler();
  }

  /** Configure the ADC multi-mode
  */
  multimode.Mode = ADC_MODE_INDEPENDENT;
  if (HAL_ADCEx_MultiModeConfigChannel(&hadc1, &multimode) != HAL_OK)
  {
    Error_Handler();
  }

  /** Configure Regular Channel rank 1: Ia
  */
  sConfig.Channel = ADC_CHANNEL_1;
  sConfig.Rank = ADC_REGULAR_RANK_1;
  sConfig.SamplingTime = ADC_SAMPLETIME_47CYCLES_5;
  sConfig.SingleDiff = ADC_SINGLE_ENDED;
  sConfig.OffsetNumber = ADC_OFFSET_NONE;
  sConfig.Offset = 0;
  if (HAL_ADC_ConfigChannel(&hadc1, &sConfig) != HAL_OK)
  {
    Error_Handler();
  }

  /** Configure Regular Channel rank 2: Ib
  */
  sConfig.Channel = ADC_CHANNEL_2;
  sConfig.Rank = ADC_REGULAR_RANK_2;
  if (HAL_ADC_ConfigChannel(&hadc1, &sConfig) != HAL_OK)
  {
    Error_Handler();
  }

  /** Configure Regular Channel rank 3: Vbus
  */
  sConfig.Channel = ADC_CHANNEL_3;
  sConfig.Rank = ADC_REGULAR_RANK_3;
  if (HAL_ADC_ConfigChannel(&hadc1, &sConfig) != HAL_OK)
  {
    Error_Handler();
  }
  /* USER CODE BEGIN ADC1_Init 2 */

  /* USER CODE END ADC1_Init 2 */

}

/**
  * @brief FDCAN1 Initialization Function
  * @param None
  * @retval None
  */
static void MX_FDCAN1_Init(void)
{

  /* USER CODE BEGIN FDCAN1_Init 0 */

  /* USER CODE END FDCAN1_Init 0 */

  /* USER CODE BEGIN FDCAN1_Init 1 */

  /* USER CODE END FDCAN1_Init 1 */
  hfdcan1.Instance = FDCAN1;
  hfdcan1.Init.ClockDivider = FDCAN_CLOCK_DIV1;
  hfdcan1.Init.FrameFormat = FDCAN_FRAME_CLASSIC;
  hfdcan1.Init.Mode = FDCAN_MODE_NORMAL;
  /* DAR=0: automatic retransmission until ACK (required for reliable classic CAN). */
  hfdcan1.Init.AutoRetransmission = ENABLE;
  hfdcan1.Init.TransmitPause = DISABLE;
  hfdcan1.Init.ProtocolException = DISABLE;
  hfdcan1.Init.NominalPrescaler = 10;
  hfdcan1.Init.NominalSyncJumpWidth = 3;
  hfdcan1.Init.NominalTimeSeg1 = 13;
  hfdcan1.Init.NominalTimeSeg2 = 3;
  hfdcan1.Init.DataPrescaler = 10;
  hfdcan1.Init.DataSyncJumpWidth = 3;
  hfdcan1.Init.DataTimeSeg1 = 13;
  hfdcan1.Init.DataTimeSeg2 = 3;
  hfdcan1.Init.StdFiltersNbr = 1;
  hfdcan1.Init.ExtFiltersNbr = 0;
  hfdcan1.Init.TxFifoQueueMode = FDCAN_TX_FIFO_OPERATION;
  if (HAL_FDCAN_Init(&hfdcan1) != HAL_OK)
  {
    Error_Handler();
  }
  /* USER CODE BEGIN FDCAN1_Init 2 */

  /* USER CODE END FDCAN1_Init 2 */

}

/**
  * @brief SPI1 Initialization Function
  * @param None
  * @retval None
  */
static void MX_SPI1_Init(void)
{

  /* USER CODE BEGIN SPI1_Init 0 */

  /* USER CODE END SPI1_Init 0 */

  /* USER CODE BEGIN SPI1_Init 1 */

  /* USER CODE END SPI1_Init 1 */
  /* SPI1 parameter configuration*/
  hspi1.Instance = SPI1;
  hspi1.Init.Mode = SPI_MODE_MASTER;
  hspi1.Init.Direction = SPI_DIRECTION_2LINES;
  hspi1.Init.DataSize = SPI_DATASIZE_8BIT;
  hspi1.Init.CLKPolarity = SPI_POLARITY_LOW;
  hspi1.Init.CLKPhase = SPI_PHASE_1EDGE;
  hspi1.Init.NSS = SPI_NSS_SOFT;
  hspi1.Init.BaudRatePrescaler = SPI_BAUDRATEPRESCALER_64;
  hspi1.Init.FirstBit = SPI_FIRSTBIT_MSB;
  hspi1.Init.TIMode = SPI_TIMODE_DISABLE;
  hspi1.Init.CRCCalculation = SPI_CRCCALCULATION_DISABLE;
  hspi1.Init.CRCPolynomial = 7;
  hspi1.Init.CRCLength = SPI_CRC_LENGTH_DATASIZE;
  hspi1.Init.NSSPMode = SPI_NSS_PULSE_DISABLE;
  if (HAL_SPI_Init(&hspi1) != HAL_OK)
  {
    Error_Handler();
  }
  /* USER CODE BEGIN SPI1_Init 2 */

  /* USER CODE END SPI1_Init 2 */

}

/**
  * @brief SPI3 Initialization Function
  * @param None
  * @retval None
  */
static void MX_SPI3_Init(void)
{

  /* USER CODE BEGIN SPI3_Init 0 */

  /* USER CODE END SPI3_Init 0 */

  /* USER CODE BEGIN SPI3_Init 1 */

  /* USER CODE END SPI3_Init 1 */
  /* SPI3 parameter configuration*/
  hspi3.Instance = SPI3;
  hspi3.Init.Mode = SPI_MODE_MASTER;
  hspi3.Init.Direction = SPI_DIRECTION_2LINES;
  hspi3.Init.DataSize = SPI_DATASIZE_8BIT;
  hspi3.Init.CLKPolarity = SPI_POLARITY_LOW;
  hspi3.Init.CLKPhase = SPI_PHASE_2EDGE;
  hspi3.Init.NSS = SPI_NSS_SOFT;
  hspi3.Init.BaudRatePrescaler = SPI_BAUDRATEPRESCALER_16;
  hspi3.Init.FirstBit = SPI_FIRSTBIT_MSB;
  hspi3.Init.TIMode = SPI_TIMODE_DISABLE;
  hspi3.Init.CRCCalculation = SPI_CRCCALCULATION_DISABLE;
  hspi3.Init.CRCPolynomial = 7;
  hspi3.Init.CRCLength = SPI_CRC_LENGTH_DATASIZE;
  hspi3.Init.NSSPMode = SPI_NSS_PULSE_DISABLE;
  if (HAL_SPI_Init(&hspi3) != HAL_OK)
  {
    Error_Handler();
  }
  /* USER CODE BEGIN SPI3_Init 2 */

  /* USER CODE END SPI3_Init 2 */

}

/**
  * @brief TIM1 Initialization Function
  * @param None
  * @retval None
  */
static void MX_TIM1_Init(void)
{

  /* USER CODE BEGIN TIM1_Init 0 */

  /* USER CODE END TIM1_Init 0 */

  TIM_MasterConfigTypeDef sMasterConfig = {0};
  TIM_OC_InitTypeDef sConfigOC = {0};
  TIM_BreakDeadTimeConfigTypeDef sBreakDeadTimeConfig = {0};

  /* USER CODE BEGIN TIM1_Init 1 */

  /* USER CODE END TIM1_Init 1 */
  htim1.Instance = TIM1;
  htim1.Init.Prescaler = 0;
  /* Center-aligned: f_pwm = TIMCLK / (2*(ARR+1)) = 170M / (2*4250) = 20 kHz */
  htim1.Init.CounterMode = TIM_COUNTERMODE_CENTERALIGNED1;
  htim1.Init.Period = 4249;
  htim1.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  /* RCR=1: one Update per full up-down cycle → 20 kHz ISR (not 40 kHz). */
  htim1.Init.RepetitionCounter = 1;
  htim1.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;
  if (HAL_TIM_PWM_Init(&htim1) != HAL_OK)
  {
    Error_Handler();
  }
  sMasterConfig.MasterOutputTrigger = TIM_TRGO_UPDATE;
  /* OC4REF from CH4 compare → TRGO2 → ADC mid-window sample trigger. */
  sMasterConfig.MasterOutputTrigger2 = TIM_TRGO2_OC4REF;
  sMasterConfig.MasterSlaveMode = TIM_MASTERSLAVEMODE_DISABLE;
  if (HAL_TIMEx_MasterConfigSynchronization(&htim1, &sMasterConfig) != HAL_OK)
  {
    Error_Handler();
  }
  sConfigOC.OCMode = TIM_OCMODE_PWM1;
  sConfigOC.Pulse = 0;
  sConfigOC.OCPolarity = TIM_OCPOLARITY_HIGH;
  sConfigOC.OCNPolarity = TIM_OCNPOLARITY_HIGH;
  sConfigOC.OCFastMode = TIM_OCFAST_DISABLE;
  sConfigOC.OCIdleState = TIM_OCIDLESTATE_RESET;
  sConfigOC.OCNIdleState = TIM_OCNIDLESTATE_RESET;
  if (HAL_TIM_PWM_ConfigChannel(&htim1, &sConfigOC, TIM_CHANNEL_1) != HAL_OK)
  {
    Error_Handler();
  }
  if (HAL_TIM_PWM_ConfigChannel(&htim1, &sConfigOC, TIM_CHANNEL_2) != HAL_OK)
  {
    Error_Handler();
  }
  if (HAL_TIM_PWM_ConfigChannel(&htim1, &sConfigOC, TIM_CHANNEL_3) != HAL_OK)
  {
    Error_Handler();
  }
  /*
   * CH4 is not routed to a pin. Small CCR produces OC4REF near the PWM valley
   * once per full up-down period (with RCR=1), used only as ADC sample strobe.
   * Pulse = 80 ≈ 1.9% of ARR — mid-valley sample, clear of high-side edges.
   */
  sConfigOC.Pulse = 80;
  if (HAL_TIM_PWM_ConfigChannel(&htim1, &sConfigOC, TIM_CHANNEL_4) != HAL_OK)
  {
    Error_Handler();
  }
  sBreakDeadTimeConfig.OffStateRunMode = TIM_OSSR_DISABLE;
  sBreakDeadTimeConfig.OffStateIDLEMode = TIM_OSSI_DISABLE;
  sBreakDeadTimeConfig.LockLevel = TIM_LOCKLEVEL_OFF;
  sBreakDeadTimeConfig.DeadTime = 0;
  sBreakDeadTimeConfig.BreakState = TIM_BREAK_DISABLE;
  sBreakDeadTimeConfig.BreakPolarity = TIM_BREAKPOLARITY_HIGH;
  sBreakDeadTimeConfig.BreakFilter = 0;
  sBreakDeadTimeConfig.BreakAFMode = TIM_BREAK_AFMODE_INPUT;
  sBreakDeadTimeConfig.Break2State = TIM_BREAK2_DISABLE;
  sBreakDeadTimeConfig.Break2Polarity = TIM_BREAK2POLARITY_HIGH;
  sBreakDeadTimeConfig.Break2Filter = 0;
  sBreakDeadTimeConfig.Break2AFMode = TIM_BREAK_AFMODE_INPUT;
  sBreakDeadTimeConfig.AutomaticOutput = TIM_AUTOMATICOUTPUT_DISABLE;
  if (HAL_TIMEx_ConfigBreakDeadTime(&htim1, &sBreakDeadTimeConfig) != HAL_OK)
  {
    Error_Handler();
  }
  /* USER CODE BEGIN TIM1_Init 2 */
  __HAL_TIM_ENABLE_OCxPRELOAD(&htim1, TIM_CHANNEL_1);
  __HAL_TIM_ENABLE_OCxPRELOAD(&htim1, TIM_CHANNEL_2);
  __HAL_TIM_ENABLE_OCxPRELOAD(&htim1, TIM_CHANNEL_3);
  __HAL_TIM_ENABLE_OCxPRELOAD(&htim1, TIM_CHANNEL_4);
  /* USER CODE END TIM1_Init 2 */
  HAL_TIM_MspPostInit(&htim1);

}

/**
  * @brief USART1 Initialization Function
  * @param None
  * @retval None
  */
static void MX_USART1_UART_Init(void)
{

  /* USER CODE BEGIN USART1_Init 0 */

  /* USER CODE END USART1_Init 0 */

  /* USER CODE BEGIN USART1_Init 1 */

  /* USER CODE END USART1_Init 1 */
  huart1.Instance = USART1;
  huart1.Init.BaudRate = 115200;
  huart1.Init.WordLength = UART_WORDLENGTH_8B;
  huart1.Init.StopBits = UART_STOPBITS_1;
  huart1.Init.Parity = UART_PARITY_NONE;
  huart1.Init.Mode = UART_MODE_TX_RX;
  huart1.Init.HwFlowCtl = UART_HWCONTROL_NONE;
  huart1.Init.OverSampling = UART_OVERSAMPLING_16;
  huart1.Init.OneBitSampling = UART_ONE_BIT_SAMPLE_DISABLE;
  huart1.Init.ClockPrescaler = UART_PRESCALER_DIV1;
  huart1.AdvancedInit.AdvFeatureInit = UART_ADVFEATURE_NO_INIT;
  if (HAL_UART_Init(&huart1) != HAL_OK)
  {
    Error_Handler();
  }
  if (HAL_UARTEx_SetTxFifoThreshold(&huart1, UART_TXFIFO_THRESHOLD_1_8) != HAL_OK)
  {
    Error_Handler();
  }
  if (HAL_UARTEx_SetRxFifoThreshold(&huart1, UART_RXFIFO_THRESHOLD_1_8) != HAL_OK)
  {
    Error_Handler();
  }
  if (HAL_UARTEx_DisableFifoMode(&huart1) != HAL_OK)
  {
    Error_Handler();
  }
  /* USER CODE BEGIN USART1_Init 2 */

  /* USER CODE END USART1_Init 2 */

}

/**
  * @brief GPIO Initialization Function
  * @param None
  * @retval None
  */
static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};
  /* USER CODE BEGIN MX_GPIO_Init_1 */

  /* USER CODE END MX_GPIO_Init_1 */

  /* GPIO Ports Clock Enable */
  __HAL_RCC_GPIOF_CLK_ENABLE();
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();

  /*Configure GPIO pin Output Level */
  HAL_GPIO_WritePin(DRV_ENABLE_GPIO_Port, DRV_ENABLE_Pin, GPIO_PIN_RESET);

  /*Configure GPIO pin : DRV_ENABLE_Pin */
  GPIO_InitStruct.Pin = DRV_ENABLE_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(DRV_ENABLE_GPIO_Port, &GPIO_InitStruct);

  /*Configure GPIO pin : DRV_nFAULT_Pin */
  GPIO_InitStruct.Pin = DRV_nFAULT_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_INPUT;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  HAL_GPIO_Init(DRV_nFAULT_GPIO_Port, &GPIO_InitStruct);

  /* USER CODE BEGIN MX_GPIO_Init_2 */

  /* USER CODE END MX_GPIO_Init_2 */
}

/* USER CODE BEGIN 4 */
static void Board_SelfTest(void)
{
  DRV8313_StartSafe();
  HAL_Delay(10);

  if (DRV8313_ReadFault() == GPIO_PIN_RESET)
  {
    (void)WS2812_SetRGB(255, 0, 0);
  }
  else
  {
    (void)WS2812_SetRGB(0, 32, 0);
  }
}

static void DRV8313_StartSafe(void)
{
  (void)HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_1);
  (void)HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_2);
  (void)HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_3);

  __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_1, 0);
  __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_2, 0);
  __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_3, 0);

  HAL_GPIO_WritePin(DRV_ENABLE_GPIO_Port, DRV_ENABLE_Pin, GPIO_PIN_SET);
}

static GPIO_PinState DRV8313_ReadFault(void)
{
  return HAL_GPIO_ReadPin(DRV_nFAULT_GPIO_Port, DRV_nFAULT_Pin);
}

static void INA240_SampleAll(void)
{
  static const uint32_t channels[INA240_CHANNEL_COUNT] = {
    ADC_CHANNEL_1,
    ADC_CHANNEL_2,
    ADC_CHANNEL_3,
  };

  ina240_last_status = HAL_OK;

  for (uint32_t index = 0; index < INA240_CHANNEL_COUNT; ++index)
  {
    uint16_t raw = 0;
    HAL_StatusTypeDef status = INA240_ReadChannel(channels[index], &raw);

    if (status != HAL_OK)
    {
      ina240_last_status = status;
      return;
    }

    ina240_adc_raw[index] = raw;
    ina240_adc_mv[index] = (uint16_t)(((uint32_t)raw * ADC_VREF_MV) / ADC_FULL_SCALE);
  }

  ina240_a_mv = ina240_adc_mv[INA240_A_INDEX];
  ina240_b_mv = ina240_adc_mv[INA240_B_INDEX];
  vsupply_sense_mv = ina240_adc_mv[VSUPPLY_INDEX];
  ina240_sample_count++;
}

static HAL_StatusTypeDef INA240_ReadChannel(uint32_t channel, uint16_t *raw)
{
  ADC_ChannelConfTypeDef sConfig = {0};

  sConfig.Channel = channel;
  sConfig.Rank = ADC_REGULAR_RANK_1;
  sConfig.SamplingTime = ADC_SAMPLETIME_47CYCLES_5;
  sConfig.SingleDiff = ADC_SINGLE_ENDED;
  sConfig.OffsetNumber = ADC_OFFSET_NONE;
  sConfig.Offset = 0;

  if (HAL_ADC_ConfigChannel(&hadc1, &sConfig) != HAL_OK)
  {
    return HAL_ERROR;
  }

  if (HAL_ADC_Start(&hadc1) != HAL_OK)
  {
    return HAL_ERROR;
  }

  if (HAL_ADC_PollForConversion(&hadc1, 10U) != HAL_OK)
  {
    (void)HAL_ADC_Stop(&hadc1);
    return HAL_TIMEOUT;
  }

  *raw = (uint16_t)HAL_ADC_GetValue(&hadc1);

  return HAL_ADC_Stop(&hadc1);
}

static void MT6701_CS_Init(void)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};

  HAL_GPIO_WritePin(MT6701_CS_GPIO_Port, MT6701_CS_Pin, GPIO_PIN_SET);

  GPIO_InitStruct.Pin = MT6701_CS_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_HIGH;
  HAL_GPIO_Init(MT6701_CS_GPIO_Port, &GPIO_InitStruct);
}

static void MT6701_Sample(void)
{
  uint16_t angle_raw = 0;
  uint8_t status = 0;

  mt6701_last_status = MT6701_ReadSSI(&angle_raw, &status);
  if (mt6701_last_status == HAL_OK)
  {
    mt6701_angle_raw = angle_raw;
    mt6701_angle_cdeg = (uint16_t)(((uint32_t)angle_raw * 36000U) / MT6701_RESOLUTION);
    mt6701_angle_deg = (float)mt6701_angle_cdeg / 100.0f;
    mt6701_status = status;
    mt6701_sample_count++;
  }
}

static HAL_StatusTypeDef MT6701_ReadSSI(uint16_t *angle_raw, uint8_t *status)
{
  uint8_t tx[MT6701_FRAME_BYTES] = {0};
  uint8_t rx[MT6701_FRAME_BYTES] = {0};
  HAL_StatusTypeDef result;

  HAL_GPIO_WritePin(MT6701_CS_GPIO_Port, MT6701_CS_Pin, GPIO_PIN_RESET);
  result = HAL_SPI_TransmitReceive(&hspi3, tx, rx, MT6701_FRAME_BYTES, 10U);
  HAL_GPIO_WritePin(MT6701_CS_GPIO_Port, MT6701_CS_Pin, GPIO_PIN_SET);

  if (result != HAL_OK)
  {
    return result;
  }

  mt6701_rx[0] = rx[0];
  mt6701_rx[1] = rx[1];
  mt6701_rx[2] = rx[2];

  *angle_raw = (uint16_t)(((uint16_t)rx[0] << 6U) | ((uint16_t)rx[1] >> 2U));
  *status = (uint8_t)(((rx[1] & 0x03U) << 2U) | (rx[2] >> 6U));
  mt6701_crc = (uint8_t)(rx[2] & 0x3FU);

  return HAL_OK;
}

static void VOFA_SendMT6701Angle(void)
{
  if (mt6701_last_status != HAL_OK)
  {
    return;
  }

  vofa_last_status = VOFA_SendJustFloat1(mt6701_angle_deg);
  if (vofa_last_status == HAL_OK)
  {
    vofa_tx_count++;
  }
}

static HAL_StatusTypeDef VOFA_SendJustFloat1(float value)
{
  uint8_t frame[sizeof(float) + 4U];

  memcpy(&frame[0], &value, sizeof(float));
  frame[4] = VOFA_JUSTFLOAT_TAIL_0;
  frame[5] = VOFA_JUSTFLOAT_TAIL_1;
  frame[6] = VOFA_JUSTFLOAT_TAIL_2;
  frame[7] = VOFA_JUSTFLOAT_TAIL_3;

  return HAL_UART_Transmit(&huart1, frame, sizeof(frame), 10U);
}

static void CAN_UpdateDiagnostics(void)
{
  FDCAN_ProtocolStatusTypeDef protocol_status = {0};
  FDCAN_ErrorCountersTypeDef error_counters = {0};

  (void)HAL_FDCAN_GetProtocolStatus(&hfdcan1, &protocol_status);
  (void)HAL_FDCAN_GetErrorCounters(&hfdcan1, &error_counters);

  can_test_error = HAL_FDCAN_GetError(&hfdcan1);
  can_test_protocol_lec = protocol_status.LastErrorCode;
  can_test_protocol_activity = protocol_status.Activity;
  can_test_protocol_bus_off = protocol_status.BusOff;
  can_test_protocol_error_warning = protocol_status.Warning;
  can_test_protocol_error_passive = protocol_status.ErrorPassive;
  can_test_tx_error_count = error_counters.TxErrorCnt;
  can_test_rx_error_count = error_counters.RxErrorCnt;
}

/*
 * When no peer ACKs, AutoRetransmission keeps retrying until TEC hits
 * error-passive and the TX path stalls. Stop/Start clears pending TX and
 * error counters so a later peer can recover without power-cycling.
 * (AbortTxRequest is for dedicated Tx buffers; this driver uses TX FIFO.)
 */
static void CAN_RecoverIfNeeded(void)
{
  static uint32_t last_recover_tick;
  uint32_t now = HAL_GetTick();

  if ((can_test_protocol_bus_off == 0UL) &&
      (can_test_protocol_error_passive == 0UL) &&
      (can_test_tx_error_count < 96UL))
  {
    return;
  }

  /* Rate-limit recovery attempts. */
  if ((now - last_recover_tick) < 500U)
  {
    return;
  }
  last_recover_tick = now;

  (void)HAL_FDCAN_Stop(&hfdcan1);
  (void)HAL_FDCAN_Start(&hfdcan1);
  CAN_UpdateDiagnostics();
}

static void CAN_ExternalDebugInit(void)
{
  FDCAN_FilterTypeDef filter = {0};

  filter.IdType = FDCAN_STANDARD_ID;
  filter.FilterIndex = 0;
  filter.FilterType = FDCAN_FILTER_MASK;
  filter.FilterConfig = FDCAN_FILTER_TO_RXFIFO0;
  filter.FilterID1 = CAN_CONTROL_BASE_ID + ((can_node_id == 0U) ? CAN_TEST_ID : (uint32_t)(can_node_id & 0x7FU));
  filter.FilterID2 = 0x7FFU;

  can_test_status = HAL_FDCAN_ConfigFilter(&hfdcan1, &filter);
  if (can_test_status != HAL_OK)
  {
    CAN_UpdateDiagnostics();
    return;
  }

  can_test_status = HAL_FDCAN_ConfigGlobalFilter(&hfdcan1,
                                                 FDCAN_REJECT,
                                                 FDCAN_REJECT,
                                                 FDCAN_REJECT_REMOTE,
                                                 FDCAN_REJECT_REMOTE);
  if (can_test_status != HAL_OK)
  {
    CAN_UpdateDiagnostics();
    return;
  }

  can_test_status = HAL_FDCAN_Start(&hfdcan1);
  if (can_test_status != HAL_OK)
  {
    CAN_UpdateDiagnostics();
    return;
  }

  can_test_last_tick = HAL_GetTick();
  CAN_UpdateDiagnostics();
}

static void CAN_ExternalDebugUpdate(void)
{
  FDCAN_RxHeaderTypeDef rx_header = {0};
  uint8_t rx_data[8] = {0};
  uint32_t now = HAL_GetTick();
  const ControlTelemetry_t *control = ControlApp_GetTelemetry();
  uint8_t mode = CAN_MODE_DISABLED;

  while (HAL_FDCAN_GetRxFifoFillLevel(&hfdcan1, FDCAN_RX_FIFO0) > 0U)
  {
    can_test_status = HAL_FDCAN_GetRxMessage(&hfdcan1, FDCAN_RX_FIFO0, &rx_header, rx_data);
    if (can_test_status != HAL_OK)
    {
      CAN_UpdateDiagnostics();
      return;
    }

    can_test_rx_id = rx_header.Identifier;
    can_test_rx_dlc = rx_header.DataLength;
    memcpy((void *)can_test_rx_data, rx_data, sizeof(can_test_rx_data));
    can_test_rx_count++;
    CAN_ApplyControlFrame(rx_header.Identifier, rx_data);
  }

  if ((now - can_test_last_tick) < CAN_TEST_TX_PERIOD_MS)
  {
    CAN_UpdateDiagnostics();
    CAN_RecoverIfNeeded();
    return;
  }
  can_test_last_tick = now;

  /* Skip TX while bus is unhealthy; recovery path will restart the controller. */
  CAN_UpdateDiagnostics();
  if ((can_test_protocol_bus_off != 0UL) ||
      (can_test_protocol_error_passive != 0UL) ||
      (can_test_tx_error_count >= 96UL))
  {
    CAN_RecoverIfNeeded();
    return;
  }

  if (control_mode_cmd == CTRL_MODE_CURRENT)
  {
    mode = CAN_MODE_CURRENT;
  }
  else if (control_mode_cmd == CTRL_MODE_SPEED)
  {
    mode = CAN_MODE_SPEED;
  }
  else if (control_mode_cmd == CTRL_MODE_POSITION)
  {
    mode = CAN_MODE_POSITION;
  }
  else if (control_mode_cmd == CTRL_MODE_MIT)
  {
    mode = CAN_MODE_MIT;
  }
  else if (control_current_test_enable != 0U)
  {
    mode = CAN_MODE_CURRENT;
  }
  else if (control_enable != 0U)
  {
    mode = CAN_MODE_SPEED;
  }

  CAN_SendStatusFrame(mode, (uint8_t)(control->fault_flags & 0xFFU));
  CAN_UpdateDiagnostics();
}

static void CAN_SendStatusFrame(uint8_t mode, uint8_t fault_flags)
{
  FDCAN_TxHeaderTypeDef tx_header = {0};
  const ControlTelemetry_t *control = ControlApp_GetTelemetry();
  uint8_t tx_data[8] = {0};
  float feedback = 0.0f;
  float speed_rpm;
  int16_t speed_rpm_x10;

  if (HAL_FDCAN_GetTxFifoFreeLevel(&hfdcan1) == 0U)
  {
    CAN_UpdateDiagnostics();
    return;
  }

  if (mode == CAN_MODE_CURRENT)
  {
    feedback = control->iq_a;
  }
  else if (mode == CAN_MODE_SPEED)
  {
    feedback = control->velocity_rad_s * RAD_S_TO_RPM;
  }
  else if ((mode == CAN_MODE_POSITION) || (mode == CAN_MODE_MIT))
  {
    feedback = control->position_rad;
  }
  else
  {
    feedback = control->bus_v;
  }

  /* Always pack live speed so host can show rpm in every mode.
   * Layout: [mode][fault][float primary][int16 rpm*10 LE]
   * (node_id/counter replaced by always-on speed feedback).
   */
  speed_rpm = control->velocity_rad_s * RAD_S_TO_RPM;
  if (speed_rpm > 3276.7f)
  {
    speed_rpm = 3276.7f;
  }
  else if (speed_rpm < -3276.8f)
  {
    speed_rpm = -3276.8f;
  }
  speed_rpm_x10 = (int16_t)(speed_rpm * 10.0f);

  tx_data[0] = mode;
  tx_data[1] = fault_flags;
  memcpy(&tx_data[2], &feedback, sizeof(float));
  memcpy(&tx_data[6], &speed_rpm_x10, sizeof(int16_t));

  tx_header.Identifier = CAN_STATUS_BASE_ID + ((can_node_id == 0U) ? CAN_TEST_ID : (uint32_t)(can_node_id & 0x7FU));
  tx_header.IdType = FDCAN_STANDARD_ID;
  tx_header.TxFrameType = FDCAN_DATA_FRAME;
  tx_header.DataLength = CAN_TEST_DLC;
  tx_header.ErrorStateIndicator = FDCAN_ESI_ACTIVE;
  tx_header.BitRateSwitch = FDCAN_BRS_OFF;
  tx_header.FDFormat = FDCAN_CLASSIC_CAN;
  tx_header.TxEventFifoControl = FDCAN_NO_TX_EVENTS;
  tx_header.MessageMarker = 0;

  can_test_status = HAL_FDCAN_AddMessageToTxFifoQ(&hfdcan1, &tx_header, tx_data);
  if (can_test_status != HAL_OK)
  {
    CAN_UpdateDiagnostics();
    return;
  }
  can_test_tx_count++;
}

static float CAN_UintToFloat(uint16_t x_int, float x_min, float x_max, uint8_t bits)
{
  float span;
  uint32_t max_int;

  span = x_max - x_min;
  max_int = (1UL << bits) - 1UL;
  if (max_int == 0UL)
  {
    return x_min;
  }
  return (((float)x_int) * span / (float)max_int) + x_min;
}

/*
 * Cheetah-style MIT pack (8 bytes, big-endian bit packing):
 *   p_des : 16 bit  [MIT_P_MIN, MIT_P_MAX]
 *   v_des : 12 bit  [MIT_V_MIN, MIT_V_MAX]
 *   kp    : 12 bit  [MIT_KP_MIN, MIT_KP_MAX]
 *   kd    : 12 bit  [MIT_KD_MIN, MIT_KD_MAX]
 *   iq_ff : 12 bit  [MIT_T_MIN, MIT_T_MAX]
 *
 * Layout:
 *   [0]=p[15:8]  [1]=p[7:0]
 *   [2]=v[11:4]
 *   [3]=v[3:0]|kp[11:8]
 *   [4]=kp[7:0]
 *   [5]=kd[11:4]
 *   [6]=kd[3:0]|t[11:8]
 *   [7]=t[7:0]
 */
static void CAN_UnpackMit(const uint8_t *data, float *pos, float *vel, float *kp, float *kd, float *iq_ff)
{
  uint16_t p_int;
  uint16_t v_int;
  uint16_t kp_int;
  uint16_t kd_int;
  uint16_t t_int;

  p_int = ((uint16_t)data[0] << 8) | (uint16_t)data[1];
  v_int = ((uint16_t)data[2] << 4) | ((uint16_t)data[3] >> 4);
  kp_int = (((uint16_t)data[3] & 0x0FU) << 8) | (uint16_t)data[4];
  kd_int = ((uint16_t)data[5] << 4) | ((uint16_t)data[6] >> 4);
  t_int = (((uint16_t)data[6] & 0x0FU) << 8) | (uint16_t)data[7];

  *pos = CAN_UintToFloat(p_int, MIT_P_MIN, MIT_P_MAX, 16U);
  *vel = CAN_UintToFloat(v_int, MIT_V_MIN, MIT_V_MAX, 12U);
  *kp = CAN_UintToFloat(kp_int, MIT_KP_MIN, MIT_KP_MAX, 12U);
  *kd = CAN_UintToFloat(kd_int, MIT_KD_MIN, MIT_KD_MAX, 12U);
  *iq_ff = CAN_UintToFloat(t_int, MIT_T_MIN, MIT_T_MAX, 12U);
}

static void CAN_ApplyControlFrame(uint32_t id, const uint8_t *data)
{
  uint32_t control_id = CAN_CONTROL_BASE_ID + ((can_node_id == 0U) ? CAN_TEST_ID : (uint32_t)(can_node_id & 0x7FU));
  float target = 0.0f;
  uint8_t cmd;

  if ((data == NULL) || (id != control_id))
  {
    return;
  }

  cmd = data[0];
  memcpy(&target, &data[2], sizeof(float));
  can_control_last_cmd = cmd;

  /*
   * Once MIT is active the control ID carries pure Cheetah 8-byte packs.
   * Escape while MIT is active:
   *   - DISABLE/ESTOP with remaining 7 bytes all zero
   *   - SET_MODE (cmd 0x07) to switch/exit
   * Everything else is treated as a MIT pack.
   */
  if (can_control_mode == CAN_MODE_MIT)
  {
    uint8_t escape_zeros = 1U;
    uint8_t i;

    for (i = 1U; i < 8U; ++i)
    {
      if (data[i] != 0U)
      {
        escape_zeros = 0U;
        break;
      }
    }

    if (((cmd == CAN_CMD_DISABLE) || (cmd == CAN_CMD_ESTOP)) && (escape_zeros != 0U))
    {
      ControlApp_Disable();
      can_control_mode = CAN_MODE_DISABLED;
      can_control_target = 0.0f;
      can_control_rx_count++;
      return;
    }

    if (cmd == CAN_CMD_SET_MODE)
    {
      switch (data[1])
      {
        case CAN_MODE_CURRENT:
          ControlApp_SetMode(CTRL_MODE_CURRENT);
          can_control_mode = CAN_MODE_CURRENT;
          break;
        case CAN_MODE_SPEED:
          ControlApp_SetMode(CTRL_MODE_SPEED);
          can_control_mode = CAN_MODE_SPEED;
          break;
        case CAN_MODE_POSITION:
          ControlApp_SetMode(CTRL_MODE_POSITION);
          can_control_mode = CAN_MODE_POSITION;
          break;
        case CAN_MODE_MIT:
          ControlApp_SetMode(CTRL_MODE_MIT);
          can_control_mode = CAN_MODE_MIT;
          break;
        default:
          ControlApp_Disable();
          can_control_mode = CAN_MODE_DISABLED;
          break;
      }
      can_control_target = target;
      can_control_rx_count++;
      return;
    }

    {
      float mit_pos = 0.0f;
      float mit_vel = 0.0f;
      float mit_kp = 0.0f;
      float mit_kd = 0.0f;
      float mit_iq = 0.0f;

      CAN_UnpackMit(data, &mit_pos, &mit_vel, &mit_kp, &mit_kd, &mit_iq);
      ControlApp_SetMitCommand(mit_pos, mit_vel, mit_kp, mit_kd, mit_iq);
      can_control_mode = CAN_MODE_MIT;
      can_control_target = mit_pos;
      can_control_last_cmd = CAN_CMD_MIT;
      can_control_rx_count++;
    }
    return;
  }

  switch (cmd)
  {
    case CAN_CMD_DISABLE:
    case CAN_CMD_ESTOP:
      ControlApp_Disable();
      can_control_mode = CAN_MODE_DISABLED;
      can_control_target = 0.0f;
      can_control_rx_count++;
      break;

    case CAN_CMD_CURRENT:
      if (target > CAN_CURRENT_LIMIT_A)
      {
        target = CAN_CURRENT_LIMIT_A;
      }
      else if (target < -CAN_CURRENT_LIMIT_A)
      {
        target = -CAN_CURRENT_LIMIT_A;
      }
      ControlApp_SetMode(CTRL_MODE_CURRENT);
      ControlApp_SetCurrentRef(target);
      can_control_mode = CAN_MODE_CURRENT;
      can_control_target = target;
      can_control_rx_count++;
      break;

    case CAN_CMD_SPEED:
      if (target > CAN_SPEED_LIMIT_RPM)
      {
        target = CAN_SPEED_LIMIT_RPM;
      }
      else if (target < -CAN_SPEED_LIMIT_RPM)
      {
        target = -CAN_SPEED_LIMIT_RPM;
      }
      ControlApp_SetMode(CTRL_MODE_SPEED);
      ControlApp_SetSpeedRef(target * RPM_TO_RAD_S);
      can_control_mode = CAN_MODE_SPEED;
      can_control_target = target;
      can_control_rx_count++;
      break;

    case CAN_CMD_POSITION:
      if (target > CAN_POSITION_LIMIT_RAD)
      {
        target = CAN_POSITION_LIMIT_RAD;
      }
      else if (target < -CAN_POSITION_LIMIT_RAD)
      {
        target = -CAN_POSITION_LIMIT_RAD;
      }
      ControlApp_SetMode(CTRL_MODE_POSITION);
      ControlApp_SetPositionRef(target);
      can_control_mode = CAN_MODE_POSITION;
      can_control_target = target;
      can_control_rx_count++;
      break;

    case CAN_CMD_MIT:
      /* Enter MIT. Subsequent frames on this ID are pure Cheetah packs. */
      ControlApp_SetMode(CTRL_MODE_MIT);
      can_control_mode = CAN_MODE_MIT;
      can_control_target = 0.0f;
      can_control_rx_count++;
      break;

    case CAN_CMD_SET_MODE:
      switch (data[1])
      {
        case CAN_MODE_CURRENT:
          ControlApp_SetMode(CTRL_MODE_CURRENT);
          can_control_mode = CAN_MODE_CURRENT;
          break;
        case CAN_MODE_SPEED:
          ControlApp_SetMode(CTRL_MODE_SPEED);
          can_control_mode = CAN_MODE_SPEED;
          break;
        case CAN_MODE_POSITION:
          ControlApp_SetMode(CTRL_MODE_POSITION);
          can_control_mode = CAN_MODE_POSITION;
          break;
        case CAN_MODE_MIT:
          ControlApp_SetMode(CTRL_MODE_MIT);
          can_control_mode = CAN_MODE_MIT;
          break;
        default:
          ControlApp_Disable();
          can_control_mode = CAN_MODE_DISABLED;
          break;
      }
      can_control_target = target;
      can_control_rx_count++;
      break;

    case CAN_CMD_SET_PID:
      if (target < 0.0f)
      {
        target = 0.0f;
      }
      switch (data[1])
      {
        case CAN_PID_CURRENT_KP:
          control_current_pi_kp = target;
          break;

        case CAN_PID_CURRENT_KI:
          control_current_pi_ki = target;
          break;

        case CAN_PID_CURRENT_LIMIT:
          if (target > 0.0f)
          {
            control_current_pi_out_limit_v = target;
          }
          break;

        case CAN_PID_POS_KP:
          control_position_kp = target;
          break;

        case CAN_PID_POS_KD:
          control_position_kd = target;
          break;

        case CAN_PID_POS_KI:
          control_position_ki = target;
          break;

        case CAN_PID_POS_ISEP:
          control_position_i_sep_rad = target;
          break;

        case CAN_PID_MIT_KP:
          control_mit_kp = target;
          break;

        case CAN_PID_MIT_KD:
          control_mit_kd = target;
          break;

        default:
          break;
      }
      can_control_target = target;
      can_control_rx_count++;
      break;

    default:
      break;
  }
}

static void LED_BootRainbow(void)
{
  static const uint8_t colors[][3] = {
    {48U, 0U, 0U},
    {48U, 16U, 0U},
    {40U, 40U, 0U},
    {0U, 48U, 0U},
    {0U, 32U, 32U},
    {0U, 0U, 48U},
    {24U, 0U, 40U},
  };

  for (uint32_t i = 0U; i < (sizeof(colors) / sizeof(colors[0])); ++i)
  {
    (void)WS2812_SetRGB(colors[i][0], colors[i][1], colors[i][2]);
    HAL_Delay(5U);
  }
  (void)WS2812_SetRGB(0U, 0U, 0U);
}

static void LED_StatusUpdate(void)
{
  static uint8_t last_red = 255U;
  static uint8_t last_green = 255U;
  static uint8_t last_blue = 255U;
  const ControlTelemetry_t *control = ControlApp_GetTelemetry();
  uint8_t red = 0U;
  uint8_t green = 0U;
  uint8_t blue = 0U;
  uint8_t node_id;
  uint32_t group_ms;
  uint32_t cycle_ms;

  if ((control->fault_flags & FAULT_BUS_UNDERVOLT) != 0UL)
  {
    red = 48U;
  }
  else if ((control_mode_cmd == CTRL_MODE_CURRENT) ||
           (control_mode_cmd == CTRL_MODE_SPEED) ||
           (control_mode_cmd == CTRL_MODE_POSITION) ||
           (control_mode_cmd == CTRL_MODE_MIT) ||
           (control_enable != 0U) ||
           (control_open_loop_enable != 0U) ||
           (control_current_test_enable != 0U) ||
           (control_position_enable != 0U))
  {
    node_id = can_node_id;
    if (node_id == 0U)
    {
      node_id = 1U;
    }
    if (node_id > LED_MAX_BLINK_ID)
    {
      node_id = LED_MAX_BLINK_ID;
    }

    group_ms = ((uint32_t)node_id * LED_BLINK_STEP_MS) + LED_GROUP_PAUSE_MS;
    cycle_ms = HAL_GetTick() % group_ms;
    if (cycle_ms < ((uint32_t)node_id * LED_BLINK_STEP_MS))
    {
      if ((cycle_ms % LED_BLINK_STEP_MS) < LED_ON_TIME_MS)
      {
        green = 48U;
      }
    }
  }

  if ((red == last_red) && (green == last_green) && (blue == last_blue))
  {
    return;
  }

  ws2812_last_status = WS2812_SetRGB(red, green, blue);
  if (ws2812_last_status == HAL_OK)
  {
    last_red = red;
    last_green = green;
    last_blue = blue;
    ws2812_update_count++;
  }
}

static void WS2812_AppendCode(uint32_t *bit_pos, uint8_t code)
{
  for (int8_t bit = 2; bit >= 0; --bit)
  {
    if ((code & (1U << bit)) != 0U)
    {
      ws2812_frame[*bit_pos / 8U] |= (uint8_t)(1U << (7U - (*bit_pos % 8U)));
    }
    (*bit_pos)++;
  }
}

static void WS2812_AppendByte(uint32_t *bit_pos, uint8_t value)
{
  for (int8_t bit = 7; bit >= 0; --bit)
  {
    WS2812_AppendCode(bit_pos, ((value & (1U << bit)) != 0U) ? WS2812_CODE_1 : WS2812_CODE_0);
  }
}

static HAL_StatusTypeDef WS2812_SetRGB(uint8_t red, uint8_t green, uint8_t blue)
{
  uint32_t bit_pos = 0;

  memset(ws2812_frame, 0, sizeof(ws2812_frame));

  WS2812_AppendByte(&bit_pos, green);
  WS2812_AppendByte(&bit_pos, red);
  WS2812_AppendByte(&bit_pos, blue);

  if (HAL_SPI_Transmit(&hspi1, ws2812_frame, sizeof(ws2812_frame), HAL_MAX_DELAY) != HAL_OK)
  {
    return HAL_ERROR;
  }

  return HAL_SPI_Transmit(&hspi1, ws2812_reset, sizeof(ws2812_reset), HAL_MAX_DELAY);
}

static void BoardTest_SetPass(uint32_t flag, uint8_t passed)
{
  if (passed != 0U)
  {
    board_test_pass_flags |= flag;
    board_test_fail_flags &= ~flag;
  }
  else
  {
    board_test_fail_flags |= flag;
    board_test_pass_flags &= ~flag;
  }
}

static void CAN_RxGpioDiagInit(void)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};

  __HAL_RCC_GPIOA_CLK_ENABLE();
  GPIO_InitStruct.Pin = GPIO_PIN_11;
  GPIO_InitStruct.Mode = GPIO_MODE_INPUT;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_HIGH;
  HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);

  can_rx_gpio_diag_samples = 0UL;
  can_rx_gpio_diag_edges = 0UL;
  can_rx_gpio_diag_level = (HAL_GPIO_ReadPin(GPIOA, GPIO_PIN_11) == GPIO_PIN_SET) ? 1U : 0U;
  (void)WS2812_SetRGB(0U, 0U, 48U);
}

static void CAN_RxGpioDiagUpdate(void)
{
  uint8_t level = (HAL_GPIO_ReadPin(GPIOA, GPIO_PIN_11) == GPIO_PIN_SET) ? 1U : 0U;

  if (level != can_rx_gpio_diag_level)
  {
    can_rx_gpio_diag_edges++;
    can_rx_gpio_diag_level = level;
  }
  can_rx_gpio_diag_samples++;
}

static void BoardTest_Init(void)
{
  board_test_pass_flags = 0UL;
  board_test_fail_flags = 0UL;
  board_test_run_count = 0UL;
  board_test_report_count = 0UL;
  board_test_motor_position_step_enable = 0U;

  control_enable = 0U;
  control_open_loop_enable = 0U;
  control_current_test_enable = 0U;
  control_align_enable = 0U;
  control_position_enable = 0U;
  control_velocity_ref_rad_s = 0.0f;

  if (WS2812_SetRGB(32U, 0U, 0U) == HAL_OK)
  {
    HAL_Delay(120U);
    (void)WS2812_SetRGB(0U, 32U, 0U);
    HAL_Delay(120U);
    (void)WS2812_SetRGB(0U, 0U, 32U);
    HAL_Delay(120U);
    (void)WS2812_SetRGB(16U, 16U, 16U);
    HAL_Delay(120U);
    BoardTest_SetPass(BOARD_TEST_FLAG_WS2812, 1U);
  }
  else
  {
    BoardTest_SetPass(BOARD_TEST_FLAG_WS2812, 0U);
  }

  DRV8313_StartSafe();
  HAL_Delay(10U);
  BoardTest_SetPass(BOARD_TEST_FLAG_DRV, (DRV8313_ReadFault() == GPIO_PIN_SET) ? 1U : 0U);

  __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_1, 0U);
  __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_2, 0U);
  __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_3, 0U);
  BoardTest_SetPass(BOARD_TEST_FLAG_PWM, 1U);

  MT6701_CS_Init();
  INA240_SampleAll();
  MT6701_Sample();
  CAN_ExternalDebugInit();

  BoardTest_Report();
}

static void BoardTest_Update(void)
{
  static uint32_t last_sample_tick;
  static uint32_t last_report_tick;
  uint32_t now = HAL_GetTick();

  CAN_ExternalDebugUpdate();

  if ((now - last_sample_tick) >= BOARD_TEST_SAMPLE_MS)
  {
    last_sample_tick = now;
    INA240_SampleAll();
    MT6701_Sample();

    BoardTest_SetPass(BOARD_TEST_FLAG_INA240, (ina240_last_status == HAL_OK) ? 1U : 0U);
    BoardTest_SetPass(BOARD_TEST_FLAG_MT6701, (mt6701_last_status == HAL_OK) ? 1U : 0U);
    BoardTest_SetPass(BOARD_TEST_FLAG_CAN,
                      ((can_test_status == HAL_OK) &&
                       (can_test_protocol_bus_off == 0UL) &&
                       (can_test_protocol_error_warning == 0UL) &&
                       (can_test_protocol_error_passive == 0UL) &&
                       (can_test_tx_error_count == 0UL)) ? 1U : 0U);

    board_test_vbus_mv = (uint16_t)((uint32_t)vsupply_sense_mv * 11U);
    board_test_mt6701_magnet_warning = (mt6701_status != 0U) ? 1U : 0U;
    board_test_run_count++;

    if (board_test_fail_flags == 0UL)
    {
      (void)WS2812_SetRGB(0U, 32U, 0U);
    }
    else
    {
      (void)WS2812_SetRGB(48U, 0U, 0U);
    }
  }

  if ((now - last_report_tick) >= BOARD_TEST_REPORT_MS)
  {
    last_report_tick = now;
    BoardTest_Report();
  }

  if (board_test_motor_position_step_enable != 0U)
  {
    board_test_motor_position_step_enable = 0U;
  }
}

static void BoardTest_Report(void)
{
  board_test_report_count++;
  vofa_last_status = BoardTest_SendVofa();
  if (vofa_last_status == HAL_OK)
  {
    vofa_tx_count++;
  }
}

static HAL_StatusTypeDef BoardTest_SendVofa(void)
{
  uint32_t expected_flags = BOARD_TEST_FLAG_WS2812 |
                            BOARD_TEST_FLAG_DRV |
                            BOARD_TEST_FLAG_INA240 |
                            BOARD_TEST_FLAG_MT6701 |
                            BOARD_TEST_FLAG_CAN |
                            BOARD_TEST_FLAG_PWM;
  float values[20];
  uint8_t frame[sizeof(values) + 4U];

  values[0] = (((board_test_pass_flags & expected_flags) == expected_flags) &&
               (board_test_fail_flags == 0UL)) ? 1.0f : 0.0f;
  values[1] = (float)board_test_pass_flags;
  values[2] = (float)board_test_fail_flags;
  values[3] = (float)board_test_vbus_mv / 1000.0f;
  values[4] = (float)ina240_adc_mv[0] / 1000.0f;
  values[5] = (float)ina240_adc_mv[1] / 1000.0f;
  values[6] = (float)ina240_adc_mv[2] / 1000.0f;
  values[7] = mt6701_angle_deg;
  values[8] = (float)mt6701_status;
  values[9] = (float)board_test_mt6701_magnet_warning;
  values[10] = (DRV8313_ReadFault() == GPIO_PIN_SET) ? 1.0f : 0.0f;
  values[11] = (float)can_test_tx_count;
  values[12] = (float)can_test_rx_count;
  values[13] = (float)can_test_tx_error_count;
  values[14] = (float)can_test_rx_error_count;
  values[15] = (float)can_test_protocol_bus_off;
  values[16] = (float)can_test_protocol_error_warning;
  values[17] = (float)can_test_protocol_error_passive;
  values[18] = (float)can_test_status;
  values[19] = (float)board_test_run_count;

  memcpy(frame, values, sizeof(values));
  frame[sizeof(values) + 0U] = VOFA_JUSTFLOAT_TAIL_0;
  frame[sizeof(values) + 1U] = VOFA_JUSTFLOAT_TAIL_1;
  frame[sizeof(values) + 2U] = VOFA_JUSTFLOAT_TAIL_2;
  frame[sizeof(values) + 3U] = VOFA_JUSTFLOAT_TAIL_3;

  return HAL_UART_Transmit(&huart1, frame, sizeof(frame), 20U);
}

/* USER CODE END 4 */

/**
  * @brief  This function is executed in case of error occurrence.
  * @retval None
  */
void Error_Handler(void)
{
  /* USER CODE BEGIN Error_Handler_Debug */
  /* User can add his own implementation to report the HAL error return state */
  __disable_irq();
  while (1)
  {
  }
  /* USER CODE END Error_Handler_Debug */
}
#ifdef USE_FULL_ASSERT
/**
  * @brief  Reports the name of the source file and the source line number
  *         where the assert_param error has occurred.
  * @param  file: pointer to the source file name
  * @param  line: assert_param error line source number
  * @retval None
  */
void assert_failed(uint8_t *file, uint32_t line)
{
  /* USER CODE BEGIN 6 */
  /* User can add his own implementation to report the file name and line number,
     ex: printf("Wrong parameters value: file %s on line %d\r\n", file, line) */
  /* USER CODE END 6 */
}
#endif /* USE_FULL_ASSERT */
