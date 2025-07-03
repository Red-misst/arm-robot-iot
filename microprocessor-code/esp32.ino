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

// Sequence execution
#define MAX_SEQUENCE_STEPS 30 // Maximum steps in a movement sequence
bool isExecutingSequence = false;
unsigned long nextStepTime = 0;

// Current joint positions
struct JointPositions {
  int base;      // Joint 0: Base rotation (0-180°)
  int shoulder;  // Joint 1: Shoulder (0-180°)
  int elbow;     // Joint 2: Elbow (0-180°)
  int gripper;   // Joint 3: Gripper (0=open, 180=closed)
};

// Globals
WebSocketsClient webSocket;
JointPositions currentPosition = {90, 90, 45, 30}; // Default startup position
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

// Move a specific servo to a position
void moveServoToAngle(uint8_t channel, int angle) {
    // Constrain angle to valid range
    angle = constrain(angle, 0, 180);
    
    // Get current angle for that channel
    int currentAngle = getCurrentAngle(channel);
    
    Serial.print("Moving servo ");
    Serial.print(channel);
    Serial.print(" from ");
    Serial.print(currentAngle);
    Serial.print("° to ");
    Serial.print(angle);
    Serial.println("°");
    
    // Move servo smoothly
    moveServoSmoothly(channel, currentAngle, angle);
    
    // Update current position
    updateCurrentPosition(channel, angle);
    
    // Send status update to report new position
    sendStatus();
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

// Process incoming commands - SIMPLIFIED VERSION
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
    DynamicJsonDocument doc(2048);  // Increased size for complex sequences
    DeserializationError error = deserializeJson(doc, jsonStr);
    free(jsonStr);
    
    if (error) {
        Serial.print("JSON parsing error: ");
        Serial.println(error.c_str());
        return;
    }
    
    // Process individual servo commands
    if (doc.containsKey("servo")) {
        Serial.println("Processing servo command");
        JsonObject servo = doc["servo"];
        
        if (servo.containsKey("channel") && servo.containsKey("angle")) {
            uint8_t channel = servo["channel"].as<uint8_t>();
            int angle = servo["angle"].as<int>();
            
            if (channel < 4) {  // We only have 4 servos (0-3)
                moveServoToAngle(channel, angle);
            } else {
                Serial.println("Invalid servo channel");
            }
        }
    }
    
    // Handle movement sequence
    else if (doc.containsKey("sequence")) {
        Serial.println("Processing movement sequence");
        executeMovementSequence(doc["sequence"]);
    }
    
    // Handle detection info (just store it, don't execute anything)
    else if (doc.containsKey("detection")) {
        Serial.println("Processing detection info");
        if (doc["detection"].containsKey("color")) {
            lastDetectedColor = doc["detection"]["color"].as<String>();
            Serial.print("Detected color: ");
            Serial.println(lastDetectedColor);
            // No automatic action - frontend will send sequence if needed
        }
    }
    
    // Send updated status after handling command
    sendStatus();
}

// Execute flexible movement sequence from frontend
void executeMovementSequence(JsonArray sequence) {
    if (isExecutingSequence) {
        Serial.println("Already executing a sequence - ignoring new request");
        return;
    }
    
    if (sequence.size() == 0 || sequence.size() > MAX_SEQUENCE_STEPS) {
        Serial.println("Invalid sequence size");
        return;
    }
    
    Serial.print("Starting sequence with ");
    Serial.print(sequence.size());
    Serial.println(" steps");
    
    isExecutingSequence = true;
    
    // Process each step in the sequence
    for (JsonObject step : sequence) {
        // Check if the step contains required fields
        if (!step.containsKey("joint") || (!step.containsKey("angle") && !step.containsKey("value"))) {
            Serial.println("Invalid step format - skipping");
            continue;
        }
        
        const char* jointName = step["joint"];
        // Support both "angle" and "value" field names for compatibility
        int angle = step.containsKey("angle") ? step["angle"].as<int>() : step["value"].as<int>();
        int delay_ms = 0;
        
        if (step.containsKey("delay")) {
            delay_ms = step["delay"].as<int>();
        }
        
        uint8_t channel;
        
        // Map joint name to channel
        if (strcmp(jointName, "base") == 0) {
            channel = 0;
        } else if (strcmp(jointName, "shoulder") == 0) {
            channel = 1;
        } else if (strcmp(jointName, "elbow") == 0) {
            channel = 2;
        } else if (strcmp(jointName, "gripper") == 0) {
            channel = 3;
        } else {
            Serial.print("Unknown joint name: ");
            Serial.println(jointName);
            continue;
        }
        
        Serial.print("Moving ");
        Serial.print(jointName);
        Serial.print(" to ");
        Serial.print(angle);
        Serial.print("° with ");
        Serial.print(delay_ms);
        Serial.println("ms delay");
        
        // Move the servo
        moveServoToAngle(channel, angle);
        
        // Apply delay if specified
        if (delay_ms > 0) {
            delay(delay_ms);
        }
    }
    
    isExecutingSequence = false;
    Serial.println("Sequence completed");
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
    doc["isExecutingSequence"] = isExecutingSequence;

    String message;
    serializeJson(doc, message);
    
    Serial.print("Sending status: ");
    Serial.println(message);
    
    webSocket.sendTXT(message);
}

// Get current angle for a specific channel
int getCurrentAngle(uint8_t channel) {
    switch(channel) {
        case 0: return currentPosition.base;
        case 1: return currentPosition.shoulder;
        case 2: return currentPosition.elbow;
        case 3: return currentPosition.gripper;
        default: return 90;
    }
}

// Update current position for a specific channel
void updateCurrentPosition(uint8_t channel, int angle) {
    switch(channel) {
        case 0: currentPosition.base = angle; break;
        case 1: currentPosition.shoulder = angle; break;
        case 2: currentPosition.elbow = angle; break;
        case 3: currentPosition.gripper = angle; break;
    }
}

// Connect to WiFi network
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
    Serial.println("\nRobot Arm Sequence Executor Starting...");
    
    // Initialize hardware - ESP32 Wire library initialization
    Wire.begin(SDA_PIN, SCL_PIN);
    pca9685.begin();
    pca9685.setPWMFreq(50);
    
    // Initialize each servo to its default position
    pca9685.setPWM(0, 0, map(currentPosition.base, 0, 180, SERVO_MIN, SERVO_MAX));
    pca9685.setPWM(1, 0, map(currentPosition.shoulder, 0, 180, SERVO_MIN, SERVO_MAX));
    pca9685.setPWM(2, 0, map(currentPosition.elbow, 0, 180, SERVO_MIN, SERVO_MAX));
    pca9685.setPWM(3, 0, map(currentPosition.gripper, 0, 180, SERVO_MIN, SERVO_MAX));
    
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
