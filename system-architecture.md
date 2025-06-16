# ARM Robot IoT System Architecture

```mermaid
graph TB
    subgraph Physical["Physical Layer"]
        ConveyorMotor["Conveyor Motor<br/>DC Motor + Encoder"]
        ConveyorBelt["Conveyor Belt System"]
        Objects["Objects on Belt"]
        ESP32CAM["ESP32-CAM Vision Sensor"]
        RoboticArm["4-DOF Robotic Arm"]
        SortingBins["Sorting Bins<br/>Red Green Blue"]
        
        Objects --> ConveyorBelt
        ConveyorMotor --> ConveyorBelt
        ConveyorBelt --> ESP32CAM
        ESP32CAM -.-> Objects
        RoboticArm --> SortingBins
    end
    
    subgraph Edge["Edge Computing Layer"]
        ESP8266["ESP8266 Controller"]
        CameraStream["Video Stream<br/>60 FPS"]
        
        ESP32CAM --> CameraStream
        ESP8266 --> ConveyorMotor
        ESP8266 --> RoboticArm
    end
    
    subgraph Communication["Communication Layer"]
        WebSocketServer["Node.js WebSocket Server"]
        HTTPServer["HTTP Server"]
        
        CameraStream --> WebSocketServer
        ESP8266 <--> WebSocketServer
    end
    
    subgraph Processing["Processing Layer"]
        AIVision["Python AI Vision Engine<br/>YOLOv8 + OpenCV"]
        DecisionEngine["Sorting Decision Logic"]
        TrajectoryPlanner["Robot Path Planning"]
        
        WebSocketServer --> AIVision
        AIVision --> DecisionEngine
        DecisionEngine --> TrajectoryPlanner
        TrajectoryPlanner --> WebSocketServer
    end
    
    subgraph Application["Application Layer"]
        WebUI["Web User Interface"]
        DataLogger["Data Logging System"]
        Dashboard["Real-time Dashboard"]
        
        WebSocketServer <--> WebUI
        WebSocketServer --> DataLogger
        WebUI --> Dashboard
    end
    
    subgraph User["User Layer"]
        Operator["Human Operator"]
        Operator --> WebUI
    end
```
