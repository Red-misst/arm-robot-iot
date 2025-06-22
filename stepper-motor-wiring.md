# Stepper Motor Wiring Diagram

## 28BYJ-48 Stepper Motor with ULN2003 Driver

### Pin Connections:
```
ESP8266 NodeMCU  <-->  ULN2003 Driver  <-->  28BYJ-48 Stepper
    D1 (GPIO5)   <-->      IN1         <-->    Coil A
    D2 (GPIO4)   <-->      IN2         <-->    Coil B  
    D3 (GPIO0)   <-->      IN3         <-->    Coil C
    D4 (GPIO2)   <-->      IN4         <-->    Coil D
    5V           <-->      VCC         <-->    Red Wire (+5V)
    GND          <-->      GND         <-->    Orange Wire (GND)
```

### Motor Specifications:
- **Type**: Unipolar Stepper Motor
- **Steps per Revolution**: 2048 (with internal 64:1 gearbox)
- **Voltage**: 5V DC
- **Current**: ~20mA per coil
- **Torque**: ~34.3 mN⋅m
- **Speed**: 5-50 steps/second optimal for conveyor belt

### Control Sequence:
The ULN2003 driver handles the complex coil switching sequence. The ESP8266 sends step pulses and direction control to move the conveyor belt at precise speeds.

### Conveyor Belt Integration:
- **Belt Drive**: Direct coupling or pulley system
- **Speed Control**: Variable steps per second (5-50 range)
- **Position Control**: Step counting for precise object positioning
- **Direction Control**: Forward/reverse for belt operation

### Code Implementation:
```cpp
#include <Stepper.h>
#define STEPS_PER_REVOLUTION 2048
Stepper conveyorStepper(STEPS_PER_REVOLUTION, D1, D3, D2, D4);

void setup() {
  conveyorStepper.setSpeed(10);  // 10 steps per second
}

void loop() {
  conveyorStepper.step(1);  // Move one step
  delay(100);               // Control timing
}
```
