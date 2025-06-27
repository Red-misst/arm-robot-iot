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
            } // End of createRoboticArm
        
        } // End of RoboticArmSimulation class
       