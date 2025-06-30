import cv2
import numpy as np
import json
import time
import threading
import websocket
import logging
from io import BytesIO
from PIL import Image
import sys
import os
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# Configuration
WS_SERVER = "ws://localhost:3000/?type=ai"
DETECTION_INTERVAL = 0.15  # Process every 150ms (6-7 FPS)
MIN_CONTOUR_AREA = 1000    # Minimum area to consider as valid object
MORPHOLOGY_KERNEL_SIZE = 5  # For noise removal

# Enhanced logging setup
class ColoredFormatter(logging.Formatter):
    """Colored log formatter for better visibility"""
    
    COLORS = {
        'DEBUG': '\033[36m',    # Cyan
        'INFO': '\033[32m',     # Green
        'WARNING': '\033[33m',  # Yellow
        'ERROR': '\033[31m',    # Red
        'CRITICAL': '\033[35m', # Magenta
    }
    RESET = '\033[0m'
    
    def format(self, record):
        log_color = self.COLORS.get(record.levelname, self.RESET)
        record.levelname = f"{log_color}[{record.levelname}]{self.RESET}"
        return super().format(record)

# Setup enhanced logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - [AI] %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

# Apply colored formatter
for handler in logger.handlers:
    handler.setFormatter(ColoredFormatter('%(asctime)s - %(levelname)s - [AI] %(message)s'))

# HSV Color Ranges for Detection
COLOR_RANGES = {
    "red": [
        (np.array([0, 120, 70]), np.array([10, 255, 255])),    # Lower red range
        (np.array([170, 120, 70]), np.array([180, 255, 255]))  # Upper red range
    ],
    "yellow": [
        (np.array([20, 100, 100]), np.array([30, 255, 255]))   # Yellow range
    ],
    "pink": [
        (np.array([140, 50, 100]), np.array([170, 255, 255]))  # Pink range
    ]
}

