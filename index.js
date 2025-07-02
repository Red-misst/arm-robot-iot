import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { promises as fsPromises } from 'fs';

// Get current file directory with ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create logs directory if it doesn't exist
const LOGS_DIR = path.join(__dirname, 'logs');
const DETECTION_LOG_PATH = path.join(LOGS_DIR, 'detections.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

async function ensureLogsDirectory() {
  try {
    await fsPromises.mkdir(LOGS_DIR, { recursive: true });
    console.log(`Logs directory created at: ${LOGS_DIR}`);
  } catch (error) {
    console.error(`Failed to create logs directory: ${error}`);
  }
}

// Call this function during initialization
ensureLogsDirectory();

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Default route - serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Initialize WebSocket server
const wss = new WebSocketServer({ server });

// Store connected clients using the improved approach
const clients = {
  browsers: new Set(), // Set of browser clients
  cameras: new Map(),  // Map of camera clients
  robot: null,         // Single robot connection
  ai: null             // AI client connection
};

// Outgoing message queue for robot
let robotMessageQueue = [];
let robotReady = false;
let lastRobotStatus = null;

// Track the latest frame for new UI connections
let latestFrame = null;

// AI control and monitoring state
let aiControlEnabled = false;
let aiProcessHealth = {
  status: 'disconnected',
  lastHeartbeat: null,
  restartCount: 0,
  lastError: null
};

// AI detection state
let lastDetection = null;
let detectionHistory = [];
const MAX_DETECTION_HISTORY = 50;

// Start the AI vision process with improved monitoring
let aiProcess = null;
let aiRestartTimeout = null;

const startAIProcess = () => {
  console.log("Starting AI vision process...");
  
  // Clear any existing restart timeout
  if (aiRestartTimeout) {
    clearTimeout(aiRestartTimeout);
    aiRestartTimeout = null;
  }
  
  const pythonPath = process.env.PYTHON_PATH || 'python';
  const scriptPath = path.join(__dirname, 'ai', 'ai_vision.py');
  
  if (!fs.existsSync(scriptPath)) {
    console.error(`AI vision script not found at: ${scriptPath}`);
    aiProcessHealth.status = 'error';
    aiProcessHealth.lastError = 'Script not found';
    return;
  }
  
  // Set AI process health to starting
  aiProcessHealth.status = 'starting';
  aiProcessHealth.restartCount++;
  
  aiProcess = spawn(pythonPath, [scriptPath], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  
  aiProcess.stdout.on('data', (data) => {
    const output = data.toString().trim();
    console.log(`AI vision output: ${output}`);
    
    // Update health status based on output
    if (output.includes('WebSocket connection established')) {
      aiProcessHealth.status = 'connected';
      aiProcessHealth.lastHeartbeat = Date.now();
    }
  });
  
  aiProcess.stderr.on('data', (data) => {
    const error = data.toString().trim();
    console.error(`AI vision error: ${error}`);
    aiProcessHealth.lastError = error;
    
    // Broadcast error to browsers
    broadcastToBrowsers({
      type: 'ai_error',
      error: error,
      timestamp: Date.now()
    });
  });
  
  aiProcess.on('close', (code) => {
    console.log(`AI vision process exited with code ${code}`);
    aiProcess = null;
    aiProcessHealth.status = 'disconnected';
    
    // Broadcast disconnection to browsers
    broadcastToBrowsers({
      type: 'connection_status',
      device: 'ai',
      status: 'disconnected'
    });
    
    if (code !== 0 && aiProcessHealth.restartCount < 5) {
      console.log(`AI process crashed, restarting in 5 seconds... (attempt ${aiProcessHealth.restartCount + 1}/5)`);
      aiRestartTimeout = setTimeout(startAIProcess, 5000);
    } else if (aiProcessHealth.restartCount >= 5) {
      console.error("AI process failed to start after 5 attempts, giving up");
      aiProcessHealth.status = 'failed';
    }
  });
  
  aiProcess.on('error', (error) => {
    console.error(`Failed to start AI process: ${error}`);
    aiProcessHealth.status = 'error';
    aiProcessHealth.lastError = error.message;
  });
  
  console.log(`AI vision process started (PID: ${aiProcess.pid})`);
};

// Helper function to check if data is binary JPEG
function isJpegData(data) {
  if (data instanceof Buffer) {
    return data.length >= 3 && 
           data[0] === 0xFF && 
           data[1] === 0xD8 && 
           data[2] === 0xFF;
  }
  return false;
}

// Broadcast message to all browser clients
function broadcastToBrowsers(message) {
  const messageStr = typeof message === "string" ? message : JSON.stringify(message);

  for (const client of clients.browsers) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(messageStr);
      } catch (error) {
        console.error('Error sending to browser client:', error);
      }
    }
  }
}

