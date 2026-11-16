import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import Chart from "chart.js/auto";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = {
  latest: null,
  view: "mission",
  lastTick: performance.now(),
  missionSeconds: 0,
  history: [],
  charts: {},
  file: null,
  imageBounds: [],
  layerVisibility: { route: true, sonar: true, defects: true, riskMap: true },
  soundEnabled: true,
  obstacleIds: new Set(),
  audioContext: null,
  videoFrame: 0,
  videoLastDraw: 0,
  videoEnhancementPending: false,
  videoEnhancementErrorShown: false,
  selectedRiskId: null,
  theme: localStorage.getItem("aquainspect-theme") === "light" ? "light" : "dark",
};

const COLORS = {
  cyan: "#61dfcf",
  green: "#84dab0",
  amber: "#eabb73",
  coral: "#ff887b",
  blue: "#83b9e8",
  muted: "#81989b",
  grid: "rgba(132, 164, 165, .12)",
};

const DEFAULT_SCENARIOS = [
  { id: "SIM-CR-01", type: "Crack", location: [-9, 0, 12], severity: "High" },
  { id: "SIM-ER-02", type: "Concrete erosion", location: [-1, 0, 12], severity: "Medium" },
  { id: "SIM-LK-03", type: "Water leakage", location: [6, 0, 13], severity: "High" },
  { id: "SIM-SD-04", type: "Surface damage", location: [11, 0, 12], severity: "Low" },
];

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove("visible"), 2800);
}

async function request(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = await response.json();
      message = body.detail || message;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    throw new Error(message);
  }
  return response.json();
}

async function postJSON(path, body) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function applyProgress(selector, value) {
  const element = $(selector);
  if (element) element.style.width = `${Math.max(0, Math.min(100, value))}%`;
}

function toScene(point) {
  return new THREE.Vector3(point[0], -point[2], point[1]);
}

function makeConcreteTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  context.fillStyle = "#819097";
  context.fillRect(0, 0, 512, 512);
  let seed = 49;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let index = 0; index < 8500; index += 1) {
    const shade = Math.floor(89 + random() * 82);
    const alpha = 0.08 + random() * 0.22;
    context.fillStyle = `rgba(${shade},${shade + 4},${shade + 6},${alpha})`;
    const size = 0.5 + random() * 3.2;
    context.fillRect(random() * 512, random() * 512, size, size);
  }
  for (let index = 0; index < 35; index += 1) {
    context.strokeStyle = `rgba(26,38,39,${0.035 + random() * 0.05})`;
    context.lineWidth = 1 + random() * 3;
    context.beginPath();
    const x = random() * 512;
    context.moveTo(x, 0);
    context.lineTo(x + (random() - 0.5) * 55, 512);
    context.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3.2, 1.6);
  return texture;
}

function damFaceZ(x) {
  return 0.08 + 0.76 * (1 - (x / 19) ** 2);
}

