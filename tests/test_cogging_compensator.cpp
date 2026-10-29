#include "CoggingCompensator.hpp"
#include <cassert>
#include <cmath>
#include <cstdio>
#include <limits>

int main() {
  constexpr float pi = 3.14159265358979323846f;
  constexpr float step = 2.0f * pi / COGGING_TABLE_SIZE;
  CoggingMap map = {};
  map.valid = 1;
  map.encoder_direction = 1;
  map.pole_pairs = 14;
  map.electrical_zero_rad = .13f;
  map.current_ma[0] = 200;
  map.current_ma[1] = 400;
  map.current_ma[511] = -200;
  using C = control::CoggingCompensator;
  assert(std::fabs(C::Lookup(map, 0) - .2f) < 1e-6f);
  assert(std::fabs(C::Lookup(map, .5f * step) - .3f) < 1e-6f);
  assert(std::fabs(C::Lookup(map, -.5f * step)) < 2e-5f);
  assert(std::fabs(C::Lookup(map, 2 * pi + .5f * step) - .3f) < 2e-5f);
  assert(C::Lookup(map, std::numeric_limits<float>::quiet_NaN()) == 0);
  assert(C::Lookup(map, std::numeric_limits<float>::infinity()) == 0);
  assert(C::Matches(map, 1, 14, .13f));
  assert(!C::Matches(map, 0, 14, .13f));
  assert(!C::Matches(map, 1, 13, .13f));
  assert(!C::Matches(map, 1, 14, .14f));
  for (unsigned mode = 0; mode <= 13; ++mode)
    assert(C::SupportsMode(mode) == (mode >= 2 && mode <= 4));
  C comp;
  assert(comp.update(map, 0, false, 1, .2f, .001f) == 0);
  assert(std::fabs(comp.update(map, 0, true, 1, .2f, .001f) - .002f) < 1e-6f);
  for (int i = 0; i < 200; ++i) comp.update(map, 0, true, 1, .2f, .001f);
  assert(std::fabs(comp.update(map, step, true, .5f, .15f, .001f) - .15f) < 1e-6f);
  assert(comp.update(map, step, false, 1, 1, .001f) == 0);
  assert(comp.update(map, 0, true, 0, .2f, .001f) == 0);
  map.valid = 0;
  assert(comp.update(map, 0, true, 1, .2f, .001f) == 0);
  assert(C::Lookup(map, 0) == 0);
  assert(C::Combine(2.4f, .2f, 2.5f) == 2.5f);
  assert(C::Combine(-2.4f, -.2f, 2.5f) == -2.5f);
  assert(std::fabs(C::Combine(2.6f, -.2f, 2.5f) - 2.4f) < 1e-6f);
  for (int i = 0; i < 1000; ++i) assert(C::Combine(.1f, .1f, .3f) == .2f);
  assert(C::Combine(1, .2f, 0) == 0);
  assert(C::Combine(1, std::numeric_limits<float>::quiet_NaN(), 2) == 0);
  std::puts("cogging interpolation, binding, gating, fade and total-current limits passed");
}