// Broadcast binary data (like video frames) to browsers
function broadcastFrameToBrowsers(frameBuffer) {
  let sentCount = 0;
  for (const client of clients.browsers) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(frameBuffer, (err) => {
          if (err) {
            console.error('Error sending frame to browser:', err);
          } else {
            sentCount++;
          }
        });
      } catch (error) {
        console.error('Exception sending frame to browser:', error);
      }
    }
  }
  
  
}



// Handle WebSocket connections
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  
  // Parse URL parameters
  const url = new URL(`http://localhost${req.url}`);
  const clientType = url.searchParams.get('type') || 'browser';

  console.log(`New ${clientType} connection from ${clientIp}`);

  // Send immediate acknowledgement to client
  try {
    ws.send(JSON.stringify({
      type: "connection_ack",
      message: "Connected to server",
      timestamp: Date.now()
    }));
  } catch (err) {
    console.error("Error sending connection acknowledgement:", err);
  }

  // Set up ping interval for connection health
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 30000);

  // Handle client type assignment
  if (clientType === 'browser' || clientType === 'ui') {
    clients.browsers.add(ws);
    console.log(`Browser client connected. Total browsers: ${clients.browsers.size}`);
    
    // Send current connection statuses to new browser client
    const connectionStatus = {
      robot: clients.robot ? 'connected' : 'disconnected',
      camera: clients.cameras.size > 0 ? 'connected' : 'disconnected',
      ai: clients.ai ? 'connected' : 'disconnected'
    };
    
    ws.send(JSON.stringify({ type: 'connection_status_all', status: connectionStatus }));
    
    // Send AI process health
    ws.send(JSON.stringify({ 
      type: 'ai_health', 
      health: aiProcessHealth,
      aiControlEnabled: aiControlEnabled
    }));
    
    // Send last detection if available
    if (lastDetection) {
      ws.send(JSON.stringify({ type: 'last_detection', detection: lastDetection }));
    }
    
    // Send detection history
    ws.send(JSON.stringify({ 
      type: 'detection_history', 
      history: detectionHistory.slice(0, 10) // Last 10 detections
    }));
    
    if (lastRobotStatus) {
      ws.send(JSON.stringify({ type: 'robot_status', data: lastRobotStatus }));
    }
    if (latestFrame) {
      ws.send(latestFrame);
    }
  } else if (clientType === 'camera') {
    const cameraId = url.searchParams.get('id') || `camera-${Date.now()}`;
    clients.cameras.set(cameraId, ws);
    console.log(`Camera ${cameraId} connected. Total cameras: ${clients.cameras.size}`);
    
    // Notify browsers about camera connection
    broadcastToBrowsers({
      type: 'connection_status',
      device: 'camera',
      status: 'connected'
    });
  } else if (clientType === 'robot') {
    if (clients.robot && clients.robot.readyState === WebSocket.OPEN) {
      clients.robot.close();
    }
    clients.robot = ws;
    robotReady = true;
    
    // Send any queued messages
    while (robotMessageQueue.length > 0) {
      const msg = robotMessageQueue.shift();
      try { ws.send(msg); } catch (e) { console.error('Failed to send queued msg:', e); }
    }
    
    broadcastToBrowsers({
      type: 'connection_status',
      device: 'robot',
      status: 'connected'
    });
  } else if (clientType === 'ai') {
    clients.ai = ws;
    aiProcessHealth.status = 'connected';
    aiProcessHealth.lastHeartbeat = Date.now();
    
    console.log('AI client connected via WebSocket');
    
    broadcastToBrowsers({ 
      type: 'connection_status', 
      device: 'ai', 
      status: 'connected' 
    });
    
    // Send AI control status
    ws.send(JSON.stringify({
      type: 'control_status',
      enabled: aiControlEnabled
    }));
  } else {
    console.log(`Unknown client type: ${clientType}`);
  }

  // Handle incoming messages
  ws.on('message', async (message) => {
    try {
      // Check if message is binary (Buffer) or text (String)
      if (Buffer.isBuffer(message)) {
       
        // Handle binary data (like camera frames)
        if (clientType === 'camera') {
       
          
          // Store latest frame for new connections
          latestFrame = message;
          
          // Broadcast frame to all browser clients
          broadcastFrameToBrowsers(message);
          
          // Forward to AI if connected and enabled
          if (clients.ai && clients.ai.readyState === WebSocket.OPEN && aiControlEnabled) {
            try {
              clients.ai.send(message);
              aiProcessHealth.lastHeartbeat = Date.now();
            } catch (aiError) {
              console.error('Error forwarding frame to AI:', aiError);
              aiProcessHealth.lastError = aiError.message;
            }
          }
        } else if (clientType === 'ai') {
          // Handle binary data from AI
       
          const data = JSON.parse(message.toString());
          switch (data.type) {
                 case 'detection':
            // Handle AI detection results
            if (clientType === 'ai') {
              console.log(`Received AI detection: ${data.detections?.length || 0} objects`);
              
              // Update AI health
              aiProcessHealth.lastHeartbeat = Date.now();
              
              // Process detections if present
              if (data.detections && data.detections.length > 0) {
                // Get highest confidence detection
                const detection = data.detections.sort((a, b) => b.confidence - a.confidence)[0];
                
                // Skip if color not specified or not one of our target colors
                if (!detection.color || !['red', 'green', 'blue'].includes(detection.color.toLowerCase())) {
                  console.log(`Ignoring detection with invalid color: ${detection.color}`);
                  break;
                }
                
                // Check for duplicate (same color within last 3 seconds)
                const now = Date.now();
                const isDuplicate = detectionHistory.some(d => 
                  d.color === detection.color && 
                  (now - d.timestamp) < 3000
                );
                
                if (!isDuplicate) {
                  console.log(`New detection: ${detection.color} with confidence ${detection.confidence}`);
                  
                  // Record this detection
                  const detectionRecord = {
                    color: detection.color,
                    confidence: detection.confidence,
                    timestamp: now,
                    area: detection.area || 0
                  };
                  
                  // Add to history and trim if needed
                  detectionHistory.unshift(detectionRecord);
                  if (detectionHistory.length > MAX_DETECTION_HISTORY) {
                    detectionHistory.pop();
                  }
                  
                  // Save as last detection
                  lastDetection = detection;
                  
                  // Log detection to file
                  logDetection(detection);
                } else {
                  console.log(`Ignoring duplicate ${detection.color} detection`);
                  break;
                }
              }
              
              // Broadcast to browsers with enhanced data
              const enhancedDetection = {
                ...data,
                aiHealth: aiProcessHealth.status,
                processingEnabled: aiControlEnabled
              };
              broadcastToBrowsers(enhancedDetection);
              
              // Send to robot if enabled
              if (aiControlEnabled && lastDetection) {
                // Send color-specific command to browser clients to trigger sequence
                console.log(`Triggering sequence for color: ${lastDetection.color}`);
                broadcastToBrowsers({
                  type: 'execute_sequence',
                  color: lastDetection.color.toLowerCase(),
                  timestamp: Date.now()
                });
              }
            }
            break;
           default:
            
            break; 
          }

        }
      } else {
        // Handle text messages (usually JSON)
        const data = JSON.parse(message.toString());
        console.log(`Received message from ${clientType}:`, data.type || 'unknown');
        
        // Handle different message types
        switch (data.type) {
          case 'ai_init':
            if (clientType === 'ai') {
              console.log('AI Engine initialized:', data.capabilities);
              broadcastToBrowsers({
                type: 'ai_initialized',
                capabilities: data.capabilities,
                colors: data.colors,
                timestamp: data.timestamp
              });
            }
            break;
            
          case 'camera_info':
            // Forward camera info to browsers
            broadcastToBrowsers(data);
            break;
            
          case 'frame_metadata':
            // Forward frame metadata to browsers and AI
            broadcastToBrowsers(data);
            if (clients.ai && clients.ai.readyState === WebSocket.OPEN) {
              clients.ai.send(JSON.stringify(data));
            }
            break;
            
    
            
          case 'ai_statistics':
            if (clientType === 'ai') {
              console.log('Received AI statistics:', data.stats);
              broadcastToBrowsers({
                type: 'ai_statistics',
                stats: data.stats,
                processing_rate: data.processing_rate,
                timestamp: data.timestamp
              });
            }
            break;
            
          case 'robot_status':
            // Handle robot status updates
            if (clientType === 'robot') {
              lastRobotStatus = data;
              broadcastToBrowsers({ type: 'robot_status', data });
            }
            break;
            
          case 'ai_control':
            // Handle AI control messages from browsers
            aiControlEnabled = data.enabled;
            console.log(`AI control ${aiControlEnabled ? 'enabled' : 'disabled'}`);
            
            // Notify AI process
            if (clients.ai && clients.ai.readyState === WebSocket.OPEN) {
              clients.ai.send(JSON.stringify({
                type: 'control_status',
                enabled: aiControlEnabled
              }));
            }
            
            // Broadcast to all browsers
            broadcastToBrowsers({
              type: 'ai_control_status',
              enabled: aiControlEnabled,
              timestamp: Date.now()
            });
            break;
            
          case 'get_ai_stats':
            // Request statistics from AI
            if (clients.ai && clients.ai.readyState === WebSocket.OPEN) {
              clients.ai.send(JSON.stringify({ type: 'get_stats' }));
            }
            break;
            
          default:
            // Forward other messages to browsers
            if (clientType === 'robot' && data.device === 'robot_arm_conveyor') {
              lastRobotStatus = data;
              broadcastToBrowsers({ type: 'robot_status', data });
            }
        }
      }
    } catch (error) {
      console.error(`Error processing message from ${clientType}:`, error);
    }
  });

  // Handle WebSocket close
  ws.on('close', () => {
    clearInterval(pingInterval);
    console.log(`${clientType} client disconnected`);
    
    if (clients.browsers.has(ws)) {
      clients.browsers.delete(ws);
      console.log(`Browser client disconnected. Remaining: ${clients.browsers.size}`);
    } else if (clientType === 'camera') {
      // Find and remove camera client
      for (const [id, camera] of clients.cameras.entries()) {
        if (camera === ws) {
          clients.cameras.delete(id);
          console.log(`Camera ${id} disconnected. Remaining: ${clients.cameras.size}`);
          broadcastToBrowsers({
            type: 'connection_status',
            device: 'camera',
            status: clients.cameras.size > 0 ? 'connected' : 'disconnected'
          });
          break;
        }
      }
    } else if (clientType === 'robot') {
      if (clients.robot === ws) {
        clients.robot = null;
        robotReady = false;
        broadcastToBrowsers({
          type: 'connection_status',
          device: 'robot',
          status: 'disconnected'
        });
      }
    } else if (clientType === 'ai') {
      clients.ai = null;
      aiProcessHealth.status = 'disconnected';
      broadcastToBrowsers({ 
        type: 'connection_status', 
        device: 'ai', 
        status: 'disconnected' 
      });
    }
  });

  // Handle WebSocket errors
  ws.on('error', (error) => {
    console.error(`WebSocket error for ${clientType}:`, error);
  });
});

