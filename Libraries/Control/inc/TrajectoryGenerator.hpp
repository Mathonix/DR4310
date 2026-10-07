#ifndef TRAJECTORY_GENERATOR_HPP
#define TRAJECTORY_GENERATOR_HPP

namespace control {

struct TrajectoryRef {
  float position_rad = 0.0f;
  float velocity_rad_s = 0.0f;
  float acceleration_rad_s2 = 0.0f;
};

class TrajectoryGenerator {
 public:
  void init(float max_velocity_rad_s, float max_acceleration_rad_s2);
  void reset(float position_rad);
  void setTarget(float target_rad);
  void setLimits(float max_velocity_rad_s, float max_acceleration_rad_s2);
  const TrajectoryRef &update(float current_position_rad, float dt);
  const TrajectoryRef &state() const;

 private:
  static float Clamp(float value, float low, float high);

  TrajectoryRef ref_ = {};
  float target_rad_ = 0.0f;
  float max_velocity_rad_s_ = 1.0f;
  float max_acceleration_rad_s2_ = 5.0f;
  float last_velocity_rad_s_ = 0.0f;
  bool initialized_ = false;
};

}  // namespace control

#endif
