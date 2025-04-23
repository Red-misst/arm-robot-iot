import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Get current file directory with ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Initialize WebSocket server
const wss = new WebSocketServer({ server });

// Store connected clients
let clients = {
  robot: null,
  camera: null,
  ui: [],
  ai: null
};

// Track the latest frame for new UI connections
let latestFrame = null;
let latestRobotStatus = null;

// AI control state
let aiControlEnabled = false;

// Start the AI vision process
let aiProcess = null;

const startAIProcess = () => {
  console.log("Starting AI vision process...");
  
  // Path to the Python executable and script
  const pythonPath = process.env.PYTHON_PATH || 'python';
  const scriptPath = path.join(__dirname, 'ai', 'ai_vision.py');
  
  if (!fs.existsSync(scriptPath)) {
    console.error(`AI vision script not found at: ${scriptPath}`);
    return;
  }
  
  // Spawn the process
  aiProcess = spawn(pythonPath, [scriptPath]);
  
  // Handle stdout data
  aiProcess.stdout.on('data', (data) => {
    console.log(`AI vision output: ${data}`);
  });
  
  // Handle stderr data
  aiProcess.stderr.on('data', (data) => {
    console.error(`AI vision error: ${data}`);
  });
  
  // Handle process exit
  aiProcess.on('close', (code) => {
    console.log(`AI vision process exited with code ${code}`);
    aiProcess = null;
    
    // Attempt to restart the process if it crashes
    if (code !== 0) {
      console.log("AI process crashed, restarting in 5 seconds...");
      setTimeout(startAIProcess, 5000);
    }
  });
  
  console.log("AI vision process started");
};

// Helper function to check if data is binary JPEG
function isJpegData(data) {
  if (data instanceof Buffer) {
    // Check for JPEG header signature (FF D8 FF)
    return data.length >= 3 && 
           data[0] === 0xFF && 
           data[1] === 0xD8 && 
           data[2] === 0xFF;
  }
  return false;
}

// Forward messages between clients
const handleMessage = (message, sender, senderType) => {
  try {
    // Check if the message is binary (likely a video frame)
    // Handle both Node.js Buffer and browser ArrayBuffer
    if (message instanceof Buffer || 
        message instanceof ArrayBuffer || 
        (typeof message === 'object' && message.toString() === '[object ArrayBuffer]') ||
        isJpegData(message)) {
      
      // Convert ArrayBuffer to Buffer if needed
      const frameBuffer = message instanceof ArrayBuffer ? Buffer.from(message) : message;
      
      if (senderType === 'camera') {
        console.log(`Received binary frame from camera: ${frameBuffer.length} bytes`);
        
        // Store the latest frame
        latestFrame = frameBuffer;
        
        // Forward camera frames to UI and AI
        broadcastToUI(frameBuffer);
        
        // Forward to AI for processing
        if (clients.ai && clients.ai.readyState === WebSocket.OPEN) {
          clients.ai.send(frameBuffer, (err) => {
            if (err) {
              console.error('Error sending frame to AI client:', err);
            }
          });
        }
      }
      return;
    }
    
    // For text messages, parse as JSON
    // First make sure it's actually a string
    const jsonData = typeof message === 'string' ? message : message.toString();
    const data = JSON.parse(jsonData);
    
    // Add a timestamp and source to the message
    data.timestamp = data.timestamp || new Date().toISOString();
    data.source = senderType;
    
    // Handle camera metadata
    if (senderType === 'camera' && data.type === 'frame_metadata') {
      broadcastToUI(data);
      if (clients.ai) {
        clients.ai.send(JSON.stringify(data));
      }
    }
    
    // Handle AI detection results
    if (senderType === 'ai' && data.type === 'detection') {
      console.log(`Received AI detection: ${data.detections.length} objects`);
      console.log(`Detection data sample:`, JSON.stringify(data.detections[0] || {}));
      
      // Forward detection results to UI clients
      broadcastToUI(data);
      
      // If AI control is enabled, forward to robot
      if (aiControlEnabled && clients.robot && clients.robot.readyState === WebSocket.OPEN) {
        clients.robot.send(JSON.stringify({
          type: 'ai_detection',
          detections: data.detections,
          timestamp: data.timestamp
        }));
      }
    }
    
    // Handle AI control messages
    if (data.type === 'ai_control') {
      aiControlEnabled = data.enabled;
      console.log(`AI control ${aiControlEnabled ? 'enabled' : 'disabled'}`);
      
      // Notify AI client of control status change
      if (clients.ai && clients.ai.readyState === WebSocket.OPEN) {
        clients.ai.send(JSON.stringify({
          type: 'control_status',
          enabled: aiControlEnabled
        }));
      }
    }
  } catch (e) {
    console.error('Error handling message:', e);
    // Log more details about the message for debugging
    console.debug('Message type:', typeof message);
    if (typeof message === 'object') {
      console.debug('Object type:', message.constructor.name);
    }
  }
};

