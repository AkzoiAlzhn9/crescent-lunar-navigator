// Crescent — Lunar Landing Site Navigator
// Data: NASA LRO LOLA polar DEM + NASA JPL Horizons (MOON_ME frame). No server needed.
const R = 1737400;                 // m, LOLA reference sphere
const SUN_R = 0.2666;              // deg, apparent solar radius
const EPOCH = Date.UTC(2026, 0, 1);
const HOUR = 3600e3;
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const $ = (s) => document.querySelector(s);

const state = {
  sites: [], sel: 0, t0: 0, dur: 720, t: 0, mask: 1,
  view: { cx: 0, cy: 0, mpp: 400 }, playing: false, series: [], customN: 0, highlight: null,
};
let META, EPH, NEAR, FAR, MAPIMG;

// ---------- geometry ----------
function llToXY(lat, lon) {
  const r = 2 * R * Math.tan((90 - Math.abs(lat)) * D2R / 2);
  return [r * Math.sin(lon * D2R), r * Math.cos(lon * D2R)];
}
function xyToLL(x, y) {
  const r = Math.hypot(x, y);
  return [-90 + R2D * 2 * Math.atan(0.5 * r / R), R2D * Math.atan2(x, y)];
}
function unit(lat, lon) {
  const a = lat * D2R, b = lon * D2R;
  return [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function frame(site) {
  const p = unit(site.lat, site.lon), lo = site.lon * D2R;
  const east = [-Math.sin(lo), Math.cos(lo), 0];
  return { p, east, north: cross(p, east), rkm: (R + site.elev) / 1000 };
}
function altaz(v, f) {
  const n = Math.hypot(v[0], v[1], v[2]);
  const el = Math.asin(dot(v, f.p) / n) * R2D;
  let az = Math.atan2(dot(v, f.east), dot(v, f.north)) * R2D;
  if (az < 0) az += 360;
  return [el, az];
}
function gridSample(G, x, y) {
  const s = G.scale, c = (x + G.half) / s - 0.5, r = (G.half - y) / s - 0.5;
  if (c < 0 || r < 0 || c > G.n - 1.001 || r > G.n - 1.001) return null;
  const c0 = c | 0, r0 = r | 0, fc = c - c0, fr = r - r0, n = G.n, d = G.data;
  const i = r0 * n + c0;
  return (d[i] * (1 - fr) * (1 - fc) + d[i + n] * fr * (1 - fc) + d[i + 1] * (1 - fr) * fc + d[i + n + 1] * fr * fc);
}
function heightAt(x, y) {
  const h = gridSample(NEAR, x, y);
  return h !== null ? h : gridSample(FAR, x, y);
}
// Ray-cast terrain horizon (same algorithm as the offline 120 m version, on 300 m / 960 m grids)
function computeHorizon(lat, lon, naz = 360, obsH = 2) {
  const [x0, y0] = llToXY(lat, lon);
  const r0 = Math.hypot(x0, y0) || 1;
  const nv = [x0 / r0, y0 / r0], ev = [nv[1], -nv[0]];
  const h0 = heightAt(x0, y0) + obsH;
  const S = unit(lat, lon).map((c) => c * (R + h0));
  const up = unit(lat, lon);
  const dist = [];
  for (let d = 150; d < 3000; d += 150) dist.push(d);
  for (let d = 3000; d < 440000; d *= 1.008) dist.push(d);
  const hz = new Float32Array(naz);
  for (let k = 0; k < naz; k++) {
    const a = (k * 360 / naz) * D2R, ca = Math.cos(a), sa = Math.sin(a);
    const dx = ca * nv[0] + sa * ev[0], dy = ca * nv[1] + sa * ev[1];
    let best = -90;
    for (const d of dist) {
      const px = x0 + dx * d, py = y0 + dy * d;
      const h = heightAt(px, py);
      if (h === null) break;
      const [la, lo] = xyToLL(px, py);
      const u = unit(la, lo), rr = R + h;
      const v = [u[0] * rr - S[0], u[1] * rr - S[1], u[2] * rr - S[2]];
      const e = Math.asin(dot(v, up) / Math.hypot(v[0], v[1], v[2])) * R2D;
      if (e > best) best = e;
    }
    hz[k] = best;
  }
  return { elev: h0 - obsH, horizon: hz };
}
function horizonAt(site, az) {
  const H = site.horizon, n = H.length, f = az / 360 * n, i = Math.floor(f) % n, w = f - Math.floor(f);
  return H[i] * (1 - w) + H[(i + 1) % n] * w;
}

// ---------- ephemeris ----------
function ephemAt(h) {             // h = hours since EPOCH (fractional ok)
  const n = META.ephem.count;
  h = Math.max(0, Math.min(n - 1.001, h));
  const i = Math.floor(h), w = h - i;
  const a = EPH.subarray(i * 5, i * 5 + 5), b = EPH.subarray(i * 5 + 5, i * 5 + 10);
  const ea = unit(a[1], a[0]), eb = unit(b[1], b[0]);
  const sa = unit(a[3], a[2]), sb = unit(b[3], b[2]);
  const dist = a[4] * (1 - w) + b[4] * w;
  const lerp = (p, q) => [p[0] * (1 - w) + q[0] * w, p[1] * (1 - w) + q[1] * w, p[2] * (1 - w) + q[2] * w];
  const e = lerp(ea, eb), s = lerp(sa, sb);
  const en = Math.hypot(...e);
  return { sun: s, earth: e.map((c) => c / en * dist), subEarth: [a[1], a[0]], subSun: [a[3] * (1 - w) + b[3] * w, a[2]] };
}
function skyAt(site, f, eph) {
  const [sEl, sAz] = altaz(eph.sun, f);
  const ev = [eph.earth[0] - f.p[0] * f.rkm, eph.earth[1] - f.p[1] * f.rkm, eph.earth[2] - f.p[2] * f.rkm];
  const [eEl, eAz] = altaz(ev, f);
  const hs = horizonAt(site, sAz), he = horizonAt(site, eAz);
  const frac = Math.min(1, Math.max(0, (sEl - hs + SUN_R) / (2 * SUN_R)));
  return { sEl, sAz, eEl, eAz, frac, earth: eEl - he >= state.mask, hs, he };
}

// ---------- analysis ----------
function analyse(site, t0, dur) {
  const f = frame(site);
  const n = dur, sun = new Float32Array(n), earth = new Uint8Array(n);
  const track = [];
  let night = 0, maxNight = 0, gap = 0, maxGap = 0, sSum = 0, eSum = 0, bSum = 0;
  for (let k = 0; k < n; k++) {
    const sk = skyAt(site, f, ephemAt(t0 + k));
    sun[k] = sk.frac; earth[k] = sk.earth ? 1 : 0;
    sSum += sk.frac; eSum += earth[k]; if (sk.frac >= 0.5 && sk.earth) bSum++;
    night = sk.frac < 0.5 ? night + 1 : 0; maxNight = Math.max(maxNight, night);
    gap = sk.earth ? 0 : gap + 1; maxGap = Math.max(maxGap, gap);
    if (k % 2 === 0) track.push(sk);
  }
  return { site, sun, earth, track, sunPct: sSum / n, earthPct: eSum / n, bothPct: bSum / n, maxNight, maxGap };
}
function score(r) {
  const wS = +$('#wSun').value, wE = +$('#wEarth').value, wN = +$('#wNight').value;
  const tot = wS + wE + wN || 1;
  const nightScore = 1 - Math.min(1, r.maxNight / (15 * 24));
  return 100 * (wS * r.sunPct + wE * r.earthPct + wN * nightScore) / tot;
}
function recompute() {
  state.series = state.sites.map((s) => analyse(s, state.t0, state.dur));
  drawAll(); renderTable();
}

// ---------- formatting ----------
const fmtDate = (h, withTime = true) => {
  const d = new Date(EPOCH + h * HOUR).toISOString();
  return withTime ? d.slice(0, 10) + ' ' + d.slice(11, 16) + ' UTC' : d.slice(0, 10);
};
const pct = (v) => (v * 100).toFixed(1) + '%';
const hrs = (h) => h >= 48 ? (h / 24).toFixed(1) + ' d' : h + ' h';

// ---------- canvas helpers ----------
function fit(cv, h) {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth;
  const hh = h ?? cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hh * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(hh * dpr);
  }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [ctx, w, hh];
}

// ---------- map ----------
function drawMap() {
  const cv = $('#map'); const [ctx, W, H] = fit(cv, $('#map').clientWidth);
  const v = state.view;
  const sx = (x) => W / 2 + (x - v.cx) / v.mpp, sy = (y) => H / 2 - (y - v.cy) / v.mpp;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  const half = META.near.half;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(MAPIMG, sx(-half), sy(half), 2 * half / v.mpp, 2 * half / v.mpp);
  // graticule
  ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 1; ctx.font = '11px IBM Plex Mono'; ctx.fillStyle = 'rgba(255,255,255,.5)';
  for (const lat of [-89, -88, -87, -86, -85, -84]) {
    const r = llToXY(lat, 0)[1];
    ctx.beginPath(); ctx.arc(sx(0), sy(0), Math.abs(r) / v.mpp, 0, 2 * Math.PI); ctx.stroke();
    ctx.fillText(`${-lat}°S`, sx(0) + 3, sy(0) - Math.abs(r) / v.mpp - 3);
  }
  for (let lon = 0; lon < 360; lon += 30) {
    const [x, y] = llToXY(-84, lon);
    ctx.beginPath(); ctx.moveTo(sx(0), sy(0)); ctx.lineTo(sx(x), sy(y)); ctx.stroke();
    const [lx, ly] = llToXY(-84.6, lon);
    ctx.fillText(`${lon > 180 ? lon - 360 : lon}°`, sx(lx) - 10, sy(ly));
  }
  // Sun & Earth directions from the pole
  const e = ephemAt(state.t0 + state.t);
  const arrow = (lon, color, label) => {
    const L = Math.min(W, H) * 0.42, a = lon * D2R;
    const x2 = sx(0) + Math.sin(a) * L, y2 = sy(0) - Math.cos(a) * L;
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash([6, 5]);
    ctx.beginPath(); ctx.moveTo(sx(0), sy(0)); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x2, y2, 6, 0, 7); ctx.fill();
    ctx.font = '600 12px Space Grotesk'; ctx.fillText(label, x2 + 9, y2 + 4);
  };
  arrow(e.subSun[1], '#ffc94a', 'to Sun');
  arrow(e.subEarth[1], '#4aa8ff', 'to Earth');
  // sites (dots first, then labels with simple collision avoidance; selected label wins)
  const pts = state.sites.map((s, i) => { const [x, y] = llToXY(s.lat, s.lon); return { s, i, X: sx(x), Y: sy(y) }; });
  pts.forEach(({ i, X, Y }) => {
    const sel = i === state.sel, ser = state.series[i];
    const lit = ser ? ser.sun[Math.min(state.t, ser.sun.length - 1)] : 0;
    ctx.beginPath(); ctx.arc(X, Y, sel ? 8 : 6, 0, 7);
    ctx.fillStyle = sel ? '#9b8cff' : (lit > 0.5 ? '#fff4cf' : '#59627a'); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#0b0f1a'; ctx.stroke();
    if (sel) { ctx.beginPath(); ctx.arc(X, Y, 13, 0, 7); ctx.strokeStyle = '#9b8cff'; ctx.stroke(); }
  });
  const boxes = [];
  [...pts].sort((a, b) => (b.i === state.sel) - (a.i === state.sel)).forEach(({ s, i, X, Y }) => {
    const sel = i === state.sel;
    ctx.font = `${sel ? 600 : 500} 12px Space Grotesk`;
    const tw = ctx.measureText(s.name).width;
    const cands = [[X + 10, Y - 9], [X - tw - 18, Y - 9], [X - tw / 2 - 4, Y - 28], [X - tw / 2 - 4, Y + 10]];
    const fitBox = cands.map(([bx, by]) => ({ x: bx, y: by, w: tw + 8, h: 17 }))
      .find((b) => boxes.every((o) => b.x > o.x + o.w || b.x + b.w < o.x || b.y > o.y + o.h || b.y + b.h < o.y));
    if (!fitBox) return;
    boxes.push(fitBox);
    ctx.fillStyle = 'rgba(7,10,18,.75)'; ctx.fillRect(fitBox.x, fitBox.y, fitBox.w, fitBox.h);
    ctx.fillStyle = sel ? '#d9d2ff' : '#e6ebf5'; ctx.fillText(s.name, fitBox.x + 4, fitBox.y + 13);
  });
  // scale bar
  const km = v.mpp * 120 / 1000, nice = [1, 2, 5, 10, 20, 50, 100].find((k) => k >= km) || 100;
  const px = nice * 1000 / v.mpp;
  ctx.fillStyle = 'rgba(7,10,18,.7)'; ctx.fillRect(W - px - 22, 10, px + 14, 24);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(W - px - 15, 26); ctx.lineTo(W - 15, 26); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = '11px IBM Plex Mono'; ctx.fillText(`${nice} km`, W - px - 15, 21);
}
function mapEvents() {
  const cv = $('#map'); let drag = null;
  const toXY = (ev) => {
    const r = cv.getBoundingClientRect(), v = state.view;
    return [v.cx + (ev.clientX - r.left - r.width / 2) * v.mpp, v.cy - (ev.clientY - r.top - r.height / 2) * v.mpp];
  };
  cv.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const [x, y] = toXY(ev), k = Math.exp(ev.deltaY * 0.0015), v = state.view;
    const mpp = Math.min(800, Math.max(25, v.mpp * k));
    v.cx = x - (x - v.cx) * mpp / v.mpp; v.cy = y - (y - v.cy) * mpp / v.mpp; v.mpp = mpp;
    drawMap();
  }, { passive: false });
  cv.addEventListener('pointerdown', (ev) => { drag = { x: ev.clientX, y: ev.clientY, cx: state.view.cx, cy: state.view.cy, moved: false }; cv.setPointerCapture(ev.pointerId); });
  cv.addEventListener('pointermove', (ev) => {
    if (drag) {
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) { state.view.cx = drag.cx - dx * state.view.mpp; state.view.cy = drag.cy + dy * state.view.mpp; drawMap(); }
      return;
    }
    const [x, y] = toXY(ev), [la, lo] = xyToLL(x, y), h = heightAt(x, y);
    showTip(ev, `${(-la).toFixed(3)}°S ${lo.toFixed(2)}°E<br>elev ${h === null ? '—' : Math.round(h) + ' m'}`);
  });
  cv.addEventListener('pointerleave', hideTip);
  cv.addEventListener('pointerup', (ev) => {
    const d = drag; drag = null;
    if (!d || d.moved) return;
    const [x, y] = toXY(ev), r = cv.getBoundingClientRect();
    // hit existing site?
    const hit = state.sites.findIndex((s) => { const [sx, sy] = llToXY(s.lat, s.lon); return Math.hypot(sx - x, sy - y) / state.view.mpp < 12; });
    if (hit >= 0) { select(hit); return; }
    const [la, lo] = xyToLL(x, y);
    if (la > -83.5 || heightAt(x, y) === null) return;
    addCustom(la, lo);
  });
}
function addCustom(la, lo) {
  const { elev, horizon } = computeHorizon(la, lo);
  state.customN++;
  const site = { name: `Custom ${state.customN}`, lat: la, lon: lo, elev, horizon, custom: true };
  const customs = state.sites.filter((s) => s.custom);
  if (customs.length >= 3) state.sites.splice(state.sites.indexOf(customs[0]), 1);
  state.sites.push(site);
  state.sel = state.sites.length - 1;
  recompute(); renderSiteInfo();
}

