#ifndef FOC_TIMING_H
#define FOC_TIMING_H

/* Center-aligned TIM1. f_pwm = TIMCLK / (2 * (ARR + 1)).
 * The current loop runs once per carrier, on the CH4 valley strobe. */
#define DR4310_TIMCLK_HZ 170000000u
#define DR4310_FOC_HZ 40000u
#if (DR4310_TIMCLK_HZ % (2u * DR4310_FOC_HZ)) != 0u
#error DR4310_FOC_HZ does not divide the timer clock
#endif
#define DR4310_PWM_ARR ((DR4310_TIMCLK_HZ / (2u * DR4310_FOC_HZ)) - 1u)

/* Keep the MT6701 DMA at 20 kHz. A 40 kHz SPI start would sit inside the
 * same callback that is already near the 25 us carrier period. */
#define DR4310_ENCODER_HZ 20000u
#if (DR4310_FOC_HZ % DR4310_ENCODER_HZ) != 0u
#error encoder rate must divide the current-loop rate
#endif
#define DR4310_ENCODER_DIVIDER (DR4310_FOC_HZ / DR4310_ENCODER_HZ)

#endif
