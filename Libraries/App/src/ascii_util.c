#include "ascii_util.h"

#include <math.h>
#include <stdlib.h>

void Text_Init(TextBuf *t, char *buf, size_t cap) {
  t->buf = buf;
  t->cap = cap;
  t->len = 0U;
  t->overflow = 0U;
  if (cap > 0U) {
    buf[0] = '\0';
  }
}

void Text_Char(TextBuf *t, char c) {
  if ((t->len + 1U) < t->cap) {
    t->buf[t->len++] = c;
    t->buf[t->len] = '\0';
  } else {
    t->overflow = 1U;
  }
}

void Text_Str(TextBuf *t, const char *s) {
  while ((s != NULL) && (*s != '\0')) {
    Text_Char(t, *s++);
  }
}

void Text_U32(TextBuf *t, uint32_t v) {
  char tmp[11];
  size_t n = 0U;
  do {
    tmp[n++] = (char)('0' + (v % 10U));
    v /= 10U;
  } while ((v != 0U) && (n < sizeof(tmp)));
  while (n > 0U) {
    Text_Char(t, tmp[--n]);
  }
}

void Text_I32(TextBuf *t, int32_t v) {
  if (v < 0) {
    Text_Char(t, '-');
    Text_U32(t, (uint32_t)(-(int64_t)v));
  } else {
    Text_U32(t, (uint32_t)v);
  }
}

void Text_Hex(TextBuf *t, uint32_t v, uint8_t digits) {
  static const char kHex[] = "0123456789ABCDEF";
  if (digits > 8U) {
    digits = 8U;
  }
  for (int8_t i = (int8_t)(digits - 1U); i >= 0; --i) {
    Text_Char(t, kHex[(v >> (4U * (uint8_t)i)) & 0xFU]);
  }
}

void Text_Float(TextBuf *t, float v) {
  if (isnan(v)) {
    Text_Str(t, "nan");
    return;
  }
  if (isinf(v)) {
    Text_Str(t, (v < 0.0f) ? "-inf" : "inf");
    return;
  }
  double d = (double)v;
  if (d < 0.0) {
    Text_Char(t, '-');
    d = -d;
  }
  if (d >= 4.0e9) {
    Text_Str(t, "9e9");
    return;
  }
  /* 7 significant digits are all a float carries; keep at most 6 decimals. */
  uint32_t decimals = 6U;
  if (d >= 10.0) decimals = 5U;
  if (d >= 100.0) decimals = 4U;
  if (d >= 1000.0) decimals = 3U;
  if (d >= 10000.0) decimals = 2U;
  if (d >= 100000.0) decimals = 1U;
  if (d >= 1000000.0) decimals = 0U;
  uint32_t scale = 1U;
  for (uint32_t i = 0U; i < decimals; ++i) {
    scale *= 10U;
  }
  const uint64_t scaled = (uint64_t)(d * (double)scale + 0.5);
  uint32_t ip = (uint32_t)(scaled / scale);
  uint32_t fp = (uint32_t)(scaled % scale);
  Text_U32(t, ip);
  if (fp == 0U) {
    return;
  }
  while ((fp % 10U) == 0U) {
    fp /= 10U;
    decimals--;
  }
  char frac[8];
  for (int32_t i = (int32_t)decimals - 1; i >= 0; --i) {
    frac[i] = (char)('0' + (fp % 10U));
    fp /= 10U;
  }
  Text_Char(t, '.');
  for (uint32_t i = 0U; i < decimals; ++i) {
    Text_Char(t, frac[i]);
  }
}

static int is_sep(char c) {
  return (c == ' ') || (c == '\t') || (c == '=') || (c == ',');
}

size_t Ascii_Tokenize(char *line, char **tokens, size_t max_tokens) {
  size_t n = 0U;
  char *p = line;
  while ((p != NULL) && (*p != '\0')) {
    while (is_sep(*p)) {
      *p++ = '\0';
    }
    if (*p == '\0') {
      break;
    }
    if (n < max_tokens) {
      tokens[n] = p;
    }
    n++;
    while ((*p != '\0') && !is_sep(*p)) {
      p++;
    }
  }
  return n; /* may exceed max_tokens: caller must reject */
}

int Ascii_ParseFloat(const char *s, float *out) {
  char *end = NULL;
  if ((s == NULL) || (*s == '\0')) {
    return 0;
  }
  const float v = strtof(s, &end);
  if ((end == s) || (*end != '\0') || !isfinite(v)) {
    return 0;
  }
  *out = v;
  return 1;
}

void Ascii_Upper(char *s) {
  for (; (s != NULL) && (*s != '\0'); ++s) {
    if ((*s >= 'a') && (*s <= 'z')) {
      *s = (char)(*s - ('a' - 'A'));
    }
  }
}