// ---------- now cards ----------
function nextChange(arr, k, test) {
  const cur = test(arr[k]);
  for (let j = k + 1; j < arr.length; j++) if (test(arr[j]) !== cur) return j - k;
  return null;
}
function renderNow() {
  const site = state.sites[state.sel], f = frame(site), sk = skyAt(site, f, ephemAt(state.t0 + state.t));
  const ser = state.series[state.sel], k = state.t;
  const ns = ser ? nextChange(ser.sun, k, (v) => v >= 0.5) : null;
  const ne = ser ? nextChange(ser.earth, k, (v) => v === 1) : null;
  const lit = sk.frac >= 0.5;
  $('#nowCards').innerHTML = `
    <div class="card ${lit ? 'on-sun' : 'off'}"><div class="k">Sun</div><div class="v">${sk.frac >= 0.999 ? 'Full sun' : sk.frac > 0 ? pct(sk.frac) + ' disk' : 'Shadow'}</div><div class="s">el ${sk.sEl.toFixed(2)}° · az ${sk.sAz.toFixed(1)}°<br>terrain ${sk.hs.toFixed(2)}°</div></div>
    <div class="card ${sk.earth ? 'on-earth' : 'off'}"><div class="k">Earth</div><div class="v">${sk.earth ? 'In view' : 'Hidden'}</div><div class="s">el ${sk.eEl.toFixed(2)}° · az ${sk.eAz.toFixed(1)}°<br>terrain ${sk.he.toFixed(2)}°</div></div>
    <div class="card ${lit && sk.earth ? 'on-sun' : ''}"><div class="k">Power + comms</div><div class="v">${lit && sk.earth ? 'Both ✓' : lit ? 'Power only' : sk.earth ? 'Comms only' : 'Neither'}</div><div class="s">${site.name}</div></div>
    <div class="card"><div class="k">Next change</div><div class="v" style="font-size:14px">${ns ? (lit ? 'Sunset' : 'Sunrise') + ' in ' + hrs(ns) : 'No sun change'}</div><div class="s">${ne ? (sk.earth ? 'Earth sets' : 'Earth rises') + ' in ' + hrs(ne) : 'No Earth change in window'}</div></div>`;
  $('#timeLabel').textContent = $('#timeLabel3').textContent = fmtDate(state.t0 + state.t);
}

