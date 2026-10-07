cmake_minimum_required(VERSION 3.22)

#
# This file is generated only once,
# and is not re-generated if converter is called multiple times.
#
# User is free to modify the file as much as necessary
#

# Setup compiler settings
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS ON)

# Business/control code is C++; CubeMX/HAL code remains C.
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS ON)


# Define the build type
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE "Debug")
endif()

# Set the project name
set(CMAKE_PROJECT_NAME 4310_G431KBT6)

# Enable compile command to ease indexing with e.g. clangd
set(CMAKE_EXPORT_COMPILE_COMMANDS TRUE)

# Core project settings
project(${CMAKE_PROJECT_NAME})
message("Build type: " ${CMAKE_BUILD_TYPE})

# Enable CMake support for ASM, C, and C++ languages
enable_language(C ASM CXX)

# Create an executable object type
add_executable(${CMAKE_PROJECT_NAME})

# Add STM32CubeMX generated sources
add_subdirectory(cmake/stm32cubemx)

# Link directories setup
target_link_directories(${CMAKE_PROJECT_NAME} PRIVATE
    # Add user defined library search paths
)

# Add sources to executable
target_sources(${CMAKE_PROJECT_NAME} PRIVATE
    Libraries/App/src/gm6020_can.c
    Libraries/App/src/calibration_store.c
    Libraries/App/src/control_app.cpp
    Libraries/Control/src/foc_control.cpp
    Libraries/Control/src/speed_controller.cpp
    Libraries/Control/src/position_controller.cpp
    Libraries/Control/src/trajectory_generator.cpp
    Libraries/Control/src/rotor_estimator.cpp
    Libraries/Control/src/pid.cpp
    Libraries/Control/src/current_loop.cpp
    Libraries/Control/src/svpwm.cpp
    Libraries/Control/src/motor_params.cpp
    Libraries/Control/src/motor_id.cpp
    Libraries/Control/src/cordic_math.cpp
    Libraries/Control/src/electrical_angle.cpp
    Libraries/Safety/src/FaultManager.cpp
    Libraries/Hardware/src/CurrentSense.cpp
    Libraries/Hardware/src/MT6701.cpp
    Libraries/Hardware/src/HardwareBridge.cpp
)

# Add include paths
target_include_directories(${CMAKE_PROJECT_NAME} PRIVATE
    Libraries/App/inc
    Libraries/Control/inc
    Libraries/Hardware/inc
    Libraries/Safety/inc
)

# Board identity is compiled into each image; never silently wrap invalid IDs.
set(MOTOR_CAN_ID "2" CACHE STRING "Motor CAN ID (1..7)")
if(NOT MOTOR_CAN_ID MATCHES "^[1-7]$")
    message(FATAL_ERROR "MOTOR_CAN_ID must be one integer in 1..7")
endif()
message(STATUS "Motor CAN ID: ${MOTOR_CAN_ID}")
# Add project symbols (macros)
target_compile_definitions(${CMAKE_PROJECT_NAME} PRIVATE
    MOTOR_CAN_ID=${MOTOR_CAN_ID}
)

# Remove wrong libob.a library dependency when using cpp files
list(REMOVE_ITEM CMAKE_C_IMPLICIT_LINK_LIBRARIES ob)

# Add linked libraries
target_link_libraries(${CMAKE_PROJECT_NAME}
    stm32cubemx

    # Add user defined libraries
)
