import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import * as THREE from "three";

/* ═══════════════════════════════════════════════════════════════
   WATER·IQ — TREATMENT TANK SYSTEM  v6.0
   Electrocoagulation · Lamella Settling · Edge Intelligence
   Propeller Flow Control · ESP32 Timed Gate
═══════════════════════════════════════════════════════════════ */

// ─── WATER TYPE PROFILES (from WATER·IQ PDF specs) ────────────
const WATER_TYPES = {
  LIGHT:   { label: "Light Greywater",   desc: "Sink / Shower",  flocMin: 120,  flocMax: 180,  clearMin: 480,  clearMax: 720,  saltNeeded: true,  contam: 0.22, color: "#00d4ff" },
  HEAVY:   { label: "Heavy Greywater",   desc: "Laundry",        flocMin: 180,  flocMax: 300,  clearMin: 720,  clearMax: 1200, saltNeeded: false, contam: 0.55, color: "#ffdb58" },
  BLACK:   { label: "Blackwater",        desc: "Sewage",         flocMin: 600,  flocMax: 900,  clearMin: 1800, clearMax: 2700, saltNeeded: false, contam: 0.90, color: "#ff3f5a" },
};

// ─── EC STAGES (from PDF §04 Electrocoagulation Chamber) ──────
const EC_STAGES = [
  { t: 0,   label: "EC INIT",        desc: "12V DC applied · Al³⁺ ions releasing",     col: "#00d4ff" },
  { t: 30,  label: "BUBBLE FORM",    desc: "H₂ bubbles visible · cathode active",       col: "#7dd3fc" },
  { t: 90,  label: "FLOC NUCLEATE",  desc: "Al(OH)₃ nucleation · floc forming",         col: "#00ff9d" },
  { t: 180, label: "POLARITY REV",   desc: "Relay reversal — passivation prevented",    col: "#ffdb58" },
  { t: 360, label: "FLOC GROWTH",    desc: "Coagulation accelerating · TDS dropping",  col: "#ff8c42" },
  { t: 540, label: "POLARITY REV",   desc: "Second reversal cycle",                     col: "#ffdb58" },
  { t: 720, label: "GATE EVAL",      desc: "ESP32 timer evaluating — 12 min elapsed",  col: "#c084fc" },
  { t: 900, label: "GATE OPEN",      desc: "15 min complete · servo rotates Disc 2",   col: "#00ff9d" },
];

// ─── TANK STRUCTURE STAGES (from PDF) ─────────────────────────
const TANK_STRUCTURE = [
  { id: "PROPELLER", label: "01 · Propeller Zone",    color: "#00d4ff", icon: "⟳", desc: "Motor outside wall · blades span 80–90% interior diameter · RPM kept low for distribution" },
  { id: "EC",        label: "02 · EC Chamber",        color: "#ffdb58", icon: "⚡", desc: "6–8 Al discs full cross-section · groove-locked · 20–30 holes per disc · 12V DC · polarity reversal every 2–3 min" },
  { id: "GATE",      label: "03 · Timed Gate",        color: "#c084fc", icon: "⏱", desc: "Two-disc mechanism · Disc 1 fixed perforated · Disc 2 servo solid · ESP32 opens after 15 min" },
  { id: "SENSOR",    label: "04 · Sensor Pod",        color: "#00ff9d", icon: "◈", desc: "Turbidity ×2 · pH · TDS/conductivity · unified pod · feeds ESP32 TFLite edge model" },
  { id: "LAMELLA",   label: "05 · Lamella Section",   color: "#7fffd4", icon: "⋁", desc: "Two acrylic strips 3mm · V-shape down · 45%+10%+45% cross section · particles slide to centre gap" },
  { id: "COLLECT",   label: "06 · Collection Zone",   color: "#ff8c42", icon: "○", desc: "Clean water floats · heavy floc sinks · turbidity sensor signals drain-ready · single side cut drain" },
];

// ─── CONSTANTS ────────────────────────────────────────────────
const BRACKET_META = {
  F1: { label: "Baseline Polishing",   color: 0x00ff9d, hex: "#00ff9d", tank: "A", reusable: true,  risk: "NONE",     desc: "pH 6.5–8.0 · TDS <200 · Turb <2 NTU",  emoji: "✦" },
  F2: { label: "Light Suspended",      color: 0x7fffd4, hex: "#7fffd4", tank: "A", reusable: true,  risk: "LOW",      desc: "TDS <300 · Turb <4 NTU",               emoji: "◈" },
  F3: { label: "High Suspended",       color: 0xffdb58, hex: "#ffdb58", tank: "B", reusable: false, risk: "MODERATE", desc: "TDS <500 · Turb <8 NTU",               emoji: "◉" },
  F4: { label: "High Dissolved",       color: 0xff8c42, hex: "#ff8c42", tank: "B", reusable: false, risk: "HIGH",     desc: "TDS <800 mg/L",                         emoji: "▲" },
  F5: { label: "Severe Contamination", color: 0xff3f5a, hex: "#ff3f5a", tank: "B", reusable: false, risk: "CRITICAL", desc: "TDS ≥800 mg/L",                         emoji: "⚠" },
};

function classifyBracket(ph, turb, tds) {
  if (turb < 2 && tds < 200 && ph >= 6.5 && ph <= 8.0) return "F1";
  if (turb < 4 && tds < 300)  return "F2";
  if (turb < 8 && tds < 500)  return "F3";
  if (tds < 800)               return "F4";
  return "F5";
}

const PHASES = ["IDLE", "FILLING", "SWIRLING", "SEPARATING", "CLASSIFYING", "ROUTING", "DRAINING", "COMPLETE"];
const PHASE_COLORS = {
  IDLE: "#4a6580", FILLING: "#00d4ff", SWIRLING: "#00b4d8",
  SEPARATING: "#ffdb58", CLASSIFYING: "#c084fc",
  ROUTING: "#00ff9d", DRAINING: "#64748b", COMPLETE: "#00ff9d",
};
const PHASE_DESCRIPTIONS = {
  IDLE: "System ready — awaiting cycle",
  FILLING: "Inlet open — chamber filling",
  SWIRLING: "Cyclonic flow active",
  SEPARATING: "Density stratification in progress",
  CLASSIFYING: "Sensor array analysing water",
  ROUTING: "Directing flow to storage",
  DRAINING: "Chamber draining",
  COMPLETE: "Cycle complete",
};

// ─── WATER VERTEX SHADER — Rankine vortex physics ────────────
const waterVS = `
  varying vec2 vUv; varying vec3 vPos; varying vec3 vNorm;
  varying float vVelocity; varying float vHeight;
  uniform float uTime; uniform float uSwirl; uniform float uFill;
  float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
  float noise(vec2 p){
    vec2 i=floor(p),f=fract(p);
    float a=hash(i),b=hash(i+vec2(1,0)),c=hash(i+vec2(0,1)),d=hash(i+vec2(1,1));
    vec2 u=f*f*(3.0-2.0*f);
    return mix(a,b,u.x)+(c-a)*u.y*(1.0-u.x)+(d-b)*u.x*u.y;
  }
  void main(){
    vUv=uv; vPos=position; vNorm=normal;
    vec3 pos=position;
    float rad=length(pos.xz);
    float ang=atan(pos.z,pos.x);
    float h=(pos.y+0.5)*0.5; vHeight=h;
    float wallFactor=smoothstep(0.0,0.85,rad);
    float centerFactor=1.0-smoothstep(0.0,0.35,rad);
    float rotAngle=ang+uSwirl*uTime*1.8*wallFactor-uSwirl*uTime*0.4*centerFactor;
    float helixDrop=uSwirl*wallFactor*sin(ang*4.0+uTime*3.5)*0.04;
    float inwardPull=uSwirl*wallFactor*0.018*sin(uTime*2.2+ang*3.0);
    float swirlRad=max(0.05,rad-inwardPull);
    if(uSwirl>0.05){
      pos.x=cos(rotAngle)*swirlRad;
      pos.z=sin(rotAngle)*swirlRad;
      pos.y+=helixDrop;
    }
    float surfFactor=smoothstep(0.0,0.5,pos.y+0.5);
    if(surfFactor>0.01){
      float vortexDip=max(-0.08,-uSwirl*(1.0-rad*1.2)*0.06*surfFactor);
      float wave=sin(pos.x*9.0+uTime*2.8)*0.007+cos(pos.z*8.0+uTime*2.3)*0.006;
      float swirlWave=sin(ang*7.0+uTime*6.5-rad*11.0)*uSwirl*0.018;
      pos.y+=(vortexDip+wave+swirlWave)*surfFactor;
    }
    vVelocity=wallFactor*uSwirl;
    gl_Position=projectionMatrix*modelViewMatrix*vec4(pos,1.0);
  }
`;

const waterFS = `
  varying vec2 vUv; varying vec3 vPos; varying vec3 vNorm;
  varying float vVelocity; varying float vHeight;
  uniform float uTime; uniform float uSwirl; uniform float uContam; uniform float uOpacity;
  float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
  float noise(vec2 p){
    vec2 i=floor(p),f=fract(p);
    float a=hash(i),b=hash(i+vec2(1,0)),c=hash(i+vec2(0,1)),d=hash(i+vec2(1,1));
    vec2 u=f*f*(3.0-2.0*f);
    return mix(a,b,u.x)+(c-a)*u.y*(1.0-u.x)+(d-b)*u.x*u.y;
  }
  void main(){
    float ang=atan(vPos.z,vPos.x); float rad=length(vPos.xz);
    vec3 cleanDeep=vec3(0.02,0.42,0.70); vec3 cleanSurf=vec3(0.08,0.68,0.92);
    vec3 murky=vec3(0.35,0.48,0.28);
    vec3 base=mix(mix(cleanDeep,cleanSurf,clamp(vHeight+0.5,0.0,1.0)),murky,uContam*0.88);
    float n1=noise(vUv*6.0+uTime*0.38); float n2=noise(vUv*13.0-uTime*0.24);
    float caustic=n1*n2*(1.0-uContam*0.75)*0.14;
    float swirlPhase=ang*9.0+uTime*7.5-rad*14.0;
    float streamBand=(sin(swirlPhase)*0.5+0.5)*vVelocity;
    vec3 streamColor=vec3(0.0,0.9,1.0)*streamBand*0.22;
    float centerGlow=(1.0-smoothstep(0.0,0.32,rad))*0.08;
    vec3 centerColor=vec3(0.05,0.95,0.55)*centerGlow;
    float depthShade=clamp(vHeight+0.6,0.3,1.0);
    vec3 viewDir=normalize(vec3(0.45,0.85,0.45));
    float fresnel=pow(1.0-abs(dot(normalize(vNorm),viewDir)),1.5)*0.22;
    float turb=noise(vUv*20.0+uTime*1.5)*uContam*0.06;
    vec3 col=(base+caustic+streamColor+centerColor+turb)*depthShade+fresnel*vec3(0.15,0.45,0.65);
    gl_FragColor=vec4(clamp(col,0.0,1.0),clamp(uOpacity+fresnel+streamBand*0.12,0.28,0.82));
  }
`;

const oilVS = `
  varying vec2 vUv; uniform float uTime; uniform float uSwirl;
  void main(){
    vUv=uv; vec3 pos=position;
    pos.y+=sin(pos.x*5.0+uTime*0.9)*0.005+cos(pos.z*4.0+uTime*0.7)*0.004;
    float ang=atan(pos.z,pos.x); float r=length(pos.xz);
    pos.x+=cos(ang+uTime*uSwirl*0.4)*r*0.008*uSwirl;
    pos.z+=sin(ang+uTime*uSwirl*0.4)*r*0.008*uSwirl;
    gl_Position=projectionMatrix*modelViewMatrix*vec4(pos,1.0);
  }
`;

const oilFS = `
  varying vec2 vUv; uniform float uTime; uniform float uSwirl;
  void main(){
    vec2 uv=vUv-0.5;
    float ang=atan(uv.y,uv.x); float rad=length(uv);
    float hue=fract(ang/6.28318+uTime*0.08+rad*2.0+uSwirl*0.3);
    vec3 c1=vec3(0.85,0.72,0.10); vec3 c2=vec3(0.95,0.55,0.05); vec3 c3=vec3(0.72,0.85,0.20);
    vec3 col=mix(c1,c2,sin(hue*6.28)*0.5+0.5);
    col=mix(col,c3,sin(hue*12.56+rad*3.0)*0.3+0.3);
    col+=sin(rad*15.0-uTime*1.2+ang*3.0)*0.04;
    gl_FragColor=vec4(clamp(col,0.0,1.0),0.42+sin(uTime*0.7+rad*8.0)*0.06);
  }
`;

// ─── PRE-ALLOCATED THREE.JS REUSABLES (avoid per-frame GC) ───
const _tmpColor = new THREE.Color();

