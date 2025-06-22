#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>
#include <ESP8266WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <Stepper.h>

// PCA9685 servo driver setup
Adafruit_PWMServoDriver pca9685 = Adafruit_PWMServoDriver(0x40);

#define SERVO_MIN  150  // Minimum pulse length
#define SERVO_MAX  600  // Maximum pulse length
#define STEP_DELAY 10   // Delay for smooth movement

// Stepper Motor Configuration for Conveyor Belt
#define STEPS_PER_REVOLUTION 2048  // 28BYJ-48 stepper motor
#define STEPPER_PIN1 D1   // IN1
#define STEPPER_PIN2 D2   // IN2  
#define STEPPER_PIN3 D3   // IN3
#define STEPPER_PIN4 D4   // IN4
Stepper conveyorStepper(STEPS_PER_REVOLUTION, STEPPER_PIN1, STEPPER_PIN3, STEPPER_PIN2, STEPPER_PIN4);

// Arm Position Definitions
struct ArmPosition {
  int base;      // Joint 0: Base rotation (0-180°)
  int shoulder;  // Joint 1: Shoulder (-90° to 90°, mapped to 0-180°)
  int elbow;     // Joint 2: Elbow (0-180°)
  int gripper;   // Joint 3: Gripper (0=open, 180=closed)
};

// Predefined arm positions
ArmPosition restPosition = {90, 90, 45, 0};      // Home/rest position
ArmPosition pickupPosition = {90, 60, 120, 0};   // Position for picking up objects
ArmPosition redBinPosition = {45, 90, 90, 180};  // Red bin sorting position
ArmPosition greenBinPosition = {90, 90, 90, 180}; // Green bin sorting position  
ArmPosition blueBinPosition = {135, 90, 90, 180}; // Blue bin sorting position

// WiFi credentials
const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";

// WebSocket server details
const char* webSocketHost = "192.168.1.100";  // Replace with your server IP
const uint16_t webSocketPort = 3000;
const char* webSocketPath = "/?type=robot";

// Globals
WebSocketsClient webSocket;
ArmPosition currentPosition = restPosition;  // Current arm position
bool conveyorRunning = false;
int conveyorStepsPerSecond = 10;  // Stepper motor speed
int conveyorDirection = 1;  // 1=forward, -1=reverse
String lastDetectedColor = "";  // Store last detected object color

// Move servo smoothly
void moveServoSmoothly(uint8_t servoChannel, int startAngle, int endAngle) {
    int startPulse = map(startAngle, 0, 180, SERVO_MIN, SERVO_MAX);
    int endPulse = map(endAngle, 0, 180, SERVO_MIN, SERVO_MAX);

    int step = (startPulse < endPulse) ? 5 : -5; // Define direction

    for (int pulse = startPulse; (step > 0) ? (pulse <= endPulse) : (pulse >= endPulse); pulse += step) {
        pca9685.setPWM(servoChannel, 0, pulse);
        delay(STEP_DELAY); // Small delay for smooth transition
    }
}

// Move arm to predefined position
void moveToPosition(ArmPosition targetPosition) {
    Serial.println("Moving arm to position...");
    
    // Move servos simultaneously for smoother operation
    moveServoSmoothly(0, currentPosition.base, targetPosition.base);
    moveServoSmoothly(1, currentPosition.shoulder, targetPosition.shoulder);
    moveServoSmoothly(2, currentPosition.elbow, targetPosition.elbow);
    moveServoSmoothly(3, currentPosition.gripper, targetPosition.gripper);
    
    // Update current position
    currentPosition = targetPosition;
    Serial.println("Position reached!");
}

// Control conveyor belt with stepper motor
void setConveyorStepper(int stepsPerSecond, int direction) {
    conveyorStepsPerSecond = constrain(stepsPerSecond, 0, 50);
    conveyorDirection = direction;
    conveyorRunning = (stepsPerSecond > 0);
    
    if (conveyorRunning) {
        conveyorStepper.setSpeed(conveyorStepsPerSecond);
        Serial.printf("Conveyor: %d steps/sec, direction: %d\n", stepsPerSecond, direction);
    } else {
        Serial.println("Conveyor stopped");
    }
}

// Run conveyor for specified steps
void runConveyorSteps(int steps) {
    if (conveyorRunning) {
        int totalSteps = steps * conveyorDirection;
        conveyorStepper.step(totalSteps);
    }
}

