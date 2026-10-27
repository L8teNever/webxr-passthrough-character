/**
 * WebXR Passthrough Character — application entry.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PhysicsSystem } from './physics.js';
import { XRManager } from './xr_manager.js';
import { PoseUI, bindHudCalibration, bindHudContact } from './ui.js';

const $ = (id) => document.getElementById(id);

const state = {
  sessionId: crypto.randomUUID?.() || String(Date.now()),
  ws: null,
  character: null,
  clock: new THREE.Clock(),
  activeModelId: 'casual-woman',
  models: [],
  loadingModel: false,
};

function setStatus(id, text, cls) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.classList.remove('ok', 'err');
  if (cls) el.classList.add(cls);
}

/* ---------- WebSocket telemetry ---------- */
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws`;
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.addEventListener('open', () => setStatus('ws-status', 'WebSocket verbunden', 'ok'));
  ws.addEventListener('close', () => {
    setStatus('ws-status', 'WebSocket getrennt — Retry…', 'err');
    setTimeout(connectWS, 2500);
  });
  ws.addEventListener('error', () => setStatus('ws-status', 'WebSocket Fehler', 'err'));
  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'welcome') {
        setStatus('ws-status', `WS Client ${msg.client_id.slice(0, 8)}`, 'ok');
      }
      if (msg.type === 'model_changed' && msg.model?.id && msg.model.id !== state.activeModelId) {
        loadModel(msg.model.id).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  });
}

function sendWS(payload) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ ...payload, session_id: state.sessionId }));
  }
}

/* ---------- Three.js scene (transparent for passthrough) ---------- */
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0); // transparent → AR passthrough
renderer.xr.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
// No skybox / no room mesh — passthrough is the background

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 50);
camera.position.set(0, 1.4, 2.2);

const hemi = new THREE.HemisphereLight(0xddeeff, 0x334455, 1.1);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 1.15);
key.position.set(1.5, 3, 1);
scene.add(key);
const fill = new THREE.DirectionalLight(0xaaccff, 0.35);
fill.position.set(-2, 1.5, -1);
scene.add(fill);

// Subtle ground shadow disc (doesn't block passthrough much)
const shadowMat = new THREE.MeshBasicMaterial({
  color: 0x000000,
  transparent: true,
  opacity: 0.22,
  depthWrite: false,
});
const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.45, 32), shadowMat);
shadow.rotation.x = -Math.PI / 2;
shadow.position.y = 0.002;
shadow.position.z = -1.5;
scene.add(shadow);

const physics = new PhysicsSystem(scene);
const poseUI = new PoseUI(scene, null);

let xrManager = null;

physics.onContact = (active) => {
  bindHudContact(active);
  if (active && xrManager) {
    // Rising-edge haptic pulse only (avoids actuator spam while penetrating)
    xrManager.pulseHaptic(0, 0.4, 35);
    xrManager.pulseHaptic(1, 0.4, 35);
  }
};

function placeCharacter(root) {
  if (state.character) {
    scene.remove(state.character);
    state.character.traverse((o) => {
      if (o.geometry) o.geometry.dispose?.();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          m.map?.dispose?.();
          m.dispose?.();
        }
      }
    });
  }
  state.character = root;
  root.position.set(0, 0, -1.5);
  scene.add(root);
  physics.bindCharacter(root);
  physics.syncRootFromCharacter();
  poseUI.setCharacter(root);
  poseUI.setPose('standing');
  xrManager?.setTarget(root);
  shadow.position.x = root.position.x;
  shadow.position.z = root.position.z;
}

function setActiveModelButtons(activeId) {
  document.querySelectorAll('.model-btn').forEach((btn) => {
    const id = btn.dataset.modelId;
    btn.classList.toggle('active', id === activeId);
  });
  const hud = $('hud-model');
  const label =
    state.models.find((m) => m.id === activeId)?.label ||
    (activeId === 'female-base' ? 'Female Base' : 'Casual Woman');
  if (hud) hud.textContent = `Modell: ${label}`;
}

function bindModelSwitchButtons() {
  document.querySelectorAll('.model-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.modelId;
      if (!id || id === state.activeModelId || state.loadingModel) return;
      selectModel(id);
    });
  });
}

async function refreshModelCatalog() {
  try {
    const res = await fetch('/api/models');
    if (!res.ok) return;
    const data = await res.json();
    state.models = data.models || [];
    if (data.active_model_id) state.activeModelId = data.active_model_id;
    setActiveModelButtons(state.activeModelId);
  } catch {
    /* ignore */
  }
}

async function selectModel(id) {
  setStatus('model-status', `Wechsle zu ${id}…`);
  try {
    const res = await fetch('/api/model/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const info = await res.json();
    await loadModel(info.id || id, info);
    sendWS({ type: 'interaction', action: 'model_switch', model: info.id || id });
  } catch (err) {
    console.warn('Model switch failed', err);
    setStatus('model-status', `Modell-Wechsel fehlgeschlagen`, 'err');
  }
}

async function loadModel(preferredId = null, infoOverride = null) {
  if (state.loadingModel) return;
  state.loadingModel = true;
  setStatus('model-status', 'Modell wird geladen…');

  let info = infoOverride;
  try {
    if (!info) {
      if (preferredId) {
        const listRes = await fetch('/api/models');
        if (listRes.ok) {
          const list = await listRes.json();
          state.models = list.models || [];
          info = (list.models || []).find((m) => m.id === preferredId) || null;
        }
      }
      if (!info) {
        const res = await fetch('/api/model');
        if (res.ok) info = await res.json();
      }
    }
  } catch {
    /* use default path */
  }

  info = info || { url: '/assets/models/character.glb', procedural: false, id: 'casual-woman' };
  const modelId = info.id || info.model_id || preferredId || 'casual-woman';
  const url = info.url || '/assets/models/character.glb';

  const loader = new GLTFLoader();
  try {
    const gltf = await loader.loadAsync(`${url}?t=${Date.now()}`);
    const root = polishCharacter(gltf.scene, modelId);
    placeCharacter(root);
    state.activeModelId = modelId;
    setActiveModelButtons(modelId);
    const src = info.procedural ? 'prozedurales Fallback' : info.source || 'remote';
    const label = info.label || modelId;
    setStatus('model-status', `${label} bereit (${src})`, 'ok');
  } catch (err) {
    console.warn('GLB load failed, building client procedural humanoid', err);
    const root = buildClientHumanoid();
    placeCharacter(root);
    state.activeModelId = modelId;
    setActiveModelButtons(modelId);
    setStatus('model-status', 'Client-Fallback-Humanoid', 'ok');
  } finally {
    state.loadingModel = false;
    refreshModelCatalog();
  }
}

/**
 * Fix common GLB issues: duplicate high-poly overlays (Z-fighting),
 * clay-only materials, broken transparency, and uneven scale/feet.
 */
function polishCharacter(root, modelId = 'casual-woman') {
  const clayMode = modelId === 'female-base' || modelId?.includes('female-base');
  const clayNames = /clay|base_female|basemesh/i;

  root.traverse((o) => {
    const name = o.name || '';
    // MakeHuman high-poly / proxy overlays only — keep Grab3D clothing/hair intact
    if (clayMode && /high[-_]?poly|proxy|helper|collision/i.test(name)) {
      o.visible = false;
      return;
    }
    if (!o.isMesh) return;

    o.castShadow = false;
    o.receiveShadow = false;
    o.frustumCulled = false;

    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const next = mats.map((mat) => {
      if (!mat) return mat;
      const m = mat.clone();
      m.transparent = false;
      m.opacity = 1;
      m.depthWrite = true;
      m.side = THREE.FrontSide;
      m.alphaTest = 0;

      // Promote flat clay base meshes to a readable skin tone
      const isClay =
        clayMode ||
        clayNames.test(m.name || '') ||
        (!m.map && m.color && m.color.getHex() < 0x555555);
      if (isClay && m.isMeshStandardMaterial && !m.map) {
        m.color.setHex(0xe0b090);
        m.roughness = 0.58;
        m.metalness = 0.02;
        m.envMapIntensity = 0.85;
      }

      if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
      if (m.emissiveMap) m.emissiveMap.colorSpace = THREE.SRGBColorSpace;
      // Kill accidental emissive "mask" glow from broken exports
      if (m.emissive && !m.emissiveMap) m.emissive.setHex(0x000000);
      m.needsUpdate = true;
      return m;
    });
    o.material = Array.isArray(o.material) ? next : next[0];
  });

  // Normalize height ~1.7m and plant feet on the floor
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (size.y > 0.01) {
    root.scale.setScalar(1.7 / size.y);
    box.setFromObject(root);
    root.position.y -= box.min.y;
  }
  return root;
}

/** Last-resort procedural humanoid if even server GLB fails to parse */
function buildClientHumanoid() {
  const group = new THREE.Group();
  group.name = 'ClientHumanoid';
  const mat = new THREE.MeshStandardMaterial({
    color: 0xdbab8c,
    roughness: 0.65,
    metalness: 0.05,
  });
  const softMat = new THREE.MeshStandardMaterial({
    color: 0xe0b09a,
    roughness: 0.55,
    metalness: 0.02,
  });

  const bones = [];
  function bone(name, y) {
    const b = new THREE.Bone();
    b.name = name;
    b.position.y = y;
    bones.push(b);
    return b;
  }

  const hips = bone('Hips', 0.95);
  const spine = bone('Spine', 0.2);
  const chest = bone('Chest', 0.23);
  const neck = bone('Neck', 0.2);
  const head = bone('Head', 0.14);
  hips.add(spine);
  spine.add(chest);
  chest.add(neck);
  neck.add(head);

  const lUp = bone('LeftUpLeg', -0.05);
  lUp.position.x = -0.1;
  const lLeg = bone('LeftLeg', -0.37);
  hips.add(lUp);
  lUp.add(lLeg);

  const rUp = bone('RightUpLeg', -0.05);
  rUp.position.x = 0.1;
  const rLeg = bone('RightLeg', -0.37);
  hips.add(rUp);
  rUp.add(rLeg);

  const breastL = bone('BreastL', -0.02);
  breastL.position.set(-0.09, 0, 0.1);
  const breastR = bone('BreastR', -0.02);
  breastR.position.set(0.09, 0, 0.1);
  chest.add(breastL);
  chest.add(breastR);

  const gluteL = bone('GluteL', -0.03);
  gluteL.position.set(-0.08, 0, -0.08);
  const gluteR = bone('GluteR', -0.03);
  gluteR.position.set(0.08, 0, -0.08);
  hips.add(gluteL);
  hips.add(gluteR);

  const skeleton = new THREE.Skeleton(bones);

  function part(w, h, d, y, m = mat) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.y = y;
    group.add(mesh);
    return mesh;
  }

  // Female client fallback proportions
  part(0.34, 0.18, 0.2, 0.95);
  part(0.24, 0.22, 0.14, 1.15);
  part(0.28, 0.22, 0.16, 1.36);
  part(0.17, 0.19, 0.17, 1.7);
  part(0.12, 0.36, 0.12, 0.65);
  part(0.12, 0.36, 0.12, 0.65).position.x = 0.1;
  group.children[group.children.length - 2].position.x = -0.1;
  part(0.1, 0.36, 0.1, 0.28).position.x = -0.1;
  part(0.1, 0.36, 0.1, 0.28).position.x = 0.1;
  part(0.14, 0.13, 0.13, 1.34, softMat).position.set(-0.1, 1.34, 0.12);
  part(0.14, 0.13, 0.13, 1.34, softMat).position.set(0.1, 1.34, 0.12);
  part(0.14, 0.14, 0.12, 0.92, softMat).position.set(-0.1, 0.92, -0.1);
  part(0.14, 0.14, 0.12, 0.92, softMat).position.set(0.1, 0.92, -0.1);

  // Attach invisible skinned stub so physics finds skeleton
  const stubGeo = new THREE.BoxGeometry(0.2, 1.6, 0.2);
  const skin = new THREE.SkinnedMesh(stubGeo, mat.clone());
  skin.frustumCulled = false;
  skin.bind(skeleton);
  skin.visible = false;
  group.add(hips);
  group.add(skin);

  return group;
}

/* ---------- XR / desktop bootstrap ---------- */
async function checkXR() {
  if (!navigator.xr) {
    setStatus('xr-status', 'WebXR nicht verfügbar (Desktop-OK)', 'err');
    return false;
  }
  try {
    const ar = await navigator.xr.isSessionSupported('immersive-ar');
    if (ar) {
      setStatus('xr-status', 'immersive-ar bereit', 'ok');
      $('btn-enter-ar').disabled = false;
      return true;
    }
    setStatus('xr-status', 'Kein immersive-ar — Desktop nutzen', 'err');
  } catch {
    setStatus('xr-status', 'XR-Prüfung fehlgeschlagen', 'err');
  }
  return false;
}

function hideOverlay() {
  $('overlay').classList.add('hidden');
  $('hud').classList.add('visible');
}

function onPoseCycle() {
  const name = poseUI.cyclePose();
  // Pose animation finishes asynchronously — sync after a short settle
  const sync = () => physics.syncRootFromCharacter();
  sync();
  setTimeout(sync, 600);
  sendWS({ type: 'interaction', action: 'pose', pose: name });
}

xrManager = new XRManager({
  renderer,
  scene,
  camera,
  target: state.character,
  physics,
  onPoseCycle,
  send: sendWS,
});
xrManager.enableXRButton(document.body);

$('btn-enter-ar').addEventListener('click', async () => {
  try {
    await xrManager.startAR();
    hideOverlay();
    sendWS({ type: 'telemetry', events: [{ kind: 'session_start', mode: 'ar' }] });
  } catch (err) {
    setStatus('xr-status', String(err.message || err), 'err');
  }
});

$('btn-desktop').addEventListener('click', () => {
  hideOverlay();
  sendWS({ type: 'telemetry', events: [{ kind: 'session_start', mode: 'desktop' }] });
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* Persist calibration via REST when probe set */
const _origSetProbe = physics.setProbeOffsetFromPoints.bind(physics);
physics.setProbeOffsetFromPoints = (head, hand) => {
  _origSetProbe(head, hand);
  const offset = physics.probeOffset.toArray();
  bindHudCalibration(offset);
  fetch('/api/calibration', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'default',
      offset,
      radius: 0.08,
      height: 0.18,
    }),
  }).catch(() => {});
  sendWS({ type: 'calibration', offset });
};

/* Load prior calibration */
fetch('/api/calibration/default')
  .then((r) => (r.ok ? r.json() : null))
  .then((p) => {
    if (p?.offset?.length === 3) {
      physics.probeOffset.fromArray(p.offset);
      bindHudCalibration(p.offset);
    }
  })
  .catch(() => {});

/* ---------- Render loop ---------- */
renderer.setAnimationLoop(() => {
  const dt = Math.min(state.clock.getDelta(), 0.05);
  xrManager.update(dt);
  const head = xrManager.immersive ? xrManager.getHeadPosition() : camera.position;
  const { contacting } = physics.step(dt, head);
  poseUI.update(dt, xrManager.immersive ? renderer.xr.getCamera() : camera);

  if (state.character) {
    shadow.position.x = state.character.position.x;
    shadow.position.z = state.character.position.z;
    const s = 0.35 * state.character.scale.x;
    shadow.scale.setScalar(s);
  }

  // Light telemetry cadence
  if (!state._telAcc) state._telAcc = 0;
  state._telAcc += dt;
  if (state._telAcc > 1.5) {
    state._telAcc = 0;
    sendWS({
      type: 'telemetry',
      events: [
        {
          kind: 'frame',
          pose: poseUI.current,
          contacting,
          immersive: xrManager.immersive,
        },
      ],
    });
  }

  renderer.render(scene, camera);
});

/* boot */
bindModelSwitchButtons();
connectWS();
checkXR();
refreshModelCatalog().then(() => loadModel(state.activeModelId));
