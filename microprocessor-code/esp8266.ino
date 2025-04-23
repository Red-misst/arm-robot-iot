#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>
#include <ESP8266WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

// PCA9685 servo driver setup
Adafruit_PWMServoDriver pca9685 = Adafruit_PWMServoDriver(0x40);

#define SERVO_MIN  150  // Minimum pulse length
#define SERVO_MAX  600  // Maximum pulse length
#define STEP_DELAY 10   // Delay for smooth movement

// L298N Motor Driver pins
#define MOTOR_ENA 14    // D5 - Enable pin for motor A
#define MOTOR_IN1 12    // D6 - Input 1 for direction control
#define MOTOR_IN2 13    // D7 - Input 2 for direction control

// WiFi credentials
const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";

// WebSocket server details
const char* webSocketHost = "192.168.1.100";  // Replace with your server IP
const uint16_t webSocketPort = 8080;
const char* webSocketPath = "/";

// Globals
WebSocketsClient webSocket;
int currentServoPositions[4] = {90, 90, 90, 90};  // Default positions for 4 servos
bool conveyorRunning = false;
int conveyorSpeed = 0;  // 0-255
int conveyorDirection = 1;  // 1=forward, -1=reverse

// Move servo smoothly
void moveServoSmoothly(uint8_t servoChannel, int startAngle, int endAngle) {
    int startPulse = map(startAngle, 0, 180, SERVO_MIN, SERVO_MAX);
    int endPulse = map(endAngle, 0, 180, SERVO_MIN, SERVO_MAX);

    int step = (startPulse < endPulse) ? 5 : -5; // Define direction

    for (int pulse = startPulse; (step > 0) ? (pulse <= endPulse) : (pulse >= endPulse); pulse += step) {
        pca9685.setPWM(servoChannel, 0, pulse);
        delay(STEP_DELAY); // Small delay for smooth transition
    }
    
    // Update the current position
    currentServoPositions[servoChannel] = endAngle;
}

// Control conveyor belt
void setConveyor(int speed, int direction) {
    // Ensure valid speed
    speed = constrain(speed, 0, 255);
    
    // Set direction pins
    if (direction > 0) {
        digitalWrite(MOTOR_IN1, HIGH);
        digitalWrite(MOTOR_IN2, LOW);
    } else {
        digitalWrite(MOTOR_IN1, LOW);
        digitalWrite(MOTOR_IN2, HIGH);
    }
    
    // Set speed
    analogWrite(MOTOR_ENA, speed);
    
    // Update globals
    conveyorSpeed = speed;
    conveyorDirection = direction;
    conveyorRunning = (speed > 0);
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
    StaticJsonDocument<256> doc;
    
    doc["device"] = "robot_arm_conveyor";
    doc["conveyor"]["running"] = conveyorRunning;
    doc["conveyor"]["speed"] = conveyorSpeed;
    doc["conveyor"]["direction"] = conveyorDirection;
    
    JsonArray servos = doc.createNestedArray("servos");
    for (int i = 0; i < 4; i++) {
        servos.add(currentServoPositions[i]);
    }
    
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
    
    // Check for conveyor commands
    if (doc.containsKey("conveyor")) {
        JsonObject conveyor = doc["conveyor"];
        if (conveyor.containsKey("speed") && conveyor.containsKey("direction")) {
            int speed = conveyor["speed"];
            int direction = conveyor["direction"];
            setConveyor(speed, direction);
        } else if (conveyor.containsKey("stop") && conveyor["stop"]) {
            setConveyor(0, 1);  // Stop the conveyor
        }
    }
    
    // Check for servo commands
    if (doc.containsKey("servo")) {
        JsonObject servo = doc["servo"];
        uint8_t channel = servo["channel"];
        int angle = servo["angle"];
        
        if (channel >= 0 && channel < 4 && angle >= 0 && angle <= 180) {
            moveServoSmoothly(channel, currentServoPositions[channel], angle);
        }
    }
    
    // Check for predefined sequence
    if (doc.containsKey("sequence")) {
        const char* sequence = doc["sequence"];
        executeSequence(sequence);
    }
    
    // Send updated status
    sendStatus();
}

// Execute predefined sequences
void executeSequence(const char* sequence) {
    if (strcmp(sequence, "pick_and_place") == 0) {
        // Example pick and place sequence
        setConveyor(200, 1);  // Start conveyor
        delay(2000);         // Wait for item to arrive
        setConveyor(0, 1);   // Stop conveyor
        
        // Position arm over item
        moveServoSmoothly(0, currentServoPositions[0], 90);  // Base
        moveServoSmoothly(1, currentServoPositions[1], 60);  // Shoulder
        moveServoSmoothly(2, currentServoPositions[2], 120); // Elbow
        
        // Close gripper (assuming servo 3 is the gripper)
        moveServoSmoothly(3, currentServoPositions[3], 180);
        
        // Lift item
        moveServoSmoothly(1, currentServoPositions[1], 90);
        
        // Rotate to destination
        moveServoSmoothly(0, currentServoPositions[0], 180);
        
        // Lower arm
        moveServoSmoothly(1, currentServoPositions[1], 60);
        
        // Open gripper
        moveServoSmoothly(3, currentServoPositions[3], 90);
        
        // Return to home position
        moveServoSmoothly(1, currentServoPositions[1], 90);
        moveServoSmoothly(0, currentServoPositions[0], 90);
    }
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
    
    // Initialize L298N pins
    pinMode(MOTOR_ENA, OUTPUT);
    pinMode(MOTOR_IN1, OUTPUT);
    pinMode(MOTOR_IN2, OUTPUT);
    digitalWrite(MOTOR_IN1, LOW);
    digitalWrite(MOTOR_IN2, LOW);
    analogWrite(MOTOR_ENA, 0);
    
    // Initialize PCA9685
    Wire.begin();
    pca9685.begin();
    pca9685.setPWMFreq(50);  // 50Hz frequency for servos
    Serial.println("PCA9685 Initialized!");
    
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
    
    // Maintain WebSocket connection
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("WiFi disconnected. Reconnecting...");
        connectToWiFi();
    }
}