function createDamGeometry() {
  const columns = 49;
  const rows = 33;
  const width = 38;
  const height = 24.5;
  const thickness = 1.25;
  const vertices = [];
  const uvs = [];
  const indices = [];

  for (const side of [0, 1]) {
    const offset = vertices.length / 3;
    for (let row = 0; row <= rows; row += 1) {
      const depth = row / rows;
      const y = 0.15 - depth * height;
      for (let column = 0; column <= columns; column += 1) {
        const x = -width / 2 + (column / columns) * width;
        const face = damFaceZ(x) - (side ? thickness : 0);
        vertices.push(x, y, face);
        uvs.push(column / columns, depth);
      }
    }

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const a = offset + row * (columns + 1) + column;
        const b = a + 1;
        const c = a + columns + 1;
        const d = c + 1;
        indices.push(...(side ? [a, b, c, b, d, c] : [a, c, b, b, c, d]));
      }
    }
  }

  const frontCount = (rows + 1) * (columns + 1);
  const backOffset = frontCount;
  const addQuad = (a, b, c, d) => indices.push(a, b, c, b, d, c);
  for (let row = 0; row < rows; row += 1) {
    const leftFront = row * (columns + 1);
    const leftBack = backOffset + leftFront;
    addQuad(leftFront, leftBack, leftFront + columns + 1, leftBack + columns + 1);

    const rightFront = leftFront + columns;
    const rightBack = leftBack + columns;
    addQuad(rightFront, rightFront + columns + 1, rightBack, rightBack + columns + 1);
  }
  for (let column = 0; column < columns; column += 1) {
    addQuad(column, column + 1, backOffset + column, backOffset + column + 1);
    const bottomFront = rows * (columns + 1) + column;
    const bottomBack = backOffset + bottomFront;
    addQuad(bottomFront, bottomBack, bottomFront + 1, bottomBack + 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function createScene() {
  const host = $("#three-canvas");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("webgl2", {
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  if (!context) {
    $("#webgl-warning").classList.remove("hidden");
    $("#render-mode").textContent = "UNAVAILABLE";
    return null;
  }

  const renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.8));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#09202b");
  scene.fog = new THREE.FogExp2("#0a202b", 0.006);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 180);
  camera.up.set(0, 1, 0);
  camera.position.set(26, -3, 27);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, -11.5, 6);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.minDistance = 11;
  controls.maxDistance = 75;
  controls.maxPolarAngle = Math.PI * 0.88;

  scene.add(new THREE.HemisphereLight("#b5e7ee", "#283a3c", 2.0));
  const keyLight = new THREE.DirectionalLight("#fff5db", 2.5);
  keyLight.position.set(-14, 14, 21);
  scene.add(keyLight);
  const blueFill = new THREE.PointLight("#37bdbb", 42, 55, 2);
  blueFill.position.set(10, -8, 15);
  scene.add(blueFill);

  const groundMaterial = new THREE.MeshStandardMaterial({ color: "#354949", roughness: 0.92, metalness: 0.02 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(46, 34), groundMaterial);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -24.1, 12);
  scene.add(ground);

  const wallTexture = makeConcreteTexture();
  const wallMaterial = new THREE.MeshStandardMaterial({
    color: "#d1d1c4", map: wallTexture, roughness: 0.98, metalness: 0, side: THREE.DoubleSide,
  });
  const wall = new THREE.Mesh(createDamGeometry(), wallMaterial);
  wall.castShadow = true;
  wall.receiveShadow = true;
  scene.add(wall);

  const structuralMaterial = new THREE.MeshStandardMaterial({ color: "#a7aaa0", map: wallTexture, roughness: 0.94 });
  const pierMaterial = new THREE.MeshStandardMaterial({ color: "#707c7c", map: wallTexture, roughness: 0.97 });
  for (const x of [-16, -11, -6, -1, 4, 9, 14, 18]) {
    const pier = new THREE.Mesh(new THREE.BoxGeometry(0.78, 24.35, 1.08), pierMaterial);
    pier.position.set(x, -12.05, damFaceZ(x) + 0.43);
    pier.castShadow = true;
    pier.receiveShadow = true;
    scene.add(pier);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.58, 1.55), structuralMaterial);
    cap.position.set(x, -0.05, damFaceZ(x) + 0.36);
    cap.castShadow = true;
    scene.add(cap);
  }
  const crest = new THREE.Mesh(new THREE.BoxGeometry(39.2, 0.62, 1.65), structuralMaterial);
  crest.position.set(0, 0.27, 0.15);
  crest.castShadow = true;
  scene.add(crest);

  const intakeGroup = new THREE.Group();
  const intakeDark = new THREE.MeshStandardMaterial({ color: "#102127", roughness: 0.72, metalness: 0.12 });
  const intakeFrame = new THREE.MeshStandardMaterial({ color: "#53686a", metalness: 0.55, roughness: 0.38 });
  for (const x of [-8, 0, 8]) {
    const face = damFaceZ(x) + 0.035;
    const inset = new THREE.Mesh(new THREE.BoxGeometry(1.95, 1.48, 0.08), intakeDark);
    inset.position.set(x, -8.2, face);
    intakeGroup.add(inset);
    for (const [barX, barY, barW, barH] of [
      [x - 1.02, -8.2, 0.14, 1.7], [x + 1.02, -8.2, 0.14, 1.7],
      [x, -7.38, 2.16, 0.14], [x, -9.02, 2.16, 0.14],
    ]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(barW, barH, 0.16), intakeFrame);
      bar.position.set(barX, barY, face + 0.1);
      intakeGroup.add(bar);
    }
    for (let barX = x - 0.58; barX <= x + 0.6; barX += 0.39) {
      const grille = new THREE.Mesh(new THREE.BoxGeometry(0.055, 1.38, 0.12), intakeFrame);
      grille.position.set(barX, -8.2, face + 0.09);
      intakeGroup.add(grille);
    }
  }
  scene.add(intakeGroup);

  const grid = new THREE.GridHelper(40, 20, "#41616b", "#29434d");
  grid.rotation.x = Math.PI / 2;
  grid.position.set(0, -24, 12);
  grid.material.transparent = true;
  grid.material.opacity = 0.27;
  scene.add(grid);

  const wallGridVertices = [];
  for (let x = -18; x <= 18; x += 3) {
    wallGridVertices.push(new THREE.Vector3(x, 0.11, damFaceZ(x) + 0.02), new THREE.Vector3(x, -24.1, damFaceZ(x) + 0.02));
  }
  for (let depth = 0; depth <= 24; depth += 3) {
    for (let x = -18; x < 18; x += 0.5) {
      wallGridVertices.push(
        new THREE.Vector3(x, -depth, damFaceZ(x) + 0.025),
        new THREE.Vector3(x + 0.5, -depth, damFaceZ(x + 0.5) + 0.025),
      );
    }
  }
  const wallGridGeometry = new THREE.BufferGeometry().setFromPoints(wallGridVertices);
  const wallGrid = new THREE.LineSegments(wallGridGeometry, new THREE.LineBasicMaterial({
    color: "#d7e8d5", transparent: true, opacity: 0.14,
  }));
  scene.add(wallGrid);

  const zoneGroup = new THREE.Group();
  const zoneColors = ["#4ed5ba", "#67b6e0", "#78d39a"];
  const zones = [[-16, -6], [-6, 6], [6, 16]];
  zones.forEach(([left, right], index) => {
    const points = [
      [left, -1, damFaceZ(left) + 0.08], [right, -1, damFaceZ(right) + 0.08], [right, -23, damFaceZ(right) + 0.08],
      [left, -23, damFaceZ(left) + 0.08], [left, -1, damFaceZ(left) + 0.08],
    ].map(([x, y]) => new THREE.Vector3(x, y, damFaceZ(x) + 0.1));
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineDashedMaterial({ color: zoneColors[index], dashSize: 0.6, gapSize: 0.33, transparent: true, opacity: 0.63 }),
    );
    line.computeLineDistances();
    zoneGroup.add(line);
  });
  scene.add(zoneGroup);

  const crackMaterial = new THREE.LineBasicMaterial({ color: "#29251e", transparent: true, opacity: 0.92 });
  const crackPoints = [
    [-10.2, -10.8], [-9.7, -11.2], [-9.9, -11.5],
    [-9.3, -11.9], [-9.5, -12.2], [-8.9, -12.7], [-8.5, -13.1],
  ].map(([x, y]) => new THREE.Vector3(x, y, damFaceZ(x) + 0.11));
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(crackPoints), crackMaterial));

  const erosionGroup = new THREE.Group();
  [[-1, -12], [11, -12]].forEach(([x, y], index) => {
    const patch = new THREE.Mesh(
      new THREE.CircleGeometry(index ? 0.82 : 0.72, 32),
      new THREE.MeshStandardMaterial({ color: "#846650", roughness: 1, transparent: true, opacity: 0.86 }),
    );
    patch.position.set(x, y, damFaceZ(x) + 0.08);
    erosionGroup.add(patch);
    for (let dot = 0; dot < 20; dot += 1) {
      const angle = dot * 2.399;
      const radius = 0.15 + (dot % 5) * 0.11;
      const pebble = new THREE.Mesh(
        new THREE.SphereGeometry(0.035 + (dot % 3) * 0.012, 7, 5),
        new THREE.MeshStandardMaterial({ color: "#4b4d43", roughness: 1 }),
      );
      const pebbleX = x + Math.cos(angle) * radius;
      pebble.position.set(pebbleX, y + Math.sin(angle) * radius, damFaceZ(pebbleX) + 0.12);
      erosionGroup.add(pebble);
    }
  });
  scene.add(erosionGroup);

  const plumeGroup = new THREE.Group();
  const leakSeed = 14;
  let leakRandomSeed = leakSeed;
  const leakRandom = () => {
    leakRandomSeed = (leakRandomSeed * 1664525 + 1013904223) >>> 0;
    return leakRandomSeed / 4294967296;
  };
  for (let index = 0; index < 56; index += 1) {
    const y = -13.0 - leakRandom() * 3.2;
    const droplet = new THREE.Mesh(
      new THREE.SphereGeometry(0.035 + leakRandom() * 0.045, 7, 6),
      new THREE.MeshBasicMaterial({ color: "#77eaff", transparent: true, opacity: 0.3 + leakRandom() * 0.55 }),
    );
    const x = 6 + (leakRandom() - 0.5) * 0.8;
    droplet.position.set(x, y, damFaceZ(x) + 0.22 + leakRandom() * 0.85);
    plumeGroup.add(droplet);
  }
  scene.add(plumeGroup);

  const rockGroup = new THREE.Group();
  const rockData = [
    [-3, 2, 12, 1.2], [4, 3, 11, 1.2], [10, 2, 19, 1.3], [-13, 5, 17, 1.0],
    [-9, 9, 22, 1.35], [3, 13, 24, 1.45], [13, 11, 23, 1.15], [-16, 15, 23, 1.2],
  ];
  rockData.forEach(([x, y, z, radius], index) => {
    const rock = new THREE.Mesh(
      new THREE.IcosahedronGeometry(radius, 1),
      new THREE.MeshStandardMaterial({ color: index < 4 ? "#746a58" : "#4d5e59", roughness: 1, flatShading: true }),
    );
    rock.scale.set(1.05, 0.72, 0.84);
    rock.position.set(x, -z + radius * 0.38, y);
    rock.rotation.set(index * 0.29, index * 0.52, index * 0.18);
    rock.castShadow = true;
    rockGroup.add(rock);
  });
  scene.add(rockGroup);

  const particleCount = 1300;
  const particlePositions = new Float32Array(particleCount * 3);
  let particleSeed = 82;
  const particleRandom = () => {
    particleSeed = (particleSeed * 1664525 + 1013904223) >>> 0;
    return particleSeed / 4294967296;
  };
  for (let index = 0; index < particleCount; index += 1) {
    particlePositions[index * 3] = -21 + particleRandom() * 42;
    particlePositions[index * 3 + 1] = -particleRandom() * 25;
    particlePositions[index * 3 + 2] = 0.7 + particleRandom() * 25;
  }
  const particleGeometry = new THREE.BufferGeometry();
  particleGeometry.setAttribute("position", new THREE.BufferAttribute(particlePositions, 3));
  const particleMaterial = new THREE.PointsMaterial({
    color: "#9bd8df", size: 0.085, transparent: true, opacity: 0.38,
    sizeAttenuation: true, depthWrite: false,
  });
  const particles = new THREE.Points(particleGeometry, particleMaterial);
  scene.add(particles);

  const defectsGroup = new THREE.Group();
  const riskMapGroup = new THREE.Group();
  scene.add(defectsGroup, riskMapGroup);

  const plannedRouteGroup = new THREE.Group();
  const traveledPathGroup = new THREE.Group();
  scene.add(plannedRouteGroup, traveledPathGroup);
  const robot = createRobot();
  scene.add(robot);

  const sonarGroup = new THREE.Group();
  const rangeRings = [];
  for (const radius of [3, 6, 9]) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius - 0.018, radius + 0.018, 100),
      new THREE.MeshBasicMaterial({ color: "#4fdaca", transparent: true, opacity: radius === 9 ? 0.2 : 0.31, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    sonarGroup.add(ring);
    rangeRings.push(ring);
  }
  const beamGeometry = new THREE.BufferGeometry();
  const beamMaterial = new THREE.MeshBasicMaterial({
    color: "#57edda", side: THREE.DoubleSide, transparent: true, opacity: 0.18,
    depthWrite: false,
  });
  const beamMesh = new THREE.Mesh(beamGeometry, beamMaterial);
  sonarGroup.add(beamMesh);
  const sonarLine = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: "#7ffff0", transparent: true, opacity: 0.8 }),
  );
  sonarGroup.add(sonarLine);
  scene.add(sonarGroup);

  const axesGroup = makeAxes();
  scene.add(axesGroup);
  const model = {
    renderer, scene, camera, controls, host, robot, plannedRouteGroup, traveledPathGroup, sonarGroup,
    rangeRings, beamGeometry, beamMaterial, sonarLine, particles, particleMaterial,
    plumeGroup, defectsGroup, riskMapGroup, riskNodes: [], riskSignature: "", detectedSignature: "", zoneGroup, axesGroup, wallGrid, resize,
  };
  renderer.domElement.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    showToast("WebGL2 context lost. Try reloading the page.");
  });
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  renderer.domElement.addEventListener("click", (event) => {
    if (!state.layerVisibility.riskMap || !sceneModel.riskNodes.length) return;
    const bounds = renderer.domElement.getBoundingClientRect();
    pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(riskMapGroup, true)
      .find((item) => item.object.userData.riskRecord);
    if (hit) showRiskMapCallout(hit.object.userData.riskRecord);
  });

  function resize() {
    const { clientWidth, clientHeight } = host;
    if (!clientWidth || !clientHeight) return;
    renderer.setSize(clientWidth, clientHeight, false);
    camera.aspect = clientWidth / clientHeight;
    camera.updateProjectionMatrix();
  }

  resize();
  new ResizeObserver(resize).observe(host);
  return model;
}

