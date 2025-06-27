// Robot Arm Sorting System - Frontend Logic (No Conveyor)

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
    
    // Named position buttons
    document.getElementById('namedPosRest').addEventListener('click', () => {
        sendRobotApiCommand({ armPosition: "rest" });
        addLogEntry('Moving to REST position');
    });
    
    document.getElementById('namedPosCenter').addEventListener('click', () => {
        sendRobotApiCommand({ armPosition: "center" });
        addLogEntry('Moving to CENTER position');
    });
    
    document.getElementById('namedPosRed').addEventListener('click', () => {
        sendRobotApiCommand({ armPosition: "red_bin" });
        addLogEntry('Moving to RED BIN position');
    });
    
    document.getElementById('namedPosGreen').addEventListener('click', () => {
        sendRobotApiCommand({ armPosition: "green_bin" });
        addLogEntry('Moving to GREEN BIN position');
    });
    
    document.getElementById('namedPosBlue').addEventListener('click', () => {
        sendRobotApiCommand({ armPosition: "blue_bin" });
        addLogEntry('Moving to BLUE BIN position');
    });
    
    // AI control toggle button
    document.getElementById('toggleAI').addEventListener('click', () => {
        aiControlEnabled = !aiControlEnabled;
        
        const toggleBtn = document.getElementById('toggleAI');
        const statusSpan = document.getElementById('aiStatus');
        
        if (aiControlEnabled) {
            toggleBtn.classList.remove('bg-robot-purple-600', 'hover:bg-robot-purple-700');
            toggleBtn.classList.add('bg-red-600', 'hover:bg-red-700');
            toggleBtn.textContent = 'Disable AI Control';
            statusSpan.textContent = 'AI control is enabled';
            addLogEntry('AI control enabled', 'system');
        } else {
            toggleBtn.classList.remove('bg-red-600', 'hover:bg-red-700');
            toggleBtn.classList.add('bg-robot-purple-600', 'hover:bg-robot-purple-700');
            toggleBtn.textContent = 'Enable AI Control';
            statusSpan.textContent = 'AI control is disabled';
            addLogEntry('AI control disabled', 'system');
        }
        
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ai_control', enabled: aiControlEnabled }));
        }
    });
    
    // Sorting action buttons
    document.getElementById('sequenceSort').addEventListener('click', () => {
        if (latestDetections && latestDetections.length > 0) {
            const color = latestDetections[0].color || 'unknown';
            executeSortingSequence(color);
        } else {
            addLogEntry('No objects detected to sort', 'warning');
        }
    });
    
    document.getElementById('sequenceReset').addEventListener('click', () => {
        sendRobotApiCommand({ armPosition: "rest" });
        addLogEntry('Resetting arm position', 'system');
    });
    
    document.getElementById('sequenceDemo').addEventListener('click', () => {
        executeDemoSequence();
    });
    
    // Clear log button
    document.getElementById('clearLog').addEventListener('click', () => {
        document.getElementById('logContainer').innerHTML = '';
        addLogEntry('Log cleared', 'system');
    });
    
    console.log('Event listeners setup complete');
};

// Execute sorting sequence for detected color
function executeSortingSequence(color) {
    addLogEntry(`Starting sorting sequence for ${color} object`, 'system');
    
    sendRobotApiCommand({
        detection: {
            color: color,
            confidence: latestDetections?.length > 0 ? (latestDetections[0].confidence || 0.8) : 0.5,
            timestamp: new Date().toISOString()
        }
    });
    
    objectsSorted++;
    document.getElementById('objectsSorted').textContent = objectsSorted;
    document.getElementById('lastColor').textContent = color;
}

// Execute demo sequence showing all positions
function executeDemoSequence() {
    addLogEntry('Starting demo sequence', 'system');
    
    const positions = ['center', 'red_bin', 'green_bin', 'blue_bin', 'rest'];
    let currentIndex = 0;
    
    function moveToNextPosition() {
        if (currentIndex < positions.length) {
            const position = positions[currentIndex];
            sendRobotApiCommand({ armPosition: position });
            addLogEntry(`Demo: Moving to ${position.toUpperCase()}`, 'sequence');
            currentIndex++;
            
            setTimeout(moveToNextPosition, 2000);
        } else {
            addLogEntry('Demo sequence complete', 'system');
        }
    }
    
    moveToNextPosition();
}

