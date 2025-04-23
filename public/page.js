// Robot Arm Control System - Frontend Logic

// Global variables
let ws;
let aiControlEnabled = false;
let currentServoPositions = [90, 90, 90, 90];
let conveyorRunning = false;
let conveyorDirection = 1;
let conveyorSpeed = 0;
let frameCount = 0;
let latestDetections = []; // Store latest AI detections

// Detection color mapping
const detectionColors = {
    'red': '#ff0000',
    'green': '#00ff00',
    'blue': '#0000ff',
    'person': '#ffff00',
    'default': '#ffffff'
};

// Initialize video elements
const initVideoElements = () => {
    window.videoCanvas = document.getElementById('videoFeed');
    window.videoCtx = videoCanvas.getContext('2d', { willReadFrequently: true });
    window.overlayCanvas = document.getElementById('detectionOverlay');
    window.overlayCtx = overlayCanvas.getContext('2d');
    
    // Set explicit dimensions
    videoCanvas.width = 640;
    videoCanvas.height = 480;
    overlayCanvas.width = 640;
    overlayCanvas.height = 480;
    
    // Draw placeholder message
    videoCtx.fillStyle = 'black';
    videoCtx.fillRect(0, 0, videoCanvas.width, videoCanvas.height);
    videoCtx.font = '20px Arial';
    videoCtx.fillStyle = 'white';
    videoCtx.textAlign = 'center';
    videoCtx.fillText('Waiting for camera feed...', videoCanvas.width/2, videoCanvas.height/2);
    
    console.log('Video elements initialized', {
        videoCanvas: videoCanvas.width + 'x' + videoCanvas.height,
        overlayCanvas: overlayCanvas.width + 'x' + overlayCanvas.height
    });
};