// REST API routes
app.use(express.json());

// POST /api/robot/command
app.post('/api/robot/command', (req, res) => {
  const command = req.body;
  if (!command || typeof command !== 'object') {
    return res.status(400).json({ error: 'Invalid command' });
  }
  
  // Check if robot is connected
  if (!clients.robot || clients.robot.readyState !== WebSocket.OPEN) {
    return res.status(503).json({ 
      error: 'Robot not connected', 
      message: 'Cannot send commands when robot is offline',
      status: 'disconnected'
    });
  }
  
  const msg = JSON.stringify(command);
  try {
    clients.robot.send(msg);
    return res.json({ 
      status: 'sent',
      timestamp: Date.now()
    });
  } catch (e) {
    console.error('Failed to send command to robot:', e);
    return res.status(500).json({ 
      error: 'Failed to send command',
      message: e.message
    });
  }
});

// GET /api/robot/status
app.get('/api/robot/status', (req, res) => {
  if (lastRobotStatus) {
    return res.json(lastRobotStatus);
  } else {
    return res.json({ status: robotReady ? 'online' : 'offline' });
  }
});

// GET /api/ai/health - New endpoint for AI health monitoring
app.get('/api/ai/health', (req, res) => {
  res.json({
    health: aiProcessHealth,
    controlEnabled: aiControlEnabled,
    lastDetection: lastDetection,
    detectionCount: detectionHistory.length
  });
});

