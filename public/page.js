// Robot Arm Sorting System - Frontend Logic (Updated for new server approach)

// Global variables
let ws;
let aiControlEnabled = false;
let currentServoPositions = [90, 90, 45, 0];
let frameCount = 0;
let latestDetections = [];
let objectsSorted = 0;

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
    
    console.log('Video elements initialized');
};

// Setup event listeners for controls
const setupEventListeners = () => {
    console.log('Setting up event listeners');
    
    // Servo sliders
    for (let i = 0; i < 4; i++) {
        const slider = document.getElementById(`servo${i}`);
        if (slider) {
            slider.addEventListener('input', function() {
                document.getElementById(`servo${i}Value`).textContent = `${this.value}°`;
            });
            
            slider.addEventListener('change', function() {
                const angle = parseInt(this.value);
                sendRobotApiCommand({
                    servo: {
                        channel: i,
                        angle: angle
                    }
                });
                addLogEntry(`Set servo ${i} to ${angle}°`);
            });
        }
    }

    // Position buttons
    ['rest', 'pickup', 'red_bin', 'green_bin', 'blue_bin'].forEach(position => {
        const button = document.getElementById(`${position}Btn`);
        if (button) {
            button.addEventListener('click', () => {
                sendRobotApiCommand({
                    armPosition: position
                });
                addLogEntry(`Moving to ${position} position`);
            });
        }
    });

    // Demo sequence button
    const demoBtn = document.getElementById('demoBtn');
    if (demoBtn) {
        demoBtn.addEventListener('click', executeDemoSequence);
    }

    // AI control toggle
    const toggleAI = document.getElementById('toggleAI');
    if (toggleAI) {
        toggleAI.addEventListener('click', async function() {
            try {
                // Use REST API approach for more reliable toggling
                const response = await fetch('/api/ai/control', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ enabled: !aiControlEnabled })
                });
                
                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(errorData.message || 'Failed to toggle AI control');
                }
                
                const result = await response.json();
                aiControlEnabled = result.enabled;
                
                // Update button text and status display
                this.textContent = aiControlEnabled ? 'Disable AI Control' : 'Enable AI Control';
                const aiStatusEl = document.getElementById('aiStatus');
                if (aiStatusEl) {
                    aiStatusEl.textContent = `AI control is ${aiControlEnabled ? 'enabled' : 'disabled'}`;
                }
                
                addLogEntry(`AI control ${aiControlEnabled ? 'enabled' : 'disabled'}`, 'system');
                console.log(`AI control set to: ${aiControlEnabled}`);
                
            } catch (error) {
                console.error('Error toggling AI control:', error);
                addLogEntry(`Failed to toggle AI control: ${error.message}`, 'error');
                // Show error to user
                alert(`Failed to toggle AI: ${error.message}`);
            }
        });
    }

    // Position template buttons
    document.getElementById('namedPosRest').addEventListener('click', () => {
        sendRobotApiCommand({armPosition: 'rest'});
        addLogEntry('Moving to REST position');
    });

    document.getElementById('namedPosCenter').addEventListener('click', () => {
        sendRobotApiCommand({armPosition: 'pickup'});  // "center" in UI = "pickup" in ESP8266
        addLogEntry('Moving to CENTER position');
    });

    document.getElementById('namedPosRed').addEventListener('click', () => {
        sendRobotApiCommand({armPosition: 'red_bin'});
        addLogEntry('Moving to RED BIN position');
    });

    document.getElementById('namedPosGreen').addEventListener('click', () => {
        sendRobotApiCommand({armPosition: 'green_bin'});
        addLogEntry('Moving to GREEN BIN position');
    });

    document.getElementById('namedPosBlue').addEventListener('click', () => {
        sendRobotApiCommand({armPosition: 'blue_bin'});
        addLogEntry('Moving to BLUE BIN position');
    });
};

// Execute sorting sequence based on detected color
function executeSortingSequence(color) {
    if (!aiControlEnabled) return;
    
    const colorMap = {
        'red': 'red_bin',
        'green': 'green_bin', 
        'blue': 'blue_bin'
    };
    
    const targetPosition = colorMap[color.toLowerCase()];
    if (targetPosition) {
        addLogEntry(`Executing sorting sequence for ${color}`, 'ai');
        
        // Sequence: pickup -> target bin -> rest
        setTimeout(() => sendRobotApiCommand({ armPosition: 'pickup' }), 100);
        setTimeout(() => sendRobotApiCommand({ armPosition: targetPosition }), 2000);
        setTimeout(() => sendRobotApiCommand({ armPosition: 'rest' }), 4000);
        
        objectsSorted++;
        document.getElementById('objectsSorted').textContent = objectsSorted;
    }
}