function createRobot() {
  const robot = new THREE.Group();
  const chassisMaterial = new THREE.MeshStandardMaterial({ color: "#48677a", metalness: 0.6, roughness: 0.35 });
  const frameMaterial = new THREE.MeshStandardMaterial({ color: "#36d9d2", metalness: 0.72, roughness: 0.29 });
  const darkMetal = new THREE.MeshStandardMaterial({ color: "#182b35", metalness: 0.55, roughness: 0.4 });
  const black = new THREE.MeshStandardMaterial({ color: "#101821", metalness: 0.24, roughness: 0.25 });
  const battery = new THREE.MeshStandardMaterial({ color: "#d39c48", metalness: 0.35, roughness: 0.4 });

  const addBox = (parent, name, size, position, material, rotation = [0, 0, 0]) => {
    const object = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    object.name = name;
    object.position.set(...position);
    object.rotation.set(...rotation);
    object.castShadow = true;
    object.receiveShadow = true;
    parent.add(object);
    return object;
  };
  const addCylinder = (parent, name, radius, length, position, material, rotation = [0, 0, Math.PI / 2]) => {
    const object = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 18), material);
    object.name = name;
    object.position.set(...position);
    object.rotation.set(...rotation);
    object.castShadow = true;
    parent.add(object);
    return object;
  };
  const addSphere = (parent, name, radius, position, material, scale = [1, 1, 1]) => {
    const object = new THREE.Mesh(new THREE.SphereGeometry(radius, 18, 12), material);
    object.name = name;
    object.position.set(...position);
    object.scale.set(...scale);
    object.castShadow = true;
    parent.add(object);
    return object;
  };

  addBox(robot, "Pressure-rated aluminum chassis", [2.05, 0.58, 1.02], [0, 0, 0], chassisMaterial);
  addBox(robot, "Armored center housing", [1.4, 0.62, 0.8], [-0.06, 0.04, 0], new THREE.MeshStandardMaterial({ color: "#607f8e", metalness: 0.52, roughness: 0.36 }));
  for (const side of [-1, 1]) {
    addBox(robot, "Cyan protective frame rail", [2.52, 0.105, 0.105], [0, 0.16, side * 0.68], frameMaterial);
    addBox(robot, "Protective frame crossbar", [0.105, 0.105, 1.37], [side * 0.91, 0.16, 0], frameMaterial);
    addCylinder(robot, "Horizontal vectored thruster", 0.23, 0.4, [0.76, 0, side * 0.47], darkMetal);
    addCylinder(robot, "Horizontal vectored thruster", 0.23, 0.4, [-0.77, 0, side * 0.47], darkMetal);
    addCylinder(robot, "Vertical depth thruster", 0.2, 0.43, [side * 0.78, -0.01, 0], darkMetal, [0, 0, 0]);
    addCylinder(robot, "Forward vectored thruster", 0.17, 0.32, [1.14, 0.01, side * 0.38], darkMetal);
    const propeller = addBox(robot, "Thruster propeller", [0.06, 0.31, 0.055], [0.99, 0, side * 0.47], frameMaterial);
    propeller.rotation.y = Math.PI / 3;
  }

  const cameraHousing = addSphere(robot, "Front inspection camera housing", 0.3, [1.05, -0.04, 0], black, [0.95, 0.94, 1.1]);
  const cameraLens = addSphere(
    robot, "Camera optical lens", 0.13, [1.31, -0.04, 0],
    new THREE.MeshPhysicalMaterial({ color: "#53caff", emissive: "#1687b1", emissiveIntensity: 0.55, metalness: 0.64, roughness: 0.13, clearcoat: 1 }),
    [0.6, 1, 1],
  );
  cameraHousing.castShadow = cameraLens.castShadow = false;

  const ledMaterial = new THREE.MeshStandardMaterial({ color: "#fff2ce", emissive: "#b8ebee", emissiveIntensity: 2.5 });
  for (const side of [-1, 1]) {
    const lamp = addSphere(robot, "LED inspection light", 0.13, [1.06, -0.18, side * 0.42], ledMaterial, [0.7, 1, 1]);
    lamp.castShadow = false;
    const beam = new THREE.SpotLight("#c9fff4", 12, 10, 0.37, 0.62, 1.4);
    beam.position.set(1.18, -0.13, side * 0.42);
    beam.target.position.set(5, -0.4, side * 0.42);
    robot.add(beam, beam.target);
  }

  addCylinder(robot, "Forward sonar transducer", 0.25, 0.25, [0.55, -0.43, 0], frameMaterial, [0, 0, 0]);
  addBox(robot, "Sealed battery module", [0.64, 0.37, 0.75], [-0.63, -0.04, 0], battery);
  addBox(robot, "Battery indicator", [0.24, 0.035, 0.06], [-0.64, 0.16, 0.38], new THREE.MeshBasicMaterial({ color: "#91e2aa" }));
  addBox(robot, "Acoustic communications module", [0.43, 0.31, 0.42], [-0.74, 0.44, 0.34], new THREE.MeshStandardMaterial({ color: "#7193aa", metalness: 0.44, roughness: 0.41 }));
  addCylinder(robot, "Acoustic antenna", 0.035, 0.36, [-0.78, 0.74, 0.34], frameMaterial, [0, 0, 0]);
  addSphere(robot, "Depth pressure sensor", 0.15, [-0.2, -0.43, -0.43], new THREE.MeshStandardMaterial({ color: "#90d8f6", metalness: 0.4, roughness: 0.24 }));
  addBox(robot, "Auxiliary sensor module", [0.42, 0.18, 0.41], [0.1, 0.41, 0], chassisMaterial);
  addBox(robot, "Identification plate", [0.46, 0.035, 0.49], [-0.03, 0.36, 0], new THREE.MeshStandardMaterial({ color: "#15323c", metalness: 0.25, roughness: 0.6 }));

  const labelCanvas = document.createElement("canvas");
  labelCanvas.width = 512;
  labelCanvas.height = 96;
  const context = labelCanvas.getContext("2d");
  context.fillStyle = "#8ff9e7";
  context.font = "700 39px 'DM Sans', sans-serif";
  context.textAlign = "center";
  context.fillText("AQUAINSPECT", 256, 57);
  const label = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(labelCanvas), transparent: true, depthTest: false,
  }));
  label.name = "Visible AQUAINSPECT vehicle identification";
  label.scale.set(2.5, 0.48, 1);
  label.position.set(-0.02, 0.91, 0);
  robot.add(label);

  const alertMaterial = new THREE.MeshStandardMaterial({
    color: "#4b1718", emissive: "#ff2424", emissiveIntensity: 0.04, roughness: 0.3,
  });
  addSphere(robot, "Blinking sonar obstacle alert", 0.15, [0, 0.7, 0], alertMaterial);
  const alertLight = new THREE.PointLight("#ff241f", 0, 5, 2);
  alertLight.position.set(0, 0.72, 0);
  robot.add(alertLight);
  robot.traverse((object) => {
    if (object.isMesh) object.userData.component = object.name;
  });
  robot.userData.label = label;
  robot.userData.alertBeacon = { material: alertMaterial, light: alertLight };
  return robot;
}

function makeAxes() {
  const group = new THREE.Group();
  const origin = new THREE.Vector3(-17.5, -22.6, 20);
  const axes = [
    { direction: new THREE.Vector3(1, 0, 0), color: "#ec8c7c", label: "X" },
    { direction: new THREE.Vector3(0, -1, 0), color: "#eabe76", label: "Z" },
    { direction: new THREE.Vector3(0, 0, -1), color: "#75c4df", label: "Y" },
  ];
  axes.forEach(({ direction, color, label }) => {
    const arrow = new THREE.ArrowHelper(direction, origin, 2.2, color, 0.33, 0.2);
    group.add(arrow);
    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    context.fillStyle = color;
    context.font = "700 42px 'DM Sans', sans-serif";
    context.textAlign = "center";
    context.fillText(label, 48, 47);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false,
    }));
    sprite.scale.set(0.7, 0.48, 1);
    sprite.position.copy(origin).addScaledVector(direction, 2.55);
    group.add(sprite);
  });
  return group;
}

const sceneModel = createScene();
if (sceneModel) requestAnimationFrame(renderScene);

function setLine(group, points, color, materialOptions = {}) {
  for (const child of [...group.children]) {
    if (child.geometry) child.geometry.dispose();
    group.remove(child);
  }
  if (!points || points.length < 2) return;
  const geometry = new THREE.BufferGeometry().setFromPoints(points.map(toScene));
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.93, ...materialOptions });
  group.add(new THREE.Line(geometry, material));
}

function updateScene(snapshot) {
  if (!sceneModel || !snapshot) return;
  const { position, orientation } = snapshot;
  sceneModel.robot.position.copy(toScene(position));
  const direction = new THREE.Vector3(orientation[0], -orientation[2], orientation[1]);
  if (direction.lengthSq() > 0.01) {
    sceneModel.robot.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), direction.normalize());
  }

  const targetY = -position[2];
  sceneModel.sonarGroup.position.set(position[0], targetY + 0.04, position[1]);
  const phase = snapshot.sonar_phase || 0;
  const radius = snapshot.sonar_radius || 9;
  const beamAngle = phase;
  const pointVertices = [new THREE.Vector3(0, 0, 0)];
  const segments = 20;
  for (let index = 0; index <= segments; index += 1) {
    const angle = beamAngle + (index / segments - 0.5) * 0.5;
    pointVertices.push(new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius));
  }
  const positions = new Float32Array(pointVertices.flatMap((point) => [point.x, point.y, point.z]));
  const indices = [];
  for (let index = 1; index <= segments; index += 1) indices.push(0, index, index + 1);
  sceneModel.beamGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  sceneModel.beamGeometry.setIndex(indices);
  sceneModel.beamGeometry.computeVertexNormals();
  const beamEnd = new THREE.Vector3(Math.cos(beamAngle) * radius, 0.015, Math.sin(beamAngle) * radius);
  sceneModel.sonarLine.geometry.dispose();
  sceneModel.sonarLine.geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.02, 0), beamEnd]);

  const planned = snapshot.planned_route || [];
  const path = snapshot.traveled_path || [];
  setLine(sceneModel.plannedRouteGroup, planned.length > 1 ? planned : [], "#eabb73");
  setLine(sceneModel.traveledPathGroup, path.length > 1 ? path : [], "#50e4c4");
  sceneModel.plannedRouteGroup.visible = state.layerVisibility.route;
  sceneModel.traveledPathGroup.visible = state.layerVisibility.route;
  sceneModel.sonarGroup.visible = state.layerVisibility.sonar;
  sceneModel.defectsGroup.visible = state.layerVisibility.defects;
  updateRiskMap(snapshot);
  sceneModel.riskMapGroup.visible = state.layerVisibility.riskMap;
  $("#risk-map-callout").classList.toggle("hidden", !state.layerVisibility.riskMap || !state.selectedRiskId);
  updateDetectedMarkers(snapshot.defects || []);
  const obscuration = snapshot.telemetry.visibility_obscuration ?? (snapshot.low_visibility ? 0.6 : 0.08);
  sceneModel.particleMaterial.opacity = 0.2 + obscuration * 0.58;
  sceneModel.particleMaterial.size = 0.07 + obscuration * 0.12;
  sceneModel.scene.fog.density = 0.003 + obscuration * 0.025;
  sceneModel.plumeGroup.visible = state.layerVisibility.defects;
  sceneModel.zoneGroup.visible = state.layerVisibility.route;
  sceneModel.robot.userData.alertBeacon.material.emissiveIntensity = snapshot.obstacles?.length ? 1.6 : 0.04;

  const sonarObstacles = snapshot.obstacles || [];
  renderSonarReturns(sonarObstacles, position);
}

