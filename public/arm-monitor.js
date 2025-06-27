/**
 * Arm Monitor Interface with REST API integration
 * Controls the robotic arm through the REST API while visualizing position
 */

// WebSocket connection for realtime updates
let ws;
let lastUpdateTime = null;

// Current arm state
let currentArmPosition = {
    base: 90,
    shoulder: 90,
    elbow: 45,
    gripper: 0
};

// Position templates (matching ESP8266)
const positionTemplates = {
    rest: { base: 90, shoulder: 90, elbow: 45, gripper: 0 },
    pickup: { base: 90, shoulder: 60, elbow: 120, gripper: 0 },
    redBin: { base: 45, shoulder: 90, elbow: 90, gripper: 180 },
    greenBin: { base: 90, shoulder: 90, elbow: 90, gripper: 180 },
    blueBin: { base: 135, shoulder: 90, elbow: 90, gripper: 180 }
};

// Keep track of current position name
let activePosition = 'rest';
let conveyorRunning = false;
let lastDetectedColor = null;

// Initialize the application
function init() {
    setupEventListeners();
    connectWebSocket();
    updateTimeAgo();
    
    // Start with initial status check
    fetchRobotStatus();
    
    // Set up periodic polling as fallback
    setInterval(fetchRobotStatus, 30000);
    
    // Update the "last updated" time display
    setInterval(updateTimeAgo, 10000);
    
    addLogEntry('Arm monitor initialized');
}

// Set up UI event listeners
function setupEventListeners() {
    // Position template buttons
    document.getElementById('restPosition').addEventListener('click', () => {
        sendPositionCommand('rest');
    });
    
    document.getElementById('pickupPosition').addEventListener('click', () => {
        sendPositionCommand('pickup');
    });
    
    document.getElementById('redBinPosition').addEventListener('click', () => {
        sendPositionCommand('red_bin');
    });
    
    document.getElementById('greenBinPosition').addEventListener('click', () => {
        sendPositionCommand('green_bin');
    });
    
    document.getElementById('blueBinPosition').addEventListener('click', () => {
        sendPositionCommand('blue_bin');
    });
    
    // Clear log button
    document.getElementById('clearLog').addEventListener('click', () => {
        document.getElementById('activityLog').innerHTML = '';
        addLogEntry('Log cleared');
    });
    
    // 3D Controls
    document.getElementById('resetView').addEventListener('click', () => {
        // Reset camera view - this would be handled by arm-simulation.js
        addLogEntry('View reset');
    });
    
    document.getElementById('autoRotate').addEventListener('click', (e) => {
        // Toggle auto-rotation - this would be handled by arm-simulation.js
        e.target.classList.toggle('bg-purple-600');
        e.target.classList.toggle('bg-white/10');
        addLogEntry('Auto-rotate toggled');
    });
}

// Connect WebSocket for real-time updates
function connectWebSocket() {
    if (ws) ws.close();
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || 'localhost:3000';
    
    ws = new WebSocket(`${protocol}//${host}/?type=ui`);
    
    ws.onopen = () => {
        updateConnectionStatus('connected');
        addLogEntry('Connected to server');
    };
    
    ws.onclose = () => {
        updateConnectionStatus('disconnected');
        addLogEntry('Disconnected from server', 'error');
        
        // Try to reconnect after 5 seconds
        setTimeout(connectWebSocket, 5000);
    };
    
    ws.onmessage = (event) => {
        try {
            // Handle text messages (JSON)
            const data = JSON.parse(event.data);
            handleMessage(data);
        } catch (e) {
            console.error('Error handling message:', e);
        }
    };
    
    ws.onerror = (error) => {
        updateConnectionStatus('error');
        addLogEntry('WebSocket error occurred', 'error');
        console.error('WebSocket error:', error);
    };
}

