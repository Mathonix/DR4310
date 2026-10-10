/* Host test of the HAL-free overload limiter.
 * Parameter rejection and v3 flash defaults live in tests/test_uart_config.c.
 *
 *   g++ -std=c++17 -Wall -Wextra -ILibraries/Control/inc tests/test_overload_limiter.cpp
 *       Libraries/Control/src/overload_limiter.cpp -o tests/test_overload_limiter.exe
 */
#include "OverloadLimiter.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace {

int g_checks = 0;

void Expect(bool ok, const char *name) {
  ++g_checks;
  if (!ok) {
    std::fprintf(stderr, "FAIL %s\n", name);
    std::abort();
  }
}

control::OverloadConfig Cfg(float iq, float ol, float time_s, int enable) {
  control::OverloadConfig cfg;
  cfg.iq_limit_a = iq;
  cfg.ol_iq_a = ol;
  cfg.ol_time_s = time_s;
  cfg.ol_enable = static_cast<uint8_t>(enable);
  return cfg;
}

float Demand(float command_a, float measured_a) {
  return std::max(std::fabs(command_a), std::fabs(measured_a));
}

}  // namespace

int main() {
  using control::OverloadLimiter;
  using control::OverloadPhase;

  {
    OverloadLimiter lim;
    const auto st = lim.status();
    Expect(st.phase == OverloadPhase::Off, "initial phase");
    Expect(st.budget_s == OL_TIME_DEFAULT_S, "initial budget");
    Expect(st.effective_a == IQ_CONTINUOUS_MAX_A, "initial effective");
  }

  {
    OverloadLimiter lim;
    const auto cfg = Cfg(1.25f, IQ_HARD_MAX_A, 4.0f, 0);
    for (int i = 0; i < 5; ++i) {
      const auto st = lim.step(cfg, Demand(-2.7f, 0.2f), 1.0f);
      Expect(st.phase == OverloadPhase::Off, "disabled phase");
      Expect(st.effective_a == 1.25f, "disabled effective");
      Expect(st.ceiling_a == 1.25f, "disabled ceiling");
      Expect(st.budget_s == 4.0f, "disabled parks full");
    }
    const auto armed = lim.step(Cfg(1.25f, IQ_HARD_MAX_A, 4.0f, 1), 0.0f, 0.0f);
    Expect(armed.phase == OverloadPhase::Ready, "enable starts ready");
    Expect(armed.effective_a == IQ_HARD_MAX_A, "enable effective");
    Expect(armed.budget_s == 4.0f, "enable budget full");
  }

  Expect(Demand(-2.7f, 0.2f) == 2.7f, "demand uses command");
  Expect(Demand(0.2f, -2.9f) == 2.9f, "demand uses measurement");

  {
    OverloadLimiter lim;
    const auto cfg = Cfg(2.5f, IQ_HARD_MAX_A, 2.0f, 1);
    const auto st = lim.step(cfg, 2.8f, 2.0f);
    Expect(st.phase == OverloadPhase::Recover, "budget ends same tick");
    Expect(st.effective_a == 2.5f, "fallback same tick");
    Expect(st.budget_s == 0.0f, "budget empty");
    Expect(st.ceiling_a == IQ_HARD_MAX_A, "ceiling stays overload");
  }

  {
    OverloadLimiter lim;
    const auto cfg = Cfg(2.5f, IQ_HARD_MAX_A, 2.0f, 1);
    auto st = lim.step(cfg, 2.8f, 1.0f);
    Expect(st.phase == OverloadPhase::Active, "partial spend active");
    Expect(st.effective_a == IQ_HARD_MAX_A, "partial spend effective");
    Expect(st.budget_s == 1.0f, "partial spend budget");
    st = lim.step(cfg, 2.5f + 0.01f, 5.0f);
    Expect(st.phase == OverloadPhase::Active, "margin band holds phase");
    Expect(st.budget_s == 1.0f, "margin band holds budget");
    const float held = st.budget_s;
    st = lim.step(cfg, 2.8f, -5.0f);
    Expect(st.budget_s == held, "negative dt does not spend");
  }

  {
    OverloadLimiter lim;
    const auto cfg = Cfg(2.5f, IQ_HARD_MAX_A, 1.0f, 1);
    auto st = lim.step(cfg, 2.8f, 1.0f);
    Expect(st.phase == OverloadPhase::Recover && st.budget_s == 0.0f, "drained");
    st = lim.step(cfg, 0.0f, 2.0f);
    Expect(st.phase == OverloadPhase::Recover, "partial recover stays latched");
    Expect(st.budget_s == 0.5f, "partial refill");
    Expect(st.effective_a == 2.5f, "partial recover clamp");
    st = lim.step(cfg, 2.8f, 10.0f);
    Expect(st.budget_s == 0.5f, "demand holds recover");
    Expect(st.phase == OverloadPhase::Recover, "demand does not re-arm");
    st = lim.step(cfg, 0.0f, 2.0f);
    Expect(st.phase == OverloadPhase::Ready, "full recover re-arms");
    Expect(st.budget_s == 1.0f, "full recover exact");
    Expect(st.effective_a == IQ_HARD_MAX_A, "re-arm effective");
    st = lim.step(cfg, 2.8f, 1.0f);
    Expect(st.phase == OverloadPhase::Recover, "next overload spends again");
    Expect(st.budget_s == 0.0f && st.effective_a == 2.5f, "second drain");
  }

  {
    OverloadLimiter lim;
    const auto cfg = Cfg(2.5f, IQ_HARD_MAX_A, 1.0f, 1);
    Expect(lim.step(cfg, 2.8f, 1.0f).budget_s == 0.0f, "empty before long rest");
    const auto st = lim.step(cfg, 0.0f, 4.0f);
    Expect(st.phase == OverloadPhase::Ready, "dt=4 refills exactly");
    Expect(st.budget_s == 1.0f, "no double refill");
    Expect(st.effective_a == IQ_HARD_MAX_A, "crossing tick does not spend");
  }

  {
    OverloadLimiter lim;
    const auto st = lim.step(Cfg(2.5f, 9.0f, 2.0f, 1), 0.0f, 0.0f);
    Expect(st.phase == OverloadPhase::Ready, "hard clamp ready");
    Expect(st.effective_a == IQ_HARD_MAX_A, "ol_iq clamped");
    Expect(st.ceiling_a == IQ_HARD_MAX_A, "ceiling clamped");
    Expect(OverloadLimiter::CommandCeiling(Cfg(2.5f, 9.0f, 2.0f, 1)) == IQ_HARD_MAX_A,
           "command ceiling clamped");
  }

  {
    OverloadLimiter lim;
    const auto st = lim.step(Cfg(2.0f, 1.0f, 2.0f, 1), 3.0f, 1.0f);
    Expect(st.phase == OverloadPhase::Off, "ol below iq stays off");
    Expect(st.effective_a == 2.0f, "defensive raise to iq");
  }

  {
    OverloadLimiter lim;
    const auto st = lim.step(Cfg(2.5f, IQ_HARD_MAX_A, 0.0f, 1), 2.8f, 5.0f);
    Expect(st.phase == OverloadPhase::Off, "zero time is off");
    Expect(st.effective_a == 2.5f, "zero time clamp");
    Expect(st.budget_s == 0.0f, "zero time parks zero");
    const auto raised = lim.step(Cfg(2.5f, IQ_HARD_MAX_A, 2.0f, 1), 2.8f, 1.0f);
    Expect(raised.phase == OverloadPhase::Active, "raising time starts full");
    Expect(raised.effective_a == IQ_HARD_MAX_A, "raised effective");
    Expect(raised.budget_s == 1.0f, "raised budget spent one second");
  }

  {
    const float iq = 2.5f;
    OverloadLimiter tight;
    const auto off = tight.step(Cfg(iq, iq + OL_DETECT_MARGIN_A, 2.0f, 1), 3.0f, 1.0f);
    Expect(off.phase == OverloadPhase::Off, "margin is not headroom");
    Expect(off.effective_a == iq, "no-headroom clamp");
    OverloadLimiter enough;
    const float ol = iq + OL_DETECT_MARGIN_A + 0.01f;
    const auto on = enough.step(Cfg(iq, ol, 2.0f, 1), 0.0f, 0.0f);
    Expect(on.phase == OverloadPhase::Ready, "margin plus a bit arms");
    Expect(on.effective_a == ol, "small headroom ceiling");
  }

  {
    OverloadLimiter lim;
    const auto cfg = Cfg(2.5f, IQ_HARD_MAX_A, 2.0f, 1);
    Expect(lim.step(cfg, 2.8f, 2.0f).phase == OverloadPhase::Recover, "drain before disable");
    const auto off = lim.step(Cfg(2.5f, IQ_HARD_MAX_A, 2.0f, 0), 2.8f, 0.0f);
    Expect(off.phase == OverloadPhase::Off, "disable phase");
    Expect(off.budget_s == 2.0f, "disable refills");
    Expect(off.effective_a == 2.5f, "disable clamp");
    const auto again = lim.step(cfg, 0.0f, 0.0f);
    Expect(again.phase == OverloadPhase::Ready, "re-enable starts ready");
    Expect(again.budget_s == 2.0f, "re-enable full");
  }

  {
    OverloadLimiter lim;
    auto st = lim.step(Cfg(2.5f, IQ_HARD_MAX_A, 2.0f, 1), 0.0f, 0.0f);
    Expect(st.phase == OverloadPhase::Ready && st.budget_s == 2.0f, "full before lengthen");
    st = lim.step(Cfg(2.5f, IQ_HARD_MAX_A, 4.0f, 1), 0.0f, 0.0f);
    Expect(st.phase == OverloadPhase::Ready && st.budget_s == 4.0f, "lengthen while full");
    st = lim.step(Cfg(2.5f, IQ_HARD_MAX_A, 4.0f, 1), 2.8f, 1.0f);
    Expect(st.budget_s == 3.0f && st.phase == OverloadPhase::Active, "spend after lengthen");
    st = lim.step(Cfg(2.5f, IQ_HARD_MAX_A, 6.0f, 1), 2.5f + 0.01f, 1.0f);
    Expect(st.budget_s == 3.0f && st.phase == OverloadPhase::Active, "lengthen while partial");
    st = lim.step(Cfg(2.5f, IQ_HARD_MAX_A, 1.0f, 1), 0.0f, 0.0f);
    Expect(st.budget_s == 1.0f && st.phase == OverloadPhase::Ready, "shrink clamps to full");
  }

  {
    OverloadLimiter lim;
    const auto ready = lim.step(Cfg(2.5f, IQ_HARD_MAX_A, 2.0f, 1), 0.0f, 0.0f);
    Expect(ready.phase == OverloadPhase::Ready, "ready before nan");
    const auto st = lim.step(Cfg(2.5f, IQ_HARD_MAX_A, 2.0f, 1), NAN, 1.0f);
    Expect(st.phase == OverloadPhase::Ready && st.budget_s == 2.0f, "nan demand rests");
  }

  std::printf("overload limiter tests passed (%d checks)\n", g_checks);
  return 0;
}