// POST /api/ai/control - New endpoint for AI control
app.post('/api/ai/control', (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be boolean' });
  }
  
  // Check if AI client is connected before enabling control
  if (enabled && (!clients.ai || clients.ai.readyState !== WebSocket.OPEN)) {
    return res.status(503).json({
      error: 'AI client not connected',
      message: 'Cannot enable AI control when AI service is not connected'
    });
  }
  
  // Set the control state
  aiControlEnabled = enabled;
  console.log(`AI control set to ${aiControlEnabled ? 'ENABLED' : 'DISABLED'} via REST API`);
  
  // Notify AI process with enhanced error handling
  if (clients.ai && clients.ai.readyState === WebSocket.OPEN) {
    try {
      const controlMsg = JSON.stringify({
        type: 'control_status',
        enabled: aiControlEnabled
      });
      
      clients.ai.send(controlMsg);
      console.log(`Sent control_status to AI client: ${controlMsg}`);
    } catch (error) {
      console.error(`Failed to send control message to AI: ${error.message}`);
      return res.status(500).json({ 
        error: 'Failed to communicate with AI process',
        message: error.message
      });
    }
  } else {
    console.warn('AI client not available to receive control message');
  }
  
  // Broadcast to browsers
  broadcastToBrowsers({
    type: 'ai_control_status',
    enabled: aiControlEnabled,
    timestamp: Date.now()
  });
  
  // Always return a response
  return res.json({ 
    status: 'updated', 
    enabled: aiControlEnabled,
    timestamp: Date.now() 
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    server: 'online',
    connections: {
      browsers: clients.browsers.size,
      cameras: clients.cameras.size,
      robot: clients.robot ? 'connected' : 'disconnected',
      ai: clients.ai ? 'connected' : 'disconnected'
    },
    ai: aiProcessHealth,
    aiControl: aiControlEnabled
  });
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`WebSocket server ready for connections`);
  console.log(`Access the dashboard at http://localhost:${PORT}`);
}).on('error', (error) => {
  console.error(`Failed to start server on port ${PORT}:`, error);
  process.exit(1);
});

