/**
 * Pose management + floating VR dashboard (3D UI panel).
 */
import * as THREE from 'three';

export const POSES = {
  standing: {
    label: 'Stehend',
    root: { position: [0, 0, -1.5], rotation: [0, 0, 0], scale: 1 },
    bones: {},
  },
  lying: {
    label: 'Liegend',
    root: { position: [0, 0.15, -1.5], rotation: [-Math.PI / 2, 0, 0], scale: 1 },
    bones: {
      LeftUpLeg: [0.2, 0, 0],
      RightUpLeg: [-0.2, 0, 0],
    },
  },
  kneeling: {
    label: 'Kniend',
    root: { position: [0, -0.35, -1.4], rotation: [0.15, 0, 0], scale: 1 },
    bones: {
      LeftUpLeg: [1.2, 0, 0],
      RightUpLeg: [1.2, 0, 0],
      LeftLeg: [-2.1, 0, 0],
      RightLeg: [-2.1, 0, 0],
    },
  },
  supine: {
    label: 'Rückenlage',
    root: { position: [0, 0.2, -1.5], rotation: [Math.PI / 2, Math.PI, 0], scale: 1 },
    bones: {},
  },
  sitting: {
    label: 'Sitzend',
    root: { position: [0, -0.45, -1.35], rotation: [0.35, 0, 0], scale: 1 },
    bones: {
      LeftUpLeg: [1.35, 0, 0],
      RightUpLeg: [1.35, 0, 0],
      LeftLeg: [-1.2, 0, 0],
      RightLeg: [-1.2, 0, 0],
    },
  },
};

const POSE_ORDER = ['standing', 'lying', 'kneeling', 'supine', 'sitting'];