// Execute demo sequence showing all positions
function executeDemoSequence() {
    const positions = ['pickup', 'red_bin', 'green_bin', 'blue_bin', 'rest'];
    let delay = 0;
    
    positions.forEach((position, index) => {
        setTimeout(() => {
            sendRobotApiCommand({ armPosition: position });
            addLogEntry(`Demo: Moving to ${position}`, 'system');
        }, delay);
        delay += 2000;
    });
}

// Connect to WebSocket server with improved error handling
function connectWebSocket() {
    if (ws) ws.close();
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || 'localhost:3000';
    ws = new WebSocket(`${protocol}//${host}/?type=browser`);  // Updated to use 'browser' type
    
    ws.binaryType = 'arraybuffer';
    
    ws.onopen = () => {
        addLogEntry('Connected to server', 'system');
        console.log('WebSocket connected');
    };
    
    ws.onclose = (event) => {
        addLogEntry(`Disconnected from server (${event.code})`, 'error');
        console.log('WebSocket disconnected, code:', event.code);
        
        // Update connection status indicators
        document.getElementById('robotStatus')?.classList.remove('bg-green-500');
        document.getElementById('robotStatus')?.classList.add('bg-red-500');
        document.getElementById('cameraStatus')?.classList.remove('bg-green-500');
        document.getElementById('cameraStatus')?.classList.add('bg-red-500');
        
        // Attempt to reconnect after 5 seconds
        setTimeout(connectWebSocket, 5000);
    };
    
    ws.onmessage = (event) => {
        try {
            // Handle binary data (video frames)
            if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
                const blob = event.data instanceof ArrayBuffer 
                    ? new Blob([event.data], {type: 'image/jpeg'}) 
                    : event.data;
                
                handleVideoFrame(blob);
                drawDetections(latestDetections);
                return;
            }
            
            // Handle JSON messages
            const data = JSON.parse(event.data);
            handleMessage(data);
        } catch (e) {
            console.error('Error parsing message:', e);
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        addLogEntry('WebSocket error occurred', 'error');
    };
}

// Handle video frames with improved error handling
function handleVideoFrame(blob) {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    
    img.onload = () => {
        try {
            videoCtx.clearRect(0, 0, videoCanvas.width, videoCanvas.height);
            videoCtx.drawImage(img, 0, 0, videoCanvas.width, videoCanvas.height);
            
            // Log frame info periodically
            if (frameCount % 30 === 0) {
                console.log(`Frame #${frameCount}, size: ${blob.size} bytes`);
            }
            frameCount++;
        } catch (e) {
            console.error('Error drawing image to canvas:', e);
        } finally {
            URL.revokeObjectURL(url);
        }
    };
    
    img.onerror = (err) => {
        console.error('Error loading image:', err);
        addLogEntry('Failed to load video frame', 'error');
        URL.revokeObjectURL(url);
    };
    
    img.src = url;
}

// Handle JSON messages with improved message routing
function handleMessage(data) {
    console.log('Received message type:', data.type);
    
    switch (data.type) {
        case 'connection_ack':
            console.log('Server acknowledged connection');
            break;
            
        case 'connection_status':
            handleConnectionStatus(data);
            break;
            
        case 'camera_info':
            handleCameraInfo(data);
            break;
            
        case 'frame_metadata':
            // Handle frame metadata if needed
            break;
            
        case 'detection':
            handleDetection(data);
            break;
            
        case 'robot_status':
            updateRobotStatus(data.data || data);
            break;
            
        default:
            // Handle robot arm messages
            if (data.device === 'robot_arm' || data.device === 'robot_arm_conveyor') {
                updateRobotStatus(data);
            }
    }
}

// Handle camera info messages
function handleCameraInfo(data) {
    const cameraInfoElement = document.getElementById('cameraInfo');
    if (cameraInfoElement) {
        cameraInfoElement.textContent = 
            `${data.id || 'Camera'} - ${data.resolution || '640x480'} @ ${data.fps || '30'}fps`;
    }
    addLogEntry(`Camera connected: ${data.id || 'Camera'}`, 'system');
}

// Handle detection results
function handleDetection(data) {
    latestDetections = data.detections || [];
    updateDetectionInfo(data.detections || []);
    drawDetections(data.detections || []);
    addLogEntry(`Detected ${latestDetections.length} objects`, 'ai');
    
    // Execute sorting if AI control is enabled and objects detected
    if (aiControlEnabled && latestDetections.length > 0) {
        const firstDetection = latestDetections[0];
        if (firstDetection.color) {
            executeSortingSequence(firstDetection.color);
        }
    }
}

// Update detection info display
function updateDetectionInfo(detections) {
    const detectionInfo = document.getElementById('detectionInfo');
    if (!detectionInfo) return;
    
    if (detections && detections.length > 0) {
        const detection = detections[0];
        const confidence = (detection.confidence * 100).toFixed(1);
        detectionInfo.innerHTML = `
            <strong>Object:</strong> ${detection.class || 'Unknown'}<br>
            <strong>Color:</strong> ${detection.color || 'Unknown'}<br>
            <strong>Confidence:</strong> ${confidence}%<br>
            <strong>Position:</strong> (${detection.bbox?.[0]?.toFixed(0) || 0}, ${detection.bbox?.[1]?.toFixed(0) || 0})
        `;
    } else {
        detectionInfo.textContent = 'No objects detected';
    }
}

