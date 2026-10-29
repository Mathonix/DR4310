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
    Libraries/App/src/store_record.c
    Libraries/App/src/device_config.c
    Libraries/App/src/ascii_util.c
    Libraries/App/src/control_app.cpp
    Libraries/Control/src/foc_control.cpp
    Libraries/Control/src/cogging_compensator.cpp
    Libraries/Control/src/overload_limiter.cpp
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
    Core/Src/dma_irq_profile.c
)

# main builds the standard controller. Keep v6 parameter/cogging compatibility
# with the shared code, but do not link any audio receiver or PCM implementation.
set(DR4310_AUDIO_ENABLED "0" CACHE STRING "Standard branch: audio is disabled")
if(NOT DR4310_AUDIO_ENABLED STREQUAL "0")
    message(FATAL_ERROR "main is the standard firmware branch; DR4310_AUDIO_ENABLED must be 0")
endif()
set(DR4310_UART_BAUD "200000" CACHE STRING "USART1 line rate")
if(NOT DR4310_UART_BAUD MATCHES "^(200000|230400)$")
    message(FATAL_ERROR "DR4310_UART_BAUD must be 200000 or 230400")
endif()
option(DR4310_FOC_OPTIMIZE "Use -O2 for Release control math" ON)
option(DR4310_FAST_ANGLE_WRAP "Bypass fmod for already bounded angles" ON)
option(DR4310_ADC_HALF_IRQ "Keep unused ADC half IRQ for A/B measurement" OFF)
option(DR4310_ENCODER_HALF_IRQ "Keep unused encoder RX half IRQ for A/B measurement" OFF)
option(DR4310_IRQ_PROFILE "Instrument DMA IRQ handler bodies for A/B measurement" OFF)
if(DR4310_FOC_OPTIMIZE)
    set_property(SOURCE
        Libraries/Control/src/foc_control.cpp
        Libraries/Control/src/rotor_estimator.cpp
        Libraries/Control/src/cordic_math.cpp
        Libraries/Control/src/electrical_angle.cpp
        Libraries/Control/src/cogging_compensator.cpp
        Libraries/Control/src/current_loop.cpp
        Libraries/Control/src/pid.cpp
        APPEND PROPERTY COMPILE_OPTIONS "$<$<CONFIG:Release>:-O2>"
    )
endif()

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
    DEVICE_UART_BAUD=${DR4310_UART_BAUD}U
    DR4310_AUDIO_ENABLED=0
    DR4310_FOC_OPTIMIZE=$<BOOL:${DR4310_FOC_OPTIMIZE}>
    DR4310_FAST_ANGLE_WRAP=$<BOOL:${DR4310_FAST_ANGLE_WRAP}>
    DR4310_ADC_HALF_IRQ=$<BOOL:${DR4310_ADC_HALF_IRQ}>
    DR4310_ENCODER_HALF_IRQ=$<BOOL:${DR4310_ENCODER_HALF_IRQ}>
    DR4310_IRQ_PROFILE=$<BOOL:${DR4310_IRQ_PROFILE}>
)

# Remove wrong libob.a library dependency when using cpp files
list(REMOVE_ITEM CMAKE_C_IMPLICIT_LINK_LIBRARIES ob)

# Add linked libraries
target_link_libraries(${CMAKE_PROJECT_NAME}
    stm32cubemx

    # Add user defined libraries
)