function makePanelTexture(title, lines, activeIndex) {
  const w = 512;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = 'rgba(10, 16, 30, 0.92)';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(20, 20, w - 40, h - 40, 28);
    ctx.fill();
  } else {
    ctx.fillRect(20, 20, w - 40, h - 40);
  }

  ctx.strokeStyle = 'rgba(61, 214, 198, 0.55)';
  ctx.lineWidth = 4;
  ctx.strokeRect(28, 28, w - 56, h - 56);

  ctx.fillStyle = '#e8eefc';
  ctx.font = 'bold 42px Segoe UI, sans-serif';
  ctx.fillText(title, 56, 100);

  ctx.font = '28px Segoe UI, sans-serif';
  lines.forEach((line, i) => {
    const y = 170 + i * 52;
    if (i === activeIndex) {
      ctx.fillStyle = 'rgba(61, 214, 198, 0.22)';
      ctx.fillRect(48, y - 34, w - 96, 46);
      ctx.fillStyle = '#3dd6c6';
    } else {
      ctx.fillStyle = '#9aa8c7';
    }
    ctx.fillText(line, 64, y);
  });

  ctx.fillStyle = '#9aa8c7';
  ctx.font = '22px Segoe UI, sans-serif';
  ctx.fillText('B / Y  →  nächste Pose', 56, h - 70);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export class PoseUI {
  constructor(scene, characterRoot) {
    this.scene = scene;
    this.characterRoot = characterRoot;
    this.current = 'standing';
    this.index = 0;
    this.panel = null;
    this.panelVisible = true;
    this._boneCache = new Map();

    this._buildPanel();
    this._cacheBones();
  }

  setCharacter(root) {
    this.characterRoot = root;
    this._boneCache.clear();
    this._cacheBones();
    this.applyPose(this.current, true);
  }

  _cacheBones() {
    if (!this.characterRoot) return;
    this.characterRoot.traverse((o) => {
      if (o.isBone) this._boneCache.set(o.name, o);
    });
  }

  _findBone(name) {
    if (this._boneCache.has(name)) return this._boneCache.get(name);

    // Map common Mixamo / procedural names → MakeHuman female rig
    const aliases = {
      LeftUpLeg: ['upperleg01.L', 'upperleg02.L'],
      RightUpLeg: ['upperleg01.R', 'upperleg02.R'],
      LeftLeg: ['lowerleg01.L', 'lowerleg02.L'],
      RightLeg: ['lowerleg01.R', 'lowerleg02.R'],
      Hips: ['root', 'pelvis.L', 'pelvis.R'],
      Spine: ['spine04', 'spine03', 'spine05'],
      Chest: ['spine02', 'spine01'],
      BreastL: ['breast.L'],
      BreastR: ['breast.R'],
    };
    for (const alt of aliases[name] || []) {
      if (this._boneCache.has(alt)) return this._boneCache.get(alt);
    }

    for (const [n, bone] of this._boneCache) {
      if (n.includes(name) || n.toLowerCase().includes(name.toLowerCase())) return bone;
    }
    // Mixamo prefixes
    const mix = this._boneCache.get(`mixamorig${name}`) || this._boneCache.get(`mixamorig:${name}`);
    return mix || null;
  }

  _buildPanel() {
    const tex = makePanelTexture(
      'Posen',
      POSE_ORDER.map((k) => POSES[k].label),
      this.index,
    );
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: true,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.55), mat);
    mesh.position.set(0.55, 1.35, -1.1);
    mesh.name = 'PoseDashboard';
    this.panel = mesh;
    this.scene.add(mesh);
  }

  refreshPanel() {
    if (!this.panel) return;
    const old = this.panel.material.map;
    const tex = makePanelTexture(
      'Posen',
      POSE_ORDER.map((k) => POSES[k].label),
      this.index,
    );
    this.panel.material.map = tex;
    this.panel.material.needsUpdate = true;
    old?.dispose();
  }

  setPanelVisible(v) {
    this.panelVisible = v;
    if (this.panel) this.panel.visible = v;
  }

  togglePanel() {
    this.setPanelVisible(!this.panelVisible);
  }

  cyclePose() {
    this.index = (this.index + 1) % POSE_ORDER.length;
    this.current = POSE_ORDER[this.index];
    this.applyPose(this.current);
    this.refreshPanel();
    this._updateHud();
    return this.current;
  }

  setPose(name) {
    const idx = POSE_ORDER.indexOf(name);
    if (idx < 0) return;
    this.index = idx;
    this.current = name;
    this.applyPose(name);
    this.refreshPanel();
    this._updateHud();
  }

  applyPose(name, instant = false) {
    const pose = POSES[name];
    if (!pose || !this.characterRoot) return;

    const { position, rotation, scale } = pose.root;
    const targetPos = new THREE.Vector3(...position);
    const targetQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation));
    const targetScale = scale;

    if (instant) {
      this.characterRoot.position.copy(targetPos);
      this.characterRoot.quaternion.copy(targetQuat);
      this.characterRoot.scale.setScalar(targetScale);
    } else {
      this._anim = {
        t: 0,
        duration: 0.55,
        fromPos: this.characterRoot.position.clone(),
        toPos: targetPos,
        fromQuat: this.characterRoot.quaternion.clone(),
        toQuat: targetQuat,
        fromScale: this.characterRoot.scale.x,
        toScale: targetScale,
      };
    }

    for (const [boneName, euler] of Object.entries(pose.bones)) {
      const bone = this._findBone(boneName);
      if (!bone) continue;
      bone.rotation.set(euler[0], euler[1], euler[2]);
    }

    // Reset soft bones not listed to rest-ish
    if (!Object.keys(pose.bones).length) {
      for (const bone of this._boneCache.values()) {
        if (/breast|glute|Breast|Glute/i.test(bone.name)) continue;
      }
    }
  }

  update(dt, camera) {
    if (this._anim && this.characterRoot) {
      this._anim.t += dt;
      const u = Math.min(1, this._anim.t / this._anim.duration);
      const e = 1 - Math.pow(1 - u, 3);
      this.characterRoot.position.lerpVectors(this._anim.fromPos, this._anim.toPos, e);
      this.characterRoot.quaternion.slerpQuaternions(this._anim.fromQuat, this._anim.toQuat, e);
      const s = THREE.MathUtils.lerp(this._anim.fromScale, this._anim.toScale, e);
      this.characterRoot.scale.setScalar(s);
      if (u >= 1) this._anim = null;
    }

    // Keep dashboard in front of user at comfortable distance
    if (this.panel && this.panelVisible && camera) {
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      forward.y = 0;
      if (forward.lengthSq() > 1e-5) forward.normalize();
      else forward.set(0, 0, -1);
      const pos = new THREE.Vector3();
      camera.getWorldPosition(pos);
      const target = pos.clone().add(forward.multiplyScalar(1.2));
      target.y = pos.y + 0.05;
      this.panel.position.lerp(target, 0.08);
      this.panel.lookAt(pos);
    }
  }

  _updateHud() {
    const el = document.getElementById('hud-pose');
    if (el) el.textContent = `Pose: ${POSES[this.current]?.label || this.current}`;
  }
}

export function bindHudCalibration(offset) {
  const el = document.getElementById('hud-calib');
  if (!el) return;
  if (!offset) {
    el.textContent = 'Kalibrierung: —';
    return;
  }
  el.textContent = `Kalibrierung: [${offset.map((v) => v.toFixed(2)).join(', ')}]`;
}

export function bindHudContact(active) {
  const el = document.getElementById('hud-contact');
  if (!el) return;
  el.textContent = `Kontakt: ${active ? 'ja' : 'nein'}`;
  el.classList.toggle('hit', !!active);
}