// Draw detections on overlay canvas
function drawDetections(detections) {
    if (!overlayCtx) return;
    
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    
    if (!detections || detections.length === 0) return;
    
    detections.forEach(detection => {
        if (detection.bbox && detection.bbox.length >= 4) {
            const [x, y, width, height] = detection.bbox;
            const color = detectionColors[detection.color?.toLowerCase()] || detectionColors.default;
            
            // Draw bounding box
            overlayCtx.strokeStyle = color;
            overlayCtx.lineWidth = 3;
            overlayCtx.strokeRect(x, y, width, height);
            
            // Draw label background
            const label = `${detection.class || 'Object'} (${detection.color || 'Unknown'})`;
            overlayCtx.font = '14px Arial';
            const textWidth = overlayCtx.measureText(label).width;
            
            overlayCtx.fillStyle = color;
            overlayCtx.fillRect(x, y - 25, textWidth + 10, 20);
            
            // Draw label text
            overlayCtx.fillStyle = 'white';
            overlayCtx.fillText(label, x + 5, y - 8);
        }
    });
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
    if (data.armPosition) {
        const pos = data.armPosition;
        const angles = [pos.base, pos.shoulder, pos.elbow, pos.gripper];
        currentServoPositions = angles;
        
        // Update servo sliders
        for (let i = 0; i < angles.length; i++) {
            const slider = document.getElementById(`servo${i}`);
            const value = document.getElementById(`servo${i}Value`);
            if (slider && value) {
                slider.value = angles[i];
                value.textContent = `${angles[i]}°`;
            }
        }
        
        // Update joint displays
        document.getElementById('jointBase').textContent = `${pos.base}°`;
        document.getElementById('jointShoulder').textContent = `${pos.shoulder}°`;
        document.getElementById('jointElbow').textContent = `${pos.elbow}°`;
        document.getElementById('jointGripper').textContent = `${pos.gripper}°`;
    }
    
    if (data.lastDetectedColor) {
        const colorElement = document.getElementById('lastDetectedColor');
        if (colorElement) {
            colorElement.textContent = data.lastDetectedColor;
            colorElement.style.color = detectionColors[data.lastDetectedColor.toLowerCase()] || detectionColors.default;
        }
    }
}

// Add log entry
function addLogEntry(message, type = '') {
    const logContainer = document.getElementById('logContainer');
    if (!logContainer) return;
    
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = document.createElement('div');
    logEntry.className = `text-sm ${type === 'error' ? 'text-red-400' : type === 'system' ? 'text-blue-400' : type === 'ai' ? 'text-green-400' : 'text-gray-300'}`;
    logEntry.textContent = `[${timestamp}] ${message}`;
    
    logContainer.appendChild(logEntry);
    logContainer.scrollTop = logContainer.scrollHeight;
    
    // Keep only last 50 entries
    while (logContainer.children.length > 50) {
        logContainer.removeChild(logContainer.firstChild);
    }
}

// REST API helpers
async function sendRobotApiCommand(command) {
    try {
        const response = await fetch('/api/robot/command', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(command),
        });

        const data = await response.json();
        
        if (response.ok) {
            addLogEntry(`Command sent successfully: ${JSON.stringify(command)}`);
        } else {
            addLogEntry(`Error sending command: ${data.message || 'Unknown error'}`, 'error');
        }
    } catch (error) {
        console.error('Error sending command:', error);
        addLogEntry(`Failed to send command: ${error.message}`, 'error');
    }
}

async function fetchRobotStatus() {
    try {
        const response = await fetch('/api/robot/status');
        if (response.ok) {
            const status = await response.json();
            if (status.armPosition) {
                updateRobotStatus(status);
            }
        }
    } catch (error) {
        console.error('Error fetching robot status:', error);
    }
}

// Initialize everything on DOM load
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, initializing application');
    initVideoElements();
    setupEventListeners();
    connectWebSocket();
    addLogEntry('Robot Arm Sorting System initialized', 'system');
    
    // Fetch initial robot status
    fetchRobotStatus();
    
    // Handle window resize
    window.addEventListener('resize', () => {
        console.log('Window resized, adjusting canvas');
        const container = videoCanvas.parentElement;
        
        videoCanvas.style.width = '100%';
        videoCanvas.style.height = 'auto';
        overlayCanvas.style.width = '100%';
        overlayCanvas.style.height = 'auto';
    });
    
    // Handle network changes
    window.addEventListener('online', () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            addLogEntry('Network restored, reconnecting...', 'system');
            connectWebSocket();
        }
    });
    
    // Periodic status updates
    setInterval(fetchRobotStatus, 30000);
});