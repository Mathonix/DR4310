#include "RotorEstimator.hpp"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstdio>

namespace {

constexpr double kTwoPi = 6.283185307179586;
constexpr double kCountsPerRev = 16384.0;
constexpr double kCountRad = kTwoPi / kCountsPerRev;
constexpr uint32_t kCpuClockHz = 170000000U;
constexpr uint32_t kCyclesPerUs = 170U;

double WrapAngle(double angle) {
  angle = std::fmod(angle, kTwoPi);
  if (angle < 0.0) {
    angle += kTwoPi;
  }
  return angle;
}

double QuantizeAngle(double angle) {
  const long count = static_cast<long>(std::lround(angle / kCountRad));
  return static_cast<double>(count) * kCountRad;
}

void Run(control::RotorEstimator &est,
         int steps,
         double speed_rad_s,
         double dt_s,
         bool quantize,
         double &angle) {
  for (int i = 0; i < steps; ++i) {
    angle = WrapAngle(angle + (speed_rad_s * dt_s));
    const double input = quantize ? QuantizeAngle(angle) : angle;
    est.update(static_cast<float>(input), static_cast<float>(dt_s));
  }
}

void RunPll(control::RotorEstimator &est,
            int steps,
            double speed_rad_s,
            double dt_us,
            bool quantize,
            double &angle,
            uint32_t &timestamp_cycles,
            int32_t sample_jitter_us = 0,
            int32_t consume_delay_us = 0) {
  const double dt_s = dt_us * 1.0e-6;
  for (int i = 0; i < steps; ++i) {
    angle = WrapAngle(angle + (speed_rad_s * dt_s));
    const double input = quantize ? QuantizeAngle(angle) : angle;
    est.predict(50.0e-6);
    est.predict(50.0e-6);
    const int32_t jitter_cycles =
        (sample_jitter_us == 0)
            ? 0
            : static_cast<int32_t>(
                  ((i & 1) != 0 ? sample_jitter_us : -sample_jitter_us) *
                  static_cast<int32_t>(kCyclesPerUs));
    timestamp_cycles +=
        static_cast<uint32_t>(
            static_cast<int32_t>(dt_us * static_cast<double>(kCyclesPerUs)) +
            jitter_cycles);
    const uint32_t consume_delay_cycles =
        static_cast<uint32_t>(consume_delay_us) * kCyclesPerUs;
    est.correct(static_cast<float>(input),
                timestamp_cycles,
                timestamp_cycles + consume_delay_cycles);
  }
}

void ExpectNear(double value, double expected, double tolerance, const char *name) {
  if (std::fabs(value - expected) > tolerance) {
    std::fprintf(stderr,
                 "FAIL %s: got %.6f expected %.6f\n",
                 name,
                 value,
                 expected);
    std::abort();
  }
}

}  // namespace