function riskMarkerColor(score, detected) {
  if (detected || score >= 80) return COLORS.coral;
  if (score >= 55) return COLORS.amber;
  return COLORS.green;
}

function updateRiskMap(snapshot) {
  const scenarios = snapshot.defect_scenarios || DEFAULT_SCENARIOS;
  const signature = scenarios.map((item) => `${item.id}:${item.risk_score ?? 0}`).join("|");
  if (signature !== sceneModel.riskSignature) {
    sceneModel.riskMapGroup.clear();
    sceneModel.riskNodes = scenarios.map((scenario) => {
      const [x, , depth] = scenario.location;
      const group = new THREE.Group();
      group.position.set(x, -depth, damFaceZ(x) + 0.38);
      const hotspot = new THREE.Mesh(
        new THREE.CircleGeometry(0.46 + (scenario.risk_score || 0) / 260, 32),
        new THREE.MeshBasicMaterial({ color: COLORS.coral, transparent: true, opacity: 0.2, depthWrite: false }),
      );
      group.add(hotspot);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.26 + (scenario.risk_score || 0) / 450, 0.045, 8, 28),
        new THREE.MeshBasicMaterial({ color: COLORS.coral, transparent: true, opacity: 0.88 }),
      );
      group.add(ring);
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.17, 16, 12),
        new THREE.MeshBasicMaterial({ color: COLORS.coral }),
      );
      marker.userData.riskRecord = scenario;
      group.add(marker);
      sceneModel.riskMapGroup.add(group);
      return { scenario, hotspot, ring, marker };
    });
    sceneModel.riskSignature = signature;
  }

  const detectedIds = new Set((snapshot.defects || []).map((item) => item.id));
  for (const node of sceneModel.riskNodes) {
    const detected = detectedIds.has(node.scenario.id);
    const color = riskMarkerColor(node.scenario.risk_score || 0, detected);
    node.marker.material.color.set(color);
    node.ring.material.color.set(color);
    node.hotspot.material.color.set(color);
    node.hotspot.material.opacity = detected ? 0.34 : 0.15;
    node.marker.scale.setScalar(detected ? 1.28 : 1);
    node.scenario.detected = detected;
  }
}

function updateDetectedMarkers(findings) {
  const signature = findings.map((item) => item.id).join("|");
  if (signature === sceneModel.detectedSignature) return;
  for (const child of [...sceneModel.defectsGroup.children]) {
    child.geometry?.dispose();
    child.material?.dispose();
    sceneModel.defectsGroup.remove(child);
  }
  findings.forEach((finding) => {
    const [x, , depth] = finding.location;
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 16, 12),
      new THREE.MeshStandardMaterial({ color: COLORS.coral, emissive: COLORS.coral, emissiveIntensity: 0.8, roughness: 0.4 }),
    );
    marker.position.set(x, -depth, damFaceZ(x) + 0.55);
    marker.userData.findingId = finding.id;
    sceneModel.defectsGroup.add(marker);
  });
  sceneModel.detectedSignature = signature;
}

function showRiskMapCallout(record) {
  state.selectedRiskId = record.id;
  const callout = $("#risk-map-callout");
  const detected = Boolean(record.detected);
  callout.innerHTML = `<button type="button" class="risk-callout-close" aria-label="Close risk details">×</button><span class="risk-callout-kicker">${detected ? "SIMULATED FINDING" : "UNSCANNED SCENARIO"}</span><b>${escapeHTML(record.type)}</b><span>${escapeHTML(record.severity)} severity · risk index ${Number(record.risk_score)}/100</span><small>${escapeHTML(record.id)} · X ${Number(record.location[0]).toFixed(1)} m · depth ${Number(record.location[2]).toFixed(1)} m</small>`;
  callout.classList.remove("hidden");
}

function renderScene() {
  if (!sceneModel) return;
  const alert = Boolean(state.latest?.obstacles?.length);
  const flash = alert ? (Math.sin(performance.now() * 0.009) > 0 ? 2.5 : 0.12) : 0;
  sceneModel.robot.userData.alertBeacon.light.intensity = flash;
  sceneModel.robot.userData.alertBeacon.material.emissiveIntensity = alert ? Math.max(0.08, flash * 0.65) : 0.04;
  sceneModel.controls.update();
  sceneModel.renderer.render(sceneModel.scene, sceneModel.camera);
  requestAnimationFrame(renderScene);
}

function drawLiveVideo(timestamp) {
  const canvas = $("#live-video-canvas");
  if (!canvas) return;
  const telemetry = state.latest?.telemetry;
  const fps = telemetry?.video_fps || 24;
  if (timestamp - state.videoLastDraw >= 1000 / fps && telemetry?.communication !== "Interrupted") {
    state.videoLastDraw = timestamp;
    state.videoFrame += 1;
    const context = canvas.getContext("2d");
    const { width, height } = canvas;
    const obscuration = telemetry?.visibility_obscuration ?? 0.08;
    const condition = telemetry?.water_condition || "Clear";
    const camera = telemetry?.camera || "Clear";
    const frameRate = telemetry?.video_stream || "Live simulation · 24 FPS";
    const acoustic = telemetry?.communication_mode === "Acoustic";

    const water = context.createLinearGradient(0, 0, width, height);
    water.addColorStop(0, "#0b3140");
    water.addColorStop(0.52, "#10313a");
    water.addColorStop(1, "#071a25");
    context.fillStyle = water;
    context.fillRect(0, 0, width, height);

    const drift = (state.videoFrame * (acoustic ? 0.025 : 0.08)) % 24;
    context.save();
    context.translate(-drift, 0);
    for (let x = -24; x < width + 24; x += 80) {
      const shade = ((x / 80) % 2 + 2) % 2 ? "#526566" : "#64716a";
      context.fillStyle = shade;
      context.fillRect(x, 15, 78, height - 31);
      context.fillStyle = "rgba(197, 194, 169, .15)";
      context.fillRect(x + 4, 17, 3, height - 35);
      context.fillStyle = "rgba(12, 26, 30, .38)";
      context.fillRect(x + 76, 15, 4, height - 31);
    }
    context.restore();

    context.strokeStyle = "rgba(210, 230, 215, .28)";
    context.lineWidth = 1;
    for (let y = 55; y < height - 20; y += 50) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }

    const crackX = 105 + Math.sin(state.videoFrame * 0.008) * 5;
    context.strokeStyle = "rgba(22, 23, 22, .75)";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(crackX, 70);
    context.lineTo(crackX - 7, 92);
    context.lineTo(crackX + 4, 108);
    context.lineTo(crackX - 5, 132);
    context.stroke();

    const sonarTarget = state.latest?.obstacles?.[0];
    if (sonarTarget) {
      const markerX = 300 + Math.sin(state.videoFrame * 0.015) * 14;
      const markerY = 171;
      context.strokeStyle = "#ff735f";
      context.lineWidth = 2;
      context.beginPath();
      context.arc(markerX, markerY, 11 + Math.sin(timestamp * 0.006) * 2, 0, Math.PI * 2);
      context.stroke();
      context.fillStyle = "#ffb292";
      context.font = "10px monospace";
      context.fillText(sonarTarget.id, markerX + 16, markerY + 4);
    }

    const light = context.createRadialGradient(width * 0.57, height * 0.52, 4, width * 0.57, height * 0.52, 180);
    light.addColorStop(0, "rgba(183, 251, 239, .2)");
    light.addColorStop(1, "rgba(92, 207, 215, 0)");
    context.fillStyle = light;
    context.fillRect(0, 0, width, height);

    if (obscuration > 0) {
      context.fillStyle = `rgba(130, 153, 145, ${Math.min(0.72, obscuration * 0.7)})`;
      context.fillRect(0, 0, width, height);
      let seed = state.videoFrame * 197 + 31;
      const random = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      context.fillStyle = `rgba(205, 215, 198, ${0.08 + obscuration * 0.14})`;
      const particles = Math.round(18 + obscuration * 190);
      for (let index = 0; index < particles; index += 1) {
        const x = (random() * width + state.videoFrame * (random() - 0.5) * 0.35) % width;
        const y = random() * height;
        const radius = 0.4 + random() * (0.7 + obscuration * 2.4);
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
      }
    }

    if (acoustic) {
      context.fillStyle = "rgba(11, 20, 25, .6)";
      context.fillRect(0, 0, width, 16);
      context.fillStyle = "#f0bf79";
      context.font = "9px monospace";
      context.fillText("ACOUSTIC LOW-RATE VIDEO PREVIEW", 9, 12);
    }
    context.fillStyle = "rgba(3, 10, 14, .7)";
    context.fillRect(0, height - 19, width, 19);
    context.fillStyle = "#b1d0ca";
    context.font = "9px monospace";
    context.fillText(`XYZ ${telemetry ? `${telemetry.x.toFixed(1)} / ${telemetry.y.toFixed(1)} / ${telemetry.z.toFixed(1)} m` : "SIMULATION"}`, 8, height - 7);

    $("#video-camera-mode").textContent = telemetry?.imaging_mode === "Sonar-primary"
      ? `SONAR PRIMARY · CAM ${camera.toUpperCase()}`
      : telemetry?.imaging_mode === "Camera + sonar fusion" ? "CAMERA + SONAR FUSION" : `CAM · ${camera.toUpperCase()}`;
    $("#video-frame-clock").textContent = `FRAME · ${String(state.videoFrame).padStart(4, "0")}`;
    $("#camera-feed-indicator").classList.toggle("offline", telemetry?.communication === "Interrupted");
    $("#camera-feed-indicator b").textContent = telemetry?.communication === "Interrupted" ? "BUFFERING" : "SIM FEED";
    $("#video-stream-status").textContent = telemetry?.communication === "Interrupted"
      ? "Link interrupted · preview buffering"
      : telemetry ? `${frameRate} · ${telemetry.imaging_mode} scan logic` : "Awaiting simulated video feed";
  }
  requestAnimationFrame(drawLiveVideo);
}