// Control conveyor belt
void setConveyor(int speed, int direction) {
    // Legacy function for backward compatibility
    setConveyorStepper(speed / 10, direction);  // Convert PWM speed to steps/sec
}

// WebSocket event handler
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
    switch(type) {
        case WStype_DISCONNECTED:
            Serial.println("WebSocket disconnected");
            break;
        case WStype_CONNECTED:
            Serial.println("WebSocket connected");
            // Send initial status to server
            sendStatus();
            break;
        case WStype_TEXT:
            Serial.printf("Received message: %s\n", payload);
            handleCommand(payload, length);
            break;
    }
}

// Send current status to server
void sendStatus() {
    StaticJsonDocument<512> doc;
    
    doc["device"] = "robot_arm_conveyor";
    doc["conveyor"]["running"] = conveyorRunning;
    doc["conveyor"]["stepsPerSecond"] = conveyorStepsPerSecond;
    doc["conveyor"]["direction"] = conveyorDirection;
    doc["conveyor"]["type"] = "stepper";
    
    // Current arm position
    JsonObject position = doc.createNestedObject("armPosition");
    position["base"] = currentPosition.base;
    position["shoulder"] = currentPosition.shoulder;
    position["elbow"] = currentPosition.elbow;
    position["gripper"] = currentPosition.gripper;
    
    doc["lastDetectedColor"] = lastDetectedColor;
    doc["timestamp"] = millis();
    
    String message;
    serializeJson(doc, message);
    webSocket.sendTXT(message);
}

// Process commands from the server
void handleCommand(uint8_t* payload, size_t length) {
    StaticJsonDocument<512> doc;
    DeserializationError error = deserializeJson(doc, payload, length);
    
    if (error) {
        Serial.print("deserializeJson() failed: ");
        Serial.println(error.c_str());
        return;
    }
    
    // Handle object detection results from AI
    if (doc.containsKey("detection")) {
        JsonObject detection = doc["detection"];
        if (detection.containsKey("color")) {
            String detectedColor = detection["color"].as<String>();
            lastDetectedColor = detectedColor;
            Serial.printf("Object detected: %s\n", detectedColor.c_str());
            
            // Execute sorting sequence based on detected color
            executeSortingSequence(detectedColor);
        }
    }
    
    // Check for conveyor commands
    if (doc.containsKey("conveyor")) {
        JsonObject conveyor = doc["conveyor"];
        if (conveyor.containsKey("stepsPerSecond") && conveyor.containsKey("direction")) {
            int stepsPerSecond = conveyor["stepsPerSecond"];
            int direction = conveyor["direction"];
            setConveyorStepper(stepsPerSecond, direction);
        } else if (conveyor.containsKey("steps")) {
            int steps = conveyor["steps"];
            runConveyorSteps(steps);
        } else if (conveyor.containsKey("stop") && conveyor["stop"]) {
            setConveyorStepper(0, 1);  // Stop the conveyor
        }
    }
    
    // Check for arm position commands
    if (doc.containsKey("armPosition")) {
        const char* positionName = doc["armPosition"];
        moveToNamedPosition(positionName);
    }
    
    // Check for manual servo commands (for testing/calibration)
    if (doc.containsKey("servo")) {
        JsonObject servo = doc["servo"];
        uint8_t channel = servo["channel"];
        int angle = servo["angle"];
        
        if (channel >= 0 && channel < 4 && angle >= 0 && angle <= 180) {
            moveServoSmoothly(channel, getCurrentAngle(channel), angle);
            updateCurrentPosition(channel, angle);
        }
    }
    
    // Send updated status
    sendStatus();
}

// Get current angle for a specific servo channel
int getCurrentAngle(uint8_t channel) {
    switch(channel) {
        case 0: return currentPosition.base;
        case 1: return currentPosition.shoulder;
        case 2: return currentPosition.elbow;
        case 3: return currentPosition.gripper;
        default: return 90;
    }
}

// Update current position for a specific servo channel
void updateCurrentPosition(uint8_t channel, int angle) {
    switch(channel) {
        case 0: currentPosition.base = angle; break;
        case 1: currentPosition.shoulder = angle; break;
        case 2: currentPosition.elbow = angle; break;
        case 3: currentPosition.gripper = angle; break;
    }
}