// Broadcast message to all UI clients
const broadcastToUI = message => {
  if (!clients.ui.length) return;
  
  const payload = message instanceof Buffer 
    ? message 
    : JSON.stringify(message);
  
  let sentCount = 0;
  clients.ui.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(payload, err => {
          if (err) {
            console.error('Error sending to UI client:', err);
          } else {
            sentCount++;
          }
        });
      } catch (e) {
        console.error('Exception sending to UI client:', e);
      }
    }
  });
  
  // Log only for binary messages to avoid console spam
  if (message instanceof Buffer) {
    console.log(`Broadcasted ${message.length} bytes to ${sentCount}/${clients.ui.length} UI clients`);
  }
};

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const clientType = url.searchParams.get('type');
  
  console.log(`New WebSocket connection: ${clientType} from ${req.socket.remoteAddress}`);
  
  // Set binary type to arraybuffer for all connections
  ws.binaryType = 'arraybuffer';
  
  // Register the client based on type
  switch (clientType) {
    case 'camera':
      clients.camera = ws;
      broadcastToUI({
        type: 'connection_status',
        device: 'camera',
        status: 'connected'
      });
      break;
      
    case 'robot':
      clients.robot = ws;
      broadcastToUI({
        type: 'connection_status',
        device: 'robot',
        status: 'connected'
      });
      break;
      
    case 'ui':
      clients.ui.push(ws);
      
      // Send current connection statuses
      ws.send(JSON.stringify({
        type: 'connection_status',
        device: 'robot',
        status: clients.robot ? 'connected' : 'disconnected'
      }));
      
      ws.send(JSON.stringify({
        type: 'connection_status',
        device: 'camera',
        status: clients.camera ? 'connected' : 'disconnected'
      }));
      
      ws.send(JSON.stringify({
        type: 'connection_status',
        device: 'ai',
        status: clients.ai ? 'connected' : 'disconnected'
      }));
      
      // Send latest robot status if available
      if (latestRobotStatus) {
        ws.send(JSON.stringify(latestRobotStatus));
      } 
      
      // Send latest camera frame if available
      if (latestFrame) {
        ws.send(latestFrame);
      }
      break;
      
    case 'ai':
      console.log('AI client connected');
      clients.ai = ws;
      broadcastToUI({
        type: 'connection_status',
        device: 'ai',
        status: 'connected'
      });
      break;
      
    default:
      console.log(`Unknown client type: ${clientType}`);
  }
  
  // Set up message handler
  ws.on('message', (message) => {
    try {
      handleMessage(message, ws, clientType);
    } catch (e) {
      console.error(`Error handling message from ${clientType}:`, e);
    }
  });
  
  // Set up close handler
  ws.on('close', () => {
    console.log(`${clientType} client disconnected`);
    
    // Handle specific client disconnections
    switch (clientType) {
      case 'camera':
        clients.camera = null;
        break;
      case 'robot':
        clients.robot = null;
        break;
      case 'ai':
        clients.ai = null;
        break;
      case 'ui':
        clients.ui = clients.ui.filter(client => client !== ws);
        break;
    }
    
    // Notify UI clients about disconnection
    if (clientType && clientType !== 'ui') {
      broadcastToUI({
        type: 'connection_status',
        device: clientType,
        status: 'disconnected'
      });
    }
  });
});

// Modify the server startup section
const startServer = (port) => {
  server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
    console.log(`WebSocket server ready for connections`);
  }).on('error', (error) => {
    console.error(`Failed to start server on port ${port}:`, error);
    
    if (error.code === 'EACCES') {
      console.error(`Permission denied. Try running with elevated privileges or use a port > 1024.`);
    } else if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Try a different port.`);
    }
    
    // Exit with error code
    process.exit(1);
  });
};

// Start the server
const PORT = process.env.PORT || 3000;
console.log(`Attempting to start server on port ${PORT}...`);
startServer(PORT);

// Start the AI process when the server starts
startAIProcess();