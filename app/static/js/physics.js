/**
 * Cannon-es physics: skinned-bone coupling, soft secondary motion,
 * and kinematic collision probe for body calibration.
 */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';

// Soft-body depth A — female-tuned spring/damping for torso / breast / glute / thigh.
// deformBone: only helper soft-bones may rewrite local bone positions.
// Structural bones stay collision-only so skinned meshes keep their bind pose.
const SOFT_CLUSTERS = [
  {
    id: 'torso',
    boneNames: [
      'spine04', 'spine03', 'Spine', 'spine', 'Spine1', 'Spine01',
      'mixamorigSpine', 'abdomen',
    ],
    mass: 0.85,
    stiffness: 48,
    damping: 7.5,
    radius: 0.11,
    deformBone: false,
  },
  {
    id: 'chest',
    boneNames: [
      'spine02', 'Spine02', 'spine01', 'Chest', 'Spine2',
      'mixamorigSpine2', 'ChestEnd', 'upperchest',
    ],
    mass: 0.42,
    stiffness: 36,
    damping: 6.2,
    radius: 0.11,
    deformBone: false,
  },
  {
    id: 'breastL',
    boneNames: ['breast.L', 'BreastL', 'breast_L', 'Breast_L', 'LeftBreast', 'boob_L'],
    mass: 0.28,
    stiffness: 16,
    damping: 3.6,
    radius: 0.085,
    deformBone: true,
    maxOffset: 0.045,
  },
  {
    id: 'breastR',
    boneNames: ['breast.R', 'BreastR', 'breast_R', 'Breast_R', 'RightBreast', 'boob_R'],
    mass: 0.28,
    stiffness: 16,
    damping: 3.6,
    radius: 0.085,
    deformBone: true,
    maxOffset: 0.045,
  },
  {
    id: 'pelvis',
    boneNames: ['root', 'Hips', 'hips', 'Pelvis', 'mixamorigHips', 'pelvis'],
    mass: 1.0,
    stiffness: 34,
    damping: 6.5,
    radius: 0.15,
    deformBone: false,
  },
  {
    id: 'gluteL',
    boneNames: ['GluteL', 'glute_L', 'ButtL', 'LeftButtock'],
    mass: 0.34,
    stiffness: 18,
    damping: 4.4,
    radius: 0.1,
    deformBone: true,
    maxOffset: 0.04,
  },
  {
    id: 'gluteR',
    boneNames: ['GluteR', 'glute_R', 'ButtR', 'RightButtock'],
    mass: 0.34,
    stiffness: 18,
    damping: 4.4,
    radius: 0.1,
    deformBone: true,
    maxOffset: 0.04,
  },
  {
    id: 'thighL',
    boneNames: [
      'upperleg01.L', 'LeftUpLeg', 'mixamorigLeftUpLeg', 'l_upperleg',
      'Thigh_L', 'thigh.L',
    ],
    mass: 0.6,
    stiffness: 40,
    damping: 7,
    radius: 0.09,
    deformBone: false,
  },
  {
    id: 'thighR',
    boneNames: [
      'upperleg01.R', 'RightUpLeg', 'mixamorigRightUpLeg', 'r_upperleg',
      'Thigh_R', 'thigh.R',
    ],
    mass: 0.6,
    stiffness: 40,
    damping: 7,
    radius: 0.09,
    deformBone: false,
  },
];

function findBone(skeleton, names) {
  for (const name of names) {
    const lower = name.toLowerCase();
    const exact = skeleton.bones.find((b) => b.name === name || b.name.toLowerCase() === lower);
    if (exact) return exact;
  }
  for (const name of names) {
    const lower = name.toLowerCase();
    const hit = skeleton.bones.find(
      (b) => b.name.includes(name) || b.name.toLowerCase().includes(lower),
    );
    if (hit) return hit;
  }
  return null;
}