requestAnimationFrame(drawLiveVideo);

function renderSonarReturns(obstacles, position) {
  const returnLayer = $("#sonar-obstacles");
  returnLayer.replaceChildren();
  const svgns = "http://www.w3.org/2000/svg";
  for (const obstacle of obstacles) {
    const x = 120 + (obstacle.x - position[0]) * 6.7;
    const y = 80 + (obstacle.y - position[1]) * 6.7;
    const distance = Math.hypot(x - 120, y - 80);
    if (distance > 66) continue;
    const marker = document.createElementNS(svgns, "circle");
    marker.setAttribute("cx", x.toFixed(1));
    marker.setAttribute("cy", y.toFixed(1));
    marker.setAttribute("r", "3.4");
    marker.setAttribute("fill", "#ff6559");
    marker.setAttribute("stroke", "#ffedc5");
    marker.setAttribute("stroke-width", "1.1");
    marker.setAttribute("data-label", obstacle.id);
    returnLayer.appendChild(marker);
  }
  const targets = obstacles.length;
  $("#sonar-detections").textContent = `${targets} target${targets === 1 ? "" : "s"} in range`;
  $("#obstacle-count").textContent = String(targets);
  $("#obstacle-count").classList.toggle("obstacle-warning", targets > 0);
}

function updateObstacleAlert(obstacles) {
  const currentIds = new Set(obstacles.map((obstacle) => obstacle.id));
  const newlyDetected = [...currentIds].some((id) => !state.obstacleIds.has(id));
  state.obstacleIds = currentIds;
  const indicator = $("#obstacle-alert");
  indicator.classList.toggle("active", currentIds.size > 0);
  $("#obstacle-alert-label").textContent = currentIds.size ? `ALERT ${currentIds.size}` : "CLEAR";
  if (newlyDetected) playObstacleAlert();
}

function playObstacleAlert() {
  if (!state.soundEnabled || !state.audioContext || state.audioContext.state !== "running") return;
  const context = state.audioContext;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const now = context.currentTime;
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(760, now);
  oscillator.frequency.exponentialRampToValueAtTime(470, now + 0.18);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.16, now + 0.025);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.23);
}

function unlockObstacleAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || state.audioContext) return;
  try {
    state.audioContext = new AudioContextClass();
    state.audioContext.resume().then(() => {
      if (state.obstacleIds.size) playObstacleAlert();
    }).catch(() => {
      state.audioContext = null;
      showToast("Audio is unavailable. Check your browser sound settings.");
    });
  } catch (error) {
    showToast("Audio alerts are unavailable in this browser.");
  }
}