// Process incoming WebSocket messages
function handleMessage(data) {
    // Handle robot arm status updates
    if (data.device === 'robot_arm_conveyor' || data.type === 'robot_status') {
        // Use the correct data object structure
        const robotData = data.type === 'robot_status' ? data.data : data;
        
        // Update arm position
        if (robotData.armPosition) {
            updateArmPosition(robotData.armPosition);
        }
        
        // Update conveyor status
        if (robotData.conveyor) {
            conveyorRunning = robotData.conveyor.running;
            updateConveyorStatus();
        }
        
        // Update last detected color
        if (robotData.lastDetectedColor) {
            lastDetectedColor = robotData.lastDetectedColor;
            updateLastDetection();
        }
        
        // Update time display
        lastUpdateTime = new Date();
        updateTimeAgo();
    }
    
    // Handle connection status updates
    if (data.type === 'connection_status') {
        if (data.device === 'robot') {
            updateConnectionStatus(data.status);
            addLogEntry(`Robot ${data.status}`);
        }
    }
}

// Display connection status in the UI
function updateConnectionStatus(status) {
    const statusDot = document.getElementById('connectionStatus');
    const statusText = document.getElementById('connectionText');
    
    statusDot.classList.remove('bg-red-500', 'bg-yellow-500', 'bg-green-500');
    statusText.classList.remove('text-red-300', 'text-yellow-300', 'text-green-300');
    
    switch (status) {
        case 'connected':
            statusDot.classList.add('bg-green-500');
            statusText.classList.add('text-green-300');
            statusText.textContent = 'Connected';
            break;
        case 'connecting':
            statusDot.classList.add('bg-yellow-500');
            statusText.classList.add('text-yellow-300');
            statusText.textContent = 'Connecting...';
            break;
        case 'error':
            statusDot.classList.add('bg-red-500');
            statusText.classList.add('text-red-300');
            statusText.textContent = 'Error';
            break;
        case 'disconnected':
        default:
            statusDot.classList.add('bg-red-500');
            statusText.classList.add('text-red-300');
            statusText.textContent = 'Disconnected';
            break;
    }
}

// Send a position command to the robot via REST API
async function sendPositionCommand(positionName) {
    try {
        addLogEntry(`Moving to ${positionName.toUpperCase()} position`);
        
        // Highlight active button
        updateActivePositionButton(positionName);
        
        // Send command via REST API
        const response = await fetch('/api/robot/command', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                armPosition: positionName
            }),
        });
        
        const result = await response.json();
        
        if (result.status === 'sent' || result.status === 'queued') {
            addLogEntry(`Command ${result.status}: ${positionName}`);
            
            // Update active position
            activePosition = positionName;
            document.getElementById('activePosition').textContent = 
                positionName.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
        } else {
            throw new Error(result.error || 'Unknown error');
        }
    } catch (error) {
        console.error('Error sending position command:', error);
        addLogEntry(`Failed to send command: ${error.message}`, 'error');
    }
}

// Update UI to show currently active position button
function updateActivePositionButton(positionName) {
    // Remove active class from all buttons
    const buttons = document.querySelectorAll('.position-btn');
    buttons.forEach(btn => btn.classList.remove('active'));
    
    // Map position name to button ID
    const buttonMap = {
        'rest': 'restPosition',
        'pickup': 'pickupPosition',
        'red_bin': 'redBinPosition',
        'green_bin': 'greenBinPosition',
        'blue_bin': 'blueBinPosition'
    };
    
    // Add active class to the selected button
    const activeButtonId = buttonMap[positionName];
    if (activeButtonId) {
        const activeButton = document.getElementById(activeButtonId);
        if (activeButton) {
            activeButton.classList.add('active');
        }
    }
}

// Update the arm position display in the UI
function updateArmPosition(position) {
    currentArmPosition = position;
    
    // Update angle displays
    document.getElementById('baseAngle').textContent = `${position.base}°`;
    document.getElementById('shoulderAngle').textContent = `${position.shoulder}°`;
    document.getElementById('elbowAngle').textContent = `${position.elbow}°`;
    document.getElementById('gripperAngle').textContent = `${position.gripper}°`;
    
    // Update progress bars
    document.getElementById('baseProgress').style.width = `${(position.base / 180) * 100}%`;
    document.getElementById('shoulderProgress').style.width = `${(position.shoulder / 180) * 100}%`;
    document.getElementById('elbowProgress').style.width = `${(position.elbow / 180) * 100}%`;
    document.getElementById('gripperProgress').style.width = `${(position.gripper / 180) * 100}%`;
    
    // Identify which predefined position this most closely matches
    identifyActivePosition(position);
}