int main() {
  control::RotorEstimator est;

  {
    std::fprintf(stderr, "test +1\n");
    double angle = 0.0;
    est.reset(0.0f);
    Run(est, 40, 1.0, 0.001, false, angle);
    ExpectNear(est.state().velocity_rad_s, 1.0, 0.05, "constant +1 rad/s");
  }

  {
    std::fprintf(stderr, "test +1 full 5ms window\n");
    double angle = 0.0;
    est.reset(0.0f);
    Run(est, 5, 1.0, 0.001, false, angle);
    const auto &s = est.state();
    assert(s.window_samples == 5U);
    ExpectNear(s.window_dt_s, 0.005, 1.0e-5, "full 5ms window dt");
    ExpectNear(s.window_delta_rad, 0.005, 1.0e-4, "full 5ms window delta");
    ExpectNear(s.velocity_rad_s, 1.0, 0.02, "full window +1 rad/s");
  }

  {
    std::fprintf(stderr, "test -1\n");
    double angle = 0.0;
    est.reset(0.0f);
    Run(est, 40, -1.0, 0.001, false, angle);
    ExpectNear(est.state().velocity_rad_s, -1.0, 0.05, "constant -1 rad/s");
  }

  {
    std::fprintf(stderr, "test wrap fwd\n");
    double angle = 6.2;
    est.reset(static_cast<float>(angle));
    Run(est, 40, 1.0, 0.001, false, angle);
    ExpectNear(est.state().velocity_rad_s, 1.0, 0.05, "wrap 2pi->0 forward");
  }

  {
    std::fprintf(stderr, "test wrap rev\n");
    double angle = 0.1;
    est.reset(static_cast<float>(angle));
    Run(est, 40, -1.0, 0.001, false, angle);
    ExpectNear(est.state().velocity_rad_s, -1.0, 0.05, "wrap 0->2pi reverse");
  }

  {
    std::fprintf(stderr, "test 0.1 quantized\n");
    double angle = 0.0;
    est.reset(0.0f);
    Run(est, 60, 0.1, 0.001, true, angle);
    const auto &s = est.state();
    assert(s.raw_velocity_rad_s > -0.2f);
    assert(s.raw_velocity_rad_s < 1.0f);
    assert(s.velocity_rad_s > 0.02f);
    assert(s.velocity_rad_s < 0.18f);
  }

  {
    std::fprintf(stderr, "test 0.5 quantized\n");
    double angle = 0.0;
    est.reset(0.0f);
    Run(est, 60, 0.5, 0.001, true, angle);
    ExpectNear(est.state().velocity_rad_s, 0.5, 0.10, "0.5 rad/s quantized");
  }

  {
    std::fprintf(stderr, "test 1.0 quantized\n");
    double angle = 0.0;
    est.reset(0.0f);
    Run(est, 40, 1.0, 0.001, true, angle);
    ExpectNear(est.state().velocity_rad_s, 1.0, 0.10, "1 rad/s quantized");
  }

  {
    std::fprintf(stderr, "test 2.0 quantized\n");
    double angle = 0.0;
    est.reset(0.0f);
    Run(est, 40, 2.0, 0.001, true, angle);
    ExpectNear(est.state().velocity_rad_s, 2.0, 0.10, "2 rad/s quantized");
  }

  {
    std::fprintf(stderr, "test -1 quantized\n");
    double angle = 0.0;
    est.reset(0.0f);
    Run(est, 40, -1.0, 0.001, true, angle);
    ExpectNear(est.state().velocity_rad_s, -1.0, 0.10, "-1 rad/s quantized");
  }

  {
    std::fprintf(stderr, "test startup\n");
    double angle = 0.0;
    est.reset(0.0f);
    Run(est, 3, 1.0, 0.001, false, angle);
    ExpectNear(est.state().velocity_rad_s, 1.0, 0.05,
               "startup partial window");
  }

  {
    std::fprintf(stderr, "test missed sample\n");
    double angle = 0.0;
    est.reset(0.0f);
    Run(est, 20, 1.0, 0.001, false, angle);
    angle = WrapAngle(angle + (1.0 * 0.002));
    est.update(static_cast<float>(angle), 0.002f);
    Run(est, 10, 1.0, 0.001, false, angle);
    const auto &s = est.state();
    assert(std::isfinite(s.velocity_rad_s));
    ExpectNear(s.velocity_rad_s, 1.0, 0.05,
               "missed sample recovers to +1 rad/s");
  }

  {
    std::fprintf(stderr, "test pll +1\n");
    control::RotorEstimator pll;
    double angle = 0.0;
    uint32_t ts = 0U;
    pll.reset(0.0f, 0U);
    RunPll(pll, 1000, 1.0, 100.0, false, angle, ts);
    ExpectNear(pll.state().velocity_rad_s, 1.0, 0.05, "pll +1 rad/s");
    assert(pll.state().pll_locked != 0U);
  }

  {
    std::fprintf(stderr, "test pll startup arbitrary angle\n");
    control::RotorEstimator pll;
    double angle = 5.0;
    uint32_t ts = 0U;
    pll.reset(0.0f, 0U);
    RunPll(pll, 1000, 1.0, 100.0, false, angle, ts);
    ExpectNear(pll.state().velocity_rad_s, 1.0, 0.05,
               "pll startup arbitrary angle");
    assert(pll.state().pll_locked != 0U);
  }

  {
    std::fprintf(stderr, "test pll -1\n");
    control::RotorEstimator pll;
    double angle = 0.0;
    uint32_t ts = 0U;
    pll.reset(0.0f, 0U);
    RunPll(pll, 1000, -1.0, 100.0, false, angle, ts);
    ExpectNear(pll.state().velocity_rad_s, -1.0, 0.05, "pll -1 rad/s");
  }

  {
    std::fprintf(stderr, "test pll +0.1 quantized\n");
    control::RotorEstimator pll;
    double angle = 0.0;
    uint32_t ts = 0U;
    pll.reset(0.0f, 0U);
    RunPll(pll, 3000, 0.1, 100.0, true, angle, ts);
    ExpectNear(pll.state().velocity_rad_s, 0.1, 0.03, "pll +0.1 quantized");
  }

  {
    std::fprintf(stderr, "test pll +0.5 quantized\n");
    control::RotorEstimator pll;
    double angle = 0.0;
    uint32_t ts = 0U;
    pll.reset(0.0f, 0U);
    RunPll(pll, 1500, 0.5, 100.0, true, angle, ts);
    ExpectNear(pll.state().velocity_rad_s, 0.5, 0.08, "pll +0.5 quantized");
  }

  {
    std::fprintf(stderr, "test pll +1 quantized\n");
    control::RotorEstimator pll;
    double angle = 0.0;
    uint32_t ts = 0U;
    pll.reset(0.0f, 0U);
    RunPll(pll, 1000, 1.0, 100.0, true, angle, ts);
    ExpectNear(pll.state().velocity_rad_s, 1.0, 0.08, "pll +1 quantized");
  }

  {
    std::fprintf(stderr, "test pll +2 quantized\n");
    control::RotorEstimator pll;
    double angle = 0.0;
    uint32_t ts = 0U;
    pll.reset(0.0f, 0U);
    RunPll(pll, 1000, 2.0, 100.0, true, angle, ts);
    ExpectNear(pll.state().velocity_rad_s, 2.0, 0.15, "pll +2 quantized");
  }

  {
    std::fprintf(stderr, "test pll wrap fwd\n");
    control::RotorEstimator pll;
    double angle = 6.2;
    uint32_t ts = 0U;
    pll.reset(static_cast<float>(angle), 0U);
    RunPll(pll, 1000, 1.0, 100.0, false, angle, ts);
    ExpectNear(pll.state().velocity_rad_s, 1.0, 0.05, "pll wrap fwd");
  }

  {
    std::fprintf(stderr, "test pll wrap rev\n");
    control::RotorEstimator pll;
    double angle = 0.1;
    uint32_t ts = 0U;
    pll.reset(static_cast<float>(angle), 0U);
    RunPll(pll, 1000, -1.0, 100.0, false, angle, ts);
    ExpectNear(pll.state().velocity_rad_s, -1.0, 0.05, "pll wrap rev");
  }

  {
    std::fprintf(stderr, "test pll jitter\n");
    control::RotorEstimator pll;
    double angle = 0.0;
    uint32_t ts = 0U;
    pll.reset(0.0f, 0U);
    RunPll(pll, 2000, 1.0, 100.0, false, angle, ts, 20, 20);
    ExpectNear(pll.state().velocity_rad_s, 1.0, 0.10, "pll jitter");
  }

  {
    std::fprintf(stderr, "test pll missing 5 frames\n");
    control::RotorEstimator pll;
    double angle = 0.0;
    uint32_t ts = 0U;
    pll.reset(0.0f, 0U);
    RunPll(pll, 500, 1.0, 100.0, false, angle, ts);
    for (int i = 0; i < 5; ++i) {
      angle = WrapAngle(angle + (1.0 * 100.0e-6));
      ts += 17000U;
      pll.predict(50.0e-6);
      pll.predict(50.0e-6);
    }
    RunPll(pll, 1000, 1.0, 100.0, false, angle, ts);
    ExpectNear(pll.state().velocity_rad_s, 1.0, 0.08,
               "pll recovers after missing frames");
  }

  {
    std::fprintf(stderr, "test pll angle jump rejected\n");
    control::RotorEstimator pll;
    double angle = 0.0;
    uint32_t ts = 0U;
    pll.reset(0.0f, 0U);
    RunPll(pll, 500, 1.0, 100.0, false, angle, ts);
    const float speed_before = pll.state().velocity_rad_s;
    angle = WrapAngle(angle + 0.5);
    ts += 17000U;
    pll.predict(50.0e-6);
    pll.predict(50.0e-6);
    pll.correct(static_cast<float>(angle), ts, ts);
    assert(std::fabs(pll.state().pll_angle_error_rad) > 0.25f);
    assert(std::fabs(pll.state().velocity_rad_s - speed_before) < 0.1f);
    RunPll(pll, 1000, 1.0, 100.0, false, angle, ts);
    ExpectNear(pll.state().velocity_rad_s, 1.0, 0.08,
               "pll recovers after rejected jump");
  }

  {
    std::fprintf(stderr, "test pll persistent outliers re-lock\n");
    control::RotorEstimator pll;
    double angle = 0.0;
    uint32_t ts = 0U;
    pll.reset(0.0f, 0U);
    RunPll(pll, 500, 1.0, 100.0, false, angle, ts);
    angle = WrapAngle(angle + 1.0);
    for (uint32_t i = 0U;
         i < control::RotorEstimator::kMaxRejectedInnovations;
         ++i) {
      ts += 17000U;
      pll.predict(100.0e-6f);
      pll.correct(static_cast<float>(angle), ts, ts);
    }
    assert(std::fabs(pll.state().velocity_rad_s) < 0.01f);
    assert(pll.state().pll_locked == 0U);
    RunPll(pll, 1000, 1.0, 100.0, false, angle, ts);
    ExpectNear(pll.state().velocity_rad_s, 1.0, 0.08,
               "pll recovers after persistent outliers");
  }

  {
    std::fprintf(stderr, "test pll velocity bounded\n");
    control::RotorEstimator pll;
    uint32_t ts = 0U;
    pll.reset(0.0f, 0U);
    for (int i = 0; i < 20000; ++i) {
      ts += 17000U;
      pll.predict(100.0e-6f);
      const float forced_angle =
          WrapAngle(pll.state().theta_mech_est_rad + 0.20f);
      pll.correct(forced_angle, ts, ts);
      assert(std::fabs(pll.state().velocity_rad_s) <=
             control::RotorEstimator::kMaxAbsVelocityRadS + 0.01f);
    }
  }

  {
    std::fprintf(stderr, "test pll speed step\n");
    control::RotorEstimator pll;
    double angle = 0.0;
    uint32_t ts = 0U;
    pll.reset(0.0f, 0U);
    RunPll(pll, 500, 1.0, 100.0, false, angle, ts);
    RunPll(pll, 1500, 2.0, 100.0, false, angle, ts);
    ExpectNear(pll.state().velocity_rad_s, 2.0, 0.10, "pll speed step");
  }

  {
    std::fprintf(stderr, "test pll reverse switch\n");
    control::RotorEstimator pll;
    double angle = 0.0;
    uint32_t ts = 0U;
    pll.reset(0.0f, 0U);
    RunPll(pll, 500, 1.0, 100.0, false, angle, ts);
    RunPll(pll, 2000, -1.0, 100.0, false, angle, ts);
    ExpectNear(pll.state().velocity_rad_s, -1.0, 0.10,
               "pll reverse switch");
  }

  {
    std::fprintf(stderr, "test pll delayed consume\n");
    control::RotorEstimator immediate;
    control::RotorEstimator delayed;
    double angle_immediate = 0.0;
    double angle_delayed = 0.0;
    uint32_t ts_immediate = 0U;
    uint32_t ts_delayed = 0U;
    RunPll(immediate, 1000, 1.0, 100.0, false, angle_immediate, ts_immediate);
    RunPll(delayed, 1000, 1.0, 100.0, false, angle_delayed, ts_delayed, 0, 50);
    ExpectNear(immediate.state().velocity_rad_s, 1.0, 0.05,
               "pll immediate consume");
    ExpectNear(delayed.state().velocity_rad_s, 1.0, 0.05,
               "pll delayed consume 50us");
    assert(std::fabs(delayed.state().velocity_rad_s -
                     immediate.state().velocity_rad_s) < 0.02f);
    ExpectNear(delayed.state().pll_measurement_dt_us, 100.0, 1.0,
               "delayed consume measurement_dt stays 100us");
    ExpectNear(delayed.state().encoder_sample_age_us, 50.0, 1.0,
               "delayed consume sample age 50us");
  }

  {
    std::fprintf(stderr, "test pll timestamp wrap\n");
    control::RotorEstimator pll;
    double angle = 0.0;
    uint32_t ts = 0xFFFFFF00U;
    pll.reset(0.0f, ts);
    RunPll(pll, 1000, 1.0, 100.0, false, angle, ts);
    ExpectNear(pll.state().velocity_rad_s, 1.0, 0.05,
               "pll DWT cycle wrap");
  }

  std::printf("RotorEstimator host tests passed\n");
  return 0;
}