// Connect to WebSocket server
function connectWebSocket() {
    if (ws) ws.close();
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || 'localhost:3000';
    ws = new WebSocket(`${protocol}//${host}/?type=ui`);
    
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
        
        setTimeout(connectWebSocket, 5000);
    };
    
    ws.onmessage = (event) => {
        if (event.data instanceof Blob || event.data instanceof ArrayBuffer) {
            const blob = event.data instanceof ArrayBuffer 
                ? new Blob([event.data], {type: 'image/jpeg'}) 
                : event.data;
            
            handleVideoFrame(blob);
            drawDetections(latestDetections);
            return;
        }
        
        try {
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

// Handle video frames
function handleVideoFrame(blob) {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    
    img.onload = () => {
        try {
            videoCtx.clearRect(0, 0, videoCanvas.width, videoCanvas.height);
            videoCtx.drawImage(img, 0, 0, videoCanvas.width, videoCanvas.height);
            
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
        case 'detection':
            latestDetections = data.detections || [];
            updateDetectionInfo(data.detections || []);
            drawDetections(data.detections || []);
            addLogEntry(`Detected ${latestDetections.length} objects`, 'ai');
            break;
        case 'robot_status':
            updateRobotStatus(data.data);
            break;
        default:
            if (data.device === 'robot_arm') {
                updateRobotStatus(data);
            }
    }
}

// Update detection info display
function updateDetectionInfo(detections) {
    const detectionInfo = document.getElementById('detectionInfo');
    
    if (!detections || detections.length === 0) {
        detectionInfo.innerHTML = 'No objects detected';
        return;
    }
    
    const counts = {};
    detections.forEach(detection => {
        const type = detection.color || detection.class || 'unknown';
        counts[type] = (counts[type] || 0) + 1;
    });
    
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
    
    if (detections.length > 0 && detections[0].color) {
        const lastColor = detections[0].color.toLowerCase();
        const colorElement = document.getElementById('lastDetectedColor');
        const colorLabel = document.getElementById('lastDetectedColorLabel');
        
        if (colorElement && colorLabel) {
            colorElement.style.backgroundColor = detectionColors[lastColor] || '#808080';
            colorLabel.textContent = lastColor || 'Unknown';
        }
    }
}

// Draw detections on overlay canvas
function drawDetections(detections) {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    
    if (!detections || !detections.length) return;
    
    overlayCtx.lineWidth = 3;
    overlayCtx.font = 'bold 16px system-ui';
    
    detections.forEach(detection => {
        if (!detection.bbox) return;
        
        let color = detectionColors.default;
        if (detection.color && detectionColors[detection.color]) {
            color = detectionColors[detection.color];
        } else if (detection.class && detectionColors[detection.class]) {
            color = detectionColors[detection.class];
        }
        
        const x = detection.bbox.x * overlayCanvas.width;
        const y = detection.bbox.y * overlayCanvas.height;
        const width = detection.bbox.width * overlayCanvas.width;
        const height = detection.bbox.height * overlayCanvas.height;
        
        overlayCtx.strokeStyle = color;
        overlayCtx.strokeRect(x, y, width, height);
        
        const label = detection.color || detection.class || 'unknown';
        const confidence = detection.confidence ? Math.round(detection.confidence * 100) : '?';
        const text = `${label} ${confidence}%`;
        
        overlayCtx.fillStyle = color;
        const textWidth = overlayCtx.measureText(text).width;
        overlayCtx.fillRect(x, y - 26, textWidth + 10, 26);
        
        overlayCtx.fillStyle = '#000000';
        overlayCtx.fillText(text, x + 5, y - 8);
        
        if (detection.center) {
            const centerX = detection.center.x * overlayCanvas.width;
            const centerY = detection.center.y * overlayCanvas.height;
            
            overlayCtx.lineWidth = 2;
            overlayCtx.strokeStyle = '#ffffff';
            overlayCtx.beginPath();
            overlayCtx.moveTo(centerX - 10, centerY);
            overlayCtx.lineTo(centerX + 10, centerY);
            overlayCtx.moveTo(centerX, centerY - 10);
            overlayCtx.lineTo(centerX, centerY + 10);
            overlayCtx.stroke();
            
            overlayCtx.fillStyle = color;
            overlayCtx.beginPath();
            overlayCtx.arc(centerX, centerY, 5, 0, Math.PI * 2);
            overlayCtx.fill();
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
        
        for (let i = 0; i < angles.length; i++) {
            const slider = document.getElementById(`servo${i}`);
            const value = document.getElementById(`servo${i}Value`);
            if (slider && value) {
                slider.value = angles[i];
                value.textContent = `${angles[i]}°`;
            }
        }
        
        document.getElementById('jointBase').textContent = `${pos.base}°`;
        document.getElementById('jointShoulder').textContent = `${pos.shoulder}°`;
        document.getElementById('jointElbow').textContent = `${pos.elbow}°`;
        document.getElementById('jointGripper').textContent = `${pos.gripper}°`;
    }
    
    if (data.lastDetectedColor) {
        const colorElement = document.getElementById('lastDetectedColor');
        const colorLabel = document.getElementById('lastDetectedColorLabel');
        
        if (colorElement && colorLabel) {
            const color = data.lastDetectedColor.toLowerCase();
            colorElement.style.backgroundColor = detectionColors[color] || '#808080';
            colorLabel.textContent = color || 'Unknown';
        }
    }
}

// Add log entry
function addLogEntry(message, type = '') {
    const logContainer = document.getElementById('logContainer');
    const entry = document.createElement('div');
    
    let typeClass = '';
    switch(type) {
        case 'system':
            typeClass = 'text-blue-600 dark:text-blue-400';
            break;
        case 'error':
            typeClass = 'text-red-600 dark:text-red-400';
            break;
        case 'warning':
            typeClass = 'text-yellow-600 dark:text-yellow-400';
            break;
        case 'ai':
            typeClass = 'text-green-600 dark:text-green-400';
            break;
        case 'sequence':
            typeClass = 'text-purple-600 dark:text-purple-400';
            break;
        default:
            typeClass = 'text-gray-700 dark:text-gray-300';
    }
    
    entry.className = `mb-1 pb-1 border-b border-gray-200 dark:border-gray-700 ${typeClass}`;
    
    const timestamp = new Date().toLocaleTimeString();
    entry.textContent = `[${timestamp}] ${message}`;
    
    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;
    
    if (logContainer.childNodes.length > 100) {
        logContainer.removeChild(logContainer.firstChild);
    }
}

// REST API helpers
async function sendRobotApiCommand(command) {
    try {
        addLogEntry(`Sending command: ${JSON.stringify(command)}`);
        
        const res = await fetch('/api/robot/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(command)
        });
        
        const data = await res.json();
        
        if (res.ok) {
            addLogEntry(`Command ${data.status}: ${JSON.stringify(command)}`);
        } else {
            addLogEntry(`Command failed: ${data.error}`, 'error');
        }
    } catch (e) {
        console.error('API Error:', e);
        addLogEntry(`Failed to send command: ${e.message}`, 'error');
    }
}

async function fetchRobotStatus() {
    try {
        const res = await fetch('/api/robot/status');
        
        if (res.ok) {
            const data = await res.json();
            updateRobotStatus(data);
        } else {
            addLogEntry('Failed to fetch robot status', 'error');
        }
    } catch (e) {
        console.error('Status fetch error:', e);
        addLogEntry('Error fetching robot status', 'error');
    }
}

// Initialize everything on DOM load
document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, initializing application');
    initVideoElements();
    setupEventListeners();
    connectWebSocket();
    addLogEntry('Robot Arm Sorting System initialized', 'system');
    
    fetchRobotStatus();
    
    window.addEventListener('resize', () => {
        console.log('Window resized, adjusting canvas');
        const container = videoCanvas.parentElement;
        
        videoCanvas.style.width = '100%';
        videoCanvas.style.height = 'auto';
        overlayCanvas.style.width = '100%';
        overlayCanvas.style.height = 'auto';
    });
    
    window.addEventListener('online', () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            addLogEntry('Network restored, reconnecting...', 'system');
            connectWebSocket();
        }
    });
    
    setInterval(fetchRobotStatus, 30000);
});