// ---------- panorama ----------
function drawPano() {
  const cv = $('#pano'); const [ctx, W, H] = fit(cv);
  const site = state.sites[state.sel], ser = state.series[state.sel];
  const lo = -8, hi = 12, X = (az) => az / 360 * W, Y = (el) => H - (el - lo) / (hi - lo) * H;
  const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#05070d'); g.addColorStop(1, '#141c33');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.font = '10px IBM Plex Mono';
  for (let e = lo; e <= hi; e += 2) { ctx.beginPath(); ctx.moveTo(0, Y(e)); ctx.lineTo(W, Y(e)); ctx.stroke(); ctx.fillText(`${e}°`, 3, Y(e) - 2); }
  ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(W, Y(0)); ctx.stroke();
  // tracks
  if (ser) {
    for (const p of ser.track) {
      ctx.fillStyle = 'rgba(255,201,74,.35)'; ctx.fillRect(X(p.sAz) - 1, Y(p.sEl) - 1, 2, 2);
      ctx.fillStyle = 'rgba(74,168,255,.45)'; ctx.fillRect(X(p.eAz) - 1, Y(p.eEl) - 1, 2, 2);
    }
  }
  // terrain
  const hz = site.horizon, n = hz.length;
  const tg = ctx.createLinearGradient(0, Y(4), 0, H); tg.addColorStop(0, '#5d5a63'); tg.addColorStop(1, '#1b1a20');
  ctx.beginPath(); ctx.moveTo(0, H);
  for (let i = 0; i <= n; i++) ctx.lineTo(X(i * 360 / n), Y(hz[i % n]));
  ctx.lineTo(W, H); ctx.closePath(); ctx.fillStyle = tg; ctx.fill();
  ctx.strokeStyle = '#b8b2c4'; ctx.lineWidth = 1; ctx.stroke();
  // current bodies
  const sk = skyAt(site, frame(site), ephemAt(state.t0 + state.t));
  const pxPerDeg = H / (hi - lo);
  const body = (az, el, r, color, glow, label) => {
    const x = X(az), y = Y(el), rad = Math.max(r * pxPerDeg, 5);
    const gr = ctx.createRadialGradient(x, y, 0, x, y, rad * 4); gr.addColorStop(0, glow); gr.addColorStop(1, 'transparent');
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, rad * 4, 0, 7); ctx.fill();
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, rad, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '600 11px Space Grotesk'; ctx.fillText(label, x + rad + 4, y - rad - 2);
  };
  body(sk.eAz, sk.eEl, 0.95, '#4aa8ff', 'rgba(74,168,255,.45)', 'Earth');
  body(sk.sAz, sk.sEl, SUN_R, '#fff3c4', 'rgba(255,201,74,.7)', 'Sun');
  // redraw terrain in front of hidden bodies (occlusion)
  ctx.save(); ctx.beginPath(); ctx.moveTo(0, H);
  for (let i = 0; i <= n; i++) ctx.lineTo(X(i * 360 / n), Y(hz[i % n]));
  ctx.lineTo(W, H); ctx.closePath(); ctx.clip(); ctx.fillStyle = tg; ctx.fillRect(0, 0, W, H); ctx.restore();
  // compass
  ctx.fillStyle = '#e6ebf5'; ctx.font = '600 11px Space Grotesk';
  [['N (away from pole)', 0], ['E', 90], ['S (toward pole)', 180], ['W', 270]].forEach(([t, a]) => { ctx.fillText(t, Math.min(W - 110, X(a) + 3), H - 6); ctx.fillRect(X(a), H - 20, 1, 20); });
}