// Start the AI process when the server starts
startAIProcess();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  if (aiProcess) {
    aiProcess.kill('SIGTERM');
  }
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  if (aiProcess) {
    aiProcess.kill('SIGTERM');
  }
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Function to log AI detections to file with rotation
async function logDetection(detection) {
  try {
    // Create log entry
    const logEntry = {
      timestamp: new Date().toISOString(),
      color: detection.color || 'unknown',
      confidence: detection.confidence || 0,
      area: detection.area || 0
    };
    
    const logLine = JSON.stringify(logEntry) + '\n';
    
    // Check if file exists and its size
    let stats;
    try {
      stats = await fsPromises.stat(DETECTION_LOG_PATH);
    } catch (error) {
      // File doesn't exist yet, which is fine
    }
    
    // If file exists and exceeds max size, rotate it
    if (stats && stats.size > MAX_LOG_SIZE) {
      console.log(`Detection log exceeds ${MAX_LOG_SIZE/1024/1024}MB, rotating...`);
      const backupPath = `${DETECTION_LOG_PATH}.${Date.now()}.bak`;
      await fsPromises.rename(DETECTION_LOG_PATH, backupPath);
      console.log(`Rotated detection log to: ${backupPath}`);
    }
    
    // Append to log file
    await fsPromises.appendFile(DETECTION_LOG_PATH, logLine);
    
  } catch (error) {
    console.error(`Error logging detection: ${error}`);
  }
}