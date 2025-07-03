import cv2
import numpy as np
import time
import json
import logging
import websocket
from threading import Thread
import math

# Configure logging - only show INFO level and above
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("AIVision")

# Color detection ranges in HSV space
COLOR_RANGES = {
    'red': [
        {'lower': np.array([0, 100, 100]), 'upper': np.array([10, 255, 255])},
        {'lower': np.array([160, 100, 100]), 'upper': np.array([180, 255, 255])}
    ],
    'green': [
        {'lower': np.array([35, 100, 100]), 'upper': np.array([85, 255, 255])}
    ],
    'blue': [
        {'lower': np.array([100, 100, 100]), 'upper': np.array([140, 255, 255])}
    ]
}

class AIVisionProcessor:
    def __init__(self, server_url="ws://localhost:3000/?type=ai"):
        self.server_url = server_url
        self.ws = None
        self.connected = False
        self.processing_enabled = True
        self.last_log_time = 0
        self.frames_processed = 0
        self.detections_made = 0
        self.processing_times = []
        
        # Detection settings
        self.min_area = 500  # Minimum contour area to consider
        self.min_confidence = 0.6  # Minimum confidence to report
        
        # Duplicate detection prevention by position
        self.recent_detections = []  # Store recent detections with positions
        self.position_threshold = 50  # Pixels distance threshold for duplicate detection
        self.detection_timeout = 5.0  # Seconds to remember a detection position
        
        # Initialize connection
        self.connect()
    
    def connect(self):
        """Connect to WebSocket server"""
        try:
            self.ws = websocket.WebSocketApp(
                self.server_url,
                on_open=self.on_open,
                on_message=self.on_message,
                on_error=self.on_error,
                on_close=self.on_close
            )
            
            # Start WebSocket connection in a thread
            Thread(target=self.ws.run_forever).start()
        except Exception as e:
            logger.error(f"Connection error: {e}")
    
    def on_open(self, ws):
        """Called when WebSocket connection is established"""
        self.connected = True
        logger.info("Connected to server")
        
        # Send initialization message
        init_message = {
            "type": "ai_init",
            "capabilities": ["color_detection", "object_tracking"],
            "colors": list(COLOR_RANGES.keys()),
            "timestamp": time.time()
        }
        self.ws.send(json.dumps(init_message))
    
    def on_message(self, ws, message):
        """Handle incoming WebSocket messages"""
        if isinstance(message, bytes):
            # Process binary data (image frame)
            if self.processing_enabled:
                start_time = time.time()
                self.process_frame(message)
                self.frames_processed += 1
                
                # Track processing time
                processing_time = time.time() - start_time
                self.processing_times.append(processing_time)
                if len(self.processing_times) > 100:
                    self.processing_times.pop(0)
        else:
            # Process JSON messages
            try:
                data = json.loads(message)
                if data.get("type") == "control_status":
                    self.processing_enabled = data.get("enabled", True)
                    logger.info(f"AI processing {'enabled' if self.processing_enabled else 'disabled'}")
            except:
                pass
    
    def on_error(self, ws, error):
        """Handle WebSocket errors"""
        logger.error(f"WebSocket error: {error}")
    
    def on_close(self, ws, close_status_code, close_msg):
        """Handle WebSocket connection close"""
        self.connected = False
        logger.warning("Disconnected from server")
        
        # Try to reconnect after a delay
        time.sleep(5)
        logger.info("Attempting to reconnect...")
        self.connect()
    
    def binary_to_opencv(self, binary_data):
        """Convert binary data to OpenCV image"""
        nparr = np.frombuffer(binary_data, np.uint8)
        return cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    
    def calculate_distance(self, pos1, pos2):
        """Calculate Euclidean distance between two positions"""
        return math.sqrt((pos1[0] - pos2[0])**2 + (pos1[1] - pos2[1])**2)
    
    def is_duplicate_by_position(self, center_x, center_y, color):
        """Check if detection is duplicate based on position and color"""
        current_time = time.time()
        
        # Clean up old detections
        self.recent_detections = [
            det for det in self.recent_detections 
            if current_time - det['timestamp'] <= self.detection_timeout
        ]
        
        # Check if current detection is too close to recent ones
        for recent_det in self.recent_detections:
            if recent_det['color'] == color:
                distance = self.calculate_distance(
                    (center_x, center_y), 
                    (recent_det['center_x'], recent_det['center_y'])
                )
                if distance < self.position_threshold:
                    logger.debug(f"Duplicate {color} detection filtered (distance: {distance:.1f}px)")
                    return True
        
        return False
    
    def detect_colors(self, image):
        """Detect colored objects in image"""
        detections = []
        hsv_image = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        current_time = time.time()
        
        for color_name, ranges in COLOR_RANGES.items():
            # Create mask by combining all ranges for this color
            mask = np.zeros((image.shape[0], image.shape[1]), dtype=np.uint8)
            
            for range_set in ranges:
                color_mask = cv2.inRange(hsv_image, range_set['lower'], range_set['upper'])
                mask = cv2.bitwise_or(mask, color_mask)
            
            # Apply morphological operations to clean up mask
            kernel = np.ones((5, 5), np.uint8)
            mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
            mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
            
            # Find contours
            contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            
            # Process contours
            for contour in contours:
                area = cv2.contourArea(contour)
                
                # Filter small contours
                if area < self.min_area:
                    continue
                
                # Calculate confidence based on area and color match
                confidence = min(1.0, area / 10000)  # Scale by area up to 1.0
                
                # Skip low confidence detections
                if confidence < self.min_confidence:
                    continue
                
                # Get bounding rectangle and center
                x, y, w, h = cv2.boundingRect(contour)
                center_x = x + w // 2
                center_y = y + h // 2
                
                # Check if this detection is a duplicate by position
                if self.is_duplicate_by_position(center_x, center_y, color_name):
                    continue
                
                # Create detection object
                detection = {
                    'color': color_name,
                    'confidence': float(confidence),
                    'bbox': [int(x), int(y), int(w), int(h)],
                    'area': float(area),
                    'center_x': center_x,
                    'center_y': center_y,
                    'class': 'colored_object',
                    'timestamp': current_time
                }
                detections.append(detection)
                
                # Record this detection to prevent future duplicates
                self.recent_detections.append({
                    'color': color_name,
                    'center_x': center_x,
                    'center_y': center_y,
                    'timestamp': current_time
                })
                
                # Log this detection
                self.log_detection(detection)
                
        # Sort by confidence (highest first)
        detections.sort(key=lambda d: d['confidence'], reverse=True)
        return detections
    
    def log_detection(self, detection):
        """Log detection information - called only when objects are detected"""
        self.detections_made += 1
        
        # Only log once per second at most to avoid flooding
        current_time = time.time()
        if current_time - self.last_log_time >= 1.0:
            self.last_log_time = current_time
            logger.info(f"New {detection['color']} object at ({detection['center_x']}, {detection['center_y']}) with {detection['confidence']:.2f} confidence")
    
    def process_frame(self, frame_data):
        """Process an incoming camera frame"""
        # Convert binary data to OpenCV image
        image = self.binary_to_opencv(frame_data)
        
        if image is None:
            return
        
        # Perform color detection
        detections = self.detect_colors(image)
        
        # Send detection results if any were found
        if detections:
            self.send_detection_results(detections, image.shape)
    
    def send_detection_results(self, detections, image_shape):
        """Send detection results to server"""
        if not self.connected:
            return
        
        result_message = {
            'type': 'detection',
            'detections': detections,
            'frame_info': {
                'width': image_shape[1], 
                'height': image_shape[0]
            },
            'timestamp': time.time()
        }
        
        try:
            self.ws.send(json.dumps(result_message))
        except Exception as e:
            logger.error(f"Failed to send detection results: {e}")
    
    def send_statistics(self):
        """Send processing statistics to server"""
        if not self.connected:
            return
            
        avg_time = sum(self.processing_times) / len(self.processing_times) if self.processing_times else 0
        fps = 1.0 / avg_time if avg_time > 0 else 0
        
        stats_message = {
            'type': 'ai_statistics',
            'stats': {
                'frames_processed': self.frames_processed,
                'detections_made': self.detections_made,
                'avg_processing_time': avg_time,
                'recent_detections_count': len(self.recent_detections)
            },
            'processing_rate': fps,
            'timestamp': time.time()
        }
        
        try:
            self.ws.send(json.dumps(stats_message))
        except Exception as e:
            logger.error(f"Failed to send statistics: {e}")

# Main execution
if __name__ == "__main__":
    logger.info("AI Vision Module starting")
    
    # Create processor instance with server URL
    server_url = "ws://localhost:3000/?type=ai"
    processor = AIVisionProcessor(server_url)
    
    # Send statistics periodically
    while True:
        time.sleep(10)
        processor.send_statistics()