// ---------- timeline ----------
const TL = { left: 190, row: 30, top: 22 };
function drawTimeline() {
  const cv = $('#timeline'); const h = TL.top + state.sites.length * TL.row + 6;
  cv.style.height = h + 'px';
  const [ctx, W, H] = fit(cv, h);
  ctx.fillStyle = '#0a0f1b'; ctx.fillRect(0, 0, W, H);
  const pw = W - TL.left - 10, dur = state.dur, X = (k) => TL.left + k / dur * pw;
  // axis
  ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.font = '10px IBM Plex Mono'; ctx.strokeStyle = 'rgba(255,255,255,.07)';
  const stepDays = dur <= 720 ? 5 : dur <= 2160 ? 15 : 60;
  for (let d = 0; d * 24 < dur; d += stepDays) {
    const x = X(d * 24); ctx.beginPath(); ctx.moveTo(x, TL.top - 4); ctx.lineTo(x, H); ctx.stroke();
    ctx.fillText(fmtDate(state.t0 + d * 24, false).slice(5), x + 2, 12);
  }
  if (state.highlight) {
    const [a, b] = state.highlight; ctx.fillStyle = 'rgba(155,140,255,.18)';
    ctx.fillRect(X(a - state.t0), TL.top - 4, (b - a) / dur * pw, H);
  }
  state.series.forEach((ser, i) => {
    const y = TL.top + i * TL.row;
    if (i === state.sel) { ctx.fillStyle = 'rgba(155,140,255,.12)'; ctx.fillRect(0, y - 2, W, TL.row); }
    ctx.fillStyle = i === state.sel ? '#d9d2ff' : '#c9d2e6'; ctx.font = `${i === state.sel ? 600 : 500} 12px Space Grotesk`;
    const name = ser.site.name.length > 26 ? ser.site.name.slice(0, 25) + '…' : ser.site.name;
    ctx.fillText(name, 8, y + 15);
    for (let px = 0; px < pw; px++) {
      const a = Math.floor(px / pw * dur), b = Math.max(a + 1, Math.floor((px + 1) / pw * dur));
      let s = 0, e = 0, bo = 0;
      for (let k = a; k < b; k++) { s += ser.sun[k]; e += ser.earth[k]; if (ser.sun[k] >= 0.5 && ser.earth[k]) bo++; }
      const m = b - a;
      ctx.fillStyle = `rgba(255,201,74,${(s / m).toFixed(3)})`; ctx.fillRect(TL.left + px, y, 1, 10);
      ctx.fillStyle = `rgba(74,168,255,${(e / m).toFixed(3)})`; ctx.fillRect(TL.left + px, y + 12, 1, 6);
      ctx.fillStyle = `rgba(61,220,151,${(bo / m).toFixed(3)})`; ctx.fillRect(TL.left + px, y + 20, 1, 4);
    }
  });
  const cx = X(state.t);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(cx, TL.top - 6); ctx.lineTo(cx, H); ctx.stroke();
}
function timelineEvents() {
  const cv = $('#timeline');
  const pick = (ev) => {
    const r = cv.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
    const pw = r.width - TL.left - 10;
    const k = Math.round((x - TL.left) / pw * state.dur), i = Math.floor((y - TL.top + 2) / TL.row);
    return { k: Math.max(0, Math.min(state.dur - 1, k)), i, inside: x >= TL.left };
  };
  cv.addEventListener('click', (ev) => {
    const p = pick(ev);
    if (p.i >= 0 && p.i < state.sites.length) state.sel = p.i;
    if (p.inside) setTime(p.k); else { renderSiteInfo(); drawAll(); renderTable(); }
  });
  cv.addEventListener('pointermove', (ev) => {
    const p = pick(ev), ser = state.series[p.i];
    if (!ser || !p.inside) return hideTip();
    showTip(ev, `<b>${ser.site.name}</b><br>${fmtDate(state.t0 + p.k)}<br>☀ ${pct(ser.sun[p.k])} · ${ser.earth[p.k] ? '🌍 Earth in view' : 'Earth hidden'}`);
  });
  cv.addEventListener('pointerleave', hideTip);
}