function formatClock(seconds) {
  const mins = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

function updateState(snapshot) {
  if (!snapshot) return;
  const priorStatus = state.latest?.telemetry?.status;
  const telemetry = snapshot.telemetry;
  state.latest = snapshot;
  $("#communication-mode").value = telemetry.communication_mode;
  $("#water-condition").value = telemetry.water_condition;
  $("#low-visibility").checked = snapshot.low_visibility;
  updateObstacleAlert(snapshot.obstacles || []);
  if (priorStatus === "Running" && telemetry.status === "Completed") {
    showToast("Inspection complete. Final report and analytics are ready.");
  }
  if (telemetry.status === "Running" || telemetry.status === "Returning to surface" || telemetry.manual_move_active) {
    const now = performance.now();
    state.missionSeconds += Math.min(1.3, Math.max(0, (now - state.lastTick) / 1000));
    state.lastTick = now;
  } else {
    state.lastTick = performance.now();
  }
  $("#mission-state").textContent = telemetry.status.toUpperCase();
  $("#mission-clock").textContent = formatClock(state.missionSeconds);
  $("#thruster-status").classList.toggle("running", telemetry.thrusters === "Active");
  $("#thruster-status").innerHTML = `<i></i> ${telemetry.thrusters.toUpperCase()}`;
  $("#metric-progress").textContent = `${Math.round(telemetry.progress)}%`;
  $("#metric-progress-note").textContent = snapshot.mission_sections.length
    ? `${telemetry.status} · ${snapshot.mission_sections.join(", ")}`
    : telemetry.status === "Idle" ? "Awaiting launch" : "Manual movement · not survey coverage";
  $("#metric-defects").textContent = String(snapshot.defects.length);
  $("#metric-battery").textContent = `${telemetry.battery.toFixed(1)}%`;
  $("#metric-depth").innerHTML = `${telemetry.depth.toFixed(1)}<span class="unit"> m</span>`;
  $("#metric-depth-target").textContent = `Target · ${$("#depth-control").value} m`;
  $("#position-x").textContent = telemetry.x.toFixed(1);
  $("#position-y").textContent = telemetry.y.toFixed(1);
  $("#position-z").textContent = telemetry.z.toFixed(1);
  $("#scene-coordinates").textContent = `X ${telemetry.x.toFixed(1)} · Y ${telemetry.y.toFixed(1)} · Z ${telemetry.z.toFixed(1)} m`;
  $("#wall-distance").textContent = `${telemetry.y.toFixed(1)} m`;
  $("#sonar-wall-range").textContent = `${telemetry.y.toFixed(1)} m`;
  $("#telemetry-speed").innerHTML = `${telemetry.speed.toFixed(2)} <small>m/s</small>`;
  const imagingMode = telemetry.imaging_mode || "Camera-primary";
  const imagingBadge = $("#imaging-mode-badge");
  imagingBadge.textContent = imagingMode.toUpperCase();
  imagingBadge.dataset.mode = imagingMode === "Sonar-primary" ? "sonar" : imagingMode === "Camera + sonar fusion" ? "fusion" : "camera";
  $("#telemetry-imaging-mode").textContent = telemetry.active_sensor.toUpperCase();
  $("#telemetry-camera").textContent = telemetry.camera.toUpperCase();
  $("#telemetry-camera").classList.toggle("good-text", telemetry.camera === "Clear");
  $("#telemetry-link").textContent = telemetry.communication.toUpperCase();
  $("#telemetry-link").classList.toggle("good-text", telemetry.communication === "Connected");
  $("#link-mode-caption").textContent = telemetry.communication_mode === "Tethered"
    ? "Tethered · high-rate data and video"
    : "Acoustic · low-rate compressed preview";
  $("#link-connection-indicator").classList.toggle("running", telemetry.communication === "Connected");
  $("#link-connection-indicator").innerHTML = `<i></i> ${telemetry.communication.toUpperCase()}`;
  $("#link-quality-value").textContent = `${telemetry.link_quality.toFixed(1)}%`;
  $("#link-quality-bar").style.width = `${telemetry.link_quality}%`;
  $("#link-quality-bar").classList.toggle("interrupted", telemetry.communication !== "Connected");
  $("#link-latency").textContent = `${telemetry.link_latency_ms} ms`;
  $("#link-bandwidth").textContent = telemetry.link_bandwidth_kbps >= 1000
    ? `${(telemetry.link_bandwidth_kbps / 1000).toFixed(0)} Mbps`
    : `${telemetry.link_bandwidth_kbps} kbps`;
  $("#link-packets").textContent = String(telemetry.packets);
  const latestLinkEvent = snapshot.communication_events.at(-1);
  $("#link-event").textContent = telemetry.communication === "Interrupted"
    ? latestLinkEvent?.event || `${telemetry.communication_mode} link interrupted · video buffering`
    : latestLinkEvent?.event || `${telemetry.communication_mode} link active · telemetry acknowledged`;
  $("#link-event").classList.toggle("interrupted", telemetry.communication !== "Connected");
  $("#telemetry-battery").textContent = `${telemetry.battery.toFixed(1)}%`;
  $("#telemetry-progress").textContent = `${Math.round(telemetry.progress)}%`;
  $("#overview-status").textContent = telemetry.status.toUpperCase();
  $("#overview-progress").textContent = `${Math.round(telemetry.progress)}%`;
  $("#overview-defects").textContent = String(snapshot.defects.length);
  $("#overview-distance").innerHTML = `${Number(telemetry.distance_traveled || 0).toFixed(1)}<span class="unit"> m</span>`;
  $("#analytics-coverage").textContent = `${Math.round(telemetry.progress)}%`;
  $("#analytics-coverage-label").textContent = telemetry.status === "Idle" ? "Inspection not started" : telemetry.status;
  $("#analytics-findings").textContent = String(snapshot.defects.length);
  $("#analytics-distance").innerHTML = `${Number(telemetry.distance_traveled || 0).toFixed(1)} <small>m</small>`;
  $("#analytics-planned").textContent = `${Number(telemetry.planned_distance || 0).toFixed(1)} m`;
  $("#analytics-battery").textContent = `${telemetry.battery.toFixed(1)}%`;
  $("#breakdown-status").textContent = telemetry.status.toUpperCase();
  $("#breakdown-link").textContent = telemetry.communication.toUpperCase();
  $("#breakdown-depth").textContent = `${snapshot.inspection_depth} m`;
  $("#breakdown-obstacles").textContent = String(snapshot.obstacles.length);
  $("#report-status-chip").textContent = `MISSION ${telemetry.status.toUpperCase()}`;
  $("#report-coverage").textContent = `${Math.round(telemetry.progress)}%`;
  $("#report-findings").textContent = String(snapshot.defects.length);
  $("#report-obstacles").textContent = String(snapshot.obstacles.length);
  $("#report-battery").textContent = `${telemetry.battery.toFixed(1)}%`;
  $("#report-location").textContent = `X ${telemetry.x.toFixed(1)} · Y ${telemetry.y.toFixed(1)} · Z ${telemetry.z.toFixed(1)} m`;
  $("#report-finding-count").textContent = `${snapshot.defects.length} RECORD${snapshot.defects.length === 1 ? "" : "S"}`;
  $("#report-severity-summary").textContent = `${snapshot.defects.filter((item) => item.severity === "High").length} high · ${snapshot.defects.filter((item) => item.severity === "Medium").length} medium`;

  [
    ["#progress-bar", telemetry.progress], ["#telemetry-progress-bar", telemetry.progress],
    ["#overview-progress-bar", telemetry.progress], ["#analytics-coverage-bar", telemetry.progress],
    ["#report-coverage-bar", telemetry.progress], ["#battery-bar", telemetry.battery],
    ["#analytics-battery-bar", telemetry.battery],
  ].forEach(([selector, value]) => applyProgress(selector, value));

  $("#report-ready-banner").classList.toggle("hidden", telemetry.status !== "Completed");
  const missionActive = ["Running", "Paused", "Returning to surface"].includes(telemetry.status) || telemetry.manual_move_active;
  $("#depth-control").disabled = missionActive;
  $("#mission-section").disabled = missionActive;
  $("#start-mission").disabled = missionActive;
  $("#pause-mission").disabled = telemetry.status !== "Running";
  $("#resume-mission").disabled = telemetry.status !== "Paused";
  renderFindings(snapshot);
  renderMissionPriorities(snapshot);
  renderReportDetails(snapshot);
  updateCharts(snapshot);
  updateScene(snapshot);
}

function renderMissionPriorities(snapshot) {
  const priorities = snapshot.mission_priorities || [];
  const markup = priorities.map((item, index) => {
    const level = item.priority.toLowerCase();
    return `<article class="priority-card ${level}"><span class="priority-rank">${String(index + 1).padStart(2, "0")}</span><div class="priority-copy"><b>${escapeHTML(item.section)}</b><small>${escapeHTML(item.reason)}</small></div><div class="priority-score"><b>${Number(item.risk_score)}<small>/100</small></b><span>${escapeHTML(item.priority)}</span></div><button class="priority-action" type="button" data-priority-section="${escapeHTML(item.section)}" aria-label="Select ${escapeHTML(item.section)} for the next mission">PLAN →</button></article>`;
  }).join("");
  const empty = '<p class="priority-empty">Risk-ranked sample sections will appear here.</p>';
  $("#mission-priority-list").innerHTML = markup || empty;
  $("#analytics-priority-list").innerHTML = markup || empty;
}

function renderFindings(snapshot) {
  const container = $("#finding-feed");
  if (!snapshot.defects.length) {
    container.innerHTML = '<div class="empty-feed"><span>◈</span><div><b>Inspection findings appear here</b><small>Launch a mission to scan the dam wall.</small></div></div>';
  } else {
    container.innerHTML = snapshot.defects.map((finding) => {
      const severity = finding.severity.toLowerCase();
      const location = finding.location.map((value) => Number(value).toFixed(1)).join(" / ");
      return `<article class="finding-chip"><span class="finding-marker">⌖</span><span class="finding-copy"><b>${escapeHTML(finding.type)}</b><small>${escapeHTML(finding.id)} · XYZ ${escapeHTML(location)} m · RISK ${Number(finding.risk_score)}/100</small></span><span class="severity-badge ${severity}">${escapeHTML(finding.severity.toUpperCase())}</span></article>`;
    }).join("");
  }

  const table = $("#report-findings-table");
  if (!snapshot.defects.length) {
    table.innerHTML = '<div class="report-empty">No findings recorded yet. Start an inspection to scan the sample locations.</div>';
    return;
  }
  table.innerHTML = `<div class="table-wrap"><table class="data-table"><thead><tr><th>ID</th><th>FINDING</th><th>LOCATION · X / Y / Z</th><th>SEVERITY</th><th>RISK INDEX</th><th>DETECTION SOURCE</th></tr></thead><tbody>${snapshot.defects.map((finding) => {
    const coords = finding.location.map((value) => Number(value).toFixed(1)).join(" / ");
    return `<tr><td>${escapeHTML(finding.id)}</td><td>${escapeHTML(finding.type)}</td><td>${escapeHTML(coords)} m</td><td><span class="severity-badge ${finding.severity.toLowerCase()}">${escapeHTML(finding.severity)}</span></td><td>${Number(finding.risk_score)}/100</td><td>${escapeHTML(finding.detection_method || "Simulated")}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}

function renderReportDetails(snapshot) {
  const telemetry = snapshot.telemetry;
  const rows = [
    ["Mission state", telemetry.status],
    ["Inspection sections", snapshot.mission_sections.join(", ") || "Not selected"],
    ["Inspection depth", `${snapshot.inspection_depth} m`],
    ["Route completion", `${Number(telemetry.progress).toFixed(1)}%`],
    ["Distance traveled", `${Number(telemetry.distance_traveled || 0).toFixed(1)} m`],
    ["Planned route", `${Number(telemetry.planned_distance || 0).toFixed(1)} m`],
    ["Communication", `${telemetry.communication_mode} · ${telemetry.communication}`],
    ["Adaptive imaging mode", telemetry.imaging_mode],
    ["Follow-up priority", snapshot.mission_priorities?.[0]?.section || "Not available"],
    ["Data packets", String(telemetry.packets)],
    ["Data source", "Offline simulation"],
  ];
  $("#report-details").innerHTML = rows.map(([label, value]) => `<div><span>${escapeHTML(label)}</span><b>${escapeHTML(value)}</b></div>`).join("");
}

function chartOptions(showLegend = false) {
  const light = state.theme === "light";
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 250 },
    plugins: {
      legend: { display: showLegend, labels: { color: light ? "#4c656b" : "#9db0b2", usePointStyle: true, boxWidth: 7, boxHeight: 7, padding: 14, font: { family: "DM Sans", size: 9 } } },
      tooltip: {
        backgroundColor: light ? "#ffffff" : "#10232b", titleColor: light ? "#18323a" : "#e4f0ed", bodyColor: light ? "#4c656b" : "#9eb3b1",
        borderColor: light ? "#c8d8dc" : "#29434b", borderWidth: 1, padding: 9, displayColors: true,
      },
    },
  };
}