// ─── SCENE BUILDER ────────────────────────────────────────────
function buildScene(canvas, getState) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const camera = new THREE.PerspectiveCamera(40, canvas.clientWidth / canvas.clientHeight, 0.1, 120);
  camera.position.set(6.2, 3.8, 7.0);
  camera.lookAt(0, 0.3, 0);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x020b14);
  scene.fog = new THREE.FogExp2(0x020b14, 0.032);

  // Collect all disposables for cleanup
  const disposables = [];

  // ── Orbit controls ─────────────────────────────────────────
  const orb = {
    theta: Math.atan2(6.2, 7.0),
    phi: Math.acos(3.8 / Math.sqrt(6.2 ** 2 + 3.8 ** 2 + 7.0 ** 2)),
    radius: Math.sqrt(6.2 ** 2 + 3.8 ** 2 + 7.0 ** 2),
    isDragging: false, lastX: 0, lastY: 0,
    tTheta: Math.atan2(6.2, 7.0),
    tPhi: Math.acos(3.8 / Math.sqrt(6.2 ** 2 + 3.8 ** 2 + 7.0 ** 2)),
    tRadius: Math.sqrt(6.2 ** 2 + 3.8 ** 2 + 7.0 ** 2),
  };

  function updateCam() {
    orb.theta  += (orb.tTheta  - orb.theta)  * 0.085;
    orb.phi    += (orb.tPhi    - orb.phi)    * 0.085;
    orb.radius += (orb.tRadius - orb.radius) * 0.085;
    orb.phi    = Math.max(0.05, Math.min(Math.PI * 0.78, orb.phi));
    orb.radius = Math.max(2.5,  Math.min(22, orb.radius));
    camera.position.set(
      orb.radius * Math.sin(orb.phi) * Math.sin(orb.theta),
      orb.radius * Math.cos(orb.phi),
      orb.radius * Math.sin(orb.phi) * Math.cos(orb.theta)
    );
    camera.lookAt(0, 0.3, 0);
  }

  const handlers = {
    mousedown: e => { orb.isDragging = true; orb.lastX = e.clientX; orb.lastY = e.clientY; },
    mousemove: e => {
      if (!orb.isDragging) return;
      orb.tTheta -= (e.clientX - orb.lastX) * 0.007;
      orb.tPhi   -= (e.clientY - orb.lastY) * 0.007;
      orb.lastX = e.clientX; orb.lastY = e.clientY;
    },
    mouseup:    () => { orb.isDragging = false; },
    mouseleave: () => { orb.isDragging = false; },
    wheel: e => { orb.tRadius += e.deltaY * 0.01; e.preventDefault(); e.stopPropagation(); },
  };
  Object.entries(handlers).forEach(([k, v]) => canvas.addEventListener(k, v, k === "wheel" ? { passive: false, capture: true } : undefined));

  let lastTD = 0;
  const touchHandlers = {
    touchstart: e => {
      if (e.touches.length === 1) { orb.isDragging = true; orb.lastX = e.touches[0].clientX; orb.lastY = e.touches[0].clientY; }
      if (e.touches.length === 2) lastTD = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    },
    touchmove: e => {
      e.preventDefault();
      if (e.touches.length === 1 && orb.isDragging) {
        orb.tTheta -= (e.touches[0].clientX - orb.lastX) * 0.008;
        orb.tPhi   -= (e.touches[0].clientY - orb.lastY) * 0.008;
        orb.lastX = e.touches[0].clientX; orb.lastY = e.touches[0].clientY;
      }
      if (e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        orb.tRadius -= (d - lastTD) * 0.02; lastTD = d;
      }
    },
    touchend: () => { orb.isDragging = false; },
  };
  Object.entries(touchHandlers).forEach(([k, v]) => canvas.addEventListener(k, v, { passive: false }));

  // ── Lighting ───────────────────────────────────────────────
  scene.add(new THREE.AmbientLight(0xc8e8ff, 0.28));

  const keyL = new THREE.DirectionalLight(0xd8eeff, 1.6);
  keyL.position.set(6, 10, 5); keyL.castShadow = true;
  keyL.shadow.mapSize.set(2048, 2048);
  keyL.shadow.camera.far = 30; keyL.shadow.camera.left = -9; keyL.shadow.camera.right = 9;
  keyL.shadow.camera.top = 9; keyL.shadow.camera.bottom = -9;
  scene.add(keyL);
  const fillLight1 = new THREE.PointLight(0x88c0e8, 0.8, 25);
  fillLight1.position.set(-6, 3, 3);
  scene.add(fillLight1);
  const fillLight2 = new THREE.PointLight(0x00d4ff, 0.7, 22);
  fillLight2.position.set(0, -1, -7);
  scene.add(fillLight2);

  const chamberSpot = new THREE.SpotLight(0xffffff, 2.2, 14, 0.35, 0.8);
  chamberSpot.position.set(0, 8, 1); chamberSpot.castShadow = true; chamberSpot.shadow.mapSize.set(1024, 1024);
  scene.add(chamberSpot);

  const tankALight = new THREE.PointLight(0x00ff9d, 0.8, 10); tankALight.position.set(-3.6, -0.8, 0); scene.add(tankALight);
  const tankBLight = new THREE.PointLight(0xff3f5a, 0.8, 10); tankBLight.position.set(3.6, -0.8, 0);  scene.add(tankBLight);

  // ── Ground & grid ──────────────────────────────────────────
  const groundGeo = new THREE.PlaneGeometry(30, 18);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x030e1a, roughness: 0.92, metalness: 0.08 });
  disposables.push(groundGeo, groundMat);
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2; ground.position.y = -2.4; ground.receiveShadow = true; scene.add(ground);
  const grid = new THREE.GridHelper(30, 36, 0x0d2235, 0x071828); grid.position.y = -2.38; scene.add(grid);

  // ── Apartment building ─────────────────────────────────────
  const aptGroup = new THREE.Group(); aptGroup.position.set(0, 4.2, -4.0);
  const buildGeo = new THREE.BoxGeometry(5.0, 4.0, 0.08);
  disposables.push(buildGeo);
  aptGroup.add(new THREE.Mesh(buildGeo, new THREE.MeshStandardMaterial({ color: 0x071828, transparent: true, opacity: 0.45, side: THREE.DoubleSide })));
  aptGroup.add(new THREE.LineSegments(new THREE.EdgesGeometry(buildGeo), new THREE.LineBasicMaterial({ color: 0x1a4060, transparent: true, opacity: 0.5 })));

  const windowMats = [];
  for (let col = -1.8; col <= 1.8; col += 0.9) {
    for (let row = -1.0; row <= 1.1; row += 0.88) {
      const wm = new THREE.MeshStandardMaterial({ color: 0x9ec8e8, transparent: true, opacity: 0.38, emissive: 0x3a80c0, emissiveIntensity: 0.1 });
      windowMats.push(wm); disposables.push(wm);
      const w = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.46, 0.015), wm);
      w.position.set(col, row, 0.05); aptGroup.add(w);
    }
  }
  for (let y = -1.2; y <= 1.2; y += 0.88) {
    const fm = new THREE.Mesh(new THREE.BoxGeometry(5.0, 0.025, 0.015), new THREE.MeshStandardMaterial({ color: 0x1a4060, transparent: true, opacity: 0.55 }));
    fm.position.set(0, y, 0.05); aptGroup.add(fm);
  }
  const sinkM = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.18, 0.03), new THREE.MeshStandardMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.75, emissive: 0x38bdf8, emissiveIntensity: 0.25 }));
  sinkM.position.set(1.9, -0.5, 0.06); aptGroup.add(sinkM);
  scene.add(aptGroup);

  const bPipeMat = new THREE.MeshStandardMaterial({ color: 0x2a4060, metalness: 0.90, roughness: 0.20 });
  disposables.push(bPipeMat);
  const bPipeVert = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 5.5, 12), bPipeMat);
  bPipeVert.position.set(2.0, 0.3, 0); scene.add(bPipeVert);
  const bPipeHoriz = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.35, 12), bPipeMat);
  bPipeHoriz.rotation.z = Math.PI / 2; bPipeHoriz.position.set(1.82, 0.8, 0); scene.add(bPipeHoriz);

  // ══ MAIN CHAMBER ══════════════════════════════════════════
  const chamberGroup = new THREE.Group(); chamberGroup.position.set(0, 0.35, 0);
  const CHAM_R = 0.78, CHAM_H = 2.8, coneH = 0.62;

  const shellMat = new THREE.MeshPhysicalMaterial({ color: 0xb0d8f5, transparent: true, opacity: 0.09, roughness: 0, metalness: 0, transmission: 0.92, thickness: 0.6, ior: 1.45, side: THREE.DoubleSide, depthWrite: false });
  disposables.push(shellMat);
  chamberGroup.add(new THREE.Mesh(new THREE.CylinderGeometry(CHAM_R, CHAM_R, CHAM_H, 96, 2, true), shellMat));
  chamberGroup.add(new THREE.Mesh(new THREE.CylinderGeometry(CHAM_R * 0.97, CHAM_R * 0.97, CHAM_H, 96, 1, true), new THREE.MeshPhysicalMaterial({ color: 0x88c8f0, transparent: true, opacity: 0.04, roughness: 0, side: THREE.BackSide, depthWrite: false })));

  const topCap = new THREE.Mesh(new THREE.CircleGeometry(CHAM_R, 96), new THREE.MeshPhysicalMaterial({ color: 0xb0d8f5, transparent: true, opacity: 0.18, roughness: 0, side: THREE.DoubleSide, depthWrite: false }));
  topCap.rotation.x = -Math.PI / 2; topCap.position.y = CHAM_H / 2; chamberGroup.add(topCap);

  const coneMesh = new THREE.Mesh(new THREE.CylinderGeometry(CHAM_R, 0.10, coneH, 64, 1, true), new THREE.MeshPhysicalMaterial({ color: 0xa0c8e8, transparent: true, opacity: 0.14, roughness: 0, side: THREE.DoubleSide, depthWrite: false }));
  coneMesh.position.y = -(CHAM_H / 2 + coneH / 2 - 0.01); chamberGroup.add(coneMesh);

  [-CHAM_H / 2 + 0.15, -0.55, 0.2, 0.95, CHAM_H / 2 - 0.15].forEach(y => {
    const r = new THREE.Mesh(new THREE.TorusGeometry(CHAM_R + 0.015, 0.018, 8, 96), new THREE.MeshStandardMaterial({ color: 0x1e3a5f, metalness: 0.95, roughness: 0.15 }));
    r.position.y = y; chamberGroup.add(r);
  });
  chamberGroup.add(new THREE.Mesh(new THREE.CylinderGeometry(CHAM_R + 0.04, CHAM_R + 0.04, 0.06, 64), new THREE.MeshStandardMaterial({ color: 0x1a3050, metalness: 0.88, roughness: 0.22 })));

  // Water shader ──
  const waterUniforms = { uTime: { value: 0 }, uSwirl: { value: 0 }, uContam: { value: 0.2 }, uOpacity: { value: 0.52 }, uFill: { value: 0 } };
  const waterMat = new THREE.ShaderMaterial({ vertexShader: waterVS, fragmentShader: waterFS, uniforms: waterUniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  disposables.push(waterMat);
  const waterMesh = new THREE.Mesh(new THREE.CylinderGeometry(CHAM_R * 0.965, CHAM_R * 0.965, CHAM_H * 0.95, 72, 16), waterMat);
  waterMesh.visible = false; chamberGroup.add(waterMesh);

  // Oil surface ──
  const oilUniforms = { uTime: { value: 0 }, uSwirl: { value: 0 } };
  const oilMat = new THREE.ShaderMaterial({ vertexShader: oilVS, fragmentShader: oilFS, uniforms: oilUniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  disposables.push(oilMat);
  const oilMesh = new THREE.Mesh(new THREE.CircleGeometry(CHAM_R * 0.92, 72), oilMat);
  oilMesh.rotation.x = -Math.PI / 2; oilMesh.visible = false; chamberGroup.add(oilMesh);

  // Sludge disc ──
  const sludgeDiscMat = new THREE.MeshStandardMaterial({ color: 0x3d1f0a, roughness: 1, transparent: true, opacity: 0, depthWrite: false });
  disposables.push(sludgeDiscMat);
  const sludgeDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.08, 0.08, 48), sludgeDiscMat);
  sludgeDisc.position.y = -(CHAM_H / 2 + coneH * 0.7); chamberGroup.add(sludgeDisc);

  // Laminar sensor zone ──
  const laminMat = new THREE.MeshStandardMaterial({ color: 0x00ff9d, transparent: true, opacity: 0.04, emissive: 0x00ff9d, emissiveIntensity: 0.12, side: THREE.DoubleSide, depthWrite: false });
  const laminRing = new THREE.Mesh(new THREE.RingGeometry(0.12, CHAM_R * 0.86, 64), laminMat);
  laminRing.rotation.x = -Math.PI / 2; laminRing.position.y = -0.12; chamberGroup.add(laminRing);
  const laminCylMat = new THREE.MeshStandardMaterial({ color: 0x00ff9d, transparent: true, opacity: 0.025, emissive: 0x00ff9d, emissiveIntensity: 0.3, side: THREE.DoubleSide, depthWrite: false });
  chamberGroup.add(new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.7, 32, 1, true), laminCylMat));
  disposables.push(laminMat, laminCylMat);

  // Baffles ──
  const baffleMat = new THREE.MeshStandardMaterial({ color: 0x2c4a6a, metalness: 0.85, roughness: 0.25 });
  disposables.push(baffleMat);
  const bVert = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.88, 0.08), baffleMat); bVert.position.set(-0.06, 0.05, 0); chamberGroup.add(bVert);
  const bHoriz = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.025, 0.72), baffleMat); bHoriz.position.set(-0.06, 0.16, 0); chamberGroup.add(bHoriz);
  const bWingMat = new THREE.MeshStandardMaterial({ color: 0x2c4a6a, metalness: 0.85, roughness: 0.25, transparent: true, opacity: 0.80 });
  disposables.push(bWingMat);
  const bWing = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.025, 0.42), bWingMat);
  bWing.position.set(0.18, -0.28, 0.22); bWing.rotation.y = Math.PI / 5; chamberGroup.add(bWing);

  // Inlet pipe ──
  const pipeMat = new THREE.MeshStandardMaterial({ color: 0x2a4060, metalness: 0.92, roughness: 0.18 });
  disposables.push(pipeMat);
  const inletPipeMat = pipeMat.clone(); disposables.push(inletPipeMat);
  const inletPipe = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 1.1, 18), inletPipeMat);
  inletPipe.rotation.z = Math.PI / 2; inletPipe.position.set(1.22, 0.45, 0);
  inletPipeMat.emissive = new THREE.Color(0x38bdf8); inletPipeMat.emissiveIntensity = 0;
  chamberGroup.add(inletPipe);
  const elbowMesh = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.075, 12, 28, Math.PI / 2), pipeMat);
  elbowMesh.position.set(1.62, 0.67, 0); elbowMesh.rotation.z = Math.PI; chamberGroup.add(elbowMesh);

  // Radar sensor ──
  const radarBase = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.12, 16), new THREE.MeshStandardMaterial({ color: 0x1a3050, metalness: 0.9, roughness: 0.2 }));
  radarBase.position.set(0, CHAM_H / 2 + 0.06, 0); chamberGroup.add(radarBase);
  const radarHead = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x00d4ff, emissive: 0x00d4ff, emissiveIntensity: 0.4, metalness: 0.5, roughness: 0.3 }));
  radarHead.position.set(0, CHAM_H / 2 + 0.13, 0); chamberGroup.add(radarHead);

  // Sensor probes ──
  const sensorDefs = [
    { id: "PH",   pos: [-0.34, 0.05,  0.26], col: 0x00ff9d, label: "pH"   },
    { id: "TDS",  pos: [ 0.34, -0.18, -0.26], col: 0xff8c42, label: "TDS"  },
    { id: "TURB", pos: [ 0.02, -0.32,  0.42], col: 0x00d4ff, label: "Turb" },
    { id: "ORP",  pos: [-0.28, -0.22, -0.38], col: 0xc084fc, label: "ORP"  },
    { id: "NH3",  pos: [ 0.30,  0.10,  0.02], col: 0xff6b8a, label: "NH₃"  },
  ];
  const sensorBulbs = [];
  sensorDefs.forEach(s => {
    const shaftMat = new THREE.MeshStandardMaterial({ color: 0x8ab0d0, metalness: 0.94, roughness: 0.16 });
    const housingMat = new THREE.MeshStandardMaterial({ color: 0x1a3050, metalness: 0.88, roughness: 0.22 });
    disposables.push(shaftMat, housingMat);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.55, 8), shaftMat);
    shaft.position.set(s.pos[0], s.pos[1] - 0.18, s.pos[2]); chamberGroup.add(shaft);
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.06, 8), housingMat);
    housing.position.set(s.pos[0], s.pos[1] + 0.14, s.pos[2]); chamberGroup.add(housing);
    const bulbMat = new THREE.MeshStandardMaterial({ color: s.col, emissive: new THREE.Color(s.col), emissiveIntensity: 0.45, metalness: 0.25, roughness: 0.35 });
    disposables.push(bulbMat);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.045, 20, 20), bulbMat);
    bulb.position.set(s.pos[0], s.pos[1] - 0.46, s.pos[2]);
    bulb.userData = { id: s.id, label: s.label, col: s.col };
    sensorBulbs.push(bulb); chamberGroup.add(bulb);
    const glowMat = new THREE.MeshStandardMaterial({ color: s.col, transparent: true, opacity: 0.08, emissive: new THREE.Color(s.col), emissiveIntensity: 1.0, side: THREE.BackSide, depthWrite: false });
    disposables.push(glowMat);
    const glowSph = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 16), glowMat);
    glowSph.position.copy(bulb.position); chamberGroup.add(glowSph);
  });

  // Classification glow shell ──
  const glowShellMat = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0, emissiveIntensity: 1.0, side: THREE.BackSide, depthWrite: false });
  disposables.push(glowShellMat);
  const glowShell = new THREE.Mesh(new THREE.CylinderGeometry(CHAM_R + 0.06, CHAM_R + 0.06, CHAM_H + 0.12, 72, 1, true), glowShellMat);
  chamberGroup.add(glowShell);
  scene.add(chamberGroup);

  // ── Outlet pipes ───────────────────────────────────────────
  function makeOutletPipe(dir, col) {
    const grp = new THREE.Group();
    grp.position.set(0, -(CHAM_H / 2 + coneH * 0.85) + 0.35, 0);
    const pMat = new THREE.MeshStandardMaterial({ color: 0x2a4060, metalness: 0.90, roughness: 0.20, emissive: new THREE.Color(col), emissiveIntensity: 0 });
    disposables.push(pMat);
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, Math.abs(dir) * 3.8, 16), pMat);
    pipe.rotation.z = Math.PI / 2; pipe.position.x = dir * 1.72; grp.add(pipe);
    const vBody = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.10, 0.22, 16), new THREE.MeshStandardMaterial({ color: 0x1a3050, metalness: 0.75, roughness: 0.28 }));
    vBody.rotation.z = Math.PI / 2; vBody.position.x = dir * 0.35; grp.add(vBody);
    const vDiscMat = new THREE.MeshStandardMaterial({ color: col, transparent: true, opacity: 0.9, emissive: new THREE.Color(col), emissiveIntensity: 0.15 });
    disposables.push(vDiscMat);
    const vDisc = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.03, 16), vDiscMat);
    vDisc.rotation.z = Math.PI / 2; vDisc.position.x = dir * 0.35; grp.add(vDisc);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.14, 0.018), new THREE.MeshStandardMaterial({ color: 0x3a6080, metalness: 0.88, roughness: 0.2 }));
    arm.position.set(dir * 0.35, 0.17, 0); grp.add(arm);
    scene.add(grp);
    return { grp, pipe, vDisc, vDiscMat, pipeMat: pMat };
  }
  const outletA = makeOutletPipe(-1, 0x00ff9d);
  const outletB = makeOutletPipe(1, 0xff3f5a);

  const outWorldY = -(CHAM_H / 2 + coneH * 0.85) + 0.35;
  const tankTopY  = -1.3 + 1.85 / 2;
  const pipeMat2  = new THREE.MeshStandardMaterial({ color: 0x2a4060, metalness: 0.90, roughness: 0.20 });
  disposables.push(pipeMat2);
  [-3.6, 3.6].forEach(tx => {
    const hLen = Math.abs(tx) - 0.52, dir = tx > 0 ? 1 : -1;
    const hPipe = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, hLen, 12), pipeMat2);
    hPipe.rotation.z = Math.PI / 2; hPipe.position.set(dir * (0.52 + hLen / 2), outWorldY, 0); scene.add(hPipe);
    const dropH = Math.abs(outWorldY - tankTopY);
    const vPipe = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, dropH, 12), pipeMat2);
    vPipe.position.set(tx, (outWorldY + tankTopY) / 2, 0); scene.add(vPipe);
  });

  // ══ STORAGE TANKS ═════════════════════════════════════════
  function makeStorageTank(posX, col) {
    const grp = new THREE.Group();
    const T_R = 0.58, T_H = 1.85;
    grp.position.set(posX, -1.3, 0);

    const tankShellMat = new THREE.MeshPhysicalMaterial({ color: 0x90c8e8, transparent: true, opacity: 0.11, roughness: 0, transmission: 0.88, thickness: 0.4, ior: 1.45, side: THREE.DoubleSide, depthWrite: false });
    disposables.push(tankShellMat);
    grp.add(new THREE.Mesh(new THREE.CylinderGeometry(T_R, T_R, T_H, 72, 2, true), tankShellMat));
    grp.add(new THREE.Mesh(new THREE.CylinderGeometry(T_R * 0.97, T_R * 0.97, T_H, 72, 1, true), new THREE.MeshPhysicalMaterial({ color: 0x60a8d8, transparent: true, opacity: 0.03, roughness: 0, side: THREE.BackSide, depthWrite: false })));

    const botDisc = new THREE.Mesh(new THREE.CircleGeometry(T_R, 72), new THREE.MeshStandardMaterial({ color: 0x0d1e30, roughness: 0.85, metalness: 0.15 }));
    botDisc.rotation.x = -Math.PI / 2; botDisc.position.y = -T_H / 2; grp.add(botDisc);

    const fillMat = new THREE.MeshStandardMaterial({ color: col, transparent: true, opacity: 0.40, emissive: new THREE.Color(col), emissiveIntensity: 0.05, depthWrite: false });
    const fillMesh = new THREE.Mesh(new THREE.CylinderGeometry(T_R * 0.93, T_R * 0.93, T_H, 48), fillMat);
    grp.add(fillMesh); disposables.push(fillMat);

    const surfaceMat = new THREE.MeshStandardMaterial({ color: col, transparent: true, opacity: 0.55, emissive: new THREE.Color(col), emissiveIntensity: 0.08, depthWrite: false });
    const surfaceMesh = new THREE.Mesh(new THREE.CircleGeometry(T_R * 0.90, 64), surfaceMat);
    surfaceMesh.rotation.x = -Math.PI / 2; grp.add(surfaceMesh); disposables.push(surfaceMat);

    const glowMat = new THREE.MeshStandardMaterial({ color: col, transparent: true, opacity: 0.025, emissive: new THREE.Color(col), emissiveIntensity: 1.0, side: THREE.BackSide, depthWrite: false });
    grp.add(new THREE.Mesh(new THREE.CylinderGeometry(T_R + 0.035, T_R + 0.035, T_H + 0.07, 72, 1, true), glowMat));
    disposables.push(glowMat);

    [-T_H / 2 + 0.12, -T_H * 0.18, T_H * 0.18, T_H / 2 - 0.12].forEach(y => {
      const ringMat = new THREE.MeshStandardMaterial({ color: col, metalness: 0.92, roughness: 0.18, emissive: new THREE.Color(col), emissiveIntensity: 0.08 });
      disposables.push(ringMat);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(T_R + 0.018, 0.016, 8, 72), ringMat);
      ring.position.y = y; grp.add(ring);
    });

    const tubeFluidMat = new THREE.MeshStandardMaterial({ color: col, transparent: true, opacity: 0.7, emissive: new THREE.Color(col), emissiveIntensity: 0.25, depthWrite: false });
    const tubeFluid = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, T_H * 0.92, 8), tubeFluidMat);
    tubeFluid.position.set(T_R + 0.055, 0, 0); grp.add(tubeFluid); disposables.push(tubeFluidMat);

    scene.add(grp);
    return { grp, fillMesh, fillMat, surfaceMesh, surfaceMat, glowMat, tubeFluid, tubeFluidMat, T_H, T_R };
  }
  const tankA = makeStorageTank(-3.6, 0x00ff9d);
  const tankB = makeStorageTank(3.6, 0xff3f5a);

  // ══ PARTICLE SYSTEMS ══════════════════════════════════════

  // Sludge ──
  const SL = 280;
  const slPos = new Float32Array(SL * 3);
  for (let i = 0; i < SL; i++) { const r = Math.random() * 0.62, a = Math.random() * Math.PI * 2; slPos[i * 3] = Math.cos(a) * r; slPos[i * 3 + 1] = -1.32 + Math.random() * 0.28; slPos[i * 3 + 2] = Math.sin(a) * r; }
  const slGeo = new THREE.BufferGeometry(); slGeo.setAttribute("position", new THREE.BufferAttribute(slPos, 3));
  const slMat = new THREE.PointsMaterial({ color: 0x5c2e0a, size: 0.038, transparent: true, opacity: 0.85, sizeAttenuation: true, depthWrite: false });
  chamberGroup.add(new THREE.Points(slGeo, slMat));
  disposables.push(slGeo, slMat);

  // Oil droplets ──
  const OIL = 80;
  const oilPos = new Float32Array(OIL * 3);
  for (let i = 0; i < OIL; i++) { const r = Math.random() * 0.68, a = Math.random() * Math.PI * 2; oilPos[i * 3] = Math.cos(a) * r; oilPos[i * 3 + 1] = 0.65 + Math.random() * 0.18; oilPos[i * 3 + 2] = Math.sin(a) * r; }
  const oilPGeo = new THREE.BufferGeometry(); oilPGeo.setAttribute("position", new THREE.BufferAttribute(oilPos, 3));
  const oilPMat = new THREE.PointsMaterial({ color: 0xd4a017, size: 0.055, transparent: true, opacity: 0.75, sizeAttenuation: true, depthWrite: false });
  chamberGroup.add(new THREE.Points(oilPGeo, oilPMat));
  disposables.push(oilPGeo, oilPMat);

  // Rising micro-bubbles ──
  const BUB = 55;
  const bubPos = new Float32Array(BUB * 3), bubAge = new Float32Array(BUB), bubLife = new Float32Array(BUB);
  for (let i = 0; i < BUB; i++) { const r = Math.random() * 0.55, a = Math.random() * Math.PI * 2; bubPos[i * 3] = Math.cos(a) * r; bubPos[i * 3 + 1] = -1.3 + Math.random() * 2.4; bubPos[i * 3 + 2] = Math.sin(a) * r; bubAge[i] = Math.random() * 2.5; bubLife[i] = 1.8 + Math.random() * 1.2; }
  const bubGeo = new THREE.BufferGeometry(); bubGeo.setAttribute("position", new THREE.BufferAttribute(bubPos, 3));
  const bubMat = new THREE.PointsMaterial({ color: 0xdcf4ff, size: 0.028, transparent: true, opacity: 0, sizeAttenuation: true, depthWrite: false });
  chamberGroup.add(new THREE.Points(bubGeo, bubMat));
  disposables.push(bubGeo, bubMat);

  // Apartment stream ──
  const STREAM = 120;
  const stPos = new Float32Array(STREAM * 3), stVel = new Float32Array(STREAM * 3);
  const stAge = new Float32Array(STREAM), stLife = new Float32Array(STREAM);
  for (let i = 0; i < STREAM; i++) {
    const spawnFrac = i / STREAM;
    stPos[i * 3] = 2.0 + (Math.random() - 0.5) * 0.06;
    stPos[i * 3 + 1] = 2.5 - spawnFrac * 1.2 + Math.random() * 0.12;
    stPos[i * 3 + 2] = (Math.random() - 0.5) * 0.06;
    stVel[i * 3] = 0; stVel[i * 3 + 1] = -(1.4 + spawnFrac * 1.2); stVel[i * 3 + 2] = 0;
    stLife[i] = 0.9 + Math.random() * 0.5; stAge[i] = Math.random() * stLife[i];
  }
  const stGeo = new THREE.BufferGeometry(); stGeo.setAttribute("position", new THREE.BufferAttribute(stPos, 3));
  const stMat = new THREE.PointsMaterial({ color: 0x7dd3fc, size: 0.038, transparent: true, opacity: 0, sizeAttenuation: true, depthWrite: false });
  const streamParticles = new THREE.Points(stGeo, stMat); scene.add(streamParticles);
  disposables.push(stGeo, stMat);

  // Splash ──
  const SPLASH = 40;
  const splPos = new Float32Array(SPLASH * 3), splVel = new Float32Array(SPLASH * 3);
  const splAge = new Float32Array(SPLASH), splLife = new Float32Array(SPLASH);
  for (let i = 0; i < SPLASH; i++) {
    splPos[i * 3] = 0.88; splPos[i * 3 + 1] = 0.75; splPos[i * 3 + 2] = 0;
    splVel[i * 3] = (Math.random() - 0.5) * 0.6; splVel[i * 3 + 1] = 0.3 + Math.random() * 0.4; splVel[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
    splLife[i] = 0.4 + Math.random() * 0.3; splAge[i] = Math.random() * splLife[i];
  }
  const splGeo = new THREE.BufferGeometry(); splGeo.setAttribute("position", new THREE.BufferAttribute(splPos, 3));
  const splMat = new THREE.PointsMaterial({ color: 0xb0e8ff, size: 0.032, transparent: true, opacity: 0, sizeAttenuation: true, depthWrite: false });
  const splashParticles = new THREE.Points(splGeo, splMat); chamberGroup.add(splashParticles);
  disposables.push(splGeo, splMat);

  // Inlet swirl ──
  const IN = 90;
  const inP = new Float32Array(IN * 3), inV = new Float32Array(IN * 3), inA = new Float32Array(IN), inL = new Float32Array(IN);
  for (let i = 0; i < IN; i++) {
    inP[i * 3] = 0.88; inP[i * 3 + 1] = 0.40; inP[i * 3 + 2] = 0;
    inV[i * 3] = -0.38 - Math.random() * 0.14; inV[i * 3 + 1] = -0.22 - Math.random() * 0.08; inV[i * 3 + 2] = 0.55 + Math.random() * 0.22;
    inL[i] = 0.5 + Math.random() * 0.85; inA[i] = Math.random() * inL[i];
  }
  const inGeo = new THREE.BufferGeometry(); inGeo.setAttribute("position", new THREE.BufferAttribute(inP, 3));
  const inMat = new THREE.PointsMaterial({ color: 0x7dd3fc, size: 0.048, transparent: true, opacity: 0, sizeAttenuation: true, depthWrite: false });
  chamberGroup.add(new THREE.Points(inGeo, inMat));
  disposables.push(inGeo, inMat);

  // Routing particles ──
  function makeRouteParticles(col) {
    const N = 120;
    const pos = new Float32Array(N * 3), age = new Float32Array(N), life = new Float32Array(N);
    const phase = new Float32Array(N), vel_y = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 0.08;
      pos[i * 3 + 1] = outWorldY + (Math.random() - 0.5) * 0.04;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 0.04;
      life[i] = 0.7 + Math.random() * 0.4; age[i] = Math.random() * life[i]; phase[i] = 0;
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({ color: col, size: 0.045, transparent: true, opacity: 0, sizeAttenuation: true, depthWrite: false });
    const pts = new THREE.Points(geo, mat); scene.add(pts);
    disposables.push(geo, mat);
    return { pts, geo, mat, age, life, phase, vel_y, N };
  }
  const routeA = makeRouteParticles(0x00ff9d);
  const routeB = makeRouteParticles(0xff3f5a);

  // Swirl arrows ──
  const arrowGroup = new THREE.Group();
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    const arrowMat = new THREE.MeshStandardMaterial({ color: 0x00d4ff, emissive: 0x00d4ff, emissiveIntensity: 0.4, transparent: true, opacity: 0 });
    disposables.push(arrowMat);
    const arrow = new THREE.Mesh(new THREE.TorusGeometry(CHAM_R * 0.88, 0.012, 4, 12, Math.PI * 0.35), arrowMat);
    arrow.rotation.x = Math.PI / 2; arrow.rotation.z = ang; arrow.position.y = 0.3 + Math.sin(i) * 0.15;
    arrowGroup.add(arrow);
  }
  chamberGroup.add(arrowGroup);

  // Drift ring ──
  const driftRingMat = new THREE.MeshStandardMaterial({ color: 0x00ff9d, transparent: true, opacity: 0, emissive: 0x00ff9d, emissiveIntensity: 0.6, side: THREE.DoubleSide, depthWrite: false });
  disposables.push(driftRingMat);
  const driftRingMesh = new THREE.Mesh(new THREE.RingGeometry(CHAM_R * 0.88, CHAM_R + 0.08, 80), driftRingMat);
  driftRingMesh.rotation.x = -Math.PI / 2; driftRingMesh.position.y = 0.12; chamberGroup.add(driftRingMesh);

  // ── Raycaster ──────────────────────────────────────────────
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  function onCanvasClick(e) {
    const rect = canvas.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects(sensorBulbs);
    if (hits.length) getState().__callbacks?.onSensorClick(hits[0].object.userData.id);
  }
  canvas.addEventListener("click", onCanvasClick);

  // ── Per-frame helpers (hoisted outside animate to avoid per-frame reallocation) ──
  function animateRoute(route, valve, destX, s, dt) {
    const arr = route.geo.attributes.position.array;
    route.mat.opacity = valve * 0.95;
    if (valve < 0.05) return;
    const dir = destX < 0 ? -1 : 1;
    const tankLevel = destX < 0 ? s.tankALevel : s.tankBLevel;
    const tankBotY = -2.225, tankSurfY = tankBotY + tankLevel * 1.85;
    for (let i = 0; i < route.N; i++) {
      route.age[i] += dt;
      const p = Math.min(route.age[i] / route.life[i], 1.0);
      if (p >= 1) {
        arr[i * 3] = (Math.random() - 0.5) * 0.05;
        arr[i * 3 + 1] = outWorldY + (Math.random() - 0.5) * 0.03;
        arr[i * 3 + 2] = (Math.random() - 0.5) * 0.04;
        route.phase[i] = 0; route.vel_y[i] = 0;
        route.age[i] = 0; route.life[i] = 0.55 + Math.random() * 0.35;
      } else {
        if (route.phase[i] === 0) {
          const speed = dir * (2.5 + 3.5 * p);
          arr[i * 3] += speed * dt;
          arr[i * 3 + 1] += (Math.random() - 0.5) * 0.003;
          arr[i * 3 + 2] += (Math.random() - 0.5) * 0.007;
          if (Math.abs(arr[i * 3 + 2]) > 0.042) arr[i * 3 + 2] *= 0.82;
          if (Math.abs(arr[i * 3]) >= Math.abs(destX) - 0.55) {
            route.phase[i] = 1; route.vel_y[i] = -(0.2 + Math.random() * 0.3);
          }
        } else {
          route.vel_y[i] -= dt * 4.2;
          if (route.vel_y[i] < -2.2) route.vel_y[i] = -2.2;
          arr[i * 3] = Math.max(destX - 0.52, Math.min(destX + 0.52, arr[i * 3] + (Math.random() - 0.5) * 0.15 * dt));
          arr[i * 3 + 1] += route.vel_y[i] * dt;
          arr[i * 3 + 2] += (Math.random() - 0.5) * 0.10 * dt;
          if (arr[i * 3 + 1] <= Math.max(tankSurfY, tankBotY + 0.02)) route.age[i] = route.life[i];
        }
      }
    }
    route.geo.attributes.position.needsUpdate = true;
  }

  function animateTank(tank, lvl, active, t) {
    const h = Math.max(0.01, lvl * tank.T_H);
    tank.fillMesh.scale.y = h / tank.T_H; tank.fillMesh.position.y = -tank.T_H / 2 + h / 2;
    tank.surfaceMesh.position.y = -tank.T_H / 2 + h;
    tank.tubeFluid.scale.y = Math.max(0.01, lvl); tank.tubeFluid.position.y = -tank.T_H / 2 + lvl * tank.T_H / 2;
    if (active) {
      tank.fillMat.emissiveIntensity = 0.12 + 0.07 * Math.sin(t * 4.5);
      tank.glowMat.opacity = 0.04 + 0.025 * Math.sin(t * 5.5);
      tank.surfaceMat.opacity = 0.62 + 0.06 * Math.sin(t * 3.2 + 0.5);
    } else {
      tank.fillMat.emissiveIntensity = 0.04;
      tank.glowMat.opacity = 0.018;
      tank.surfaceMat.opacity = 0.50;
    }
  }

  // ══ ANIMATION LOOP ════════════════════════════════════════
  // FIX: Use a single clock reference; compute dt from lastTime to avoid
  //      the double-advance bug (getElapsedTime + getDelta both advance internal state).
  let raf, lastTime = 0;
  const clock = new THREE.Clock();

  function animate(nowMs) {
    raf = requestAnimationFrame(animate);
    const t  = clock.getElapsedTime();              // monotonic elapsed
    const dt = Math.min((nowMs - lastTime) / 1000, 0.05); // real delta from rAF timestamp
    lastTime = nowMs;

    const s = getState();
    updateCam();

    waterUniforms.uTime.value  = t; waterUniforms.uSwirl.value   = s.swirl;
    waterUniforms.uContam.value = s.contamination; waterUniforms.uFill.value = s.chamberLevel;
    oilUniforms.uTime.value    = t; oilUniforms.uSwirl.value     = s.swirl;

    // Water body
    waterMesh.visible = s.chamberLevel > 0.02;
    if (waterMesh.visible) {
      const h = s.chamberLevel * (CHAM_H * 0.90);
      waterMesh.scale.y = Math.max(0.01, h / (CHAM_H * 0.95));
      waterMesh.position.y = -(CHAM_H * 0.95 / 2) + h / 2 - 0.1;
    }
    const surfY = waterMesh.visible ? (-(CHAM_H * 0.95 / 2) + s.chamberLevel * (CHAM_H * 0.90) - 0.06) : -99;
    oilMesh.visible = s.showOil && s.chamberLevel > 0.25;
    oilMesh.position.y = surfY;
    sludgeDiscMat.opacity = s.showSludge ? (0.55 + s.contamination * 0.3) : 0;

    // Laminar zone
    const sensing = s.phase === "SEPARATING" || s.phase === "CLASSIFYING";
    laminMat.opacity = sensing ? 0.07 + 0.05 * Math.abs(Math.sin(t * 3.8)) : 0.03;
    laminMat.emissiveIntensity = sensing ? 0.35 + 0.25 * Math.abs(Math.sin(t * 4.2)) : 0.08;
    laminCylMat.opacity = sensing ? 0.04 + 0.03 * Math.abs(Math.sin(t * 3)) : 0.015;

    // Sludge particles
    {
      const arr = slGeo.attributes.position.array;
      const sw = s.swirl > 0.08 && (s.phase === "SWIRLING" || s.phase === "SEPARATING");
      for (let i = 0; i < SL; i++) {
        const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
        if (sw) {
          const ang = Math.atan2(z, x), rad = Math.sqrt(x * x + z * z);
          const na = ang + s.swirl * 2.2 * (1 - rad * 0.9) * dt, nr = Math.min(rad, 0.70);
          arr[i * 3] = Math.cos(na) * nr; arr[i * 3 + 2] = Math.sin(na) * nr;
          arr[i * 3 + 1] = Math.max(-1.38, y - dt * 0.03 * s.swirl);
        } else {
          arr[i * 3]     += (Math.random() - 0.5) * 0.0015;
          arr[i * 3 + 2] += (Math.random() - 0.5) * 0.0015;
          arr[i * 3 + 1]  = Math.max(-1.42, Math.min(-0.72, y + (Math.random() - 0.51) * 0.004));
          const d = Math.sqrt(arr[i * 3] ** 2 + arr[i * 3 + 2] ** 2);
          if (d > 0.70) { arr[i * 3] *= 0.70 / d; arr[i * 3 + 2] *= 0.70 / d; }
        }
      }
      slGeo.attributes.position.needsUpdate = true;
      slMat.opacity = s.showSludge ? 0.88 : 0;
    }

    // Oil particles
    {
      const arr = oilPGeo.attributes.position.array;
      for (let i = 0; i < OIL; i++) {
        const ang = Math.atan2(arr[i * 3 + 2], arr[i * 3]), rad = Math.sqrt(arr[i * 3] ** 2 + arr[i * 3 + 2] ** 2);
        if (s.swirl > 0.05) {
          const na = ang + s.swirl * 0.78 * (1 - rad * 0.45) * dt;
          arr[i * 3] = Math.cos(na) * rad; arr[i * 3 + 2] = Math.sin(na) * rad;
          arr[i * 3 + 1] = Math.min(surfY + 0.055, arr[i * 3 + 1] + 0.0012);
        } else {
          arr[i * 3 + 1] += Math.sin(t * 0.85 + i * 1.3) * 0.0003;
        }
      }
      oilPGeo.attributes.position.needsUpdate = true;
      oilPMat.opacity = s.showOil ? 0.72 : 0;
    }

    // Micro-bubbles
    {
      const arr = bubGeo.attributes.position.array;
      const active = s.chamberLevel > 0.15;
      bubMat.opacity = active ? 0.55 : 0;
      if (active) {
        for (let i = 0; i < BUB; i++) {
          bubAge[i] += dt;
          if (bubAge[i] > bubLife[i]) {
            const r = Math.random() * 0.58, a = Math.random() * Math.PI * 2;
            arr[i * 3] = Math.cos(a) * r; arr[i * 3 + 1] = -1.2 + Math.random() * 0.3; arr[i * 3 + 2] = Math.sin(a) * r;
            bubAge[i] = 0;
          } else {
            arr[i * 3 + 1] += dt * (0.12 + Math.random() * 0.06);
            arr[i * 3]     += Math.sin(t * 2 + i) * 0.0008;
            if (arr[i * 3 + 1] > surfY + 0.05) { arr[i * 3 + 1] = surfY + 0.05; bubAge[i] = bubLife[i]; }
          }
        }
        bubGeo.attributes.position.needsUpdate = true;
      }
    }

    // Apartment stream
    {
      const arr = stGeo.attributes.position.array;
      const isActive = s.phase === "FILLING" || s.phase === "SWIRLING";
      stMat.opacity = isActive ? 0.90 : 0;
      if (isActive) {
        for (let i = 0; i < STREAM; i++) {
          stAge[i] += dt;
          if (stAge[i] > stLife[i]) {
            const spawnFrac = i / STREAM;
            arr[i * 3] = 2.0 + (Math.random() - 0.5) * 0.052;
            arr[i * 3 + 1] = 2.5 - spawnFrac * 1.2 + Math.random() * 0.12;
            arr[i * 3 + 2] = (Math.random() - 0.5) * 0.052;
            stVel[i * 3] = 0; stVel[i * 3 + 1] = -(1.4 + spawnFrac * 1.2); stVel[i * 3 + 2] = 0;
            stLife[i] = 0.9 + Math.random() * 0.5; stAge[i] = 0;
          } else {
            stVel[i * 3 + 1] -= dt * 6.8;
            stVel[i * 3]     += (Math.random() - 0.5) * 0.05;
            stVel[i * 3 + 2] += (Math.random() - 0.5) * 0.05;
            arr[i * 3]   += stVel[i * 3]   * dt;
            arr[i * 3 + 1] += stVel[i * 3 + 1] * dt;
            arr[i * 3 + 2] += stVel[i * 3 + 2] * dt;
            if (arr[i * 3 + 1] > 0.82) {
              const dx = arr[i * 3] - 2.0, dz = arr[i * 3 + 2];
              const r = Math.sqrt(dx * dx + dz * dz);
              if (r > 0.062) { arr[i * 3] = 2.0 + dx * (0.062 / r); arr[i * 3 + 2] = dz * (0.062 / r); }
            }
            if (arr[i * 3 + 1] < 0.84 && arr[i * 3] > 1.65 && stVel[i * 3] > -0.5) {
              const exitSpeed = Math.max(1.8, Math.abs(stVel[i * 3 + 1]));
              stVel[i * 3] = -exitSpeed * (0.88 + Math.random() * 0.15);
              stVel[i * 3 + 1] = -0.05 + (Math.random() - 0.5) * 0.08;
              stVel[i * 3 + 2] = (Math.random() - 0.5) * 0.12;
            }
            if (arr[i * 3] < 0.8 && arr[i * 3 + 1] < 0.95) stAge[i] = stLife[i];
          }
        }
        stGeo.attributes.position.needsUpdate = true;
      }
    }

    // Splash at inlet
    {
      const arr = splGeo.attributes.position.array;
      const isActive = s.phase === "FILLING";
      splMat.opacity = isActive ? 0.65 : 0;
      if (isActive) {
        for (let i = 0; i < SPLASH; i++) {
          splAge[i] += dt;
          if (splAge[i] > splLife[i]) {
            arr[i * 3] = 0.68 + (Math.random() - 0.5) * 0.08;
            arr[i * 3 + 1] = 0.40 + (Math.random() - 0.5) * 0.06;
            arr[i * 3 + 2] = (Math.random() - 0.5) * 0.08;
            splVel[i * 3] = (Math.random() - 0.5) * 0.7;
            splVel[i * 3 + 1] = 0.25 + Math.random() * 0.45;
            splVel[i * 3 + 2] = (Math.random() - 0.5) * 0.6;
            splAge[i] = 0;
          } else {
            splVel[i * 3 + 1] -= dt * 3.5;
            arr[i * 3]   += splVel[i * 3]   * dt;
            arr[i * 3 + 1] += splVel[i * 3 + 1] * dt;
            arr[i * 3 + 2] += splVel[i * 3 + 2] * dt;
          }
        }
        splGeo.attributes.position.needsUpdate = true;
      }
    }

    // Inlet swirl particles
    {
      const arr = inGeo.attributes.position.array;
      const isActive = s.phase === "FILLING" || s.phase === "SWIRLING";
      inMat.opacity = isActive ? 0.92 : 0;
      if (isActive) {
        for (let i = 0; i < IN; i++) {
          inA[i] += dt;
          if (inA[i] > inL[i]) {
            arr[i * 3] = 0.88 + (Math.random() - 0.5) * 0.05;
            arr[i * 3 + 1] = 0.40 + (Math.random() - 0.5) * 0.05;
            arr[i * 3 + 2] = 0;
            inV[i * 3] = -0.38 - Math.random() * 0.15; inV[i * 3 + 1] = -0.22 - Math.random() * 0.07; inV[i * 3 + 2] = 0.55 + Math.random() * 0.2;
            inA[i] = 0;
          } else {
            arr[i * 3]   += inV[i * 3]   * dt;
            arr[i * 3 + 1] += inV[i * 3 + 1] * dt;
            arr[i * 3 + 2] += inV[i * 3 + 2] * dt;
            const d = Math.sqrt(arr[i * 3] ** 2 + arr[i * 3 + 2] ** 2);
            if (d > 0.72) { arr[i * 3] *= 0.72 / d; arr[i * 3 + 2] *= 0.72 / d; inV[i * 3] *= -0.3; inV[i * 3 + 2] *= -0.3; }
          }
        }
        inGeo.attributes.position.needsUpdate = true;
      }
    }

    animateRoute(routeA, s.valveA, -3.6, s, dt);
    animateRoute(routeB, s.valveB,  3.6, s, dt);

    // Valve discs
    const rotA = (1 - s.valveA) * Math.PI / 2, rotB = (1 - s.valveB) * Math.PI / 2;
    outletA.vDisc.rotation.y += (rotA - outletA.vDisc.rotation.y) * 0.08;
    outletB.vDisc.rotation.y += (rotB - outletB.vDisc.rotation.y) * 0.08;
    outletA.pipeMat.emissiveIntensity = s.valveA > 0.5 ? 0.28 + 0.15 * Math.sin(t * 5.5) : 0;
    outletB.pipeMat.emissiveIntensity = s.valveB > 0.5 ? 0.28 + 0.15 * Math.sin(t * 5.5) : 0;
    inletPipeMat.emissiveIntensity = (s.phase === "FILLING" || s.phase === "SWIRLING") ? 0.42 + 0.22 * Math.sin(t * 7) : 0;

    // Swirl arrows
    arrowGroup.children.forEach((arrow, i) => {
      const sw = s.swirl > 0.08;
      arrow.material.opacity = sw ? 0.35 + 0.2 * Math.abs(Math.sin(t * 4 + i)) : 0;
      if (sw) arrow.rotation.z += s.swirl * 0.018 * dt * 60;
    });

    animateTank(tankA, s.tankALevel, s.valveA > 0.5, t);
    animateTank(tankB, s.tankBLevel, s.valveB > 0.5, t);

    // Sensor bulbs
    sensorBulbs.forEach((b, i) => {
      const isSensing = s.phase === "SEPARATING" || s.phase === "CLASSIFYING";
      const isDrift   = s.showDrift && s.driftState !== "normal";
      b.material.emissiveIntensity = (b.userData.id === s.selectedSensor || isDrift)
        ? 1.4 + 0.4 * Math.abs(Math.sin(t * 8 + i))
        : isSensing ? 0.8 + 0.45 * Math.abs(Math.sin(t * 5.2 + i)) : 0.3;
    });

    // Classification glow — FIX: reuse _tmpColor instead of new THREE.Color() each frame
    if (s.bracket && (s.phase === "CLASSIFYING" || s.phase === "ROUTING")) {
      const m = BRACKET_META[s.bracket];
      _tmpColor.set(m.color);
      glowShellMat.color.copy(_tmpColor);
      glowShellMat.emissive.copy(_tmpColor);
      glowShellMat.opacity = 0.08 + 0.055 * Math.abs(Math.sin(t * 6.5));
    } else {
      glowShellMat.opacity = 0;
    }

    // Window flicker
    windowMats.forEach((w, i) => { w.emissiveIntensity = 0.05 + ((Math.sin(t * 0.28 + i * 2.1) + 1) / 2) * 0.16; });

    // Drift ring
    if (s.showDrift) {
      const dc = { normal: 0x00ff9d, degraded: 0xffdb58, flatline: 0xff3f5a, recalibrating: 0x00d4ff }[s.driftState] || 0x00ff9d;
      _tmpColor.setHex(dc);
      driftRingMat.color.copy(_tmpColor);
      driftRingMat.emissive.copy(_tmpColor);
      driftRingMat.opacity = s.driftState === "flatline" ? 0.2 + 0.16 * Math.abs(Math.sin(t * 10)) : s.driftState === "recalibrating" ? 0.12 + 0.08 * Math.sin(t * 3.5) : 0.08;
      driftRingMesh.rotation.z = s.driftState === "recalibrating" ? t * 1.8 : 0;
    } else {
      driftRingMat.opacity = 0;
    }

    renderer.render(scene, camera);
  }

  requestAnimationFrame(ts => { lastTime = ts; animate(ts); });

  function onResize() {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
  }
  window.addEventListener("resize", onResize);

  // Cleanup — dispose all tracked resources
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", onResize);
    canvas.removeEventListener("click", onCanvasClick);
    Object.entries(handlers).forEach(([k, v]) => canvas.removeEventListener(k, v));
    Object.entries(touchHandlers).forEach(([k, v]) => canvas.removeEventListener(k, v));
    disposables.forEach(d => { try { d.dispose(); } catch (_) {} });
    renderer.dispose();
  };
}

