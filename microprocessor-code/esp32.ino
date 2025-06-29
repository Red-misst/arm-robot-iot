#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

// PCA9685 servo driver setup
Adafruit_PWMServoDriver pca9685 = Adafruit_PWMServoDriver(0x40);

#define SERVO_MIN  150  // Minimum pulse length
#define SERVO_MAX  600  // Maximum pulse length
#define STEP_DELAY 10   // Delay for smooth movement

// Arm Position Definitions
struct ArmPosition {
  int base;      // Joint 0: Base rotation (0-180°)
  int shoulder;  // Joint 1: Shoulder (-90° to 90°, mapped to 0-180°)
  int elbow;     // Joint 2: Elbow (0-180°)
  int gripper;   // Joint 3: Gripper (0=open, 180=closed)
};

// Predefined arm positions
ArmPosition restPosition = {90, 90, 45, 0};
ArmPosition pickupPosition = {90, 60, 120, 0};
ArmPosition redBinPosition = {45, 90, 90, 180};
ArmPosition greenBinPosition = {90, 90, 90, 180};
ArmPosition blueBinPosition = {135, 90, 90, 180};

// Wi-Fi credentials
const char* ssid = "Tenda_5C30C8";
const char* password = "op898989..";

// WebSocket server details
const char* webSocketHost = "192.168.0.109";
const uint16_t webSocketPort = 3000;
const char* webSocketPath = "/?type=robot";

// Define ESP32 pins for I2C (standard ESP32 DevKit pins)
#define SDA_PIN 21  // GPIO21 (standard ESP32 SDA)
#define SCL_PIN 22  // GPIO22 (standard ESP32 SCL)

// Connection management
#define CONNECTION_CHECK_INTERVAL 5000    // Check connection every 5 seconds
#define HEARTBEAT_INTERVAL 15000          // Send heartbeat every 15 seconds
#define MAX_RECONNECT_ATTEMPTS 10         // Maximum reconnection attempts before resetting
unsigned long lastConnectionCheck = 0;
unsigned long lastHeartbeat = 0;
int reconnectAttempts = 0;
bool isConnected = false;

// Globals
WebSocketsClient webSocket;
ArmPosition currentPosition = restPosition;
String lastDetectedColor = "";

// Move servo smoothly
void moveServoSmoothly(uint8_t servoChannel, int startAngle, int endAngle) {
    int startPulse = map(startAngle, 0, 180, SERVO_MIN, SERVO_MAX);
    int endPulse = map(endAngle, 0, 180, SERVO_MIN, SERVO_MAX);
    int step = (startPulse < endPulse) ? 5 : -5;

    for (int pulse = startPulse; (step > 0) ? (pulse <= endPulse) : (pulse >= endPulse); pulse += step) {
        pca9685.setPWM(servoChannel, 0, pulse);
        delay(STEP_DELAY);
    }
}

// Move arm to predefined position
void moveToPosition(ArmPosition targetPosition) {
    moveServoSmoothly(0, currentPosition.base, targetPosition.base);
    moveServoSmoothly(1, currentPosition.shoulder, targetPosition.shoulder);
    moveServoSmoothly(2, currentPosition.elbow, targetPosition.elbow);
    moveServoSmoothly(3, currentPosition.gripper, targetPosition.gripper);
    currentPosition = targetPosition;
}

// Send heartbeat to keep connection alive
void sendHeartbeat() {
    StaticJsonDocument<128> doc;
    doc["type"] = "heartbeat";
    doc["device"] = "robot_arm";
    doc["uptime"] = millis();
    
    String message;
    serializeJson(doc, message);
    webSocket.sendTXT(message);
    Serial.println("Heartbeat sent");
}

// WebSocket event handler
void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
    switch(type) {
        case WStype_DISCONNECTED:
            Serial.println("WebSocket disconnected");
            isConnected = false;
            break;
            
        case WStype_CONNECTED:
            Serial.println("WebSocket connected");
            isConnected = true;
            reconnectAttempts = 0;
            // Send initial status upon connection
            delay(500);  // Short delay for connection stability
            sendStatus();
            break;
            
        case WStype_TEXT:
            Serial.println("Received text message");
            handleCommand(payload, length);
            break;
            
        case WStype_BIN:
            Serial.println("Received binary data - not supported");
            break;
            
        case WStype_PING:
            Serial.println("Received ping");
            break;
            
        case WStype_PONG:
            Serial.println("Received pong");
            break;
            
        case WStype_ERROR:
            Serial.println("WebSocket error");
            break;
            
        default:
            Serial.print("Unknown WebSocket event: ");
            Serial.println(type);
            break;
    }
}

