# System Operation Flow with Predefined Positions

## Complete Sorting Workflow

```mermaid
sequenceDiagram
    participant C as ESP32-CAM
    participant S as Node.js Server
    participant A as AI Vision Engine
    participant R as ESP8266 Robot
    participant B as Conveyor Belt
    participant ARM as Robotic Arm

    Note over C,ARM: System Initialization
    C->>S: Connect WebSocket (camera feed)
    R->>S: Connect WebSocket (robot control)
    A->>S: Connect WebSocket (AI processing)
    R->>ARM: Move to REST POSITION
    R->>B: Start conveyor at low speed

    Note over C,ARM: Object Detection Phase
    C->>S: Send video frame (JPEG)
    S->>A: Forward frame for AI processing
    A->>A: YOLOv8 object detection
    A->>A: Color analysis (HSV)
    A->>S: Send detection result {color: "red", confidence: 0.95}

    Note over C,ARM: Sorting Execution Phase
    S->>R: Send detection {color: "red"}
    R->>B: Stop conveyor (precise positioning)
    R->>ARM: Move to PICKUP POSITION
    R->>ARM: Close gripper (grab object)
    R->>ARM: Lift to transport height
    R->>ARM: Move to RED_BIN POSITION (θ₁=45°)
    R->>ARM: Open gripper (release object)
    R->>ARM: Return to REST POSITION
    R->>B: Resume conveyor (next object)

    Note over C,ARM: Continuous Operation
    loop For each object
        C->>S: Video frame
        S->>A: Process frame
        A->>S: Detection result
        S->>R: Sorting command
        R->>ARM: Execute sequence
    end
```

## Position Templates in ESP8266

### Arm Position Definitions:
```cpp
struct ArmPosition {
  int base;      // Joint 0: Base rotation (0-180°)
  int shoulder;  // Joint 1: Shoulder angle
  int elbow;     // Joint 2: Elbow angle  
  int gripper;   // Joint 3: Gripper state
};

// Template positions stored in ESP8266 memory
ArmPosition restPosition = {90, 90, 45, 0};        // Safe home
ArmPosition pickupPosition = {90, 60, 120, 0};     // Object pickup
ArmPosition redBinPosition = {45, 90, 90, 180};    // Red sorting
ArmPosition greenBinPosition = {90, 90, 90, 180};  // Green sorting  
ArmPosition blueBinPosition = {135, 90, 90, 180};  // Blue sorting
```

## WebSocket Communication Protocol

### Detection Message Format:
```json
{
  "detection": {
    "color": "red|green|blue|unknown",
    "confidence": 0.95,
    "timestamp": "2025-06-22T10:30:45.123Z"
  }
}
```

### Robot Status Message:
```json
{
  "device": "robot_arm_conveyor",
  "conveyor": {
    "running": true,
    "stepsPerSecond": 15,
    "direction": 1,
    "type": "stepper"
  },
  "armPosition": {
    "base": 90,
    "shoulder": 90,
    "elbow": 45,
    "gripper": 0
  },
  "lastDetectedColor": "red"
}
```

### Conveyor Control Commands:
```json
{
  "conveyor": {
    "stepsPerSecond": 15,
    "direction": 1
  }
}
```

### Arm Position Commands:
```json
{
  "armPosition": "rest|pickup|red_bin|green_bin|blue_bin"
}
```

## Stepper Motor Control

### Advantages over DC Motor:
- **Precise Positioning**: Step-by-step control eliminates need for encoders
- **Repeatable Motion**: Consistent belt positioning for object pickup
- **Low Speed Stability**: Excellent performance at slow speeds
- **Simple Control**: No PID tuning required
- **Cost Effective**: Cheaper than DC motor + encoder systems

### Speed Control:
- **Range**: 5-50 steps/second
- **Resolution**: 2048 steps per revolution
- **Positioning**: ±1 step accuracy (~0.18° precision)
- **Control Method**: Variable delay between steps