// Update conveyor status display
function updateConveyorStatus() {
    document.getElementById('conveyorStatus').textContent = conveyorRunning ? 'Running' : 'Stopped';
}

// Update last detected color display
function updateLastDetection() {
    if (!lastDetectedColor) {
        document.getElementById('lastDetection').textContent = 'None';
        return;
    }
    
    const colorMap = {
        'red': '#ff0000',
        'green': '#00ff00',
        'blue': '#0000ff'
    };
    
    document.getElementById('lastDetection').innerHTML = `
        <span class="inline-block w-3 h-3 rounded-full mr-2" 
              style="background-color: ${colorMap[lastDetectedColor.toLowerCase()] || '#808080'}">
        </span>
        ${lastDetectedColor.charAt(0).toUpperCase() + lastDetectedColor.slice(1)}`;
}

// Identify which position the arm is closest to
function identifyActivePosition(position) {
    // Check if position exactly matches a template
    for (const [name, template] of Object.entries(positionTemplates)) {
        if (position.base === template.base && 
            position.shoulder === template.shoulder && 
            position.elbow === template.elbow && 
            position.gripper === template.gripper) {
            
            activePosition = name;
            document.getElementById('activePosition').textContent = 
                name.charAt(0).toUpperCase() + name.slice(1);
            
            // Update button highlighting
            updateActivePositionButton(name);
            return;
        }
    }
    
    // If no exact match, display "Custom"
    document.getElementById('activePosition').textContent = 'Custom';
    
    // Remove highlighting from all position buttons
    const buttons = document.querySelectorAll('.position-btn');
    buttons.forEach(btn => btn.classList.remove('active'));
}

// Add entry to activity log
function addLogEntry(message, type = 'info') {
    const logContainer = document.getElementById('activityLog');
    const entry = document.createElement('div');
    
    // Style based on message type
    let typeClass = '';
    switch (type) {
        case 'error':
            typeClass = 'text-red-300';
            break;
        case 'warning':
            typeClass = 'text-yellow-300';
            break;
        case 'success':
            typeClass = 'text-green-300';
            break;
        default:
            typeClass = 'text-gray-300';
    }
    
    entry.className = typeClass;
    
    const timestamp = new Date().toLocaleTimeString();
    entry.textContent = `[${timestamp}] ${message}`;
    
    // Add at the top for newest-first display
    logContainer.insertBefore(entry, logContainer.firstChild);
    
    // Limit entries
    if (logContainer.childNodes.length > 100) {
        logContainer.removeChild(logContainer.lastChild);
    }
}

// Fetch robot status via REST API
async function fetchRobotStatus() {
    try {
        updateConnectionStatus('connecting');
        
        const response = await fetch('/api/robot/status');
        
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Process received data as if it came from WebSocket
        handleMessage({
            device: 'robot_arm_conveyor',
            ...data
        });
        
        updateConnectionStatus('connected');
    } catch (error) {
        console.error('Error fetching robot status:', error);
        updateConnectionStatus('error');
        addLogEntry('Failed to fetch robot status', 'error');
    }
}

// Update the "last updated" time display
function updateTimeAgo() {
    const timeElement = document.getElementById('lastUpdate');
    
    if (!lastUpdateTime) {
        timeElement.textContent = 'Not yet updated';
        return;
    }
    
    const now = new Date();
    const diffMs = now - lastUpdateTime;
    const diffSec = Math.floor(diffMs / 1000);
    
    if (diffSec < 60) {
        timeElement.textContent = `Updated ${diffSec}s ago`;
    } else if (diffSec < 3600) {
        const diffMin = Math.floor(diffSec / 60);
        timeElement.textContent = `Updated ${diffMin}m ago`;
    } else {
        timeElement.textContent = `Updated at ${lastUpdateTime.toLocaleTimeString()}`;
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', init);
