/**
 * Advanced 3D Robotic Arm Simulation
 * Real-time position tracking with realistic physics and animations
 */

class RoboticArmSimulation {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.armGroup = null;
        this.joints = [];
        this.conveyor = null;
        this.sortingBins = [];
        this.currentObject = null;
        
        // Arm dimensions (in relative units)
        this.armConfig = {
            baseHeight: 0.3,
            baseRadius: 0.4,
            shoulderLength: 1.5,
            elbowLength: 1.2,
            gripperLength: 0.5,
            segmentRadius: 0.1
        };
        
        // Current joint angles (matching ESP8266 positions)
        this.currentAngles = {
            base: 90,      // 0-180°
            shoulder: 90,  // 0-180° 
            elbow: 45,     // 0-180°
            gripper: 0     // 0-180° (0=open, 180=closed)
        };
        
        // Position templates (matching ESP8266)
        this.positionTemplates = {
            rest: { base: 90, shoulder: 90, elbow: 45, gripper: 0 },
            pickup: { base: 90, shoulder: 60, elbow: 120, gripper: 0 },
            redBin: { base: 45, shoulder: 90, elbow: 90, gripper: 180 },
            greenBin: { base: 90, shoulder: 90, elbow: 90, gripper: 180 },
            blueBin: { base: 135, shoulder: 90, elbow: 90, gripper: 180 }
        };
        
        // Animation system
        this.isAnimating = false;
        this.animationQueue = [];
        this.animationSpeed = 0.02; // Degrees per frame
        
        // WebSocket connection
        this.ws = null;
        this.connectionState = 'disconnected';
        this.lastUpdate = null;
        
