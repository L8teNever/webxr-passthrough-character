/**
 * WebXR immersive-AR session, dual Quest controllers, grab/scale/rotate,
 * haptics, and desktop fallback controls.
 */
import * as THREE from 'three';

export class XRManager {
  /**
   * @param {object} opts
   * @param {THREE.WebGLRenderer} opts.renderer
   * @param {THREE.Scene} opts.scene
   * @param {THREE.PerspectiveCamera} opts.camera
   * @param {THREE.Object3D} opts.target — character root to manipulate
   * @param {import('./physics.js').PhysicsSystem} opts.physics
   * @param {(poseName: string) => void} [opts.onPoseCycle]
   * @param {(msg: object) => void} [opts.send]
   */
  constructor({ renderer, scene, camera, target, physics, onPoseCycle, send }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.target = target;
    this.physics = physics;
    this.onPoseCycle = onPoseCycle;
    this.send = send || (() => {});

    this.controller0 = null;
    this.controller1 = null;
    this.controllerGrip0 = null;
    this.controllerGrip1 = null;
    this.raycaster = new THREE.Raycaster();
    this.tempMatrix = new THREE.Matrix4();
    this.grabbing = { 0: null, 1: null };
    this.prevTrigger = { 0: false, 1: false };
    this.prevGrip = { 0: false, 1: false };
    this.prevA = { 0: false, 1: false };
    this.prevB = { 0: false, 1: false };
    this.twoHandStartDist = null;
    this.twoHandStartScale = 1;
    this.session = null;
    this.immersive = false;

    // Desktop fallback
    this.desktop = {
      dragging: false,
      rightDown: false,
      prev: new THREE.Vector2(),
      spherical: new THREE.Spherical(2.4, Math.PI / 2.4, 0.4),
    };

    this._setupControllers();
    this._setupDesktop();
  }

