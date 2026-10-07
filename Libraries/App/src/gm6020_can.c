#include "gm6020_can.h"
#include <math.h>
#include <stddef.h>
static void put16(uint8_t *p, uint16_t value) {
  p[0] = (uint8_t)(value >> 8); p[1] = (uint8_t)value;
}
static int16_t signed16(float value) {
  if (!isfinite(value)) return 0;
  if (value > 32767.0f) value = 32767.0f;
  if (value < -32768.0f) value = -32768.0f;
  return (int16_t)lroundf(value);
}
int GM6020_DecodeCurrent(uint8_t motor_id, uint32_t id, const uint8_t *data,
                         uint8_t length, uint8_t standard_data_classic, float *amps) {
  if (motor_id < 1 || motor_id > 7 || !data || !amps || length != 8 ||
      !standard_data_classic || id != ((motor_id <= 4) ? 0x1FEU : 0x2FEU)) return 0;
  unsigned slot = (motor_id - 1U) % 4U;
  uint16_t bits = ((uint16_t)data[2U*slot] << 8) | data[2U*slot+1U];
  int32_t raw = bits < 32768U ? (int32_t)bits : (int32_t)bits - 65536;
  if (raw > 16384) raw = 16384;
  if (raw < -16384) raw = -16384;
  *amps = (float)raw * (3.0f / 16384.0f);
  return 1;
}
void GM6020_PackFeedback(float angle_deg, float rpm, float iq_a, uint8_t data[8]) {
  float angle = isfinite(angle_deg) ? fmodf(angle_deg, 360.0f) : 0.0f;
  if (angle < 0.0f) angle += 360.0f;
  uint16_t ticks = (uint16_t)(angle * (8192.0f / 360.0f));
  put16(data, ticks & 8191U);
  put16(data+2, (uint16_t)signed16(rpm));
  /* Project convention: feedback uses the same 16384/3 A scale as commands.
   * The supplied manual does not explicitly specify feedback current scaling. */
  put16(data+4, (uint16_t)signed16(iq_a * (16384.0f / 3.0f)));
  data[6] = 0xFFU; /* Temperature unavailable: project extension, NOT measured. */
  data[7] = 0U;
}
void GM6020_Cancel(GM6020_Session *s) { s->active=0U; s->ready=0U; }
int GM6020_CheckSession(GM6020_Session *s, uint32_t now, uint8_t still_current) {
  if (s->active && (!still_current || (uint32_t)(now-s->last_tick) >= GM6020_COMMAND_TIMEOUT_MS)) {
    GM6020_Cancel(s); return 1;
  }
  return 0;
}
int GM6020_Accept(GM6020_Session *s, uint32_t now, float amps, uint8_t safe, uint8_t idle) {
  if (!safe || !isfinite(amps)) {
    int owned=s->active; GM6020_Cancel(s); return owned ? -1 : 0;
  }
  if (amps == 0.0f) {
    int owned=s->active;
    s->active=0U; s->ready=(idle || owned); s->last_tick=now;
    return owned ? -1 : 0;
  }
  if (!s->active && (!s->ready || !idle)) return 0;
  s->active=1U; s->ready=0U; s->last_tick=now;
  return 1;
}