// ─── SPARKLINE ────────────────────────────────────────────────
function Sparkline({ data, color, w = 88, h = 20 }) {
  const ref    = useRef(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    const d = dataRef.current;
    if (d.length < 2) return;
    const mn = Math.min(...d) * 0.92, mx = Math.max(...d) * 1.08 + 0.0001;
    ctx.beginPath();
    d.forEach((v, i) => {
      const x = (i / (d.length - 1)) * w, y = h - (((v - mn) / (mx - mn)) * h * 0.82 + h * 0.09);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, color + "44"); g.addColorStop(1, color + "cc");
    ctx.strokeStyle = g; ctx.lineWidth = 1.5; ctx.lineJoin = "round"; ctx.stroke();
    const lv = d[d.length - 1], lx = w;
    const ly = h - (((lv - mn) / (mx - mn)) * h * 0.82 + h * 0.09);
    ctx.beginPath(); ctx.arc(lx - 1, ly, 2.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, color, w, h]); // data identity changes on each update — this is intentional

  return <canvas ref={ref} width={w} height={h} style={{ display: "block" }} />;
}

// ─── MAIN COMPONENT ───────────────────────────────────────────
export default function GreywaterViz() {
  const canvasRef  = useRef(null);
  const stateRef   = useRef({});

  // ── Responsive: detect mobile ───────────────────────────────
  const [isMobile, setIsMobile] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const [phase,          setPhase]       = useState("IDLE");
  const [bracket,        setBracket]     = useState(null);
  const [chamberLevel,   setChamberLvl]  = useState(0);
  const [swirl,          setSwirl]       = useState(0);
  const [valveA,         setValveA]      = useState(0);
  const [valveB,         setValveB]      = useState(0);
  const [tankALevel,     setTankALvl]    = useState(0.11);
  const [tankBLevel,     setTankBLvl]    = useState(0.06);
  const [contamination,  setContam]      = useState(0.22);
  const [swirlSpeed,     setSwirlSpeed]  = useState(1.0);
  const [selectedSensor, setSelSensor]   = useState(null);
  const [showOil,        setShowOil]     = useState(true);
  const [showSludge,     setShowSludge]  = useState(true);
  const [showDrift,      setShowDrift]   = useState(false);
  const [driftState,     setDriftState]  = useState("normal");
  const [showAnalytics,  setShowAnalytics] = useState(false);
  const [running,        setRunning]     = useState(false);
  const [popup,          setPopup]       = useState(null);
  const [lastResult,     setLastResult]  = useState(null);
  const [log,            setLog]         = useState([]);
  const [readings,       setReadings]    = useState({ ph: 7.2, turbidity: 1.8, tds: 180, orp: 320, nh3: 0.4 });
  const [reusePct,       setReusePct]    = useState(68);
  const [cycleCount,     setCycleCount]  = useState(0);
  const [efficiency,     setEfficiency]  = useState(94);
  const [sparkPH,        setSparkPH]     = useState(() => Array(30).fill(7.2));
  const [sparkTDS,       setSparkTDS]    = useState(() => Array(30).fill(180));
  const [sparkTurb,      setSparkTurb]   = useState(() => Array(30).fill(1.8));
  const [sparkORP,       setSparkORP]    = useState(() => Array(30).fill(320));
  const [activeTab,      setActiveTab]   = useState("controls"); // "controls" | "matrix" | "structure" | "log"

  // v6 — WATER·IQ specific
  const [waterType,      setWaterType]   = useState("LIGHT");
  const [ecTimer,        setEcTimer]     = useState(0);       // seconds elapsed in EC phase
  const [ecStageIdx,     setEcStageIdx]  = useState(0);
  const [polarityCount,  setPolarityCount] = useState(0);
  const [gateOpen,       setGateOpen]    = useState(false);
  const [lamellaEff,     setLamellaEff]  = useState(94);
  const [ecActive,       setEcActive]    = useState(false);
  const [saltAlert,      setSaltAlert]   = useState(false);
  const [activeStage,    setActiveStage] = useState(null);   // highlighted structure stage

  const addLog = useCallback((msg, col = "#00ff9d") => {
    setLog(p => [{ msg, col, id: Date.now() + Math.random() }, ...p].slice(0, 12));
  }, []);

  // Sync stateRef every render (no dep array — intentional)
  useEffect(() => {
    stateRef.current = {
      phase, bracket, chamberLevel, swirl: swirl * swirlSpeed,
      valveA, valveB, tankALevel, tankBLevel, contamination,
      selectedSensor, showOil, showSludge, showDrift, driftState,
      gateOpen, ecActive,
      __callbacks: { onSensorClick: (id) => setSelSensor(p => p === id ? null : id) },
    };
  });

  // Mount scene once; also clear any pending cycle timers on unmount
  useEffect(() => {
    const canvas = canvasRef.current;
    const cleanupScene = buildScene(canvas, () => stateRef.current);
    return () => {
      cleanupScene();
      cycleTimers.current.forEach(id => clearTimeout(id));
      cycleTimers.current = [];
    };
  }, []);

  // Live sensor noise when idle
  useEffect(() => {
    if (running) return;
    const iv = setInterval(() => {
      setReadings(r => ({
        ph:        +Math.max(4,   Math.min(10,   r.ph        + (Math.random() - 0.5) * 0.04)).toFixed(2),
        turbidity: +Math.max(0,   Math.min(20,   r.turbidity + (Math.random() - 0.5) * 0.08)).toFixed(2),
        tds:       +Math.max(50,  Math.min(1200, r.tds       + (Math.random() - 0.5) * 4   )).toFixed(0),
        orp:       +Math.max(0,   Math.min(600,  r.orp       + (Math.random() - 0.5) * 3   )).toFixed(0),
        nh3:       +Math.max(0,   Math.min(5,    r.nh3       + (Math.random() - 0.5) * 0.02)).toFixed(2),
      }));
      setSparkPH  (p => [...p.slice(1), +(p[p.length-1] + (Math.random()-0.5)*0.05).toFixed(2)]);
      setSparkTDS (p => [...p.slice(1), +(p[p.length-1] + (Math.random()-0.5)*5   ).toFixed(0)]);
      setSparkTurb(p => [...p.slice(1), +(p[p.length-1] + (Math.random()-0.5)*0.08).toFixed(2)]);
      setSparkORP (p => [...p.slice(1), +(p[p.length-1] + (Math.random()-0.5)*4   ).toFixed(0)]);
    }, 700);
    return () => clearInterval(iv);
  }, [running]);

  // Ref to track all pending timeouts so they can be cancelled if component unmounts mid-cycle
  const cycleTimers = useRef([]);

  const triggerCycle = useCallback(() => {
    if (running) return;
    setRunning(true); setPopup(null); setBracket(null);
    setValveA(0); setValveB(0); setChamberLvl(0); setSwirl(0);
    setEcTimer(0); setEcStageIdx(0); setPolarityCount(0); setGateOpen(false); setEcActive(false);

    const wt  = WATER_TYPES[waterType];
    const baseContam = wt.contam;

    // salt alert for light greywater
    if (wt.saltNeeded) {
      setSaltAlert(true);
      setTimeout(() => setSaltAlert(false), 4000);
    }

    const ph   = +(6.5  + Math.random() * 2   - baseContam * 1.8).toFixed(2);
    const turb = +(baseContam * 14 + Math.random() * 2).toFixed(2);
    const tds  = +(150  + baseContam * 900  + Math.random() * 60 ).toFixed(0);
    const orp  = +(400  - baseContam * 220  + Math.random() * 40 ).toFixed(0);
    const nh3  = +(baseContam * 3.5 + Math.random() * 0.3).toFixed(2);
    const cl   = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const rd   = { ph: cl(ph,4,10), turbidity: cl(turb,0,22), tds: cl(tds,80,1300), orp: cl(orp,0,600), nh3: cl(nh3,0,6) };
    const br   = classifyBracket(rd.ph, rd.turbidity, rd.tds);
    const toA  = ["F1","F2"].includes(br);

    setContam(baseContam);
    setReadings(rd);
    setSparkPH  (p => [...p.slice(1), rd.ph]);
    setSparkTDS (p => [...p.slice(1), rd.tds]);
    setSparkTurb(p => [...p.slice(1), rd.turbidity]);
    setSparkORP (p => [...p.slice(1), rd.orp]);

    addLog(`▶ Cycle initiated — ${wt.label} (${wt.desc})`, "#00d4ff");

    const T = (ms, fn) => { const id = setTimeout(fn, ms); cycleTimers.current.push(id); return id; };

    // Phase 1: FILLING — propeller zone active
    T(80,   () => { setPhase("FILLING"); setActiveStage("PROPELLER"); });
    for (let i = 1; i <= 14; i++) T(i * 90, () => setChamberLvl(i / 14 * 0.84));
    T(1350, () => { setPhase("SWIRLING"); setSwirl(0.92); setActiveStage("EC"); addLog("↺ Propeller zone active — flow distributed to EC discs", "#00d4ff"); });

    // Phase 2: EC CHAMBER — timed gate countdown, polarity reversals
    T(1400, () => { setEcActive(true); addLog("⚡ EC discs energised — 12V DC · Al³⁺ ions releasing", "#ffdb58"); });

    // EC stage progression
    EC_STAGES.forEach((stage, i) => {
      T(1400 + stage.t * 4, () => {
        setEcStageIdx(i);
        setEcTimer(stage.t);
        if (stage.label.includes("POLARITY")) {
          setPolarityCount(p => p + 1);
          addLog(`↻ Polarity reversal #${i <= 3 ? 1 : 2} — passivation prevented`, "#ffdb58");
        }
      });
    });

    // Running EC timer
    for (let s = 0; s <= 900; s += 30) {
      T(1400 + s * 4, () => setEcTimer(s));
    }

    T(3100, () => { setPhase("SEPARATING"); setSwirl(0.48); setActiveStage("LAMELLA"); addLog("⬇ Gate opening — flow entering lamella section", "#c084fc"); setGateOpen(true); });
    T(4000, () => { setLamellaEff(+(88 + Math.random() * 10).toFixed(1)); addLog("⋁ Lamella V-settler active — particles sliding to centre gap", "#7fffd4"); });
    T(5200, () => {
      setPhase("CLASSIFYING"); setBracket(br); setActiveStage("SENSOR");
      setLastResult({ br, rd, toA });
      addLog(`◈ ESP32 TFLite analysis — ${BRACKET_META[br].label}`, BRACKET_META[br].hex);
    });
    T(7400, () => {
      setPopup(null); setPhase("ROUTING"); setActiveStage("COLLECT");
      setEcActive(false);
      if (toA) { setValveA(1); setValveB(0); addLog("▸ Valve A → Tank A (Reusable)", "#00ff9d"); }
      else      { setValveA(0); setValveB(1); addLog("▸ Valve B → Tank B (Treatment)", "#ff3f5a"); }
    });
    T(9000, () => {
      setPhase("DRAINING"); setSwirl(0); setChamberLvl(0.07); setGateOpen(false); setActiveStage(null);
      if (toA) setTankALvl(p => Math.min(0.97, p + 0.16 + Math.random() * 0.09));
      else     setTankBLvl(p => Math.min(0.97, p + 0.16 + Math.random() * 0.09));
      addLog("○ Collection zone draining — sludge first, clean water above", "#64748b");
    });
    T(11000, () => {
      setPhase("COMPLETE"); setValveA(0); setValveB(0);
      setCycleCount(p => p + 1);
      if (toA) setReusePct(p => Math.min(100, p + Math.round(Math.random() * 4 + 2)));
      setEfficiency(+(88 + Math.random() * 10).toFixed(1));
      addLog("✓ Cycle complete — chamber ready for next batch", "#00ff9d");
      T(1500, () => { setPhase("IDLE"); setRunning(false); setEcTimer(0); setEcStageIdx(0); setPolarityCount(0); });
    });
  }, [running, waterType, addLog]);

  const triggerDrift = useCallback(() => {
    if (running) return;
    setShowDrift(true);
    setDriftState("degraded"); addLog("⚠ Sensor drift — ±2σ deviation detected", "#ffdb58");
    setTimeout(() => { setDriftState("flatline");       addLog("⛔ FLATLINE — pH probe offline",              "#ff3f5a"); }, 2500);
    setTimeout(() => { setDriftState("recalibrating");  addLog("↻ Auto-recalibration initiated",              "#00d4ff"); }, 5200);
    setTimeout(() => { setDriftState("normal");         addLog("✓ Sensors nominal — 98.7% confidence",        "#00ff9d"); }, 8800);
  }, [addLog, running]);

  const resetTanks = useCallback(() => {
    if (running) return;
    setTankALvl(0); setTankBLvl(0);
    addLog("↺ Tanks reset to empty", "#64748b");
  }, [running, addLog]);

  const phC    = PHASE_COLORS[phase] || "#4a6580";
  const brMeta = bracket ? BRACKET_META[bracket] : null;

  const sensorRows = useMemo(() => [
    { id: "PH",   label: "pH",         val: readings.ph.toFixed(2),         unit: "",       col: "#00ff9d", safe: [6.5,8.5], pct: (readings.ph - 4) / 6 * 100 },
    { id: "TDS",  label: "TDS",        val: readings.tds,                   unit: " mg/L",  col: "#ff8c42", safe: [0,500],   pct: Math.min(readings.tds / 1000, 1) * 100 },
    { id: "TURB", label: "Turbidity",  val: readings.turbidity.toFixed(2),  unit: " NTU",   col: "#00d4ff", safe: [0,8],     pct: Math.min(readings.turbidity / 20, 1) * 100 },
    { id: "ORP",  label: "ORP",        val: readings.orp,                   unit: " mV",    col: "#c084fc", safe: [100,500], pct: Math.min(readings.orp / 600, 1) * 100 },
    { id: "NH3",  label: "NH₃",        val: readings.nh3.toFixed(2),        unit: " mg/L",  col: "#ff6b8a", safe: [0,1],     pct: Math.min(readings.nh3 / 5, 1) * 100 },
  ], [readings]);

  return (
    <div style={S.root}>
      <style>{CSS}</style>

      {/* ── HEADER ─────────────────────────────────────────── */}
      <header style={{ ...S.header, height: isMobile ? 48 : 52 }}>
        <div style={S.logoRow}>
          <div style={S.logoPulse} />
          <span style={{ ...S.logoText, fontSize: isMobile ? 15 : 17 }}>Water<span style={{ color: "#00d4ff" }}>IQ</span></span>
          {!isMobile && <><div style={S.logoDivider} /><span style={S.logoSub}>EC · Lamella · Edge AI  v6.0</span></>}
        </div>

        {/* On mobile: just phase pill in center */}
        <div style={{ ...S.headerCenter, justifyContent: isMobile ? "flex-start" : "center" }}>
          <div style={{ ...S.pill, borderColor: phC + "55", background: phC + "12", color: phC, fontSize: isMobile ? 9 : 9 }}>
            <div className="pulse-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: phC, boxShadow: `0 0 6px ${phC}`, flexShrink: 0 }} />
            <span style={{ fontWeight: 700 }}>{phase}</span>
            {!isMobile && <span style={{ opacity: 0.55, fontSize: 8 }}> — {PHASE_DESCRIPTIONS[phase]}</span>}
          </div>
          {!isMobile && brMeta && (
            <div style={{ ...S.pill, borderColor: brMeta.hex + "77", background: brMeta.hex + "18", color: brMeta.hex }}>
              {brMeta.emoji} &nbsp;{bracket} · {brMeta.label}
            </div>
          )}
          {!isMobile && (
            <div style={{ ...S.pill, borderColor: WATER_TYPES[waterType].color + "55", background: WATER_TYPES[waterType].color + "0e", color: WATER_TYPES[waterType].color, fontSize: 9 }}>
              💧 {WATER_TYPES[waterType].label}
            </div>
          )}
          {!isMobile && ecActive && (
            <div style={{ ...S.pill, borderColor: "#ffdb5866", background: "#ffdb580e", color: "#ffdb58", fontSize: 9 }}>
              ⚡ EC {Math.floor(ecTimer/60)}:{String(ecTimer%60).padStart(2,"0")} · {gateOpen ? "GATE OPEN" : "GATE CLOSED"}
            </div>
          )}
        </div>

        {/* Header right: stats on desktop, run button on mobile */}
        {isMobile ? (
          <button
            className={running ? "btn-running" : "btn-primary"}
            onClick={triggerCycle}
            disabled={running}
            style={{ width: "auto", padding: "8px 14px", fontSize: 10, borderRadius: 7, flexShrink: 0 }}
          >
            {running ? <><span className="spin-icon">⟳</span></> : <>▶ Run</>}
          </button>
        ) : (
          <div style={S.headerStats}>
            {[["CYCLES", cycleCount, "#c8e8f8"], ["REUSE", reusePct + "%", "#00ff9d"], ["EFF.", efficiency + "%", "#00d4ff"], ["LAMELLA", lamellaEff + "%", "#7fffd4"]].map(([k, v, c]) => (
              <div key={k} style={S.hStat}>
                <span style={{ fontSize: 7, color: "#2a5070", letterSpacing: "0.12em" }}>{k}</span>
                <span style={{ fontFamily: "'Orbitron',monospace", fontSize: 13, fontWeight: 700, color: c }}>{v}</span>
              </div>
            ))}
            <div style={S.hint}>🖱 Drag · Scroll</div>
          </div>
        )}
      </header>

      {/* ── BODY ───────────────────────────────────────────── */}
      {isMobile ? (
        /* ══ MOBILE LAYOUT ══ */
        <div style={S.bodyMobile}>
          {/* Canvas fills screen above sheet */}
          <div style={{ ...S.canvasWrapMobile, height: sheetOpen ? "45vh" : "calc(100vh - 48px - 52px)" }}>
            <canvas ref={canvasRef} style={S.canvas} />

            {/* Minimal phase dot on mobile */}
            <div style={{ position: "absolute", top: 8, left: 8, display: "flex", flexDirection: "column", gap: 3, pointerEvents: "none" }}>
              {PHASES.map((p, i) => {
                const ci = PHASES.indexOf(phase), done = i < ci, cur = p === phase;
                const c = PHASE_COLORS[p] || "#4a6580";
                return <div key={p} style={{ width: cur ? 8 : 5, height: cur ? 8 : 5, borderRadius: "50%", background: cur ? c : done ? "#00ff9d33" : "#071828", boxShadow: cur ? `0 0 8px ${c}` : "none", transition: "all 0.3s", animation: cur ? "pulseDot 1s infinite" : "none" }} />;
              })}
            </div>

            {/* Mobile EC bar — compact strip at top of canvas */}
            {ecActive && (
              <div style={{ position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)", background: "#030c16ee", border: "1px solid #ffdb5833", borderRadius: 6, padding: "5px 12px", backdropFilter: "blur(8px)", pointerEvents: "none", display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#ffdb58" }}>⚡ EC</span>
                <div style={{ width: 80, height: 3, background: "#071828", borderRadius: 99, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${(ecTimer / 900) * 100}%`, background: "linear-gradient(90deg,#00d4ff,#ffdb58)", borderRadius: 99, transition: "width 0.4s" }} />
                </div>
                <span style={{ fontFamily: "'Orbitron',monospace", fontSize: 9, color: "#ffdb58" }}>{Math.floor(ecTimer/60)}:{String(ecTimer%60).padStart(2,"0")}</span>
              </div>
            )}

            {/* Mobile sparklines — compact bottom strip */}
            {!sheetOpen && (
              <div style={{ position: "absolute", bottom: 8, right: 8, background: "#030c16dd", border: "1px solid #0d2235", borderRadius: 7, padding: "7px 10px", backdropFilter: "blur(8px)", pointerEvents: "none" }}>
                {[
                  { label: "pH", data: sparkPH, col: "#00ff9d", val: readings.ph.toFixed(1) },
                  { label: "TDS", data: sparkTDS, col: "#ff8c42", val: readings.tds },
                  { label: "Turb", data: sparkTurb, col: "#00d4ff", val: readings.turbidity.toFixed(1) },
                ].map(s => (
                  <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                    <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: s.col, width: 22, flexShrink: 0 }}>{s.label}</span>
                    <Sparkline data={s.data} color={s.col} w={60} h={14} />
                    <span style={{ fontFamily: "'Orbitron',monospace", fontSize: 9, color: s.col, minWidth: 32, textAlign: "right" }}>{s.val}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Valve pills on mobile */}
            {!sheetOpen && (
              <div style={{ position: "absolute", bottom: 8, left: 8, display: "flex", flexDirection: "column", gap: 4, pointerEvents: "none" }}>
                <VPill label="A" open={valveA > 0.5} col="#00ff9d" dest="Reuse" />
                <VPill label="B" open={valveB > 0.5} col="#ff3f5a" dest="Treat" />
              </div>
            )}

            {/* Tank levels mobile — top center */}
            <div style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 8, pointerEvents: "none" }}>
              <TLvl label="A" sub="REUSE" level={tankALevel} col="#00ff9d" />
              <TLvl label="B" sub="TREAT" level={tankBLevel} col="#ff3f5a" />
            </div>

            {/* Classification popup */}
            {popup && (
              <div className="modal-in" style={{ ...S.modal, borderColor: BRACKET_META[popup.br].hex + "aa", boxShadow: `0 0 60px ${BRACKET_META[popup.br].hex}28` }}>
                <button onClick={() => setPopup(null)} style={S.closeBtn}>✕</button>
                <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#1a4060", letterSpacing: "0.2em", marginBottom: 10 }}>◈ WATER QUALITY REPORT</div>
                <div style={{ fontFamily: "'Orbitron',monospace", fontSize: 56, fontWeight: 900, color: BRACKET_META[popup.br].hex, lineHeight: 1, textShadow: `0 0 30px ${BRACKET_META[popup.br].hex}66` }}>{popup.br}</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#c8e8f8", marginTop: 6 }}>{BRACKET_META[popup.br].label}</div>
                <div style={{ fontSize: 9, color: "#2a5070", marginTop: 3, fontFamily: "'Space Mono',monospace" }}>{BRACKET_META[popup.br].desc}</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 12 }}>
                  {[["pH", popup.rd.ph, ""], ["TDS", popup.rd.tds, " mg/L"], ["Turbidity", popup.rd.turbidity, " NTU"], ["ORP", popup.rd.orp, " mV"]].map(([k, v, u]) => (
                    <div key={k} style={{ background: "#030c16", borderRadius: 7, padding: "7px 8px", border: "1px solid #0d2235", textAlign: "center" }}>
                      <div style={{ fontSize: 8, color: "#1a3a5a", fontFamily: "'Space Mono',monospace", marginBottom: 2 }}>{k}</div>
                      <div style={{ fontFamily: "'Orbitron',monospace", fontSize: 13, fontWeight: 700, color: "#c8e8f8" }}>{v}<span style={{ fontSize: 8, opacity: 0.5 }}>{u}</span></div>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 7, marginTop: 12, justifyContent: "center" }}>
                  <div style={{ padding: "7px 12px", borderRadius: 6, background: BRACKET_META[popup.br].reusable ? "#00281a" : "#1c0208", border: `1.5px solid ${BRACKET_META[popup.br].hex}`, color: BRACKET_META[popup.br].hex, fontFamily: "'Orbitron',monospace", fontSize: 10, fontWeight: 700 }}>
                    {popup.toA ? "→ TANK A · REUSABLE" : "→ TANK B · TREATMENT"}
                  </div>
                </div>
              </div>
            )}

            {/* Drift badge mobile */}
            {showDrift && (
              <div style={{ ...S.driftBadge, right: 8, top: "auto", bottom: sheetOpen ? "auto" : 100 }}>
                <div className={driftState !== "normal" ? "pulse-dot" : ""} style={{ width: 6, height: 6, borderRadius: "50%", background: { normal: "#00ff9d", degraded: "#ffdb58", flatline: "#ff3f5a", recalibrating: "#00d4ff" }[driftState], flexShrink: 0 }} />
                <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: { normal: "#00ff9d", degraded: "#ffdb58", flatline: "#ff3f5a", recalibrating: "#00d4ff" }[driftState] }}>
                  {{ normal: "NOMINAL", degraded: "⚠ DRIFT", flatline: "⛔ FLATLINE", recalibrating: "↻ RECAL" }[driftState]}
                </span>
              </div>
            )}
          </div>

          {/* ── BOTTOM SHEET ── */}
          <div style={{ ...S.panelMobile, height: sheetOpen ? "55vh" : 52 }}>
            {/* Drag handle + tab bar */}
            <div
              onClick={() => setSheetOpen(p => !p)}
              style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "10px 0 0", cursor: "pointer", flexShrink: 0 }}
            >
              <div style={{ width: 36, height: 4, borderRadius: 99, background: "#1a3a5a" }} />
            </div>
            <div style={S.tabBar}>
              {[["controls", "Controls"], ["structure", "Tank"], ["matrix", "F1–F5"], ["log", "Log"]].map(([id, label]) => (
                <button key={id} style={{ ...S.tabMobile, ...(activeTab === id ? S.tabActive : {}) }}
                  onClick={e => { e.stopPropagation(); setActiveTab(id); setSheetOpen(true); }}>
                  {label}
                </button>
              ))}
            </div>
            {/* Sheet content — scrollable */}
            <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
              {activeTab === "controls" && renderControlsTab()}
              {activeTab === "structure" && renderStructureTab()}
              {activeTab === "matrix" && renderMatrixTab()}
              {activeTab === "log" && renderLogTab()}
            </div>
          </div>
        </div>
      ) : (
        /* ══ DESKTOP LAYOUT ══ */
        <div style={S.body}>
          <aside style={S.panel}>
            <div style={S.tabBar}>
              {[["controls", "Controls"], ["structure", "Tank"], ["matrix", "Matrix"], ["log", "Log"]].map(([id, label]) => (
                <button key={id} style={{ ...S.tab, ...(activeTab === id ? S.tabActive : {}) }} onClick={() => setActiveTab(id)}>
                  {label}
                </button>
              ))}
            </div>
            {activeTab === "controls" && renderControlsTab()}
            {activeTab === "structure" && renderStructureTab()}
            {activeTab === "matrix" && renderMatrixTab()}
            {activeTab === "log" && renderLogTab()}
          </aside>

          {/* ── 3D CANVAS ── */}
          <div style={S.canvasWrap}>
            <canvas ref={canvasRef} style={S.canvas} />
            {renderCanvasOverlays()}
          </div>
        </div>
      )}
    </div>
  );

  // ─── RENDER FUNCTIONS (extracted for mobile/desktop reuse) ───

  function renderControlsTab() {
    return (
      <>
        {saltAlert && (
          <div style={{ margin: "8px 14px 0", padding: "7px 10px", borderRadius: 6, background: "#ffdb5812", border: "1px solid #ffdb5866", display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontSize: 12 }}>🧂</span>
            <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, color: "#ffdb58" }}>Add pinch of table salt — low conductivity</span>
          </div>
        )}
        <Sec title="WATER TYPE">
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {Object.entries(WATER_TYPES).map(([key, wt]) => (
              <button key={key} disabled={running}
                onClick={() => setWaterType(key)}
                style={{ padding: "10px 10px", borderRadius: 7, border: `1.5px solid ${waterType === key ? wt.color + "aa" : "#0d2235"}`, background: waterType === key ? wt.color + "12" : "transparent", color: waterType === key ? wt.color : "#2a5070", fontFamily: "'Space Mono',monospace", fontSize: 9, fontWeight: 700, cursor: running ? "not-allowed" : "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", transition: "all 0.2s", opacity: running ? 0.4 : 1 }}>
                <span>{wt.label}</span>
                <span style={{ opacity: 0.6, fontSize: 8 }}>{wt.desc}</span>
              </button>
            ))}
          </div>
          <div style={{ marginTop: 8, padding: "6px 9px", borderRadius: 5, background: "#030c16", border: "1px solid #071828" }}>
            <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#1a4060", marginBottom: 4 }}>◈ FLOC / CLEAR TIMELINE</div>
            <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "'Orbitron',monospace", fontSize: 9 }}>
              <span style={{ color: "#00d4ff" }}>Floc: {Math.round(WATER_TYPES[waterType].flocMin/60)}–{Math.round(WATER_TYPES[waterType].flocMax/60)} min</span>
              <span style={{ color: "#00ff9d" }}>Clear: {Math.round(WATER_TYPES[waterType].clearMin/60)}–{Math.round(WATER_TYPES[waterType].clearMax/60)} min</span>
            </div>
          </div>
        </Sec>

        <Sec title="SIMULATION">
          <button className={running ? "btn-running" : "btn-primary"} onClick={triggerCycle} disabled={running}>
            {running ? <><span className="spin-icon">⟳</span> Processing…</> : <>▶&ensp;Run — {WATER_TYPES[waterType].label}</>}
          </button>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 8 }}>
            <button className="btn-sec btn-yellow" onClick={triggerDrift} disabled={running}>⚠ Drift Sim</button>
            <button className="btn-sec btn-ghost" onClick={resetTanks} disabled={running}>↺ Reset Tanks</button>
          </div>
          <button className="btn-sec btn-blue" onClick={() => lastResult && setPopup(lastResult)} disabled={!lastResult} style={{ marginTop: 6, width: "100%" }}>🔬 &ensp;Last Analysis</button>
          <button className="btn-sec btn-ghost" onClick={() => setShowAnalytics(p => !p)} style={{ marginTop: 6, width: "100%" }}>{showAnalytics ? "◈ Hide" : "◈ Show"} Analytics</button>
        </Sec>

        {(ecActive || ecTimer > 0) && (
          <Sec title="EC CHAMBER LIVE">
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, color: "#ffdb58" }}>{EC_STAGES[ecStageIdx]?.label || "STANDBY"}</span>
                <span style={{ fontFamily: "'Orbitron',monospace", fontSize: 11, fontWeight: 700, color: "#ffdb58" }}>{Math.floor(ecTimer / 60)}:{String(ecTimer % 60).padStart(2, "0")} / 15:00</span>
              </div>
              <div style={{ height: 3, background: "#071828", borderRadius: 99, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${(ecTimer / 900) * 100}%`, background: "linear-gradient(90deg,#00d4ff,#ffdb58,#00ff9d)", borderRadius: 99, transition: "width 0.4s" }} />
              </div>
              <div style={{ fontSize: 8, color: "#1a3a5a", fontFamily: "'Space Mono',monospace", marginTop: 4 }}>{EC_STAGES[ecStageIdx]?.desc}</div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1, textAlign: "center", padding: "6px 0", background: "#030c16", border: "1px solid #ffdb5822", borderRadius: 6 }}>
                <div style={{ fontFamily: "'Orbitron',monospace", fontSize: 14, fontWeight: 700, color: "#ffdb58" }}>{polarityCount}</div>
                <div style={{ fontSize: 8, color: "#1a3a5a", fontFamily: "'Space Mono',monospace" }}>POLARITY REV.</div>
              </div>
              <div style={{ flex: 1, textAlign: "center", padding: "6px 0", background: "#030c16", border: `1px solid ${gateOpen ? "#00ff9d44" : "#0d2235"}`, borderRadius: 6 }}>
                <div style={{ fontFamily: "'Orbitron',monospace", fontSize: 11, fontWeight: 700, color: gateOpen ? "#00ff9d" : "#1a3a5a" }}>{gateOpen ? "OPEN" : "CLOSED"}</div>
                <div style={{ fontSize: 8, color: "#1a3a5a", fontFamily: "'Space Mono',monospace" }}>TIMED GATE</div>
              </div>
              <div style={{ flex: 1, textAlign: "center", padding: "6px 0", background: "#030c16", border: "1px solid #7fffd422", borderRadius: 6 }}>
                <div style={{ fontFamily: "'Orbitron',monospace", fontSize: 14, fontWeight: 700, color: "#7fffd4" }}>{lamellaEff}%</div>
                <div style={{ fontSize: 8, color: "#1a3a5a", fontFamily: "'Space Mono',monospace" }}>LAMELLA EFF.</div>
              </div>
            </div>
          </Sec>
        )}

        <Sec title="MANUAL PARAMETERS" sub="Override">
          <SRow label="Contamination Level" val={Math.round(contamination * 100) + "%"} color="#ffdb58"
            min={0} max={100} value={Math.round(contamination * 100)} disabled={running}
            onChange={e => setContam(+e.target.value / 100)} left="F1  Clean" right="F5  Severe" />
          <SRow label="Swirl Intensity" val={Math.round(swirlSpeed * 100) + "%"} color="#00d4ff"
            min={10} max={250} value={Math.round(swirlSpeed * 100)}
            onChange={e => setSwirlSpeed(+e.target.value / 100)} />
        </Sec>

        <Sec title="3D LAYER VISIBILITY">
          <Tog label="Oil Film Layer" color="#d4a017" val={showOil} on={() => setShowOil(p => !p)} />
          <Tog label="Sludge Zone" color="#8c5a2a" val={showSludge} on={() => setShowSludge(p => !p)} />
          <Tog label="Drift Monitor Ring" color="#ffdb58" val={showDrift} on={() => setShowDrift(p => !p)} />
        </Sec>

        <Sec title="SENSOR PROBES" sub="Click in 3D view">
          {sensorRows.map(s => (
            <div key={s.id} className="sensor-card"
              style={{ borderColor: selectedSensor === s.id ? s.col : "#0d2235", background: selectedSensor === s.id ? s.col + "10" : "transparent" }}
              onClick={() => setSelSensor(p => p === s.id ? null : s.id)}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 10, color: s.col, fontWeight: 700, fontFamily: "'Space Mono',monospace" }}>{s.label}</span>
                <span style={{ fontFamily: "'Orbitron',monospace", fontSize: 13, fontWeight: 700, color: s.col }}>{s.val}<span style={{ fontSize: 8, opacity: 0.6 }}>{s.unit}</span></span>
              </div>
              <div style={{ height: 2, background: "#071828", borderRadius: 99, marginTop: 6, overflow: "hidden" }}>
                <div style={{ height: "100%", width: s.pct + "%", background: s.col, borderRadius: 99, transition: "width 0.6s ease", boxShadow: `0 0 6px ${s.col}88` }} />
              </div>
              <div style={{ fontSize: 9, color: "#1a3a5a", marginTop: 3, fontFamily: "'Space Mono',monospace" }}>Safe: {s.safe[0]}–{s.safe[1]}{s.unit}</div>
            </div>
          ))}
        </Sec>
      </>
    );
  }

  function renderStructureTab() {
    return (
      <Sec title="TANK STRUCTURE" sub="Design doc">
        <div style={{ marginBottom: 10, padding: "8px 10px", borderRadius: 6, background: "#030c16", border: "1px solid #071828" }}>
          <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#1a4060", marginBottom: 5 }}>◈ TANK SPEC</div>
          {[["Diameter","15–20 cm"],["Height","60–80 cm"],["Material","Clear PVC / Acrylic"],["Power","12V DC · ESP32"],["Gate","15 min EC contact"]].map(([k,v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid #071828" }}>
              <span style={{ fontSize: 9, color: "#2a5070", fontFamily: "'Space Mono',monospace" }}>{k}</span>
              <span style={{ fontSize: 9, color: "#c8e8f8", fontFamily: "'Orbitron',monospace", fontWeight: 700 }}>{v}</span>
            </div>
          ))}
        </div>
        {TANK_STRUCTURE.map(stage => {
          const isActive = activeStage === stage.id;
          return (
            <div key={stage.id} style={{ padding: "10px", borderRadius: 7, marginBottom: 6, border: `1px solid ${isActive ? stage.color + "88" : "#0d2235"}`, background: isActive ? stage.color + "0d" : "transparent", transition: "all 0.3s" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 16 }}>{stage.icon}</span>
                <span style={{ fontFamily: "'Orbitron',monospace", fontSize: 9, fontWeight: 700, color: stage.color, flex: 1 }}>{stage.label}</span>
                {isActive && <div className="pulse-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: stage.color }} />}
              </div>
              <div style={{ fontSize: 9, color: "#2a5070", fontFamily: "'Space Mono',monospace", lineHeight: 1.55 }}>{stage.desc}</div>
            </div>
          );
        })}
        <div style={{ marginTop: 6, padding: "8px 10px", borderRadius: 6, background: "#030c16", border: "1px solid #0d2235" }}>
          <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#1a4060", marginBottom: 5 }}>◈ ESP32 SEQUENCE</div>
          {["Inlet sensor detects water","15-min countdown starts","EC discs run full current","Timer ends → servo opens gate","Water flows → lamella","Turbidity confirms clear","Servo closes gate","Cycle repeats"].map((step, i) => (
            <div key={i} style={{ display: "flex", gap: 7, padding: "3px 0", borderBottom: "1px solid #071828" }}>
              <span style={{ fontFamily: "'Orbitron',monospace", fontSize: 8, color: "#1a4060", minWidth: 14 }}>{i + 1}.</span>
              <span style={{ fontSize: 9, color: "#2a5070", fontFamily: "'Space Mono',monospace" }}>{step}</span>
            </div>
          ))}
        </div>
      </Sec>
    );
  }

  function renderMatrixTab() {
    return (
      <Sec title="BRACKET MATRIX" sub="Classification guide">
        {Object.entries(BRACKET_META).map(([br, m]) => (
          <div key={br} style={{ padding: "10px", borderRadius: 7, margin: "0 0 6px", border: `1px solid ${bracket === br ? m.hex + "88" : "#0d2235"}`, background: bracket === br ? m.hex + "0e" : "transparent", opacity: !bracket || bracket === br ? 1 : 0.35, transition: "all 0.3s" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
              <span style={{ fontFamily: "'Orbitron',monospace", fontSize: 15, fontWeight: 800, color: m.hex }}>{br}</span>
              <div style={{ flex: 1, height: 1, background: m.hex + "33" }} />
              <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: m.reusable ? "#00ff9d1a" : "#ff3f5a1a", color: m.reusable ? "#00ff9d" : "#ff3f5a", fontFamily: "'Space Mono',monospace", fontWeight: 700 }}>{m.reusable ? "REUSE" : "TREAT"}</span>
              <span style={{ fontSize: 9, padding: "2px 6px", borderRadius: 3, background: "#071828", color: "#2a5070", fontFamily: "'Space Mono',monospace" }}>Tank {m.tank}</span>
            </div>
            <div style={{ fontSize: 11, color: "#8ab0c8", marginBottom: 3 }}>{m.label}</div>
            <div style={{ fontSize: 9, color: "#2a5070", fontFamily: "'Space Mono',monospace" }}>{m.desc}</div>
            <div style={{ marginTop: 5, display: "flex", gap: 4, alignItems: "center" }}>
              <div style={{ height: 3, flex: 1, borderRadius: 99, background: "#071828", overflow: "hidden" }}>
                <div style={{ height: "100%", width: { NONE: "5%", LOW: "25%", MODERATE: "55%", HIGH: "78%", CRITICAL: "100%" }[m.risk], background: m.hex, borderRadius: 99 }} />
              </div>
              <span style={{ fontSize: 8, color: m.hex, fontFamily: "'Space Mono',monospace", fontWeight: 700, minWidth: 44 }}>⚡ {m.risk}</span>
            </div>
          </div>
        ))}
      </Sec>
    );
  }

  function renderLogTab() {
    return (
      <Sec title="EVENT LOG" sub={`${log.length} events`}>
        {log.length === 0 && (
          <div style={{ textAlign: "center", padding: "24px 0", color: "#1a3a5a", fontFamily: "'Space Mono',monospace", fontSize: 10 }}>No events recorded.<br />Run a cycle to begin.</div>
        )}
        {log.map((e, i) => (
          <div key={e.id} className="log-entry" style={{ borderColor: e.col + "28", background: e.col + "08", color: e.col, opacity: 1 - i * 0.05 }}>{e.msg}</div>
        ))}
      </Sec>
    );
  }

  function renderCanvasOverlays() {
    return (
      <>
        <div style={S.phaseTimeline}>
          <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#1a4060", letterSpacing: "0.16em", marginBottom: 8 }}>◈ PIPELINE</div>
          {PHASES.map((p, i) => {
            const ci = PHASES.indexOf(phase), done = i < ci, cur = p === phase;
            const c = PHASE_COLORS[p] || "#4a6580";
            return (
              <div key={p} style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
                <div style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, border: `1.5px solid ${cur ? c : done ? "#00ff9d66" : "#0d2235"}`, background: cur ? c : done ? "#00ff9d22" : "transparent", boxShadow: cur ? `0 0 8px ${c}` : "none", animation: cur ? "pulseDot 1s infinite" : "none" }} />
                <span style={{ fontSize: 9, fontFamily: "'Space Mono',monospace", color: cur ? c : done ? "#1a5a3a" : "#0d2235", fontWeight: cur ? 700 : 400 }}>{p}</span>
              </div>
            );
          })}
          {activeStage && (
            <div style={{ marginTop: 8, paddingTop: 7, borderTop: "1px solid #071828" }}>
              {TANK_STRUCTURE.filter(s => s.id === activeStage).map(s => (
                <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 12 }}>{s.icon}</span>
                  <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: s.color, fontWeight: 700 }}>{s.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {ecActive && (
          <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", background: "#030c16ee", border: "1px solid #ffdb5833", borderRadius: 8, padding: "10px 16px", backdropFilter: "blur(10px)", pointerEvents: "none", minWidth: 220 }}>
            <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#ffdb5880", letterSpacing: "0.14em", marginBottom: 7, textAlign: "center" }}>◈ EC CHAMBER — 6–8 Al DISCS</div>
            <div style={{ display: "flex", gap: 4, justifyContent: "center", marginBottom: 7 }}>
              {Array.from({ length: 7 }).map((_, i) => {
                const isPos = i % 2 === 0, isActive = i <= Math.floor(ecTimer / 130);
                return <div key={i} style={{ width: 24, height: 6, borderRadius: 2, background: isActive ? (isPos ? "#00d4ff" : "#ff8c42") : "#071828", border: `1px solid ${isActive ? (isPos ? "#00d4ff44" : "#ff8c4244") : "#0d2235"}`, transition: "all 0.4s", boxShadow: isActive ? `0 0 6px ${isPos ? "#00d4ff" : "#ff8c42"}66` : "none" }} />;
              })}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ flex: 1, height: 2, background: "#071828", borderRadius: 99, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${(ecTimer / 900) * 100}%`, background: "linear-gradient(90deg,#00d4ff,#ffdb58,#00ff9d)", borderRadius: 99, transition: "width 0.4s" }} />
              </div>
              <span style={{ fontFamily: "'Orbitron',monospace", fontSize: 9, color: "#ffdb58", whiteSpace: "nowrap" }}>{Math.floor(ecTimer / 60)}:{String(ecTimer % 60).padStart(2, "0")} / 15:00</span>
            </div>
            <div style={{ textAlign: "center", marginTop: 5, fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#1a4060" }}>{EC_STAGES[ecStageIdx]?.desc || ""}</div>
          </div>
        )}

        {popup && (
          <div className="modal-in" style={{ ...S.modal, borderColor: BRACKET_META[popup.br].hex + "aa", boxShadow: `0 0 80px ${BRACKET_META[popup.br].hex}28` }}>
            <button onClick={() => setPopup(null)} style={S.closeBtn}>✕</button>
            <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#1a4060", letterSpacing: "0.2em", marginBottom: 12 }}>◈ WATER QUALITY REPORT</div>
            <div style={{ fontFamily: "'Orbitron',monospace", fontSize: 72, fontWeight: 900, color: BRACKET_META[popup.br].hex, lineHeight: 1, textShadow: `0 0 40px ${BRACKET_META[popup.br].hex}66` }}>{popup.br}</div>
            <div style={{ fontSize: 16, fontWeight: 600, color: "#c8e8f8", marginTop: 8 }}>{BRACKET_META[popup.br].label}</div>
            <div style={{ fontSize: 10, color: "#2a5070", marginTop: 4, fontFamily: "'Space Mono',monospace" }}>{BRACKET_META[popup.br].desc}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 16 }}>
              {[["pH", popup.rd.ph, ""], ["TDS", popup.rd.tds, " mg/L"], ["Turbidity", popup.rd.turbidity, " NTU"], ["ORP", popup.rd.orp, " mV"]].map(([k, v, u]) => (
                <div key={k} style={{ background: "#030c16", borderRadius: 8, padding: "8px 10px", border: "1px solid #0d2235", textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: "#1a3a5a", fontFamily: "'Space Mono',monospace", marginBottom: 2 }}>{k}</div>
                  <div style={{ fontFamily: "'Orbitron',monospace", fontSize: 15, fontWeight: 700, color: "#c8e8f8" }}>{v}<span style={{ fontSize: 9, opacity: 0.5 }}>{u}</span></div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "center" }}>
              <div style={{ padding: "8px 16px", borderRadius: 6, background: BRACKET_META[popup.br].reusable ? "#00281a" : "#1c0208", border: `1.5px solid ${BRACKET_META[popup.br].hex}`, color: BRACKET_META[popup.br].hex, fontFamily: "'Orbitron',monospace", fontSize: 11, fontWeight: 700 }}>
                {popup.toA ? "→ TANK A  ·  REUSABLE" : "→ TANK B  ·  TREATMENT"}
              </div>
              <div style={{ padding: "8px 12px", borderRadius: 6, background: "#0d1a2a", border: `1.5px solid ${BRACKET_META[popup.br].hex}44`, color: BRACKET_META[popup.br].hex, fontSize: 11, fontWeight: 700 }}>{BRACKET_META[popup.br].risk}</div>
            </div>
          </div>
        )}

        <div style={S.legend}>
          {[["#d4a017","Oil film"],["#00d4ff","Clean water"],["#00ff9d","Sensor zone"],["#5c2e0a","Sludge"],["#ddf4ff","H₂ bubbles"],["#7fffd4","Lamella"],["#c084fc", gateOpen ? "Gate OPEN" : "Gate CLOSED"]].map(([c,l]) => (
            <div key={l} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 9, color: "#2a5070", fontFamily: "'Space Mono',monospace" }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: c, flexShrink: 0, boxShadow: `0 0 5px ${c}88` }} />{l}
            </div>
          ))}
        </div>

        <div style={S.valveRow}>
          <VPill label="VALVE A" open={valveA > 0.5} col="#00ff9d" dest="→ Tank A" />
          <VPill label="VALVE B" open={valveB > 0.5} col="#ff3f5a" dest="→ Tank B" />
        </div>

        <div style={S.tankLevels}>
          <TLvl label="TANK A" sub="REUSE" level={tankALevel} col="#00ff9d" />
          <TLvl label="TANK B" sub="TREATMENT" level={tankBLevel} col="#ff3f5a" />
        </div>

        <div style={S.sparkPanel}>
          <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#1a4060", letterSpacing: "0.14em", marginBottom: 7 }}>◈ LIVE SENSOR FEED</div>
          {[
            { label: "pH", data: sparkPH, col: "#00ff9d", val: readings.ph.toFixed(2), unit: "" },
            { label: "TDS", data: sparkTDS, col: "#ff8c42", val: readings.tds, unit: " mg/L" },
            { label: "Turb", data: sparkTurb, col: "#00d4ff", val: readings.turbidity.toFixed(1), unit: " NTU" },
            { label: "ORP", data: sparkORP, col: "#c084fc", val: readings.orp, unit: " mV" },
          ].map(s => (
            <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
              <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, color: s.col, width: 28, flexShrink: 0, fontWeight: 700 }}>{s.label}</span>
              <Sparkline data={s.data} color={s.col} w={82} h={18} />
              <span style={{ fontFamily: "'Orbitron',monospace", fontSize: 9, color: s.col, minWidth: 52, textAlign: "right", flexShrink: 0, whiteSpace: "nowrap" }}>{s.val}<span style={{ fontSize: 7, opacity: 0.5 }}>{s.unit}</span></span>
            </div>
          ))}
        </div>

        {showAnalytics && (
          <div style={S.analyticsPanel}>
            <div style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#1a4060", letterSpacing: "0.14em", marginBottom: 8 }}>◈ ANALYTICS</div>
            {[
              { k: "Water Reuse", v: reusePct + "%", c: "#00ff9d" },
              { k: "Water Type", v: WATER_TYPES[waterType].label.split(" ")[0], c: WATER_TYPES[waterType].color },
              { k: "Efficiency", v: efficiency + "%", c: "#ffdb58" },
              { k: "Lamella Eff.", v: lamellaEff + "%", c: "#7fffd4" },
              { k: "EC Reversals", v: String(polarityCount), c: "#ffdb58" },
              { k: "Confidence", v: "97.4%", c: "#c084fc" },
              { k: "Cycles", v: String(cycleCount), c: "#ff8c42" },
              { k: "Avg Turb", v: readings.turbidity.toFixed(1) + " NTU", c: "#00d4ff" },
            ].map(r => (
              <div key={r.k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: "1px solid #071828" }}>
                <span style={{ fontSize: 10, color: "#2a5070", fontFamily: "'Space Mono',monospace" }}>{r.k}</span>
                <span style={{ fontFamily: "'Orbitron',monospace", fontSize: 11, fontWeight: 700, color: r.c }}>{r.v}</span>
              </div>
            ))}
          </div>
        )}

        {showDrift && (
          <div style={{ ...S.driftBadge, right: showAnalytics ? 180 : 10, borderColor: { normal: "#00ff9d33", degraded: "#ffdb5866", flatline: "#ff3f5a88", recalibrating: "#00d4ff66" }[driftState], background: { normal: "#00ff9d0a", degraded: "#ffdb580e", flatline: "#ff3f5a0e", recalibrating: "#00d4ff0e" }[driftState] }}>
            <div className={driftState !== "normal" ? "pulse-dot" : ""} style={{ width: 6, height: 6, borderRadius: "50%", background: { normal: "#00ff9d", degraded: "#ffdb58", flatline: "#ff3f5a", recalibrating: "#00d4ff" }[driftState], flexShrink: 0 }} />
            <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 9, color: { normal: "#00ff9d", degraded: "#ffdb58", flatline: "#ff3f5a", recalibrating: "#00d4ff" }[driftState] }}>
              {{ normal: "● SENSORS NOMINAL", degraded: "⚠ DRIFT DETECTED", flatline: "⛔ FLATLINE", recalibrating: "↻ RECALIBRATING" }[driftState]}
            </span>
          </div>
        )}
      </>
    );
  }

}

// ─── UI ATOMS ─────────────────────────────────────────────────
function Sec({ title, sub, children }) {
  return (
    <div style={{ padding: "14px 14px 12px", borderBottom: "1px solid #071828" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 8.5, fontWeight: 700, color: "#1a4060", letterSpacing: "0.16em", textTransform: "uppercase" }}>{title}</span>
        {sub && <span style={{ fontFamily: "'Space Mono',monospace", fontSize: 8, color: "#0d2235" }}>{sub}</span>}
      </div>
      {children}
    </div>
  );
}

function SRow({ label, val, color, min, max, value, onChange, disabled, left, right }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#4a7090", marginBottom: 5 }}>
        <span>{label}</span>
        <span style={{ fontFamily: "'Orbitron',monospace", fontSize: 11, fontWeight: 700, color }}>{val}</span>
      </div>
      <input type="range" className="slider" min={min} max={max} value={value} onChange={onChange} disabled={disabled} style={{ "--sc": color }} />
      {left && (
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#0d2235", marginTop: 3, fontFamily: "'Space Mono',monospace" }}>
          <span>{left}</span><span>{right}</span>
        </div>
      )}
    </div>
  );
}

function Tog({ label, color, val, on }) {
  return (
    <div onClick={on} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 0", cursor: "pointer", userSelect: "none" }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: val ? "#c8e8f8" : "#2a4a6a", transition: "color 0.2s" }}>{label}</span>
      <div style={{ width: 36, height: 20, borderRadius: 99, border: `1.5px solid ${val ? color : "#0d2235"}`, background: val ? color + "25" : "transparent", position: "relative", transition: "all 0.2s", flexShrink: 0 }}>
        <div style={{ position: "absolute", top: 3, left: val ? 18 : 3, width: 12, height: 12, borderRadius: "50%", background: val ? color : "#1a3a5a", transition: "left 0.2s, background 0.2s", boxShadow: val ? `0 0 8px ${color}` : "none" }} />
      </div>
    </div>
  );
}

function VPill({ label, open, col, dest }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 12px", borderRadius: 5, border: `1px solid ${open ? col + "88" : "#0d2235"}`, background: open ? col + "12" : "#030c16", color: open ? col : "#1a3a5a", fontFamily: "'Space Mono',monospace", fontSize: 10, fontWeight: 700, transition: "all 0.35s", minWidth: 130 }}>
      <div style={{ width: 6, height: 6, borderRadius: "50%", background: open ? col : "#0d2235", boxShadow: open ? `0 0 8px ${col}` : "none" }} className={open ? "pulse-dot" : ""} />
      <span>{label}</span>
      <span style={{ opacity: open ? 1 : 0, marginLeft: "auto", fontSize: 8, transition: "opacity 0.3s" }}>{dest}</span>
      <span style={{ marginLeft: open ? 0 : "auto", fontSize: 9, opacity: open ? 1 : 0.4 }}>{open ? "OPEN" : "CLOSED"}</span>
    </div>
  );
}

function TLvl({ label, sub, level, col }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, background: "#030c16cc", border: "1px solid #071828", padding: "7px 14px", borderRadius: 8, backdropFilter: "blur(10px)", minWidth: 88 }}>
      <div style={{ fontFamily: "'Orbitron',monospace", fontSize: 9, fontWeight: 700, color: col, letterSpacing: "0.1em", textAlign: "center" }}>
        {label}
      </div>
      <div style={{ fontSize: 7, color: "#1a3a5a", fontFamily: "'Space Mono',monospace" }}>{sub}</div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 22 }}>
        {Array.from({ length: 10 }).map((_, i) => {
          const filled = i < Math.round(level * 10);
          return <div key={i} style={{ width: 5, height: 4 + i * 1.8, borderRadius: 2, background: filled ? col : "#071828", transition: "background 0.5s", boxShadow: filled ? `0 0 5px ${col}88` : "none" }} />;
        })}
      </div>
      <div style={{ fontFamily: "'Orbitron',monospace", fontSize: 11, fontWeight: 700, color: col }}>{Math.round(level * 100)}%</div>
    </div>
  );
}

// ─── STYLES ───────────────────────────────────────────────────
const S = {
  root: { width: "100vw", height: "100vh", background: "#020b14", display: "flex", flexDirection: "column", fontFamily: "'Rajdhani',sans-serif", overflow: "hidden", color: "#c8e8f8" },
  // Desktop header (52px), mobile header (48px)
  header: { height: 52, background: "linear-gradient(90deg,#020b14,#030e1a 40%,#020b14)", borderBottom: "1px solid #071828", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", flexShrink: 0, gap: 10 },
  logoRow: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 },
  logoPulse: { width: 8, height: 8, borderRadius: "50%", background: "#00ff9d", boxShadow: "0 0 14px #00ff9d", flexShrink: 0 },
  logoText: { fontFamily: "'Orbitron',monospace", fontWeight: 900, fontSize: 17, letterSpacing: "0.04em", color: "#c8e8f8" },
  logoDivider: { width: 1, height: 18, background: "#071828" },
  logoSub: { fontSize: 9, color: "#1a3a5a", fontFamily: "'Space Mono',monospace", whiteSpace: "nowrap" },
  headerCenter: { display: "flex", alignItems: "center", gap: 8, flex: 1, justifyContent: "center", minWidth: 0, overflow: "hidden" },
  pill: { display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 5, border: "1px solid", fontFamily: "'Space Mono',monospace", fontSize: 9, fontWeight: 700, letterSpacing: "0.04em", transition: "all 0.3s", whiteSpace: "nowrap", flexShrink: 0 },
  headerStats: { display: "flex", alignItems: "center", gap: 2, flexShrink: 0 },
  hStat: { display: "flex", flexDirection: "column", alignItems: "center", gap: 1, padding: "2px 8px", borderLeft: "1px solid #071828" },
  hint: { fontSize: 9, color: "#0d2235", fontFamily: "'Space Mono',monospace", borderLeft: "1px solid #071828", paddingLeft: 10 },
  // Desktop: sidebar + canvas. Mobile: canvas fills, panel is bottom sheet
  body: { flex: 1, display: "grid", gridTemplateColumns: "228px 1fr", overflow: "hidden" },
  bodyMobile: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" },
  panel: { background: "#030c16", borderRight: "1px solid #071828", display: "flex", flexDirection: "column", overflowY: "auto", overflowX: "hidden" },
  // Mobile panel: bottom sheet
  panelMobile: { position: "absolute", bottom: 0, left: 0, right: 0, background: "#030c16f5", borderTop: "1px solid #0d2235", display: "flex", flexDirection: "column", zIndex: 50, backdropFilter: "blur(16px)", borderRadius: "16px 16px 0 0", transition: "height 0.32s cubic-bezier(0.4,0,0.2,1)", overflow: "hidden" },
  tabBar: { display: "flex", borderBottom: "1px solid #071828", flexShrink: 0 },
  tab: { flex: 1, padding: "10px 0", background: "transparent", border: "none", color: "#1a4060", fontFamily: "'Space Mono',monospace", fontSize: 9, fontWeight: 700, cursor: "pointer", letterSpacing: "0.1em", transition: "all 0.2s", textTransform: "uppercase" },
  tabMobile: { flex: 1, padding: "12px 0", background: "transparent", border: "none", color: "#1a4060", fontFamily: "'Space Mono',monospace", fontSize: 9, fontWeight: 700, cursor: "pointer", letterSpacing: "0.08em", transition: "all 0.2s", textTransform: "uppercase" },
  tabActive: { color: "#00d4ff", borderBottom: "2px solid #00d4ff", background: "#00d4ff08" },
  canvasWrap: { position: "relative", overflow: "hidden", touchAction: "none" },
  canvasWrapMobile: { flex: 1, position: "relative", overflow: "hidden", touchAction: "none" },
  canvas: { width: "100%", height: "100%", display: "block", touchAction: "none", userSelect: "none" },
  modal: { position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-55%)", background: "linear-gradient(135deg,#030c16,#071828)", border: "1.5px solid", borderRadius: 16, padding: "20px 24px 18px", minWidth: 280, maxWidth: "90vw", textAlign: "center", zIndex: 200 },
  closeBtn: { position: "absolute", top: 10, right: 12, background: "transparent", border: "1px solid #0d2235", borderRadius: "50%", color: "#1a3a5a", fontSize: 11, cursor: "pointer", width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", transition: "all 0.2s" },
  phaseTimeline: { position: "absolute", top: 10, left: 10, background: "#030c16ee", border: "1px solid #071828", borderRadius: 8, padding: "8px 10px", backdropFilter: "blur(10px)", pointerEvents: "none" },
  legend: { position: "absolute", bottom: 56, left: 10, display: "flex", flexDirection: "column", gap: 4, background: "#030c16ee", border: "1px solid #071828", padding: "7px 10px", borderRadius: 7, backdropFilter: "blur(10px)", pointerEvents: "none" },
  valveRow: { position: "absolute", bottom: 10, left: 10, display: "flex", flexDirection: "column", gap: 4, pointerEvents: "none" },
  tankLevels: { position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 14, pointerEvents: "none" },
  sparkPanel: { position: "absolute", bottom: 10, right: 10, width: 200, background: "#030c16ee", border: "1px solid #0d2235", borderRadius: 8, padding: "9px 11px", backdropFilter: "blur(12px)", pointerEvents: "none" },
  analyticsPanel: { position: "absolute", top: 10, right: 10, width: 160, background: "#030c16ee", border: "1px solid #071828", borderRadius: 8, padding: "9px 11px", backdropFilter: "blur(12px)", pointerEvents: "none" },
  driftBadge: { position: "absolute", top: 10, right: 180, display: "flex", alignItems: "center", gap: 7, padding: "5px 10px", borderRadius: 5, border: "1px solid", backdropFilter: "blur(8px)", pointerEvents: "none" },
};

// ─── GLOBAL CSS ───────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700;800;900&family=Space+Mono:wght@400;700&family=Rajdhani:wght@300;400;500;600;700&display=swap');
  *{box-sizing:border-box;margin:0;padding:0;}
  html{-webkit-text-size-adjust:100%;}
  body{margin:0;padding:0;overscroll-behavior:none;-webkit-tap-highlight-color:transparent;}
  ::-webkit-scrollbar{width:3px;}
  ::-webkit-scrollbar-track{background:transparent;}
  ::-webkit-scrollbar-thumb{background:#0d2235;border-radius:2px;}

  @keyframes pulseDot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(0.7)}}
  @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
  @keyframes modalIn{from{opacity:0;transform:translate(-50%,-60%) scale(0.88)}to{opacity:1;transform:translate(-50%,-55%) scale(1)}}
  @keyframes logSlide{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
  @keyframes saltFade{0%{opacity:1;transform:translateY(0)}80%{opacity:1}100%{opacity:0;transform:translateY(-6px)}}
  @keyframes ecPulse{0%,100%{box-shadow:0 0 6px #ffdb5866}50%{box-shadow:0 0 18px #ffdb58cc}}
  @keyframes sheetUp{from{transform:translateY(100%)}to{transform:translateY(0)}}

  .pulse-dot{animation:pulseDot 1.4s infinite;}
  .spin-icon{display:inline-block;animation:spin 1s linear infinite;}
  .modal-in{animation:modalIn 0.38s cubic-bezier(0.34,1.56,0.64,1);}
  .ec-active-disc{animation:ecPulse 1.2s infinite;}

  .btn-primary{
    width:100%;padding:12px;border-radius:8px;
    border:1px solid #00d4ff66;background:linear-gradient(135deg,#00d4ff0d,#00ff9d0d);
    color:#00d4ff;font-family:'Orbitron',monospace;font-size:11px;font-weight:700;
    letter-spacing:0.08em;cursor:pointer;transition:all 0.2s;
    display:flex;align-items:center;justify-content:center;gap:8px;
    -webkit-tap-highlight-color:transparent;touch-action:manipulation;
  }
  .btn-primary:hover:not(:disabled){background:linear-gradient(135deg,#00d4ff1a,#00ff9d1a);box-shadow:0 0 20px #00d4ff22;border-color:#00d4ffaa;}
  .btn-primary:disabled{cursor:not-allowed;opacity:0.4;}

  .btn-running{
    width:100%;padding:12px;border-radius:8px;
    border:1px solid #00d4ff33;background:#00d4ff08;
    color:#00d4ff66;font-family:'Orbitron',monospace;font-size:11px;font-weight:700;
    letter-spacing:0.08em;cursor:not-allowed;
    display:flex;align-items:center;justify-content:center;gap:8px;
  }

  .btn-sec{
    padding:10px 12px;border-radius:6px;border:1px solid #0d2235;background:#030c16;
    font-family:'Space Mono',monospace;font-size:9.5px;font-weight:700;cursor:pointer;
    letter-spacing:0.05em;transition:all 0.2s;color:#2a5070;
    -webkit-tap-highlight-color:transparent;touch-action:manipulation;
  }
  .btn-sec:active:not(:disabled){filter:brightness(1.5);border-color:currentColor;}
  .btn-sec:hover:not(:disabled){filter:brightness(1.5);border-color:currentColor;}
  .btn-sec:disabled{opacity:0.3;cursor:not-allowed;}
  .btn-yellow{color:#ffdb58;border-color:#ffdb5822;}
  .btn-ghost{color:#4a7090;border-color:#0d2235;}
  .btn-blue{color:#00d4ff;border-color:#00d4ff22;}

  input[type=range].slider{
    width:100%;-webkit-appearance:none;height:4px;border-radius:99px;
    background:#071828;cursor:pointer;outline:none;
  }
  input[type=range].slider::-webkit-slider-thumb{
    -webkit-appearance:none;width:18px;height:18px;border-radius:50%;
    background:var(--sc,#00d4ff);border:2px solid var(--sc,#00d4ff);
    box-shadow:0 0 8px var(--sc,#00d4ff);cursor:pointer;transition:transform 0.15s;
  }
  input[type=range].slider::-webkit-slider-thumb:hover{transform:scale(1.3);}
  input[type=range].slider:disabled{opacity:0.3;cursor:not-allowed;}

  .sensor-card{
    border:1px solid;border-radius:8px;padding:10px 12px;margin-bottom:6px;
    cursor:pointer;transition:all 0.25s;-webkit-tap-highlight-color:transparent;
    touch-action:manipulation;
  }
  .sensor-card:active{filter:brightness(1.1);}

  .log-entry{
    font-family:'Space Mono',monospace;font-size:9px;padding:6px 10px;border-radius:4px;
    border:1px solid;line-height:1.55;animation:logSlide 0.3s ease;
    margin-bottom:3px;
  }

  /* ── MOBILE overrides ─────────────────────────── */
  @media (max-width:767px){
    .hide-mobile{display:none!important;}
    .btn-primary{font-size:12px;padding:14px;}
    .btn-sec{padding:11px 14px;font-size:10px;}
    input[type=range].slider::-webkit-slider-thumb{width:22px;height:22px;}
    .sensor-card{padding:12px 14px;margin-bottom:8px;}
  }
`;
