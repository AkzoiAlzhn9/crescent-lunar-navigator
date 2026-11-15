// 3D view: LOLA terrain around the selected site, lit by the real Sun direction (JPL Horizons).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function init(api) {
  const { state, frame, ephemAt, skyAt, heightAt, llToXY, xyToLL, unit, R } = api;
  const host = document.getElementById('three');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x000000);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 2000);
  camera.position.set(-17, 11, 19);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.49; controls.target.set(0, 0.3, 0);

  // stars
  const sg = new THREE.BufferGeometry(), sp = [];
  for (let i = 0; i < 2500; i++) { const v = new THREE.Vector3().randomDirection().multiplyScalar(900); sp.push(v.x, v.y, v.z); }
  sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 1.2, sizeAttenuation: false })));

  const sun = new THREE.DirectionalLight(0xfff4e0, 3.2);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -28, right: 28, top: 28, bottom: -28, near: 1, far: 200 });
  sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  const earthshine = new THREE.DirectionalLight(0x6fa8ff, 0.0); scene.add(earthshine, earthshine.target);
  scene.add(new THREE.AmbientLight(0x223044, 0.08));

  // sun & earth markers
  const glowTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d'); const r = g.createRadialGradient(64, 64, 0, 64, 64, 64); r.addColorStop(0, 'rgba(255,250,230,1)'); r.addColorStop(0.15, 'rgba(255,220,140,.9)'); r.addColorStop(1, 'rgba(255,200,80,0)'); g.fillStyle = r; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c); })();
  const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, depthWrite: false })); sunSprite.scale.set(40, 40, 1); scene.add(sunSprite);
  const earth = new THREE.Mesh(new THREE.SphereGeometry(6, 32, 16), new THREE.MeshBasicMaterial({ color: 0x3d8bff }));
  scene.add(earth);

  let terrain = null, marker = null, site = null, f = null;
  const HALF = 22000, STEP = 300, VEX = 1.6; // meters, vertical exaggeration
  function enu(v0, S) { const d = [v0[0] - S[0], v0[1] - S[1], v0[2] - S[2]]; return [d[0] * f.east[0] + d[1] * f.east[1] + d[2] * f.east[2], d[0] * f.north[0] + d[1] * f.north[1] + d[2] * f.north[2], d[0] * f.p[0] + d[1] * f.p[1] + d[2] * f.p[2]]; }
  function rebuild() {
    site = state.sites[state.sel]; f = frame(site);
    if (terrain) { scene.remove(terrain); terrain.geometry.dispose(); }
    const [x0, y0] = llToXY(site.lat, site.lon);
    const S = unit(site.lat, site.lon).map((c) => c * (R + site.elev));
    const n = Math.round(2 * HALF / STEP) + 1;
    const pos = new Float32Array(n * n * 3), col = new Float32Array(n * n * 3);
    let k = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = x0 - HALF + i * STEP, y = y0 + HALF - j * STEP;
      const h = heightAt(x, y) ?? site.elev;
      const [la, lo] = xyToLL(x, y); const u = unit(la, lo);
      const [e, nn, up] = enu(u.map((c) => c * (R + h)), S);
      pos[k] = e / 1000; pos[k + 1] = up / 1000 * VEX; pos[k + 2] = -nn / 1000;
      const g = 0.5 + 0.06 * Math.random(); col[k] = g; col[k + 1] = g * 0.98; col[k + 2] = g * 0.95;
      k += 3;
    }
    const idx = [];
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { const a = j * n + i; idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx); geo.computeVertexNormals();
    terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
    terrain.castShadow = terrain.receiveShadow = true; scene.add(terrain);
    if (!marker) {
      marker = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.2), new THREE.MeshBasicMaterial({ color: 0x9b8cff }));
      pole.position.y = 0.6; const top = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 8), new THREE.MeshBasicMaterial({ color: 0x9b8cff }));
      top.position.y = 1.25; marker.add(pole, top); scene.add(marker);
    }
    update();
  }
  function dirFrom(el, az) { const e = el * Math.PI / 180, a = az * Math.PI / 180; return new THREE.Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a)); }
  function update() {
    if (!site) return;
    const sk = skyAt(site, f, ephemAt(state.t0 + state.t));
    const sd = dirFrom(sk.sEl * VEX, sk.sAz);      // exaggerate angle consistently with terrain
    sun.position.copy(sd.clone().multiplyScalar(80)); sun.target.position.set(0, 0, 0);
    sunSprite.position.copy(sd.clone().multiplyScalar(700));
    const ed = dirFrom(sk.eEl * VEX, sk.eAz);
    earth.position.copy(ed.clone().multiplyScalar(650));
    earthshine.position.copy(ed.clone().multiplyScalar(80)); earthshine.intensity = sk.eEl > -1 ? 0.12 : 0;
  }
  function resize() { const w = host.clientWidth, h = host.clientHeight; renderer.setSize(w, h, false); renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%'; camera.aspect = w / h; camera.updateProjectionMatrix(); }
  window.addEventListener('resize', resize); resize();
  (function loop() { requestAnimationFrame(loop); if (host.offsetParent) { resize(); controls.update(); renderer.render(scene, camera); } })();
  return { rebuild, update };
}