// Connect to WebSocket server
function connectWebSocket() {
    // Close any existing connections
    if (ws) {
        ws.close();
    }
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Fix: Add fallback for empty host
    const host = window.location.host || 'localhost:3000';
    ws = new WebSocket(`${protocol}//${host}/?type=ui`);
    
    // CRITICAL: Set binary type to arraybuffer for video frames
    ws.binaryType = 'arraybuffer';
    
    ws.onopen = () => {
        addLogEntry('Connected to server', 'system');
        console.log('WebSocket connected');
    };
    
    ws.onclose = () => {
        addLogEntry('Disconnected from server', 'error');
        document.getElementById('robotStatus').classList.remove('bg-green-500');
        document.getElementById('robotStatus').classList.add('bg-red-500');
        document.getElementById('cameraStatus').classList.remove('bg-green-500');
        document.getElementById('cameraStatus').classList.add('bg-red-500');
        
        // Try to reconnect after 5 seconds
        setTimeout(connectWebSocket, 5000);
    };
    
    ws.onmessage = (event) => {
        // Check if the message is binary data (either Blob or ArrayBuffer)
        if (event.data instanceof Blob || event.data instanceof ArrayBuffer) {
            console.log("Processing binary frame, type:", 
                event.data instanceof ArrayBuffer ? "ArrayBuffer" : "Blob", 
                "size:", event.data instanceof ArrayBuffer ? event.data.byteLength : event.data.size, "bytes");
            
            // Convert ArrayBuffer to Blob if needed
            const blob = event.data instanceof ArrayBuffer 
                ? new Blob([event.data], {type: 'image/jpeg'}) 
                : event.data;
            
            // Process the video frame
            handleVideoFrame(blob);
            
            // Redraw AI detections on each frame
            drawDetections(latestDetections);
            
            return;
        }
        
        // Handle text messages (JSON)
        try {
            const data = JSON.parse(event.data);
            handleMessage(data);
        } catch (e) {
            console.error('Error parsing message:', e, typeof event.data, event.data);
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        addLogEntry('WebSocket error occurred', 'error');
    };
}

// Handle video frames
function handleVideoFrame(blob) {
    // Create URL from the blob
    const url = URL.createObjectURL(blob);
    const img = new Image();
    
    // Debug info
    console.log(`Processing frame #${frameCount}, blob size: ${blob.size} bytes`);
    
    // Set onload handler before setting src
    img.onload = () => {
        try {
            // Log when image is loaded
            console.log(`Image loaded: ${img.width}x${img.height}`);
            
            // Clear the canvas before drawing new frame
            videoCtx.clearRect(0, 0, videoCanvas.width, videoCanvas.height);
            
            // Draw the image
            videoCtx.drawImage(img, 0, 0, videoCanvas.width, videoCanvas.height);
            
            // Show frame counter every 30 frames
            if (frameCount % 30 === 0) {
                addLogEntry(`Displayed frame #${frameCount}`, 'system');
            }
            
            frameCount++;
        } catch (e) {
            console.error('Error drawing image to canvas:', e);
        } finally {
            // Always release the blob URL to prevent memory leaks
            URL.revokeObjectURL(url);
        }
    };
    
    img.onerror = (err) => {
        console.error('Error loading image:', err);
        addLogEntry('Failed to load video frame', 'error');
        URL.revokeObjectURL(url);
    };
    
    // Trigger the load
    img.src = url;
}

// Handle JSON messages
function handleMessage(data) {
    console.log('Received message type:', data.type);
    
    switch (data.type) {
        case 'connection_status':
            handleConnectionStatus(data);
            break;
        case 'camera_info':
            document.getElementById('cameraInfo').textContent = 
                `${data.id || 'Camera'} - ${data.resolution || '640x480'} @ ${data.fps || '30'}fps`;
            addLogEntry(`Camera connected: ${data.id || 'Camera'}`, 'system');
            break;
        case 'frame_metadata':
            // Received frame metadata, actual frame will follow
            console.log(`Expecting frame: ${data.size} bytes`);
            break;
        case 'detection':
            // Add debugging
            console.log('Received detection data:', data);
            console.log('Number of detections:', data.detections ? data.detections.length : 0);
            if (data.detections && data.detections.length > 0) {
                console.log('First detection:', data.detections[0]);
            }
            
            // Process detections
            latestDetections = data.detections || [];
            updateDetectionInfo(data.detections || []);
            drawDetections(data.detections || []);
            addLogEntry(`Detected ${latestDetections.length} objects`, 'ai');
            break;
        case 'ai_detection':
            // Legacy format support
            handleDetection(data);
            break;
        case 'ai_command':
            addLogEntry(`AI command: ${JSON.stringify(data.command)}`, 'ai');
            break;
        default:
            if (data.device === 'robot_arm_conveyor') {
                updateRobotStatus(data);
            }
    }
}

// Update detection info with object counts and details
function updateDetectionInfo(detections) {
    const detectionInfo = document.getElementById('detectionInfo');
    
    if (!detections || detections.length === 0) {
        detectionInfo.innerHTML = 'No objects detected';
        return;
    }
    
    // Count detections by type
    const counts = {};
    detections.forEach(detection => {
        const type = detection.color || detection.class || 'unknown';
        counts[type] = (counts[type] || 0) + 1;
    });
    
    // Generate HTML
    let html = '<ul class="list-disc pl-5 space-y-1">';
    Object.entries(counts).forEach(([type, count]) => {
        const color = detectionColors[type] || detectionColors.default;
        html += `<li>
            <span class="inline-block w-3 h-3 rounded-full mr-2" style="background-color: ${color};"></span>
            ${type}: ${count}
        </li>`;
    });
    html += '</ul>';
    
    detectionInfo.innerHTML = html;
}

// Draw detections on overlay canvas
function drawDetections(detections) {
    // Clear the overlay canvas
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    
    if (!detections || !detections.length) {
        return;
    }
    
    // Draw each detection
    overlayCtx.lineWidth = 3;
    overlayCtx.font = 'bold 16px system-ui';
    
    detections.forEach(detection => {
        // Skip if missing required properties
        if (!detection.bbox) return;
        
        // Determine color based on detection type
        let color = detectionColors.default;
        if (detection.color && detectionColors[detection.color]) {
            color = detectionColors[detection.color];
        } else if (detection.class && detectionColors[detection.class]) {
            color = detectionColors[detection.class];
        }
        
        // Compute display coordinates
        const x = detection.bbox.x * overlayCanvas.width; // This line was likely missing
        const y = detection.bbox.y * overlayCanvas.height;
        const width = detection.bbox.width * overlayCanvas.width;
        const height = detection.bbox.height * overlayCanvas.height;
        
        // Draw bounding box
        overlayCtx.strokeStyle = color;
        overlayCtx.strokeRect(x, y, width, height);
        
        // Prepare label text
        const label = detection.color || detection.class || 'unknown';
        const confidence = detection.confidence ? Math.round(detection.confidence * 100) : '?';
        const text = `${label} ${confidence}%`;
        
        // Draw label background
        overlayCtx.fillStyle = color;
        const textWidth = overlayCtx.measureText(text).width;
        overlayCtx.fillRect(x, y - 26, textWidth + 10, 26);
        
        // Draw label text
        overlayCtx.fillStyle = '#000000';
        overlayCtx.fillText(text, x + 5, y - 8);
        
        // Draw center point for objects with center coordinates (useful for robot control)
        if (detection.center) {
            const centerX = detection.center.x * overlayCanvas.width;
            const centerY = detection.center.y * overlayCanvas.height;
            
            // Draw crosshair
            overlayCtx.lineWidth = 2;
            overlayCtx.strokeStyle = '#ffffff';
            overlayCtx.beginPath();
            overlayCtx.moveTo(centerX - 10, centerY);
            overlayCtx.lineTo(centerX + 10, centerY);
            overlayCtx.moveTo(centerX, centerY - 10);
            overlayCtx.lineTo(centerX, centerY + 10);
            overlayCtx.stroke();
            
            // Draw center point
            overlayCtx.fillStyle = color;
            overlayCtx.beginPath();
            overlayCtx.arc(centerX, centerY, 5, 0, Math.PI * 2);
            overlayCtx.fill();
        }
    });
}

// Legacy handler for AI detections (older format)
function handleDetection(data) {
    latestDetections = data.detections || [];
    updateDetectionInfo(latestDetections);
    drawDetections(latestDetections);
}

// Handle connection status updates
function handleConnectionStatus(data) {
    const statusElement = document.getElementById(`${data.device}Status`);
    if (statusElement) {
        if (data.status === 'connected') {
            statusElement.classList.remove('bg-red-500');
            statusElement.classList.add('bg-green-500');
        } else {
            statusElement.classList.remove('bg-green-500'); 
            statusElement.classList.add('bg-red-500');
        }
    }
    
    addLogEntry(`${data.device} ${data.status}`, 'system');
}

// Update robot status display
function updateRobotStatus(data) {
    // Update servo positions
    if (data.servos) {
        currentServoPositions = data.servos;
        for (let i = 0; i < data.servos.length; i++) {
            const slider = document.getElementById(`servo${i}`);
            const value = document.getElementById(`servo${i}Value`);
            if (slider && value) {
                slider.value = data.servos[i];
                value.textContent = `${data.servos[i]}°`;
            }
        }
    }
    
    // Update conveyor status
    if (data.conveyor) {
        const speedSlider = document.getElementById('conveyorSpeed');
        const speedValue = document.getElementById('conveyorSpeedValue');
        
        conveyorRunning = data.conveyor.running;
        conveyorSpeed = data.conveyor.speed;
        conveyorDirection = data.conveyor.direction;
        
        speedSlider.value = conveyorSpeed;
        speedValue.textContent = conveyorSpeed;
    }
}

// Add log entry
function addLogEntry(message, type = '') {
    const logContainer = document.getElementById('logContainer');
    const entry = document.createElement('div');
    
    // Apply Tailwind classes based on entry type
    let typeClass = '';
    switch(type) {
        case 'system':
            typeClass = 'text-purple-500';
            break;
        case 'error':
            typeClass = 'text-red-500';
            break;
        case 'ai':
            typeClass = 'text-indigo-500';
            break;
        default:
            typeClass = 'text-gray-700';
    }
    
    entry.className = `mb-1 pb-1 border-b border-gray-200 ${typeClass}`;
    
    const timestamp = new Date().toLocaleTimeString();
    entry.textContent = `[${timestamp}] ${message}`;
    
    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;
    
    // Limit log entries
    if (logContainer.childNodes.length > 100) {
        logContainer.removeChild(logContainer.firstChild);
    }
}

// Send command to robot
function sendRobotCommand(command) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'robot_command',
            command: command
        }));
        addLogEntry(`Command sent: ${JSON.stringify(command)}`);
    } else {
        addLogEntry('Cannot send command: not connected to server', 'error');
    }
}