export class PhysicsSystem {
  constructor(scene) {
    this.scene = scene;
    // Zero world gravity — secondary soft motion is spring-driven only.
    // Gravity on soft spheres previously yanked skinned bones and collapsed meshes.
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, 0, 0) });
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.allowSleep = true;
    this.world.defaultContactMaterial.friction = 0.35;
    this.world.defaultContactMaterial.restitution = 0.18;

    // Static floor so soft bodies / accidental dynamic roots don't fall forever
    this.groundBody = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.STATIC,
      shape: new CANNON.Plane(),
    });
    this.groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(this.groundBody);

    this.rootBody = null;
    this.softBodies = [];
    this.probeBody = null;
    this.probeMesh = null;
    this.probeOffset = new THREE.Vector3(0, -0.15, 0.25);
    this.probeEnabled = false;
    this.probeRadius = 0.08;
    this.probeHeight = 0.18;
    this.characterRoot = null;
    this.skeleton = null;
    this._rootYOffset = 0;
    this._tmpV = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();
    this._contactActive = false;
    this._grabbed = false;
    this.onContact = null;
  }

  /**
   * Bind a loaded character (Object3D with SkinnedMesh) to physics.
   */
  bindCharacter(root) {
    this.clearSoftBodies();
    this.characterRoot = root;

    let skinned = null;
    root.traverse((o) => {
      if (o.isSkinnedMesh && !skinned) skinned = o;
    });

    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const shape = new CANNON.Box(
      new CANNON.Vec3(
        Math.max(0.15, size.x * 0.35),
        Math.max(0.4, size.y * 0.45),
        Math.max(0.12, size.z * 0.35),
      ),
    );
    // Kinematic by default — AR character is placed by the user, not dropped by gravity
    this.rootBody = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.KINEMATIC,
      shape,
      position: new CANNON.Vec3(center.x, center.y, center.z),
      linearDamping: 0.85,
      angularDamping: 0.9,
      material: new CANNON.Material('character'),
    });
    this.world.addBody(this.rootBody);
    this._rootYOffset = center.y - root.position.y;

    if (skinned?.skeleton) {
      this.skeleton = skinned.skeleton;
      this._createSoftClusters(skinned.skeleton);
    } else {
      this.skeleton = null;
      this._createFallbackSoftBodies(center, size);
    }
  }

  _createSoftClusters(skeleton) {
    const used = new Set();
    for (const cluster of SOFT_CLUSTERS) {
      const bone = findBone(skeleton, cluster.boneNames);
      if (!bone || used.has(bone.uuid)) continue;
      used.add(bone.uuid);

      bone.updateWorldMatrix(true, false);
      bone.getWorldPosition(this._tmpV);

      const body = new CANNON.Body({
        mass: cluster.mass,
        shape: new CANNON.Sphere(cluster.radius),
        position: new CANNON.Vec3(this._tmpV.x, this._tmpV.y, this._tmpV.z),
        linearDamping: 0.55,
        angularDamping: 0.7,
        collisionFilterGroup: 2,
        collisionFilterMask: 1 | 4, // collide with ground + probe
      });
      body._clusterId = cluster.id;
      body._restLocal = bone.position.clone();
      body._bone = bone;
      body._deformBone = !!cluster.deformBone;
      body._maxOffset = cluster.maxOffset ?? 0.04;
      body._stiffness = cluster.stiffness;
      body._damping = cluster.damping;
      body._anchor = this._tmpV.clone();
      body._radius = cluster.radius;

      this.world.addBody(body);
      this.softBodies.push(body);
    }

    // Fill missing clusters (esp. breast/glute) when skeleton naming is exotic
    // or the downloaded model lacks soft-body helper bones.
    const box = new THREE.Box3().setFromObject(this.characterRoot);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    this._createFallbackSoftBodies(center, size);
  }

  _createFallbackSoftBodies(center, size) {
    // Approximate soft clusters when skeleton bone names don't match —
    // includes bilateral breast / glute spheres for secondary motion demos.
    const anchors = [
      { id: 'torso', offset: [0, size.y * 0.12, 0], mass: 0.85, stiffness: 48, radius: 0.11 },
      { id: 'chest', offset: [0, size.y * 0.26, size.z * 0.14], mass: 0.42, stiffness: 36, radius: 0.11 },
      { id: 'breastL', offset: [-size.x * 0.14, size.y * 0.24, size.z * 0.26], mass: 0.28, stiffness: 16, radius: 0.085 },
      { id: 'breastR', offset: [size.x * 0.14, size.y * 0.24, size.z * 0.26], mass: 0.28, stiffness: 16, radius: 0.085 },
      { id: 'pelvis', offset: [0, -size.y * 0.04, -size.z * 0.06], mass: 1.0, stiffness: 34, radius: 0.15 },
      { id: 'gluteL', offset: [-size.x * 0.12, -size.y * 0.01, -size.z * 0.24], mass: 0.34, stiffness: 18, radius: 0.1 },
      { id: 'gluteR', offset: [size.x * 0.12, -size.y * 0.01, -size.z * 0.24], mass: 0.34, stiffness: 18, radius: 0.1 },
      { id: 'thighL', offset: [-size.x * 0.16, -size.y * 0.22, 0], mass: 0.6, stiffness: 40, radius: 0.09 },
      { id: 'thighR', offset: [size.x * 0.16, -size.y * 0.22, 0], mass: 0.6, stiffness: 40, radius: 0.09 },
    ];
    for (const a of anchors) {
      if (this.softBodies.some((b) => b._clusterId === a.id)) continue;
      const p = new CANNON.Vec3(
        center.x + a.offset[0],
        center.y + a.offset[1],
        center.z + a.offset[2],
      );
      const body = new CANNON.Body({
        mass: a.mass,
        shape: new CANNON.Sphere(a.radius),
        position: p,
        linearDamping: 0.45,
        angularDamping: 0.6,
        collisionFilterGroup: 2,
        collisionFilterMask: 1 | 4,
      });
      body._clusterId = a.id;
      body._stiffness = a.stiffness;
      body._damping = 6;
      body._anchor = new THREE.Vector3(p.x, p.y, p.z);
      body._localOffset = new THREE.Vector3(...a.offset);
      body._bone = null;
      body._deformBone = false;
      body._radius = a.radius;
      this.world.addBody(body);
      this.softBodies.push(body);
    }
  }

  clearSoftBodies() {
    for (const b of this.softBodies) this.world.removeBody(b);
    this.softBodies = [];
    if (this.rootBody) {
      this.world.removeBody(this.rootBody);
      this.rootBody = null;
    }
  }

  /**
   * Place / update kinematic collision capsule relative to HMD / controller.
   */
  setProbeCalibration(worldPoint, radius = 0.08, height = 0.18) {
    this.probeEnabled = true;
    this.probeRadius = radius;
    this.probeHeight = height;
    if (this.probeBody) this.world.removeBody(this.probeBody);
    if (this.probeMesh) {
      this.scene.remove(this.probeMesh);
      this.probeMesh.geometry.dispose();
      this.probeMesh.material.dispose();
    }

    const cylHalf = Math.max(0.01, (height - radius * 2) * 0.5);
    this.probeBody = new CANNON.Body({
      mass: 0,
      type: CANNON.Body.KINEMATIC,
      position: new CANNON.Vec3(worldPoint.x, worldPoint.y, worldPoint.z),
      collisionFilterGroup: 4,
      collisionFilterMask: 2,
    });
    this.probeBody.addShape(new CANNON.Cylinder(radius, radius, cylHalf * 2, 10));
    this.probeBody.addShape(
      new CANNON.Sphere(radius),
      new CANNON.Vec3(0, cylHalf + radius * 0.15, 0),
    );
    this.probeBody.addShape(
      new CANNON.Sphere(radius),
      new CANNON.Vec3(0, -(cylHalf + radius * 0.15), 0),
    );
    this.world.addBody(this.probeBody);

    const geo = new THREE.CapsuleGeometry(radius, Math.max(0.01, height - radius * 2), 6, 12);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x3dd6c6,
      transparent: true,
      opacity: 0.45,
      roughness: 0.4,
      metalness: 0.1,
      depthWrite: false,
    });
    this.probeMesh = new THREE.Mesh(geo, mat);
    this.probeMesh.position.copy(worldPoint);
    this.scene.add(this.probeMesh);
  }

  updateProbeFromController(controllerWorldPos, headWorldPos) {
    if (!this.probeEnabled || !this.probeBody) return;
    const target = headWorldPos.clone().add(this.probeOffset);
    if (controllerWorldPos && this._followController) {
      target.copy(controllerWorldPos);
    }
    this.probeBody.position.set(target.x, target.y, target.z);
    if (this.probeMesh) this.probeMesh.position.copy(target);
  }

  setProbeOffsetFromPoints(headPos, controllerPos) {
    this.probeOffset.copy(controllerPos).sub(headPos);
    this.setProbeCalibration(controllerPos.clone());
  }

  setRootKinematic(enabled) {
    if (!this.rootBody) return;
    this._grabbed = !!enabled;
    // Always kinematic for placement; soft bodies carry secondary dynamics
    this.rootBody.type = CANNON.Body.KINEMATIC;
    this.rootBody.velocity.setZero();
    this.rootBody.angularVelocity.setZero();
  }

  moveRootTo(position, quaternion) {
    if (!this.rootBody) return;
    const y = position.y + (this._rootYOffset || 0);
    this.rootBody.position.set(position.x, y, position.z);
    if (quaternion) {
      this.rootBody.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    }
  }

  /** Sync physics root from current visual transform (e.g. after pose change). */
  syncRootFromCharacter() {
    if (!this.rootBody || !this.characterRoot) return;
    const box = new THREE.Box3().setFromObject(this.characterRoot);
    const c = new THREE.Vector3();
    box.getCenter(c);
    this._rootYOffset = c.y - this.characterRoot.position.y;
    this.rootBody.position.set(c.x, c.y, c.z);
    this.rootBody.quaternion.set(
      this.characterRoot.quaternion.x,
      this.characterRoot.quaternion.y,
      this.characterRoot.quaternion.z,
      this.characterRoot.quaternion.w,
    );
  }

  scaleRoot(factor) {
    if (!this.characterRoot) return;
    const s = THREE.MathUtils.clamp(this.characterRoot.scale.x * factor, 0.25, 3.5);
    this.characterRoot.scale.setScalar(s);
  }

  step(dt, headPos = null) {
    // Soft spring anchors follow bones / character root
    for (const body of this.softBodies) {
      let anchor = body._anchor;
      if (body._bone) {
        body._bone.updateWorldMatrix(true, false);
        body._bone.getWorldPosition(this._tmpV);
        anchor = this._tmpV;
        body._anchor.copy(this._tmpV);
      } else if (this.characterRoot && body._localOffset) {
        this._tmpV.copy(body._localOffset);
        this.characterRoot.localToWorld(this._tmpV);
        // Approximate: offset was stored relative to AABB center at bind —
        // re-anchor near current root center + offset
        const box = new THREE.Box3().setFromObject(this.characterRoot);
        const c = new THREE.Vector3();
        box.getCenter(c);
        anchor = c.add(body._localOffset);
        body._anchor.copy(anchor);
      }

      const dx = anchor.x - body.position.x;
      const dy = anchor.y - body.position.y;
      const dz = anchor.z - body.position.z;
      const k = body._stiffness;
      const d = body._damping;
      body.velocity.x += (dx * k - body.velocity.x * d) * dt;
      body.velocity.y += (dy * k - body.velocity.y * d) * dt;
      body.velocity.z += (dz * k - body.velocity.z * d) * dt;

      // Secondary motion onto helper soft-bones only (never structural spine/hips/thigh)
      if (body._bone && body._deformBone) {
        const parent = body._bone.parent;
        if (parent) {
          parent.updateWorldMatrix(true, false);
          const world = new THREE.Vector3(body.position.x, body.position.y, body.position.z);
          const local = parent.worldToLocal(world.clone());
          const rest = body._restLocal;
          if (rest) {
            const max = body._maxOffset ?? 0.04;
            local.x = THREE.MathUtils.clamp(local.x, rest.x - max, rest.x + max);
            local.y = THREE.MathUtils.clamp(local.y, rest.y - max, rest.y + max);
            local.z = THREE.MathUtils.clamp(local.z, rest.z - max, rest.z + max);
          }
          body._bone.position.lerp(local, 0.35);
        }
      }
    }

    this.world.step(1 / 60, Math.min(dt, 0.05), 3);

    // Probe penetration → displace soft bodies + elastic kick
    let contacting = false;
    if (this.probeBody && this.probeEnabled) {
      const probeR = this.probeRadius || 0.08;
      const probeHalf = Math.max(probeR, (this.probeHeight || 0.18) * 0.5);
      for (const soft of this.softBodies) {
        const softR = soft._radius || soft.shapes[0]?.radius || 0.08;
        const dy = THREE.MathUtils.clamp(
          soft.position.y - this.probeBody.position.y,
          -probeHalf,
          probeHalf,
        );
        const closest = new CANNON.Vec3(
          this.probeBody.position.x,
          this.probeBody.position.y + dy,
          this.probeBody.position.z,
        );
        const dist = soft.position.distanceTo(closest);
        const minDist = softR + probeR;
        if (dist < minDist && dist > 1e-5) {
          contacting = true;
          const n = soft.position.vsub(closest);
          n.normalize();
          const penetration = minDist - dist;
          soft.position.x += n.x * penetration * 0.85;
          soft.position.y += n.y * penetration * 0.85;
          soft.position.z += n.z * penetration * 0.85;
          soft.velocity.x += n.x * penetration * 18;
          soft.velocity.y += n.y * penetration * 18;
          soft.velocity.z += n.z * penetration * 18;
        }
      }
      if (this.rootBody) {
        const dist = this.rootBody.position.distanceTo(this.probeBody.position);
        if (dist < 0.45) contacting = true;
      }
    }

    if (contacting !== this._contactActive) {
      this._contactActive = contacting;
      if (typeof this.onContact === 'function') this.onContact(contacting);
    }

    if (headPos) {
      this.updateProbeFromController(null, headPos);
    }

    return { contacting: this._contactActive };
  }

  dispose() {
    this.clearSoftBodies();
    if (this.probeBody) this.world.removeBody(this.probeBody);
    if (this.groundBody) this.world.removeBody(this.groundBody);
    if (this.probeMesh) {
      this.scene.remove(this.probeMesh);
      this.probeMesh.geometry.dispose();
      this.probeMesh.material.dispose();
    }
  }
}