function createCharts() {
  Chart.defaults.color = state.theme === "light" ? "#526970" : "#82999b";
  Chart.defaults.font.family = "DM Sans";
  Chart.defaults.font.size = 9;
  const progress = $("#progress-chart");
  state.charts.progress = new Chart(progress, {
    type: "line",
    data: {
      labels: ["Ready"],
      datasets: [
        { label: "Coverage", data: [0], borderColor: COLORS.cyan, backgroundColor: "#61dfcf19", fill: true, tension: 0.35, pointRadius: 2 },
        { label: "Battery", data: [100], borderColor: COLORS.green, backgroundColor: "transparent", fill: false, tension: 0.35, pointRadius: 1 },
      ],
    },
    options: {
      ...chartOptions(true),
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 7 } },
        y: { min: 0, max: 100, grid: { color: state.theme === "light" ? "rgba(45, 80, 88, .12)" : COLORS.grid }, ticks: { stepSize: 25, callback: (value) => `${value}%` } },
      },
    },
  });

  state.charts.severity = new Chart($("#severity-chart"), {
    type: "doughnut",
    data: {
      labels: ["High", "Medium", "Low", "Not yet found"],
      datasets: [{ data: [0, 0, 0, 4], backgroundColor: [COLORS.coral, COLORS.amber, COLORS.green, "#253941"], borderColor: state.theme === "light" ? "#ffffff" : "#0b1c25", borderWidth: 3, hoverOffset: 3 }],
    },
    options: { ...chartOptions(false), cutout: "77%", plugins: { ...chartOptions(false).plugins, tooltip: chartOptions().plugins.tooltip } },
  });

  state.charts.locations = new Chart($("#location-chart"), {
    type: "scatter",
    data: {
      datasets: [
        { label: "High severity", data: [], backgroundColor: COLORS.coral, pointRadius: 5, pointHoverRadius: 7 },
        { label: "Medium severity", data: [], backgroundColor: COLORS.amber, pointRadius: 5, pointHoverRadius: 7 },
        { label: "Low severity", data: [], backgroundColor: COLORS.green, pointRadius: 5, pointHoverRadius: 7 },
        { label: "Not-yet-scanned scenarios", data: DEFAULT_SCENARIOS.map((item) => ({ x: item.location[0], y: item.location[2], label: item.type, severity: item.severity })), backgroundColor: "#51646a", pointRadius: 4, pointStyle: "crossRot" },
      ],
    },
    options: {
      ...chartOptions(true),
      scales: {
        x: { min: -18, max: 18, title: { display: true, text: "HORIZONTAL WALL POSITION · X (m)", color: "#7d9497" }, grid: { color: COLORS.grid }, ticks: { stepSize: 6 } },
        y: { reverse: true, min: 0, max: 24, title: { display: true, text: "DEPTH · Z (m)", color: "#7d9497" }, grid: { color: COLORS.grid }, ticks: { stepSize: 6 } },
      },
      plugins: {
        ...chartOptions(true).plugins,
        tooltip: { ...chartOptions(true).plugins.tooltip, callbacks: { label: (context) => {
          const point = context.raw;
          return `${point.label || context.dataset.label} · X ${point.x} m, depth ${point.y} m${point.severity ? ` · ${point.severity}` : ""}`;
        } } },
      },
    },
  });
}

function updateCharts(snapshot) {
  if (!state.charts.progress) return;
  const telemetry = snapshot.telemetry;
  const progressChart = state.charts.progress;
  const timeLabel = telemetry.status === "Idle" ? "Ready" : formatClock(state.missionSeconds);
  const last = progressChart.data.labels[progressChart.data.labels.length - 1];
  if (last === timeLabel) {
    progressChart.data.datasets[0].data[progressChart.data.datasets[0].data.length - 1] = telemetry.progress;
    progressChart.data.datasets[1].data[progressChart.data.datasets[1].data.length - 1] = telemetry.battery;
  } else {
    progressChart.data.labels.push(timeLabel);
    progressChart.data.datasets[0].data.push(telemetry.progress);
    progressChart.data.datasets[1].data.push(telemetry.battery);
  }
  while (progressChart.data.labels.length > 30) {
    progressChart.data.labels.shift();
    progressChart.data.datasets.forEach((dataset) => dataset.data.shift());
  }
  progressChart.update("none");

  const counts = { High: 0, Medium: 0, Low: 0 };
  snapshot.defects.forEach((item) => { if (counts[item.severity] !== undefined) counts[item.severity] += 1; });
  const notFound = Math.max(0, DEFAULT_SCENARIOS.length - snapshot.defects.length);
  state.charts.severity.data.datasets[0].data = [counts.High, counts.Medium, counts.Low, notFound];
  state.charts.severity.update("none");
  $("#severity-total").textContent = String(snapshot.defects.length);
  $("#severity-legend").innerHTML = [
    ["High", COLORS.coral, counts.High], ["Medium", COLORS.amber, counts.Medium],
    ["Low", COLORS.green, counts.Low],
  ].map(([name, color, count]) => `<span><i style="background:${color}"></i>${name} · ${count}</span>`).join("");

  const severityIndex = { High: 0, Medium: 1, Low: 2 };
  const locationDatasets = state.charts.locations.data.datasets;
  locationDatasets.slice(0, 3).forEach((dataset) => { dataset.data = []; });
  snapshot.defects.forEach((finding) => {
    const index = severityIndex[finding.severity];
    if (index !== undefined) locationDatasets[index].data.push({
      x: finding.location[0], y: finding.location[2],
      label: finding.type, id: finding.id, severity: finding.severity,
    });
  });
  locationDatasets[3].data = (snapshot.defect_scenarios || DEFAULT_SCENARIOS)
    .filter((item) => !snapshot.defects.some((finding) => finding.id === item.id))
    .map((item) => ({ x: item.location[0], y: item.location[2], label: item.type, severity: item.severity }));
  state.charts.locations.update("none");
}

function setView(viewName) {
  state.view = viewName;
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${viewName}`));
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === viewName));
  $("#page-title").textContent = $(`#view-${viewName}`)?.dataset.pageTitle || "LIVE MISSION";
  if (sceneModel && viewName === "mission") {
    window.setTimeout(() => {
      sceneModel.resize();
      sceneModel.controls.update();
      sceneModel.renderer.render(sceneModel.scene, sceneModel.camera);
    }, 40);
  }
}

function applyTheme(theme) {
  state.theme = theme;
  document.body.classList.toggle("theme-light", theme === "light");
  const nextTheme = theme === "light" ? "dark" : "light";
  $("#theme-label").textContent = nextTheme.toUpperCase();
  $("#theme-icon").textContent = nextTheme === "light" ? "☼" : "◐";
  $("#theme-toggle").setAttribute("aria-label", `Switch to ${nextTheme} mode`);
  $("#theme-toggle").title = `Switch to ${nextTheme} mode`;
  Chart.defaults.color = theme === "light" ? "#526970" : "#82999b";
  const gridColor = theme === "light" ? "rgba(45, 80, 88, .12)" : COLORS.grid;
  Object.values(state.charts).forEach((chart) => {
    chart.options.plugins.legend.labels.color = theme === "light" ? "#4c656b" : "#9db0b2";
    chart.options.plugins.tooltip.backgroundColor = theme === "light" ? "#ffffff" : "#10232b";
    chart.options.plugins.tooltip.titleColor = theme === "light" ? "#18323a" : "#e4f0ed";
    chart.options.plugins.tooltip.bodyColor = theme === "light" ? "#4c656b" : "#9eb3b1";
    chart.options.plugins.tooltip.borderColor = theme === "light" ? "#c8d8dc" : "#29434b";
    for (const axis of Object.values(chart.options.scales || {})) {
      if (axis.ticks) axis.ticks.color = theme === "light" ? "#526970" : "#82999b";
      if (axis.title) axis.title.color = theme === "light" ? "#526970" : "#7d9497";
      if (axis.grid) axis.grid.color = gridColor;
    }
    chart.update("none");
  });
}

$("#theme-toggle").addEventListener("click", () => {
  const nextTheme = state.theme === "dark" ? "light" : "dark";
  localStorage.setItem("aquainspect-theme", nextTheme);
  applyTheme(nextTheme);
});
applyTheme(state.theme);

$$("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
$$("[data-view-link]").forEach((button) => button.addEventListener("click", (event) => {
  event.preventDefault();
  setView(button.dataset.viewLink);
}));

async function performControl(action, successMessage) {
  try {
    const snapshot = await request(`/api/control/${action}`, { method: "POST" });
    updateState(snapshot);
    if (successMessage) showToast(successMessage);
  } catch (error) {
    showToast(error.message);
  }
}

$("#start-mission").addEventListener("click", async () => {
  try {
    const snapshot = await postJSON("/api/mission/start", {
      sections: [$("#mission-section").value],
      inspection_depth: Number($("#depth-control").value),
    });
    state.missionSeconds = 0;
    state.history = [];
    updateState(snapshot);
    setView("mission");
    showToast("Inspection route planned. Simulated vehicle is moving.");
  } catch (error) {
    showToast(error.message);
  }
});
$("#pause-mission").addEventListener("click", () => performControl("pause", "Inspection paused."));
$("#resume-mission").addEventListener("click", () => performControl("resume", "Inspection resumed."));
$("#return-surface").addEventListener("click", () => performControl("surface", "Return-to-surface route planned."));
$("#reset-mission").addEventListener("click", () => {
  state.missionSeconds = 0;
  $("#low-visibility").checked = false;
  $("#water-condition").value = "Clear";
  $("#communication-mode").value = "Tethered";
  $("#depth-control").disabled = false;
  $("#mission-section").disabled = false;
  $("#start-mission").disabled = false;
  performControl("reset", "Simulation reset to the launch point.");
});
$("#depth-control").addEventListener("input", (event) => {
  $("#depth-value").textContent = `${event.target.value} m`;
  $("#metric-depth-target").textContent = `Target · ${event.target.value} m`;
  $("#breakdown-depth").textContent = `${event.target.value} m`;
});

async function saveSettings(event) {
  try {
    const snapshot = await postJSON("/api/settings", {
      communication_mode: $("#communication-mode").value,
      low_visibility: $("#low-visibility").checked,
      water_condition: $("#water-condition").value,
    });
    updateState(snapshot);
    if (event?.target?.id === "communication-mode") {
      showToast(`${snapshot.telemetry.communication_mode} link selected · rates and interruptions are simulated.`);
    } else {
      showToast(`${snapshot.telemetry.water_condition} water · camera visibility adapted; sonar remains available.`);
    }
  } catch (error) {
    showToast(error.message);
  }
}
$("#communication-mode").addEventListener("change", saveSettings);
$("#low-visibility").addEventListener("change", saveSettings);
$("#water-condition").addEventListener("change", saveSettings);

async function enhanceLiveVideoFrame() {
  if (!$("#enhance-live-video").checked || state.videoEnhancementPending || !state.latest) return;
  if (state.latest.telemetry.communication !== "Connected") return;
  state.videoEnhancementPending = true;
  try {
    const canvas = $("#live-video-canvas");
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Could not capture the simulated video frame.")), "image/jpeg", 0.82);
    });
    const form = new FormData();
    form.append("file", blob, "simulated-rov-frame.jpg");
    form.append("profile", $("#video-enhancement-profile").value);
    const result = await request("/api/vision/enhance-frame", { method: "POST", body: form });
    $("#live-video-enhanced").src = `data:image/jpeg;base64,${result.enhanced_image}`;
    $("#live-video-enhanced").classList.remove("hidden");
    state.videoEnhancementErrorShown = false;
  } catch (error) {
    $("#enhance-live-video").checked = false;
    $("#live-video-enhanced").classList.add("hidden");
    if (!state.videoEnhancementErrorShown) showToast(`Live-frame enhancement stopped: ${error.message}`);
    state.videoEnhancementErrorShown = true;
  } finally {
    state.videoEnhancementPending = false;
  }
}