// Setup event listeners
function setupEventListeners() {
    // Servo control sliders
    for (let i = 0; i < 4; i++) {
        const slider = document.getElementById(`servo${i}`);
        const value = document.getElementById(`servo${i}Value`);
        
        slider.addEventListener('input', () => {
            value.textContent = `${slider.value}°`;
        });
        
        slider.addEventListener('change', () => {
            sendRobotCommand({
                servo: {
                    channel: i,
                    angle: parseInt(slider.value)
                }
            });
        });
    }
    
    // Conveyor speed slider
    document.getElementById('conveyorSpeed').addEventListener('input', () => {
        const speed = document.getElementById('conveyorSpeed').value;
        document.getElementById('conveyorSpeedValue').textContent = speed;
    });
    
    // Conveyor control buttons
    document.getElementById('conveyorForward').addEventListener('click', () => {
        const speed = parseInt(document.getElementById('conveyorSpeed').value);
        sendRobotCommand({
            conveyor: {
                speed: speed,
                direction: 1
            }
        });
    });
    
    document.getElementById('conveyorReverse').addEventListener('click', () => {
        const speed = parseInt(document.getElementById('conveyorSpeed').value);
        sendRobotCommand({
            conveyor: {
                speed: speed,
                direction: -1
            }
        });
    });
    
    document.getElementById('conveyorStop').addEventListener('click', () => {
        sendRobotCommand({
            conveyor: {
                stop: true
            }
        });
    });
    
    // Sequence buttons
    document.getElementById('sequencePickPlace').addEventListener('click', () => {
        sendRobotCommand({
            sequence: 'pick_and_place'
        });
    });
    
    document.getElementById('sequenceReset').addEventListener('click', () => {
        for (let i = 0; i < 4; i++) {
            sendRobotCommand({
                servo: {
                    channel: i,
                    angle: 90
                }
            });
        }
    });
    
    document.getElementById('sequenceIdentify').addEventListener('click', () => {
        sendRobotCommand({
            sequence: 'sort_objects'
        });
    });
    
    // AI control toggle
    document.getElementById('toggleAI').addEventListener('click', () => {
        aiControlEnabled = !aiControlEnabled;
        
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'ai_control',
                enabled: aiControlEnabled
            }));
            
            document.getElementById('aiStatus').textContent = 
                aiControlEnabled ? 'AI control is enabled' : 'AI control is disabled';
            
            document.getElementById('toggleAI').textContent = 
                aiControlEnabled ? 'Disable AI Control' : 'Enable AI Control';
            
            // Update button style
            const toggleBtn = document.getElementById('toggleAI');
            if (aiControlEnabled) {
                toggleBtn.classList.remove('bg-purple-600', 'hover:bg-purple-700');
                toggleBtn.classList.add('bg-red-600', 'hover:bg-red-700');
            } else {
                toggleBtn.classList.remove('bg-red-600', 'hover:bg-red-700');
                toggleBtn.classList.add('bg-purple-600', 'hover:bg-purple-700');
            }
            
            addLogEntry(`AI control ${aiControlEnabled ? 'enabled' : 'disabled'}`, 'system');
        }
    });
    
    // Clear log button
    document.getElementById('clearLog').addEventListener('click', () => {
        document.getElementById('logContainer').innerHTML = '';
    });
}

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, initializing application');
    initVideoElements();
    setupEventListeners();
    connectWebSocket();
    addLogEntry('System initialized', 'system');
    
    // Additional initialization to ensure video display works
    window.addEventListener('resize', () => {
        console.log('Window resized, adjusting canvas');
        // Ensure canvas stays responsive but maintains aspect ratio
        const container = videoCanvas.parentElement;
        const containerWidth = container.clientWidth;
        
        // Keep 4:3 aspect ratio
        videoCanvas.style.width = '100%';
        videoCanvas.style.height = 'auto';
        overlayCanvas.style.width = '100%';
        overlayCanvas.style.height = 'auto';
    });
    
    // Make sure we're properly connected
    window.addEventListener('online', () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            addLogEntry('Network connection restored, reconnecting', 'system');
            connectWebSocket();
        }
    });
});