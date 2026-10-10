#ifndef ASCII_UTIL_H
#define ASCII_UTIL_H

/* Small HAL-free text helpers for the UART command protocol (no printf-float
 * dependency: newlib-nano is linked without _printf_float). */

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  char *buf;
  size_t cap;
  size_t len;
  uint8_t overflow;
} TextBuf;

void Text_Init(TextBuf *t, char *buf, size_t cap);
void Text_Str(TextBuf *t, const char *s);
void Text_Char(TextBuf *t, char c);
void Text_U32(TextBuf *t, uint32_t v);
void Text_I32(TextBuf *t, int32_t v);
void Text_Hex(TextBuf *t, uint32_t v, uint8_t digits);
/* Up to 6 decimals, trailing zeros trimmed; "nan"/"inf" for non-finite. */
void Text_Float(TextBuf *t, float v);

/* Split in place on spaces, tabs, '=' and ','. Returns token count (<= max). */
size_t Ascii_Tokenize(char *line, char **tokens, size_t max_tokens);
/* Strict float parse: whole token must be a finite number. */
int Ascii_ParseFloat(const char *s, float *out);
/* In-place ASCII upper-case. */
void Ascii_Upper(char *s);

#ifdef __cplusplus
}
#endif

#endif
