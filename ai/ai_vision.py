import cv2
import numpy as np
import websocket
import threading
import json
import time
import base64
from io import BytesIO
from PIL import Image
import ssl

# Import ultralytics YOLO (make sure it's installed)
try:
    from ultralytics import YOLO
except ImportError:
    print("Error: YOLO not found. Please install with: pip install ultralytics")
    exit(1)

# Configuration
WS_SERVER = "ws://localhost:3000/?type=ai"
AI_CONTROL_ENABLED = False
DETECTION_INTERVAL = 0.1  # seconds between processing frames
MIN_CONFIDENCE = 0.5  # Minimum confidence threshold

# Colors to detect (in HSV space)
COLOR_RANGES = {
    'red': [
        (np.array([0, 100, 100]), np.array([10, 255, 255])),   # Lower red range
        (np.array([160, 100, 100]), np.array([180, 255, 255]))  # Upper red range
    ],
    'green': [(np.array([40, 100, 100]), np.array([80, 255, 255]))],
    'blue': [(np.array([100, 100, 100]), np.array([140, 255, 255]))]
}

# Global variables
latest_frame = None
robot_status = None
processing_frame = False
ws_app = None

# Track sorted objects
sorted_objects = {
    'red': 0,
    'green': 0,
    'blue': 0
}

# Initialize YOLO model
model = YOLO("yolov8n.pt")  # Using the nano model for speed