// Process incoming commands - IMPROVED VERSION
void handleCommand(uint8_t* payload, size_t length) {
    // Create a null-terminated string from the payload
    char* jsonStr = (char*)malloc(length + 1);
    if (jsonStr == NULL) {
        Serial.println("Memory allocation failed");
        return;
    }
    
    memcpy(jsonStr, payload, length);
    jsonStr[length] = '\0';
    
    Serial.print("Received command: ");
    Serial.println(jsonStr);
    
    // Use a dynamic document for better memory management
    DynamicJsonDocument doc(1024);  // Increased size for more complex messages
    DeserializationError error = deserializeJson(doc, jsonStr);
    free(jsonStr);
    
    if (error) {
        Serial.print("JSON parsing error: ");
        Serial.println(error.c_str());
        return;
    }

    // Process detection commands
    if (doc.containsKey("detection")) {
        Serial.println("Processing detection command");
        const char* color = doc["detection"]["color"];
        if (color != NULL) {
            lastDetectedColor = String(color);
            Serial.print("Detected color: ");
            Serial.println(lastDetectedColor);
            executeSortingSequence(lastDetectedColor);
        }
    }
    
    // Process arm position commands
    else if (doc.containsKey("armPosition")) {
        Serial.println("Processing arm position command");
        const char* position = doc["armPosition"];
        if (position != NULL) {
            Serial.print("Moving to position: ");
            Serial.println(position);
            moveToNamedPosition(position);
        }
    }
    
    // Process individual servo commands
    else if (doc.containsKey("servo")) {
        Serial.println("Processing servo command");
        JsonObject servo = doc["servo"];
        
        if (servo.containsKey("channel") && servo.containsKey("angle")) {
            uint8_t channel = servo["channel"].as<uint8_t>();
            int angle = servo["angle"].as<int>();
            
            Serial.print("Moving servo channel ");
            Serial.print(channel);
            Serial.print(" to angle ");
            Serial.println(angle);
            
            moveServoSmoothly(channel, getCurrentAngle(channel), angle);
            updateCurrentPosition(channel, angle);
        }
    }
    
    // Acknowledge receipt of command with updated status
    sendStatus();
}

// Improved sendStatus function to ensure format matches what server expects
void sendStatus() {
    DynamicJsonDocument doc(1024);  // Larger buffer for complex status
    
    // Basic device identification
    doc["device"] = "robot_arm";
    doc["status"] = "ok";
    
    // Arm position status
    JsonObject position = doc.createNestedObject("armPosition");
    position["base"] = currentPosition.base;
    position["shoulder"] = currentPosition.shoulder;
    position["elbow"] = currentPosition.elbow;
    position["gripper"] = currentPosition.gripper;

    // Additional info
    doc["lastDetectedColor"] = lastDetectedColor;
    doc["timestamp"] = millis();
    doc["freeHeap"] = ESP.getFreeHeap();  // ESP32 compatible heap function

    String message;
    serializeJson(doc, message);
    
    Serial.print("Sending status: ");
    Serial.println(message);
    
    webSocket.sendTXT(message);
}

// Add this new function to confirm receipt of commands
void acknowledgeCommand(const char* commandType) {
    DynamicJsonDocument doc(256);
    doc["device"] = "robot_arm";
    doc["type"] = "ack";
    doc["command"] = commandType;
    doc["status"] = "received";
    doc["timestamp"] = millis();
    
    String message;
    serializeJson(doc, message);
    webSocket.sendTXT(message);
    Serial.print("Sent command acknowledgement: ");
    Serial.println(message);
}

int getCurrentAngle(uint8_t channel) {
    switch(channel) {
        case 0: return currentPosition.base;
        case 1: return currentPosition.shoulder;
        case 2: return currentPosition.elbow;
        case 3: return currentPosition.gripper;
        default: return 90;
    }
}

void updateCurrentPosition(uint8_t channel, int angle) {
    switch(channel) {
        case 0: currentPosition.base = angle; break;
        case 1: currentPosition.shoulder = angle; break;
        case 2: currentPosition.elbow = angle; break;
        case 3: currentPosition.gripper = angle; break;
    }
}

