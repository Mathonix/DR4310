#ifndef GM6020_CAN_H
#define GM6020_CAN_H
#include <stdint.h>
#ifndef MOTOR_CAN_ID
#define MOTOR_CAN_ID 2
#endif
#if MOTOR_CAN_ID < 1 || MOTOR_CAN_ID > 7
#error MOTOR_CAN_ID must be in range 1..7
#endif
#define GM6020_COMMAND_ID ((MOTOR_CAN_ID <= 4) ? 0x1FEU : 0x2FEU)
#define GM6020_FEEDBACK_ID (0x204U + MOTOR_CAN_ID)
#define GM6020_COMMAND_TIMEOUT_MS 100U
#ifdef __cplusplus
extern "C" {
#endif
/* Wire format is GM6020 current mode. Voltage frames are intentionally ignored. */
int GM6020_DecodeCurrent(uint8_t motor_id, uint32_t id, const uint8_t *data,
                         uint8_t length, uint8_t standard_data_classic, float *amps);
void GM6020_PackFeedback(float angle_deg, float rpm, float iq_a, uint8_t data[8]);
/* A zero frame arms a fresh session. Timeout/interlock requires another zero. */
typedef struct { uint32_t last_tick; uint8_t active; uint8_t ready; } GM6020_Session;
void GM6020_Cancel(GM6020_Session *session);
int GM6020_CheckSession(GM6020_Session *session, uint32_t now, uint8_t still_current);
/* Return 1=set current, -1=disable owned session, 0=ignore. */
int GM6020_Accept(GM6020_Session *session, uint32_t now, float amps,
                  uint8_t safe, uint8_t idle);
#ifdef __cplusplus
}
#endif
#endif