  _setupControllers() {
    const makeRay = () => {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -1),
      ]);
      const line = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({ color: 0x3dd6c6, transparent: true, opacity: 0.7 }),
      );
      line.scale.z = 1.2;
      line.name = 'ray';
      return line;
    };

    for (let i = 0; i < 2; i++) {
      const controller = this.renderer.xr.getController(i);
      controller.add(makeRay());
      controller.userData.index = i;
      controller.addEventListener('selectstart', () => this._onSelectStart(i));
      controller.addEventListener('selectend', () => this._onSelectEnd(i));
      controller.addEventListener('squeezestart', () => this._onSqueezeStart(i));
      controller.addEventListener('squeezeend', () => this._onSqueezeEnd(i));
      this.scene.add(controller);
      if (i === 0) this.controller0 = controller;
      else this.controller1 = controller;

      const grip = this.renderer.xr.getControllerGrip(i);
      this.scene.add(grip);
      if (i === 0) this.controllerGrip0 = grip;
      else this.controllerGrip1 = grip;
    }
  }

  _setupDesktop() {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      if (this.immersive) return;
      if (e.button === 0) {
        this.desktop.dragging = true;
        this.desktop.prev.set(e.clientX, e.clientY);
      }
      if (e.button === 2) {
        this.desktop.rightDown = true;
        this._desktopGrab(true);
      }
    });
    window.addEventListener('pointerup', (e) => {
      if (e.button === 0) this.desktop.dragging = false;
      if (e.button === 2) {
        this.desktop.rightDown = false;
        this._desktopGrab(false);
      }
    });
    window.addEventListener('pointermove', (e) => {
      if (this.immersive) return;
      if (this.desktop.dragging) {
        const dx = e.clientX - this.desktop.prev.x;
        const dy = e.clientY - this.desktop.prev.y;
        this.desktop.prev.set(e.clientX, e.clientY);
        this.desktop.spherical.theta -= dx * 0.005;
        this.desktop.spherical.phi = THREE.MathUtils.clamp(
          this.desktop.spherical.phi + dy * 0.005,
          0.2,
          Math.PI - 0.2,
        );
      }
      if (this.desktop.rightDown && this.target) {
        const ndc = new THREE.Vector2(
          (e.clientX / window.innerWidth) * 2 - 1,
          -(e.clientY / window.innerHeight) * 2 + 1,
        );
        this.raycaster.setFromCamera(ndc, this.camera);
        const hit = new THREE.Vector3();
        this.raycaster.ray.at(2.0, hit);
        this.target.position.lerp(hit, 0.35);
        this.physics?.moveRootTo(this.target.position, this.target.quaternion);
      }
    });
    el.addEventListener(
      'wheel',
      (e) => {
        if (this.immersive) return;
        this.desktop.spherical.radius = THREE.MathUtils.clamp(
          this.desktop.spherical.radius + e.deltaY * 0.002,
          0.8,
          6,
        );
      },
      { passive: true },
    );
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _desktopGrab(active) {
    this.physics?.setRootKinematic(active);
    if (active) this.pulseHaptic(0, 0.4, 40);
  }

  async startAR() {
    if (!navigator.xr) throw new Error('WebXR nicht verfügbar');
    const ok = await navigator.xr.isSessionSupported('immersive-ar');
    if (!ok) throw new Error('immersive-ar nicht unterstützt');

    // Prefer full feature set; fall back if Quest rejects optional flags / dom-overlay
    const attempts = [
      {
        requiredFeatures: ['local-floor'],
        optionalFeatures: ['hand-tracking', 'hit-test', 'dom-overlay'],
        domOverlay: { root: document.getElementById('hud') },
      },
      {
        requiredFeatures: ['local-floor'],
        optionalFeatures: ['hand-tracking'],
      },
      {
        requiredFeatures: ['local-floor'],
        optionalFeatures: [],
      },
    ];

    let session = null;
    let lastErr = null;
    for (const opts of attempts) {
      try {
        session = await navigator.xr.requestSession('immersive-ar', opts);
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!session) {
      throw lastErr || new Error('immersive-ar Session fehlgeschlagen');
    }

    await this.renderer.xr.setSession(session);
    this.session = session;
    this.immersive = true;
    session.addEventListener('end', () => {
      this.immersive = false;
      this.session = null;
      this.grabbing[0] = null;
      this.grabbing[1] = null;
    });
    return session;
  }

  enableXRButton(_container) {
    // Custom overlay buttons drive the session; Three's XRButton is unused
    // (it would paint an "XR NOT SUPPORTED" badge over the desktop UI).
    this.renderer.xr.enabled = true;
  }

  setTarget(target) {
    this.target = target;
  }

  _controller(i) {
    return i === 0 ? this.controller0 : this.controller1;
  }

  _onSelectStart(i) {
    const controller = this._controller(i);
    if (!controller || !this.target) return;

    this.tempMatrix.identity().extractRotation(controller.matrixWorld);
    this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
    this.raycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.tempMatrix);

    const hits = this.raycaster.intersectObject(this.target, true);
    if (hits.length) {
      this.grabbing[i] = {
        mode: 'ray',
        offset: this.target.position.clone().sub(hits[0].point),
        hitPoint: hits[0].point.clone(),
      };
      this.physics?.setRootKinematic(true);
      this.pulseHaptic(i, 0.55, 55);
      this.send({
        type: 'interaction',
        action: 'grab_start',
        controller: i,
        broadcast: false,
      });
    }
  }

  _onSelectEnd(i) {
    if (this.grabbing[i]) {
      this.grabbing[i] = null;
      if (!this.grabbing[0] && !this.grabbing[1]) {
        this.physics?.setRootKinematic(false);
      }
      this.pulseHaptic(i, 0.25, 30);
      this.send({ type: 'interaction', action: 'grab_end', controller: i });
    }
  }

  _onSqueezeStart(i) {
    this.prevGrip[i] = true;
    if (this.grabbing[0] && this.grabbing[1] && this.target) {
      const a = new THREE.Vector3().setFromMatrixPosition(this.controller0.matrixWorld);
      const b = new THREE.Vector3().setFromMatrixPosition(this.controller1.matrixWorld);
      this.twoHandStartDist = a.distanceTo(b);
      this.twoHandStartScale = this.target.scale.x;
    }
  }

  _onSqueezeEnd(i) {
    this.prevGrip[i] = false;
    this.twoHandStartDist = null;
  }

  pulseHaptic(controllerIndex, intensity = 0.5, durationMs = 40) {
    const src = this._inputSource(controllerIndex);
    const actuator = src?.gamepad?.hapticActuators?.[0];
    if (actuator?.pulse) {
      actuator.pulse(THREE.MathUtils.clamp(intensity, 0, 1), durationMs);
      return;
    }
    // Fallback vibration actuator API
    const pad = src?.gamepad;
    if (pad?.vibrationActuator?.playEffect) {
      pad.vibrationActuator.playEffect('dual-rumble', {
        duration: durationMs,
        strongMagnitude: intensity,
        weakMagnitude: intensity * 0.6,
      });
    }
  }

  _inputSource(index) {
    const session = this.renderer.xr.getSession();
    if (!session) return null;
    const sources = [...session.inputSources];
    return sources[index] || null;
  }

  _readButtons(index) {
    const src = this._inputSource(index);
    const gp = src?.gamepad;
    if (!gp) return { trigger: false, grip: false, a: false, b: false };
    // Quest: 0 trigger, 1 grip, 4 A/X, 5 B/Y (varies; also check buttons length)
    const buttons = gp.buttons || [];
    return {
      trigger: !!(buttons[0]?.pressed || buttons[0]?.value > 0.7),
      grip: !!(buttons[1]?.pressed || buttons[1]?.value > 0.7),
      a: !!(buttons[4]?.pressed),
      b: !!(buttons[5]?.pressed),
    };
  }

  getHeadPosition() {
    const ref = this.renderer.xr.getCamera?.(this.camera) || this.camera;
    const p = new THREE.Vector3();
    ref.getWorldPosition(p);
    return p;
  }

  update(dt) {
    if (!this.immersive) {
      this._updateDesktopCamera();
      return;
    }

    for (let i = 0; i < 2; i++) {
      const btn = this._readButtons(i);
      const controller = this._controller(i);

      // Calibration: A/X rising edge
      if (btn.a && !this.prevA[i] && controller) {
        const head = this.getHeadPosition();
        const hand = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
        this.physics?.setProbeOffsetFromPoints(head, hand);
        this.pulseHaptic(i, 0.8, 80);
        this.send({
          type: 'calibration',
          offset: this.physics.probeOffset.toArray(),
          point: hand.toArray(),
          broadcast: false,
        });
      }

      // Pose cycle / dashboard: B/Y
      if (btn.b && !this.prevB[i]) {
        this.onPoseCycle?.();
        this.pulseHaptic(i, 0.35, 35);
      }

      this.prevA[i] = btn.a;
      this.prevB[i] = btn.b;
      this.prevTrigger[i] = btn.trigger;
      this.prevGrip[i] = btn.grip;

      // Move grabbed character along ray
      if (this.grabbing[i] && controller && this.target) {
        this.tempMatrix.identity().extractRotation(controller.matrixWorld);
        const origin = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
        const dir = new THREE.Vector3(0, 0, -1).applyMatrix4(this.tempMatrix);
        const point = origin.clone().add(dir.multiplyScalar(1.4));
        const desired = point.add(this.grabbing[i].offset);
        const before = this.target.position.clone();
        this.target.position.lerp(desired, 0.45);
        // Mild rotate toward controller yaw
        const yaw = Math.atan2(dir.x, dir.z);
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        this.target.quaternion.slerp(q, 0.08);
        this.physics?.moveRootTo(this.target.position, this.target.quaternion);
        // Soft bodies pick up inertia from root motion
        const delta = this.target.position.clone().sub(before);
        if (this.physics?.softBodies?.length && delta.lengthSq() > 1e-8) {
          const invDt = 1 / Math.max(dt, 1 / 90);
          for (const soft of this.physics.softBodies) {
            soft.velocity.x += delta.x * invDt * 0.15;
            soft.velocity.y += delta.y * invDt * 0.08;
            soft.velocity.z += delta.z * invDt * 0.15;
          }
        }
      }
    }

    // Two-hand scale
    if (this.twoHandStartDist && this.controller0 && this.controller1 && this.target) {
      const a = new THREE.Vector3().setFromMatrixPosition(this.controller0.matrixWorld);
      const b = new THREE.Vector3().setFromMatrixPosition(this.controller1.matrixWorld);
      const dist = a.distanceTo(b);
      const factor = dist / this.twoHandStartDist;
      const s = THREE.MathUtils.clamp(this.twoHandStartScale * factor, 0.25, 3.5);
      this.target.scale.setScalar(s);
    }

    // Keep probe following HMD + offset
    const head = this.getHeadPosition();
    this.physics?.updateProbeFromController(null, head);
  }

  _updateDesktopCamera() {
    const { spherical } = this.desktop;
    const offset = new THREE.Vector3().setFromSpherical(spherical);
    const look = this.target?.position.clone() || new THREE.Vector3(0, 1, 0);
    look.y += 0.9;
    this.camera.position.copy(look).add(offset);
    this.camera.lookAt(look);
  }
}