// Move to named position
void moveToNamedPosition(const char* positionName) {
    Serial.printf("Moving to position: %s\n", positionName);
    
    if (strcmp(positionName, "rest") == 0) {
        moveToPosition(restPosition);
    } else if (strcmp(positionName, "pickup") == 0) {
        moveToPosition(pickupPosition);
    } else if (strcmp(positionName, "red_bin") == 0) {
        moveToPosition(redBinPosition);
    } else if (strcmp(positionName, "green_bin") == 0) {
        moveToPosition(greenBinPosition);
    } else if (strcmp(positionName, "blue_bin") == 0) {
        moveToPosition(blueBinPosition);
    } else {
        Serial.printf("Unknown position: %s\n", positionName);
    }
}

// Execute sorting sequence based on detected object color
void executeSortingSequence(String detectedColor) {
    Serial.printf("Executing sorting sequence for: %s\n", detectedColor.c_str());
    
    // Step 1: Stop conveyor to position object
    setConveyorStepper(0, 1);
    delay(500);
    
    // Step 2: Move to pickup position
    moveToPosition(pickupPosition);
    delay(1000);
    
    // Step 3: Close gripper to grab object
    ArmPosition grabPosition = pickupPosition;
    grabPosition.gripper = 180;  // Close gripper
    moveToPosition(grabPosition);
    delay(1000);
    
    // Step 4: Lift object slightly
    ArmPosition liftPosition = grabPosition;
    liftPosition.shoulder = 90;  // Lift up
    moveToPosition(liftPosition);
    delay(500);
    
    // Step 5: Move to appropriate bin based on color
    if (detectedColor.equalsIgnoreCase("red")) {
        moveToPosition(redBinPosition);
    } else if (detectedColor.equalsIgnoreCase("green")) {
        moveToPosition(greenBinPosition);
    } else if (detectedColor.equalsIgnoreCase("blue")) {
        moveToPosition(blueBinPosition);
    } else {
        // Default to green bin for unknown objects
        Serial.println("Unknown color, using green bin");
        moveToPosition(greenBinPosition);
    }
    delay(1000);
    
    // Step 6: Open gripper to release object
    ArmPosition releasePosition = currentPosition;
    releasePosition.gripper = 0;  // Open gripper
    moveToPosition(releasePosition);
    delay(1000);
    
    // Step 7: Return to rest position
    moveToPosition(restPosition);
    delay(500);
    
    // Step 8: Restart conveyor for next object
    setConveyorStepper(15, 1);  // Resume conveyor at moderate speed
    
    Serial.println("Sorting sequence completed!");
}

void connectToWiFi() {
    Serial.print("Connecting to WiFi");
    WiFi.begin(ssid, password);
    
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    
    Serial.println();
    Serial.print("Connected! IP address: ");
    Serial.println(WiFi.localIP());
}

void setup() {
    Serial.begin(115200);
    
    // Initialize stepper motor pins
    pinMode(STEPPER_PIN1, OUTPUT);
    pinMode(STEPPER_PIN2, OUTPUT);
    pinMode(STEPPER_PIN3, OUTPUT);
    pinMode(STEPPER_PIN4, OUTPUT);
    
    // Set initial stepper speed
    conveyorStepper.setSpeed(10);  // Default 10 steps per second
    
    // Initialize PCA9685
    Wire.begin();
    pca9685.begin();
    pca9685.setPWMFreq(50);  // 50Hz frequency for servos
    Serial.println("PCA9685 Initialized!");
    
    // Move to initial rest position
    moveToPosition(restPosition);
    Serial.println("Arm moved to rest position");
    
    // Connect to WiFi
    connectToWiFi();
    
    // Initialize WebSocket connection
    webSocket.begin(webSocketHost, webSocketPort, webSocketPath);
    webSocket.onEvent(webSocketEvent);
    webSocket.setReconnectInterval(5000);
    
    Serial.println("System initialized and ready!");
}

void loop() {
    webSocket.loop();
    
    // Run conveyor continuously if enabled
    if (conveyorRunning) {
        runConveyorSteps(1);  // Move one step at a time for smooth operation
        delay(1000 / max(1, conveyorStepsPerSecond));  // Control speed
    }
    
    // Maintain WebSocket connection
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("WiFi disconnected. Reconnecting...");
        connectToWiFi();
    }
}