        this.init();
        this.setupEventListeners();
        this.setupWebSocket();
        this.animate();
    }
    
    init() {
        const container = document.getElementById('armContainer');
        
        // Scene setup
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0a0a0a);
        this.scene.fog = new THREE.Fog(0x0a0a0a, 10, 50);
        
        // Camera setup
        this.camera = new THREE.PerspectiveCamera(
            60,
            container.clientWidth / container.clientHeight,
            0.1,
            100
        );
        this.camera.position.set(5, 4, 5);
        
        // Renderer setup
        this.renderer = new THREE.WebGLRenderer({ 
            antialias: true, 
            alpha: true,
            powerPreference: "high-performance"
        });
        this.renderer.setSize(container.clientWidth, container.clientHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.renderer.outputEncoding = THREE.sRGBEncoding;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.2;
        
        container.appendChild(this.renderer.domElement);
        
        // Controls setup
        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.maxDistance = 15;
        this.controls.minDistance = 2;
        this.controls.maxPolarAngle = Math.PI * 0.8;
        
        // Lighting setup
        this.setupLighting();
        
        // Create environment
        this.createEnvironment();
        
        // Create robotic arm
        this.createRoboticArm();
        
        // Create conveyor and bins
        this.createConveyor();
        this.createSortingBins();
        
        // Handle window resize
        window.addEventListener('resize', () => this.handleResize());
    }
    
    setupLighting() {
        // Ambient light
        const ambientLight = new THREE.AmbientLight(0x404040, 0.3);
        this.scene.add(ambientLight);
        
        // Main directional light
        const mainLight = new THREE.DirectionalLight(0xffffff, 1.0);
        mainLight.position.set(5, 10, 5);
        mainLight.castShadow = true;
        mainLight.shadow.mapSize.width = 2048;
        mainLight.shadow.mapSize.height = 2048;
        mainLight.shadow.camera.near = 0.1;
        mainLight.shadow.camera.far = 50;
        mainLight.shadow.camera.left = -10;
        mainLight.shadow.camera.right = 10;
        mainLight.shadow.camera.top = 10;
        mainLight.shadow.camera.bottom = -10;
        this.scene.add(mainLight);
        
        // Fill light
        const fillLight = new THREE.DirectionalLight(0x4466ff, 0.3);
        fillLight.position.set(-5, 5, -5);
        this.scene.add(fillLight);
        
        // Accent lights for atmosphere
        const accentLight1 = new THREE.PointLight(0x8b5cf6, 0.5, 10);
        accentLight1.position.set(3, 2, 3);
        this.scene.add(accentLight1);
        
        const accentLight2 = new THREE.PointLight(0x06b6d4, 0.3, 8);
        accentLight2.position.set(-3, 1, -2);
        this.scene.add(accentLight2);
    }
    
    createEnvironment() {
        // Ground plane
        const groundGeometry = new THREE.PlaneGeometry(20, 20);
        const groundMaterial = new THREE.MeshLambertMaterial({ 
            color: 0x1a1a1a,
            transparent: true,
            opacity: 0.8
        });
        const ground = new THREE.Mesh(groundGeometry, groundMaterial);
        ground.rotation.x = -Math.PI / 2;
        ground.receiveShadow = true;
        this.scene.add(ground);
        
        // Grid helper
        const gridHelper = new THREE.GridHelper(20, 20, 0x444444, 0x222222);
        gridHelper.material.transparent = true;
        gridHelper.material.opacity = 0.3;
        this.scene.add(gridHelper);
        
        // Work surface
        const surfaceGeometry = new THREE.BoxGeometry(4, 0.1, 3);
        const surfaceMaterial = new THREE.MeshPhongMaterial({ 
            color: 0x2a2a2a,
            transparent: true,
            opacity: 0.9
        });
        const workSurface = new THREE.Mesh(surfaceGeometry, surfaceMaterial);
        workSurface.position.set(0, 0.05, 0);
        workSurface.receiveShadow = true;
        this.scene.add(workSurface);
    }
    
    createRoboticArm() {
        this.armGroup = new THREE.Group();
        this.joints = [];
        
        // Create materials
        const baseMaterial = new THREE.MeshPhongMaterial({ 
            color: 0x333333,
            shininess: 100
        });
        const jointMaterial = new THREE.MeshPhongMaterial({ 
            color: 0x666666,
            shininess: 80
        });
        const segmentMaterial = new THREE.MeshPhongMaterial({ 
            color: 0x8b5cf6,
            shininess: 60
        });
        const gripperMaterial = new THREE.MeshPhongMaterial({ 
            color: 0x06b6d4,
            shininess: 90
        });
        
        // Base
        const baseGeometry = new THREE.CylinderGeometry(
            this.armConfig.baseRadius, 
            this.armConfig.baseRadius, 
            this.armConfig.baseHeight, 
            16
        );
        const base = new THREE.Mesh(baseGeometry, baseMaterial);
        base.position.y = this.armConfig.baseHeight / 2;
        base.castShadow = true;
        base.receiveShadow = true;
        this.armGroup.add(base);
        
        // Base joint (rotation around Y-axis)\n        const baseJoint = new THREE.Group();\n        baseJoint.position.y = this.armConfig.baseHeight;\n        this.armGroup.add(baseJoint);\n        this.joints.push({ group: baseJoint, axis: 'y', angle: 0 });\n        \n        // Shoulder segment\n        const shoulderGeometry = new THREE.CylinderGeometry(\n            this.armConfig.segmentRadius,\n            this.armConfig.segmentRadius,\n            this.armConfig.shoulderLength,\n            8\n        );\n        const shoulderSegment = new THREE.Mesh(shoulderGeometry, segmentMaterial);\n        shoulderSegment.position.y = this.armConfig.shoulderLength / 2;\n        shoulderSegment.rotation.z = Math.PI / 2;\n        shoulderSegment.castShadow = true;\n        baseJoint.add(shoulderSegment);\n        \n        // Shoulder joint (rotation around Z-axis)\n        const shoulderJoint = new THREE.Group();\n        shoulderJoint.position.set(this.armConfig.shoulderLength, 0, 0);\n        baseJoint.add(shoulderJoint);\n        this.joints.push({ group: shoulderJoint, axis: 'z', angle: 0 });\n        \n        // Elbow segment\n        const elbowGeometry = new THREE.CylinderGeometry(\n            this.armConfig.segmentRadius * 0.8,\n            this.armConfig.segmentRadius * 0.8,\n            this.armConfig.elbowLength,\n            8\n        );\n        const elbowSegment = new THREE.Mesh(elbowGeometry, segmentMaterial);\n        elbowSegment.position.y = this.armConfig.elbowLength / 2;\n        elbowSegment.rotation.z = Math.PI / 2;\n        elbowSegment.castShadow = true;\n        shoulderJoint.add(elbowSegment);\n        \n        // Elbow joint (rotation around Z-axis)\n        const elbowJoint = new THREE.Group();\n        elbowJoint.position.set(this.armConfig.elbowLength, 0, 0);\n        shoulderJoint.add(elbowJoint);\n        this.joints.push({ group: elbowJoint, axis: 'z', angle: 0 });\n        \n        // Gripper assembly\n        this.createGripper(elbowJoint, gripperMaterial);\n        \n        this.scene.add(this.armGroup);\n        \n        // Set initial position\n        this.updateArmPosition(this.currentAngles, false);\n    }\n    \n    createGripper(parent, material) {\n        const gripperGroup = new THREE.Group();\n        \n        // Gripper base\n        const gripperBaseGeometry = new THREE.BoxGeometry(0.3, 0.15, 0.15);\n        const gripperBase = new THREE.Mesh(gripperBaseGeometry, material);\n        gripperBase.position.set(0.15, 0, 0);\n        gripperBase.castShadow = true;\n        gripperGroup.add(gripperBase);\n        \n        // Gripper fingers\n        const fingerGeometry = new THREE.BoxGeometry(0.2, 0.05, 0.02);\n        \n        // Left finger\n        const leftFinger = new THREE.Mesh(fingerGeometry, material);\n        leftFinger.position.set(0.25, 0.1, 0);\n        leftFinger.castShadow = true;\n        gripperGroup.add(leftFinger);\n        \n        // Right finger  \n        const rightFinger = new THREE.Mesh(fingerGeometry, material);\n        rightFinger.position.set(0.25, -0.1, 0);\n        rightFinger.castShadow = true;\n        gripperGroup.add(rightFinger);\n        \n        // Store finger references for animation\n        this.gripperFingers = { left: leftFinger, right: rightFinger };\n        \n        parent.add(gripperGroup);\n        this.joints.push({ \n            group: gripperGroup, \n            axis: 'gripper', \n            angle: 0,\n            fingers: this.gripperFingers\n        });\n    }\n    \n    createConveyor() {\n        const conveyorGroup = new THREE.Group();\n        \n        // Conveyor belt\n        const beltGeometry = new THREE.BoxGeometry(6, 0.1, 0.8);\n        const beltMaterial = new THREE.MeshPhongMaterial({ \n            color: 0x2a2a2a,\n            transparent: true,\n            opacity: 0.8\n        });\n        const belt = new THREE.Mesh(beltGeometry, beltMaterial);\n        belt.position.set(0, 0.05, -2);\n        belt.receiveShadow = true;\n        conveyorGroup.add(belt);\n        \n        // Belt texture animation (simulated movement)\n        const beltTextureGeometry = new THREE.PlaneGeometry(6, 0.8);\n        const beltTextureMaterial = new THREE.MeshBasicMaterial({ \n            color: 0x444444,\n            transparent: true,\n            opacity: 0.5\n        });\n        const beltTexture = new THREE.Mesh(beltTextureGeometry, beltTextureMaterial);\n        beltTexture.position.set(0, 0.11, -2);\n        beltTexture.rotation.x = -Math.PI / 2;\n        conveyorGroup.add(beltTexture);\n        \n        this.conveyor = conveyorGroup;\n        this.scene.add(conveyorGroup);\n    }\n    \n    createSortingBins() {\n        const binGeometry = new THREE.BoxGeometry(0.6, 0.4, 0.6);\n        const binPositions = [\n            { x: -2, z: 1.5, color: 0xff4444, name: 'red' },\n            { x: 0, z: 1.5, color: 0x44ff44, name: 'green' },\n            { x: 2, z: 1.5, color: 0x4444ff, name: 'blue' }\n        ];\n        \n        binPositions.forEach(bin => {\n            const material = new THREE.MeshPhongMaterial({ \n                color: bin.color,\n                transparent: true,\n                opacity: 0.7\n            });\n            const binMesh = new THREE.Mesh(binGeometry, material);\n            binMesh.position.set(bin.x, 0.2, bin.z);\n            binMesh.receiveShadow = true;\n            binMesh.userData = { type: 'bin', color: bin.name };\n            \n            this.sortingBins.push(binMesh);\n            this.scene.add(binMesh);\n        });\n    }\n    \n    // Animation and position control\n    updateArmPosition(targetAngles, animate = true) {\n        if (animate && !this.isAnimating) {\n            this.animateToPosition(targetAngles);\n        } else if (!animate) {\n            this.setArmPosition(targetAngles);\n        }\n    }\n    \n    setArmPosition(angles) {\n        // Convert degrees to radians and apply to joints\n        const baseAngleRad = THREE.MathUtils.degToRad(angles.base - 90); // Offset for proper orientation\n        const shoulderAngleRad = THREE.MathUtils.degToRad(angles.shoulder - 90);\n        const elbowAngleRad = THREE.MathUtils.degToRad(angles.elbow);\n        \n        // Apply rotations\n        this.joints[0].group.rotation.y = baseAngleRad;\n        this.joints[1].group.rotation.z = -shoulderAngleRad;\n        this.joints[2].group.rotation.z = -elbowAngleRad;\n        \n        // Update gripper\n        this.updateGripper(angles.gripper);\n        \n        // Store current angles\n        this.currentAngles = { ...angles };\n        \n        // Update UI\n        this.updateUI();\n    }\n    \n    animateToPosition(targetAngles) {\n        this.isAnimating = true;\n        const startAngles = { ...this.currentAngles };\n        const duration = 2000; // 2 seconds\n        const startTime = Date.now();\n        \n        const animate = () => {\n            const elapsed = Date.now() - startTime;\n            const progress = Math.min(elapsed / duration, 1);\n            \n            // Easing function for smooth animation\n            const easeInOutCubic = t => t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1;\n            const easedProgress = easeInOutCubic(progress);\n            \n            // Interpolate angles\n            const currentAngles = {\n                base: startAngles.base + (targetAngles.base - startAngles.base) * easedProgress,\n                shoulder: startAngles.shoulder + (targetAngles.shoulder - startAngles.shoulder) * easedProgress,\n                elbow: startAngles.elbow + (targetAngles.elbow - startAngles.elbow) * easedProgress,\n                gripper: startAngles.gripper + (targetAngles.gripper - startAngles.gripper) * easedProgress\n            };\n            \n            this.setArmPosition(currentAngles);\n            \n            if (progress < 1) {\n                requestAnimationFrame(animate);\n            } else {\n                this.isAnimating = false;\n                this.currentAngles = { ...targetAngles };\n                this.updateUI();\n            }\n        };\n        \n        animate();\n    }\n    \n    updateGripper(angle) {\n        if (this.gripperFingers) {\n            const openDistance = 0.1;\n            const closedDistance = 0.02;\n            const progress = angle / 180;\n            const fingerDistance = openDistance - (openDistance - closedDistance) * progress;\n            \n            this.gripperFingers.left.position.y = fingerDistance;\n            this.gripperFingers.right.position.y = -fingerDistance;\n        }\n    }\n    \n    // UI Updates\n    updateUI() {\n        // Update angle displays\n        document.getElementById('baseAngle').textContent = `${Math.round(this.currentAngles.base)}°`;\n        document.getElementById('shoulderAngle').textContent = `${Math.round(this.currentAngles.shoulder)}°`;\n        document.getElementById('elbowAngle').textContent = `${Math.round(this.currentAngles.elbow)}°`;\n        document.getElementById('gripperAngle').textContent = `${Math.round(this.currentAngles.gripper)}°`;\n        \n        // Update progress bars\n        document.getElementById('baseProgress').style.width = `${(this.currentAngles.base / 180) * 100}%`;\n        document.getElementById('shoulderProgress').style.width = `${(this.currentAngles.shoulder / 180) * 100}%`;\n        document.getElementById('elbowProgress').style.width = `${(this.currentAngles.elbow / 180) * 100}%`;\n        document.getElementById('gripperProgress').style.width = `${(this.currentAngles.gripper / 180) * 100}%`;\n        \n        // Update last update time\n        const now = new Date();\n        document.getElementById('lastUpdate').textContent = now.toLocaleTimeString();\n    }\n    \n    logActivity(message, type = 'info') {\n        const log = document.getElementById('activityLog');\n        const timestamp = new Date().toLocaleTimeString();\n        const colors = {\n            info: 'text-blue-300',\n            success: 'text-green-300', \n            warning: 'text-yellow-300',\n            error: 'text-red-300'\n        };\n        \n        const entry = document.createElement('div');\n        entry.className = colors[type] || colors.info;\n        entry.innerHTML = `[${timestamp}] ${message}`;\n        \n        log.appendChild(entry);\n        log.scrollTop = log.scrollHeight;\n        \n        // Keep only last 50 entries\n        while (log.children.length > 50) {\n            log.removeChild(log.firstChild);\n        }\n    }\n    \n    // WebSocket connection\n    setupWebSocket() {\n        this.connectWebSocket();\n    }\n    \n    connectWebSocket() {\n        try {\n            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';\n            const wsUrl = `${protocol}//${window.location.host}/?type=ui`;\n            \n            this.ws = new WebSocket(wsUrl);\n            \n            this.ws.onopen = () => {\n                this.connectionState = 'connected';\n                this.updateConnectionStatus();\n                this.logActivity('Connected to robot system', 'success');\n            };\n            \n            this.ws.onmessage = (event) => {\n                try {\n                    const data = JSON.parse(event.data);\n                    this.handleWebSocketMessage(data);\n                } catch (e) {\n                    // Handle binary data (video frames) - ignore for arm monitor\n                }\n            };\n            \n            this.ws.onclose = () => {\n                this.connectionState = 'disconnected';\n                this.updateConnectionStatus();\n                this.logActivity('Disconnected from robot system', 'warning');\n                \n                // Reconnect after 3 seconds\n                setTimeout(() => this.connectWebSocket(), 3000);\n            };\n            \n            this.ws.onerror = (error) => {\n                this.logActivity('WebSocket error occurred', 'error');\n                console.error('WebSocket error:', error);\n            };\n            \n        } catch (error) {\n            this.logActivity('Failed to connect to robot system', 'error');\n            setTimeout(() => this.connectWebSocket(), 5000);\n        }\n    }\n    \n    handleWebSocketMessage(data) {\n        if (data.device === 'robot_arm_conveyor') {\n            // Update arm position from real robot data\n            if (data.armPosition) {\n                const angles = {\n                    base: data.armPosition.base,\n                    shoulder: data.armPosition.shoulder,\n                    elbow: data.armPosition.elbow,\n                    gripper: data.armPosition.gripper\n                };\n                this.updateArmPosition(angles, true);\n                this.logActivity(`Position updated: Base ${angles.base}° Shoulder ${angles.shoulder}° Elbow ${angles.elbow}° Gripper ${angles.gripper}°`);\n            }\n            \n            // Update conveyor status\n            if (data.conveyor) {\n                const status = data.conveyor.running ? \n                    `Running at ${data.conveyor.stepsPerSecond} steps/sec` : 'Stopped';\n                document.getElementById('conveyorStatus').textContent = status;\n            }\n            \n            // Update last detected color\n            if (data.lastDetectedColor && data.lastDetectedColor !== '') {\n                document.getElementById('lastDetection').textContent = data.lastDetectedColor;\n                this.logActivity(`Object detected: ${data.lastDetectedColor}`, 'success');\n            }\n        }\n        \n        // Handle AI detection results\n        if (data.type === 'detection' && data.detections && data.detections.length > 0) {\n            const detection = data.detections[0];\n            if (detection.color) {\n                document.getElementById('lastDetection').textContent = detection.color;\n                this.logActivity(`AI Detection: ${detection.color} (confidence: ${(detection.confidence * 100).toFixed(1)}%)`, 'info');\n            }\n        }\n    }\n    \n    updateConnectionStatus() {\n        const statusEl = document.getElementById('connectionStatus');\n        const textEl = document.getElementById('connectionText');\n        \n        if (this.connectionState === 'connected') {\n            statusEl.className = 'w-3 h-3 rounded-full bg-green-500 pulse-glow';\n            textEl.textContent = 'Connected';\n        } else {\n            statusEl.className = 'w-3 h-3 rounded-full bg-red-500 pulse-glow';\n            textEl.textContent = 'Disconnected';\n        }\n    }\n    \n    // Event listeners\n    setupEventListeners() {\n        // Position template buttons\n        Object.keys(this.positionTemplates).forEach(positionName => {\n            const buttonId = positionName === 'rest' ? 'restPosition' :\n                            positionName === 'pickup' ? 'pickupPosition' :\n                            `${positionName}BinPosition`;\n            \n            const button = document.getElementById(buttonId);\n            if (button) {\n                button.addEventListener('click', () => {\n                    this.moveToTemplate(positionName);\n                    this.updateActivePosition(positionName);\n                });\n            }\n        });\n        \n        // Control buttons\n        document.getElementById('resetView')?.addEventListener('click', () => {\n            this.resetCameraView();\n        });\n        \n        document.getElementById('autoRotate')?.addEventListener('click', (e) => {\n            this.controls.autoRotate = !this.controls.autoRotate;\n            e.target.textContent = this.controls.autoRotate ? 'Stop Rotation' : 'Auto Rotate';\n        });\n        \n        document.getElementById('clearLog')?.addEventListener('click', () => {\n            const log = document.getElementById('activityLog');\n            log.innerHTML = '<div class=\"text-gray-500\">[System] Activity log cleared</div>';\n        });\n    }\n    \n    moveToTemplate(templateName) {\n        if (this.positionTemplates[templateName]) {\n            const position = this.positionTemplates[templateName];\n            this.updateArmPosition(position, true);\n            this.logActivity(`Moving to ${templateName} position`, 'info');\n        }\n    }\n    \n    updateActivePosition(positionName) {\n        // Update active position display\n        document.getElementById('activePosition').textContent = \n            positionName.charAt(0).toUpperCase() + positionName.slice(1);\n        \n        // Update button states\n        document.querySelectorAll('.position-btn').forEach(btn => {\n            btn.classList.remove('active');\n        });\n        \n        const activeButton = document.getElementById(\n            positionName === 'rest' ? 'restPosition' :\n            positionName === 'pickup' ? 'pickupPosition' :\n            `${positionName}BinPosition`\n        );\n        \n        if (activeButton) {\n            activeButton.classList.add('active');\n        }\n    }\n    \n    resetCameraView() {\n        this.camera.position.set(5, 4, 5);\n        this.controls.target.set(0, 1, 0);\n        this.controls.update();\n    }\n    \n    handleResize() {\n        const container = document.getElementById('armContainer');\n        const width = container.clientWidth;\n        const height = container.clientHeight;\n        \n        this.camera.aspect = width / height;\n        this.camera.updateProjectionMatrix();\n        this.renderer.setSize(width, height);\n    }\n    \n    // Animation loop\n    animate() {\n        requestAnimationFrame(() => this.animate());\n        \n        this.controls.update();\n        \n        // Add subtle floating animation to bins\n        const time = Date.now() * 0.001;\n        this.sortingBins.forEach((bin, index) => {\n            bin.position.y = 0.2 + Math.sin(time + index) * 0.02;\n        });\n        \n        this.renderer.render(this.scene, this.camera);\n    }\n}\n\n// Initialize the simulation when the page loads\ndocument.addEventListener('DOMContentLoaded', () => {\n    // Small delay to ensure Three.js is fully loaded\n    setTimeout(() => {\n        window.armSimulation = new RoboticArmSimulation();\n    }, 100);\n});