// ---------- table ----------
function renderTable() {
  const rows = state.series.map((r, i) => ({ r, i, sc: score(r) })).sort((a, b) => b.sc - a.sc);
  $('#rank tbody').innerHTML = rows.map(({ r, i, sc }, k) => `
    <tr data-i="${i}" class="${i === state.sel ? 'sel' : ''}">
      <td class="num">${k + 1}</td><td>${r.site.name}${r.site.custom ? ' <span class="hint">(custom, 300 m)</span>' : ''}</td>
      <td class="num">${pct(r.sunPct)}<span class="bar" style="width:${r.sunPct * 50}px;background:var(--sun)"></span></td>
      <td class="num">${pct(r.earthPct)}<span class="bar" style="width:${r.earthPct * 50}px;background:var(--earth)"></span></td>
      <td class="num">${pct(r.bothPct)}</td>
      <td class="num">${hrs(r.maxNight)}</td><td class="num">${hrs(r.maxGap)}</td>
      <td class="num"><b>${sc.toFixed(1)}</b></td></tr>`).join('');
  $('#rank tbody').querySelectorAll('tr').forEach((tr) => tr.addEventListener('click', () => select(+tr.dataset.i)));
}
function exportCSV() {
  const lines = ['site,lat,lon,elev_m,utc,sun_fraction,earth_visible'];
  state.series.forEach((r) => {
    for (let k = 0; k < r.sun.length; k++) lines.push(`"${r.site.name}",${r.site.lat.toFixed(4)},${r.site.lon.toFixed(4)},${Math.round(r.site.elev)},${new Date(EPOCH + (state.t0 + k) * HOUR).toISOString()},${r.sun[k].toFixed(3)},${r.earth[k]}`);
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = `crescent_${fmtDate(state.t0, false)}_${state.dur}h.csv`; a.click();
}

// ---------- mission window finder ----------
function findWindows() {
  const site = state.sites[state.sel], stay = +$('#stay').value, minSun = +$('#minSun').value;
  const span = Math.min(8760, META.ephem.count - 1 - state.t0);
  const r = analyse(site, state.t0, span);
  const ps = new Float64Array(span + 1), pe = new Float64Array(span + 1);
  for (let k = 0; k < span; k++) { ps[k + 1] = ps[k] + r.sun[k]; pe[k + 1] = pe[k] + r.earth[k]; }
  const cand = [];
  for (let k = 0; k + stay <= span; k += 3) {
    const s = (ps[k + stay] - ps[k]) / stay, e = (pe[k + stay] - pe[k]) / stay;
    if (s >= minSun - 1e-9) cand.push({ k, s, e });
  }
  cand.sort((a, b) => b.e - a.e || b.s - a.s);
  const pickd = [];
  for (const c of cand) { if (pickd.every((p) => Math.abs(p.k - c.k) > stay)) pickd.push(c); if (pickd.length >= 6) break; }
  const ol = $('#windows');
  if (!pickd.length) { ol.innerHTML = `<li>No ${stay / 24}-day window with ≥${minSun * 100}% sunlight at ${site.name} in the next ${(span / 24).toFixed(0)} days. Try a rim/ridge site or relax the requirement.</li>`; return; }
  ol.innerHTML = pickd.map((c) => `<li data-k="${c.k}"><b>${fmtDate(state.t0 + c.k)}</b> → ${fmtDate(state.t0 + c.k + stay)}<br>sunlight ${pct(c.s)} · Earth in view ${pct(c.e)}</li>`).join('');
  ol.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
    const k = +li.dataset.k, start = state.t0 + k;
    state.t0 = Math.max(0, start - 48); state.highlight = [start, start + stay];
    $('#startDate').value = fmtDate(state.t0, false);
    recompute(); setTime(48);
  }));
}