void moveToNamedPosition(const char* name) {
    if (strcmp(name, "rest") == 0) moveToPosition(restPosition);
    else if (strcmp(name, "pickup") == 0) moveToPosition(pickupPosition);
    else if (strcmp(name, "red_bin") == 0) moveToPosition(redBinPosition);
    else if (strcmp(name, "green_bin") == 0) moveToPosition(greenBinPosition);
    else if (strcmp(name, "blue_bin") == 0) moveToPosition(blueBinPosition);
}

void executeSortingSequence(String color) {
    moveToPosition(pickupPosition);
    delay(1000);
    ArmPosition grab = pickupPosition; grab.gripper = 180;
    moveToPosition(grab);
    delay(1000);
    ArmPosition lift = grab; lift.shoulder = 90;
    moveToPosition(lift);
    delay(500);

    if (color.equalsIgnoreCase("red")) moveToPosition(redBinPosition);
    else if (color.equalsIgnoreCase("green")) moveToPosition(greenBinPosition);
    else if (color.equalsIgnoreCase("blue")) moveToPosition(blueBinPosition);
    else moveToPosition(greenBinPosition);

    delay(1000);
    ArmPosition release = currentPosition; release.gripper = 0;
    moveToPosition(release);
    delay(1000);
    moveToPosition(restPosition);
}

void connectToWiFi() {
    Serial.println("Connecting to WiFi...");
    WiFi.disconnect();
    delay(1000);
    WiFi.mode(WIFI_STA);
    WiFi.begin(ssid, password);
    
    // Try for 20 seconds (40 * 500ms = 20s)
    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 40) {
        delay(500);
        Serial.print(".");
        attempts++;
    }
    
    if (WiFi.status() == WL_CONNECTED) {
        Serial.println("\nWiFi connected");
        Serial.print("IP address: ");
        Serial.println(WiFi.localIP());
    } else {
        Serial.println("\nWiFi connection failed");
        // Reset ESP32 after multiple failed attempts
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            Serial.println("Too many reconnect attempts, restarting ESP...");
            ESP.restart();
        }
    }
}

void setup() {
    Serial.begin(115200);
    delay(1000);
    Serial.println("\nRobot Arm Control System Starting...");
    
    // Initialize hardware - ESP32 Wire library initialization
    Wire.begin(SDA_PIN, SCL_PIN);
    pca9685.begin();
    pca9685.setPWMFreq(50);
    moveToPosition(restPosition);
    
    // Connect to WiFi
    connectToWiFi();
    
    // Configure WebSocket with better settings
    webSocket.begin(webSocketHost, webSocketPort, webSocketPath);
    webSocket.onEvent(webSocketEvent);
    webSocket.setReconnectInterval(2000);       // More aggressive reconnect (2 seconds)
    webSocket.enableHeartbeat(25000, 3000, 2);  // Enable heartbeat with 25s interval, 3s timeout, 2 retries
    
    lastConnectionCheck = millis();
    lastHeartbeat = millis();
    Serial.println("Setup complete!");
}

void loop() {
    webSocket.loop();
    
    unsigned long currentTime = millis();
    
    // Check connection health periodically
    if (currentTime - lastConnectionCheck > CONNECTION_CHECK_INTERVAL) {
        lastConnectionCheck = currentTime;
        
        // Check WiFi connection
        if (WiFi.status() != WL_CONNECTED) {
            Serial.println("WiFi disconnected, reconnecting...");
            reconnectAttempts++;
            connectToWiFi();
        }
        
        // If connected to WiFi but not to WebSocket server, reconnect WebSocket
        if (WiFi.status() == WL_CONNECTED && !isConnected) {
            Serial.println("WebSocket disconnected, reconnecting...");
            webSocket.disconnect();
            delay(500);
            webSocket.begin(webSocketHost, webSocketPort, webSocketPath);
        }
    }
    
    // Send heartbeat periodically to keep connection alive
    if (isConnected && currentTime - lastHeartbeat > HEARTBEAT_INTERVAL) {
        lastHeartbeat = currentTime;
        sendHeartbeat();
    }
    
    // Reset device if too many reconnection attempts have occurred
    if (!isConnected && reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        Serial.println("Max reconnect attempts reached, resetting ESP...");
        delay(1000);
        ESP.restart();
    }
}