def process_frame(frame_data):
    global latest_frame, processing_frame
    
    if processing_frame:
        return
    
    processing_frame = True
    
    try:
        # Convert frame data to numpy array
        frame_bytes = np.frombuffer(frame_data, dtype=np.uint8)
        
        # Decode the image
        image = cv2.imdecode(frame_bytes, cv2.IMREAD_COLOR)
        if image is None:
            print("Failed to decode image")
            processing_frame = False
            return
        
        # Store latest frame
        latest_frame = image
        
        # Process with YOLO
        results = model(image)
        
        # Get standard YOLO detections (people, objects)
        yolo_detections = []
        for r in results:
            boxes = r.boxes
            for box in boxes:
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                conf = box.conf[0].item()
                cls = int(box.cls[0].item())
                class_name = model.names[cls]
                
                if conf > MIN_CONFIDENCE:
                    yolo_detections.append({
                        'class': class_name,
                        'confidence': conf,
                        'bbox': {
                            'x': float(x1) / image.shape[1],
                            'y': float(y1) / image.shape[0],
                            'width': float(x2 - x1) / image.shape[1],
                            'height': float(y2 - y1) / image.shape[0]
                        }
                    })
        
        # Convert to HSV for color detection
        hsv_image = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        
        # Color-based detection
        color_detections = []
        for color_name, ranges in COLOR_RANGES.items():
            # Create mask for this color
            mask = None
            for lower, upper in ranges:
                if mask is None:
                    mask = cv2.inRange(hsv_image, lower, upper)
                else:
                    mask = mask | cv2.inRange(hsv_image, lower, upper)
            
            # Find contours
            contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            
            # Filter by size and create detection objects
            for contour in contours:
                area = cv2.contourArea(contour)
                
                # Filter small noise
                if area > 500:  # Minimum area threshold
                    x, y, w, h = cv2.boundingRect(contour)
                    
                    # Calculate center point for robot control
                    center_x = x + (w // 2)
                    center_y = y + (h // 2)
                    
                    # Add to detections
                    color_detections.append({
                        'color': color_name,
                        'area': area,
                        'confidence': 1.0,  # Color detection confidence
                        'bbox': {
                            'x': float(x) / image.shape[1],
                            'y': float(y) / image.shape[0],
                            'width': float(w) / image.shape[1],
                            'height': float(h) / image.shape[0]
                        },
                        'center': {
                            'x': float(center_x) / image.shape[1],
                            'y': float(center_y) / image.shape[0]
                        }
                    })
        
        # Send all detections to the server
        if ws_app and ws_app.sock.connected:
            ws_app.send(json.dumps({
                'type': 'detection',
                'detections': color_detections + yolo_detections,
                'timestamp': time.time()
            }))
        
        # If AI control is enabled, process the largest colored object
        if AI_CONTROL_ENABLED and color_detections:
            # Sort by area (largest first)
            color_detections.sort(key=lambda x: x['area'], reverse=True)
            largest_object = color_detections[0]
            
            # Check if object is in the center of the frame
            if 0.4 <= largest_object['center']['x'] <= 0.6:
                handle_object_detection(largest_object)
    
    except Exception as e:
        print(f"Error processing frame: {e}")
    
    finally:
        processing_frame = False

def handle_object_detection(detection):
    global robot_status, sorted_objects
    
    if not robot_status:
        return
    
    color = detection['color']
    print(f"Processing {color} object")
    
    # Check if conveyor is already running
    if robot_status.get('conveyor', {}).get('running', False):
        return
        
    # Send command to start sorting sequence for this color
    if ws_app and ws_app.sock.connected:
        sorted_objects[color] += 1
        
        # First stop the conveyor
        ws_app.send(json.dumps({
            'type': 'robot_command',
            'command': {
                'conveyor': {
                    'stop': True
                }
            }
        }))
        
        time.sleep(0.5)  # Short pause
        
        # Different position based on color
        if color == 'red':
            target_angle = 180  # Right side
        elif color == 'green':
            target_angle = 90   # Middle
        elif color == 'blue':
            target_angle = 0    # Left side
        
        # Custom sequence for this color
        ws_app.send(json.dumps({
            'type': 'robot_command',
            'command': {
                'sequence': 'custom',
                'steps': [
                    # Move arm to position over object
                    {'servo': {'channel': 0, 'angle': 90}},
                    {'servo': {'channel': 1, 'angle': 60}},
                    {'servo': {'channel': 2, 'angle': 120}},
                    {'servo': {'channel': 3, 'angle': 90}},
                    
                    # Grab object (close gripper)
                    {'servo': {'channel': 3, 'angle': 180}},
                    {'delay': 500},
                    
                    # Lift up
                    {'servo': {'channel': 1, 'angle': 90}},
                    {'delay': 500},
                    
                    # Rotate to target position
                    {'servo': {'channel': 0, 'angle': target_angle}},
                    {'delay': 500},
                    
                    # Lower arm
                    {'servo': {'channel': 1, 'angle': 60}},
                    {'delay': 500},
                    
                    # Release object
                    {'servo': {'channel': 3, 'angle': 90}},
                    {'delay': 500},
                    
                    # Return to home
                    {'servo': {'channel': 1, 'angle': 90}},
                    {'servo': {'channel': 0, 'angle': 90}},
                    
                    # Restart conveyor
                    {'conveyor': {'speed': 150, 'direction': 1}}
                ]
            }
        }))
        
        print(f"Sent sorting command for {color} object. Total sorted: {sorted_objects}")

def on_message(ws, message):
    try:
        # Check if binary data (frame)
        if isinstance(message, bytes):
            process_frame(message)
            return
        
        # Parse JSON messages
        data = json.loads(message)
        print(f"Received message: {data.get('type', 'unknown')}")
        
        # Handle control status message
        if data.get('type') == 'control_status':
            global AI_CONTROL_ENABLED
            AI_CONTROL_ENABLED = data.get('enabled', False)
            print(f"AI control enabled: {AI_CONTROL_ENABLED}")
        
        # Handle robot status updates
        elif data.get('type') == 'robot_status':
            global robot_status
            robot_status = data.get('status', {})
    
    except Exception as e:
        print(f"Error in message handler: {e}")

def on_error(ws, error):
    print(f"WebSocket error: {error}")

def on_close(ws, close_status_code=None, close_reason=None):
    print(f"WebSocket connection closed: {close_status_code}, {close_reason}")
    # Try to reconnect after a delay
    time.sleep(5)
    connect_websocket()

def on_open(ws):
    print("WebSocket connection established")
    # Send initial message to server
    ws.send(json.dumps({
        "type": "hello",
        "client": "ai_vision",
        "version": "1.0"
    }))

def connect_websocket():
    global ws_app
    # Configure WebSocket connection
    websocket.enableTrace(False)  # Set to True for debugging
    
    # Create WebSocket connection
    ws_app = websocket.WebSocketApp(WS_SERVER,
                                    on_open=on_open,
                                    on_message=on_message,
                                    on_error=on_error,
                                    on_close=on_close)
    
    # Start WebSocket connection in a separate thread
    ws_thread = threading.Thread(target=ws_app.run_forever)
    ws_thread.daemon = True
    ws_thread.start()
    return ws_thread

if __name__ == "__main__":
    print("Starting AI vision system")
    
    try:
        # Connect to WebSocket server
        ws_thread = connect_websocket()
        
        # Keep the main thread running
        while True:
            time.sleep(1)
            
    except KeyboardInterrupt:
        print("Shutting down")
        if 'ws_app' in globals() and ws_app:
            ws_app.close()