// ---------- tooltip ----------
function showTip(ev, html) { const t = $('#tip'); t.innerHTML = html; t.style.display = 'block'; t.style.left = ev.clientX + 14 + 'px'; t.style.top = ev.clientY + 14 + 'px'; }
function hideTip() { $('#tip').style.display = 'none'; }

// ---------- glue ----------
function renderSiteInfo() {
  const s = state.sites[state.sel];
  $('#siteInfo').innerHTML = `<b>${s.name}</b><br>${(-s.lat).toFixed(3)}°S, ${s.lon.toFixed(2)}°E · elevation ${Math.round(s.elev)} m · ${s.custom ? 'horizon from 300 m grid' : 'horizon from 120 m LOLA'}<br>highest terrain on horizon ${Math.max(...s.horizon).toFixed(2)}°`;
  $('#t3name').textContent = s.name;
}
function select(i) { state.sel = i; renderSiteInfo(); drawAll(); renderTable(); $('#windows').innerHTML = ''; if (window.__t3) window.__t3.rebuild(); }
function setTime(k) {
  state.t = Math.max(0, Math.min(state.dur - 1, k));
  $('#time').value = $('#time3').value = state.t;
  drawMap(); drawPano(); drawTimeline(); renderNow();
  if (window.__t3) window.__t3.update();
}
function drawAll() { drawMap(); drawPano(); drawTimeline(); renderNow(); }
function setWindow() {
  const d = Date.parse($('#startDate').value + 'T00:00:00Z');
  state.t0 = Math.max(0, Math.round((d - EPOCH) / HOUR));
  state.dur = Math.min(+$('#duration').value, META.ephem.count - 1 - state.t0);
  $('#time').max = $('#time3').max = state.dur - 1;
  state.highlight = null;
  recompute(); setTime(Math.min(state.t, state.dur - 1));
}
function play(btn) {
  state.playing = !state.playing;
  $('#play').textContent = $('#play3').textContent = state.playing ? '❚❚' : '▶';
  const step = () => {
    if (!state.playing) return;
    setTime((state.t + Math.max(1, Math.round(state.dur / 500))) % state.dur);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

async function load() {
  const get = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u); return r; });
  const [meta, sites, eph, near, far] = await Promise.all([
    get('data/meta.json').then((r) => r.json()), get('data/sites.json').then((r) => r.json()),
    get('data/ephem.bin').then((r) => r.arrayBuffer()), get('data/dem_near.bin').then((r) => r.arrayBuffer()),
    get('data/dem_far.bin').then((r) => r.arrayBuffer()),
  ]);
  META = meta; EPH = new Float32Array(eph);
  NEAR = { ...meta.near, data: new Int16Array(near) };
  FAR = { ...meta.far, data: new Int16Array(far) };
  MAPIMG = new Image(); MAPIMG.src = 'data/map.jpg'; await MAPIMG.decode();
  state.sites = sites.sites.map((s) => ({ ...s, horizon: Float32Array.from(s.horizon) }));
}