class AIVisionProcessor:
    def __init__(self):
        self.ws = None
        self.latest_frame = None
        self.processing_frame = False
        self.last_detection_time = 0
        self.detection_enabled = False  # Start disabled, wait for server command
        self.frame_count = 0
        self.frames_received = 0
        self.frames_processed = 0
        self.detection_stats = {
            'red': 0,
            'yellow': 0,
            'pink': 0,
            'total_processed': 0,
            'processing_errors': 0
        }
        
        # Performance monitoring
        self.start_time = time.time()
        self.last_stats_time = time.time()
        
        # Create morphological kernel for noise reduction
        self.kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, 
                                              (MORPHOLOGY_KERNEL_SIZE, MORPHOLOGY_KERNEL_SIZE))
        
        logger.info("[AI] AI Vision Processor initialized")
        logger.info(f"[CONFIG] Monitoring colors: {list(COLOR_RANGES.keys())}")

    def connect_websocket(self):
        """Connect to the WebSocket server with retry logic"""
        try:
            logger.info(f"[WS] Connecting to WebSocket server: {WS_SERVER}")
            self.ws = websocket.WebSocketApp(
                WS_SERVER,
                on_open=self.on_open,
                on_message=self.on_message,
                on_error=self.on_error,
                on_close=self.on_close
            )
            
            # Start the WebSocket connection in a separate thread
            ws_thread = threading.Thread(target=self.ws.run_forever)
            ws_thread.daemon = True
            ws_thread.start()
            
            logger.info("[WS] WebSocket connection initiated...")
            return True
            
        except Exception as e:
            logger.error(f"❌ Failed to connect to WebSocket: {e}")
            return False

    def on_open(self, ws):
        """Called when WebSocket connection is established"""
        logger.info("[WS] WebSocket connection established with server")
        
        # Send initial message to identify as AI client
        init_message = {
            "type": "ai_init",
            "message": "AI Vision Engine connected",
            "capabilities": ["color_detection", "object_tracking"],
            "colors": list(COLOR_RANGES.keys()),
            "version": "2.0",
            "timestamp": time.time()
        }
        
        try:
            ws.send(json.dumps(init_message))
            logger.info("📤 AI initialization message sent to server")
        except Exception as e:
            logger.error(f"❌ Failed to send init message: {e}")

    def on_message(self, ws, message):
        """Handle incoming WebSocket messages"""
        try:
            # Check if message is binary (frame data) or text (JSON)
            if isinstance(message, bytes):
                self.handle_frame_data(message)
            else:
                # Handle JSON messages
                data = json.loads(message)
                self.handle_json_message(data)
                
        except json.JSONDecodeError:
            logger.warning("⚠️  Received non-JSON text message")
        except Exception as e:
            logger.error(f"❌ Error processing message: {e}")

    def handle_frame_data(self, frame_data):
        """Process incoming camera frame data"""
        self.frames_received += 1
        current_time = time.time()
        
        # Log frame reception periodically
        if self.frames_received % 30 == 1:  # Every 30 frames
            logger.info(f"📸 Received frame #{self.frames_received} ({len(frame_data)} bytes)")
        
        # Check if detection is enabled
        if not self.detection_enabled:
            if self.frames_received % 50 == 1:  # Log every 50 frames when disabled
                logger.warning("⏸️  Detection DISABLED - frames received but not processed")
            return
        
        # Rate limiting - only process frames at specified interval
        if current_time - self.last_detection_time < DETECTION_INTERVAL:
            return
            
        if self.processing_frame:
            logger.debug("⏭️  Skipping frame - already processing")
            return
            
        self.frame_count += 1
        self.latest_frame = frame_data
        
        # Process frame in separate thread to avoid blocking
        processing_thread = threading.Thread(target=self.process_frame, args=(frame_data,))
        processing_thread.daemon = True
        processing_thread.start()

    def handle_json_message(self, data):
        """Handle JSON control messages"""
        message_type = data.get('type', '')
        logger.debug(f"📥 Received JSON message: {message_type}")
        
        if message_type == 'control_status':
            old_status = self.detection_enabled
            self.detection_enabled = data.get('enabled', False)  # Default to False if not specified
            
            # Always log the status change clearly
            status_text = "🟢 ENABLED" if self.detection_enabled else "🔴 DISABLED"
            logger.info(f"🎛️ AI Control Message Received! Detection now {status_text}")
            logger.info(f"Control message details: {data}")
            
        elif message_type == 'get_stats':
            self.send_statistics()
            
        else:
            logger.debug(f"📨 Received control message: {message_type}")

    def process_frame(self, frame_data):
        """Main frame processing pipeline"""
        if not self.detection_enabled:
            return
            
        self.processing_frame = True
        self.last_detection_time = time.time()
        processing_start = time.time()
        
        try:
            # Convert binary data to OpenCV image
            image = self.binary_to_opencv(frame_data)
            if image is None:
                logger.warning("⚠️  Failed to convert frame data to image")
                return
                
            # Perform color detection
            detections = self.detect_colors(image)
            
            # Send detection results
            if detections:
                self.send_detection_results(detections, image.shape)
                detection = detections[0]
                logger.info(f"🎯 DETECTED: {detection['color'].upper()} "
                           f"(confidence: {detection['confidence']:.3f}, "
                           f"area: {detection['area']}px)")
            else:
                # Log no detection periodically
                if self.frame_count % 20 == 1:
                    logger.debug("🔍 No objects detected in frame")
                
            self.frames_processed += 1
            self.detection_stats['total_processed'] += 1
            
            # Performance logging
            processing_time = time.time() - processing_start
            if processing_time > 0.1:  # Log slow processing
                logger.warning(f"⚠️  Slow processing: {processing_time:.3f}s")
            
        except Exception as e:
            logger.error(f"❌ Error processing frame #{self.frame_count}: {e}")
            self.detection_stats['processing_errors'] += 1
        finally:
            self.processing_frame = False

    def binary_to_opencv(self, frame_data):
        """Convert binary JPEG data to OpenCV image"""
        try:
            # Convert binary data to PIL Image
            pil_image = Image.open(BytesIO(frame_data))
            
            # Convert PIL to OpenCV format (BGR)
            opencv_image = cv2.cvtColor(np.array(pil_image), cv2.COLOR_RGB2BGR)
            
            return opencv_image
            
        except Exception as e:
            logger.error(f"❌ Failed to convert frame data: {e}")
            return None

    def detect_colors(self, image):
        """Detect colored objects in the image using HSV color space"""
        detections = []
        
        # Convert to HSV color space
        hsv_image = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        height, width = image.shape[:2]
        
        # Process each color
        for color_name, ranges in COLOR_RANGES.items():
            total_mask = None
            
            # Combine all ranges for this color (important for red)
            for lower, upper in ranges:
                mask = cv2.inRange(hsv_image, lower, upper)
                
                if total_mask is None:
                    total_mask = mask
                else:
                    total_mask = cv2.bitwise_or(total_mask, mask)
            
            # Apply morphological operations to reduce noise
            total_mask = cv2.morphologyEx(total_mask, cv2.MORPH_OPEN, self.kernel)
            total_mask = cv2.morphologyEx(total_mask, cv2.MORPH_CLOSE, self.kernel)
            
            # Find contours
            contours, _ = cv2.findContours(total_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            
            # Process valid contours
            for contour in contours:
                area = cv2.contourArea(contour)
                
                if area > MIN_CONTOUR_AREA:
                    # Get bounding box
                    x, y, w, h = cv2.boundingRect(contour)
                    
                    # Calculate confidence based on area and mask density
                    mask_region = total_mask[y:y+h, x:x+w]
                    density = np.sum(mask_region > 0) / (w * h)
                    confidence = min(0.95, (area / 5000) * density)
                    
                    detection = {
                        'color': color_name,
                        'confidence': round(confidence, 3),
                        'bbox': {
                            'x': int(x),
                            'y': int(y),
                            'width': int(w),
                            'height': int(h)
                        },
                        'area': int(area),
                        'center': {
                            'x': int(x + w/2),
                            'y': int(y + h/2)
                        }
                    }
                    
                    detections.append(detection)
                    self.detection_stats[color_name] += 1
        
        # Sort by area (largest first) and return top detection
        if detections:
            detections.sort(key=lambda d: d['area'], reverse=True)
            return detections[:1]  # Return only the largest detection
        
        return []

    def send_detection_results(self, detections, image_shape):
        """Send detection results to the server"""
        if not self.ws or not detections:
            return
            
        result_message = {
            'type': 'detection',
            'detections': detections,
            'frame_info': {
                'width': image_shape[1],
                'height': image_shape[0],
                'frame_count': self.frame_count
            },
            'timestamp': time.time()
        }
        
        try:
            self.ws.send(json.dumps(result_message))
            logger.debug("📤 Detection results sent to server")
            
        except Exception as e:
            logger.error(f"❌ Failed to send detection results: {e}")

    def send_statistics(self):
        """Send processing statistics to the server"""
        if not self.ws:
            return
            
        current_time = time.time()
        uptime = current_time - self.start_time
        
        stats_message = {
            'type': 'ai_statistics',
            'stats': {
                **self.detection_stats,
                'frames_received': self.frames_received,
                'frames_processed': self.frames_processed,
                'uptime_seconds': round(uptime, 1),
                'processing_rate_fps': round(self.frames_processed / max(uptime, 1), 2)
            },
            'processing_rate': f"{1/DETECTION_INTERVAL:.1f} FPS target",
            'timestamp': current_time
        }
        
        try:
            self.ws.send(json.dumps(stats_message))
            logger.info("📊 Statistics sent to server")
        except Exception as e:
            logger.error(f"❌ Failed to send statistics: {e}")

    def print_periodic_stats(self):
        """Print statistics periodically"""
        uptime = time.time() - self.start_time
        logger.info("[STATS] === PERFORMANCE STATS ===")
        logger.info(f"   [TIME] Uptime: {uptime:.1f}s")
        logger.info(f"   [RECV] Frames received: {self.frames_received}")
        logger.info(f"   [PROC] Frames processed: {self.frames_processed}")
        logger.info(f"   [DET] Detections: R:{self.detection_stats['red']} "
                    f"Y:{self.detection_stats['yellow']} P:{self.detection_stats['pink']}")
        logger.info(f"   [FPS] Processing rate: {self.frames_processed/max(uptime,1):.2f} FPS")
        logger.info(f"   [ERR] Errors: {self.detection_stats['processing_errors']}")
        logger.info(f"   [MODE] Detection: {'ENABLED' if self.detection_enabled else 'DISABLED'}")

    def on_error(self, ws, error):
        """Handle WebSocket errors"""
        logger.error(f"❌ WebSocket error: {error}")

    def on_close(self, ws, close_status_code, close_reason):
        """Handle WebSocket connection close"""
        logger.warning(f"🔌 WebSocket connection closed: {close_status_code} - {close_reason}")
        
        # Attempt to reconnect after a delay
        logger.info("⏳ Attempting to reconnect in 5 seconds...")
        time.sleep(5)
        self.connect_websocket()

    def run(self):
        """Main execution loop"""
        logger.info("🚀 Starting AI Vision Engine...")
        
        # Connect to WebSocket server
        if not self.connect_websocket():
            logger.error("❌ Failed to establish WebSocket connection")
            return
        
        # Keep the main thread alive
        try:
            while True:
                time.sleep(1)
                self.print_periodic_stats()
                
        except KeyboardInterrupt:
            logger.info("🛑 Shutting down AI Vision Engine...")
            if self.ws:
                self.ws.close()

def main():
    """Main entry point"""
    try:
        # Create and run the AI vision processor
        processor = AIVisionProcessor()
        processor.run()
        
    except Exception as e:
        logger.error(f"💥 Fatal error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