$("#enhance-live-video").addEventListener("change", () => {
  $("#live-video-enhanced").classList.toggle("hidden", !$("#enhance-live-video").checked);
  if ($("#enhance-live-video").checked) enhanceLiveVideoFrame();
});
$("#video-enhancement-profile").addEventListener("change", enhanceLiveVideoFrame);
window.setInterval(enhanceLiveVideoFrame, 1800);

$$(".layer-button").forEach((button) => button.addEventListener("click", () => {
  const layer = button.dataset.layer;
  state.layerVisibility[layer] = !state.layerVisibility[layer];
  button.classList.toggle("selected", state.layerVisibility[layer]);
  if (state.latest) updateScene(state.latest);
}));
$$(".mission-priority-list").forEach((list) => list.addEventListener("click", (event) => {
  const button = event.target.closest("[data-priority-section]");
  if (!button) return;
  const section = button.dataset.prioritySection;
  $("#mission-section").value = section;
  const active = ["Running", "Paused", "Returning to surface"].includes(state.latest?.telemetry?.status);
  if (active) {
    showToast(`${section} selected for the next mission. The current route is unchanged.`);
  } else {
    setView("mission");
    showToast(`${section} selected. Start inspection when ready.`);
  }
}));
$("#risk-map-callout").addEventListener("click", (event) => {
  if (!event.target.closest(".risk-callout-close")) return;
  state.selectedRiskId = null;
  $("#risk-map-callout").classList.add("hidden");
});
$("#camera-reset").addEventListener("click", () => {
  if (!sceneModel) return;
  sceneModel.camera.position.set(26, -3, 27);
  sceneModel.controls.target.set(0, -11.5, 6);
  sceneModel.controls.update();
});
$("#camera-focus").addEventListener("click", () => {
  if (!sceneModel || !state.latest) return;
  const robotPosition = toScene(state.latest.position);
  sceneModel.controls.target.copy(robotPosition);
  sceneModel.camera.position.copy(robotPosition).add(new THREE.Vector3(10, 7, 12));
  sceneModel.controls.update();
});

function zoomCamera(factor) {
  if (!sceneModel) return;
  const offset = sceneModel.camera.position.clone().sub(sceneModel.controls.target);
  const distance = THREE.MathUtils.clamp(offset.length() * factor, sceneModel.controls.minDistance, sceneModel.controls.maxDistance);
  offset.setLength(distance);
  sceneModel.camera.position.copy(sceneModel.controls.target).add(offset);
  sceneModel.controls.update();
}

$("#zoom-in").addEventListener("click", () => zoomCamera(0.78));
$("#zoom-out").addEventListener("click", () => zoomCamera(1.28));

async function moveRobot(direction) {
  if (state.manualRequestPending) return;
  state.manualRequestPending = true;
  $$("[data-move]").forEach((button) => { button.disabled = true; });
  try {
    updateState(await postJSON("/api/manual/move", { direction }));
  } catch (error) {
    showToast(error.message);
  } finally {
    state.manualRequestPending = false;
    $$("[data-move]").forEach((button) => { button.disabled = false; });
  }
}

$$("[data-move]").forEach((button) => {
  button.addEventListener("click", () => moveRobot(button.dataset.move));
});

document.addEventListener("pointerdown", unlockObstacleAudio, { once: true });
$("#sound-toggle").addEventListener("click", (event) => {
  state.soundEnabled = !state.soundEnabled;
  const button = event.currentTarget;
  button.setAttribute("aria-pressed", String(state.soundEnabled));
  button.textContent = state.soundEnabled ? "♪ SOUND ON" : "♪ MUTED";
  button.title = state.soundEnabled ? "Mute obstacle alert sound" : "Enable obstacle alert sound";
  if (state.soundEnabled) unlockObstacleAudio();
});

window.addEventListener("keydown", (event) => {
  if (event.repeat || state.view !== "mission") return;
  if (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.matches("input, textarea, select"))) return;
  const directions = {
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
    w: "toward", W: "toward", s: "away", S: "away",
  };
  const direction = directions[event.key];
  if (!direction) return;
  event.preventDefault();
  moveRobot(direction);
});

$("#local-clock").textContent = `LOCAL · ${new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date())}`;
window.setInterval(() => {
  $("#local-clock").textContent = `LOCAL · ${new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date())}`;
}, 1000);

async function pollState() {
  try {
    const snapshot = await request("/api/state");
    updateState(snapshot);
  } catch (error) {
    $("#mission-state").textContent = "API OFFLINE";
    showToast(`Local API unavailable: ${error.message}`);
  }
}

async function analyzeImage(endpoint, options) {
  const response = await request(endpoint, options);
  renderImageResults(response);
}

function renderImageResults(result) {
  $("#image-placeholder").classList.add("hidden");
  $("#image-result").classList.remove("hidden");
  const profileLabels = {
    visibility: "VISIBILITY RECOVERY",
    "low-light": "LOW-LIGHT BOOST",
    "color-correct": "COLOR CORRECTED",
  };
  $("#image-stage-pill").textContent = profileLabels[result.profile] || "OPENCV ENHANCED";
  $("#enhancement-caption").textContent = `${profileLabels[result.profile] || "OpenCV enhancement"} · local processing`;
  $("#enhanced-image").src = `data:image/jpeg;base64,${result.enhanced_image}`;
  $("#image-file-name").textContent = result.name;
  $("#candidate-boxes").replaceChildren();
  const image = $("#enhanced-image");
  const drawCandidateBoxes = () => {
    const boxLayer = $("#candidate-boxes");
    boxLayer.replaceChildren();
    const rect = image.getBoundingClientRect();
    const scaleX = rect.width / result.width;
    const scaleY = rect.height / result.height;
    result.candidates.forEach((candidate) => {
      const [x, y, width, height] = candidate.box;
      const box = document.createElement("div");
      box.className = "candidate-box";
      box.style.left = `${x * scaleX}px`;
      box.style.top = `${y * scaleY}px`;
      box.style.width = `${width * scaleX}px`;
      box.style.height = `${height * scaleY}px`;
      boxLayer.appendChild(box);
    });
  };
  if (image.complete) drawCandidateBoxes();
  else image.addEventListener("load", drawCandidateBoxes, { once: true });

  const results = $("#candidate-results");
  if (!result.candidates.length) {
    results.innerHTML = `<h3>NO CANDIDATE REGIONS</h3><div class="candidate-row">No areas passed the heuristic filter.<span>NOT A MODEL PREDICTION</span></div>`;
  } else {
    results.innerHTML = `<h3>${result.candidates.length} IMAGE-PROCESSING CANDIDATE${result.candidates.length === 1 ? "" : "S"}</h3><div class="candidate-list">${result.candidates.map((candidate, index) => `<div class="candidate-row"><span class="legend-dot dot-amber"></span><b>${escapeHTML(candidate.type)}</b><span>ROI ${String(index + 1).padStart(2, "0")} · ${candidate.area_px} px</span></div>`).join("")}</div>`;
  }
  showToast("OpenCV enhancement complete. Candidates are heuristic regions, not AI predictions.");
}

$("#analyze-sample").addEventListener("click", async () => {
  const button = $("#analyze-sample");
  button.disabled = true;
  try {
    await analyzeImage("/api/vision/sample", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defect_type: $("#sample-defect").value, profile: $("#enhancement-profile").value }),
    });
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

$("#image-upload").addEventListener("change", (event) => {
  state.file = event.target.files[0] || null;
  $("#image-file-name").textContent = state.file ? state.file.name : "No file selected";
  $("#analyze-upload").disabled = !state.file;
});

$("#analyze-upload").addEventListener("click", async () => {
  if (!state.file) return;
  const button = $("#analyze-upload");
  button.disabled = true;
  try {
    const form = new FormData();
    form.append("file", state.file);
    form.append("profile", $("#enhancement-profile").value);
    await analyzeImage("/api/vision/upload", { method: "POST", body: form });
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = !state.file;
  }
});

createCharts();
pollState();
window.setInterval(pollState, 500);