async function main() {
  await load();
  const today = new Date(); const iso = today.toISOString().slice(0, 10);
  $('#startDate').value = iso >= '2026-01-01' && iso <= '2030-11-30' ? iso : '2027-01-01';
  state.view = { cx: 0, cy: -8000, mpp: 330000 / Math.max(300, $('#map').clientWidth) };
  mapEvents(); timelineEvents();
  $('#startDate').addEventListener('change', setWindow);
  $('#duration').addEventListener('change', setWindow);
  $('#commMask').addEventListener('change', () => { state.mask = +$('#commMask').value; recompute(); });
  $('#time').addEventListener('input', (e) => setTime(+e.target.value));
  $('#time3').addEventListener('input', (e) => setTime(+e.target.value));
  $('#play').addEventListener('click', play); $('#play3').addEventListener('click', play);
  ['#wSun', '#wEarth', '#wNight'].forEach((s) => $(s).addEventListener('input', renderTable));
  $('#csv').addEventListener('click', exportCSV);
  $('#coordForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const la = +$('#inLat').value, lo = ((+$('#inLon').value + 540) % 360) - 180;
    const [x, y] = llToXY(la, lo);
    if (!(la <= -80 && la >= -90) || heightAt(x, y) === null) { alert('Enter a latitude between -90 and -80 (south polar region covered by the LOLA model).'); return; }
    addCustom(la, lo);
    state.view.cx = x; state.view.cy = y; drawMap();
  });
  $('#find').addEventListener('click', findWindows);
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', async () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('hidden', v.id !== 'view-' + b.dataset.view));
    if (b.dataset.view === 'terrain') {
      if (!window.__t3) { const m = await import('./terrain3d.js'); window.__t3 = m.init({ state, frame, ephemAt, skyAt, heightAt, llToXY, xyToLL, unit, R }); }
      window.__t3.rebuild();
    }
    if (b.dataset.view === 'plan') drawAll();
  }));
  window.addEventListener('resize', () => drawAll());
  renderSiteInfo();
  setWindow();
  $('#loading').classList.add('done');
  window.__crescent = { state, setTime, select, setWindow, findWindows, addCustom };
  const hv = location.hash.slice(1);
  if (['terrain', 'learn'].includes(hv)) document.querySelector(`.tab[data-view="${hv}"]`).click();
}
main().catch((e) => { $('#loading').textContent = 'Failed to load data: ' + e.message; console.error(e); });
