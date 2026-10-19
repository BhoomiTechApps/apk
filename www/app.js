'use strict';
/*
 * FieldCam — video + GPS track recorder with an offline cell-tower fallback (Android).
 *
 * Location sources, each tagged per point in the exported GeoJSON:
 *   gps  — satellite fixes from the WebView's Geolocation API (always recorded)
 *   cell — our own estimate from the towers the modem can hear (native CellInfo plugin)
 *          looked up in an OpenCelliD database stored on the phone. No internet needed.
 *          Recorded only while GPS is missing or weaker than the chosen threshold.
 */

// ---------- Platform ----------
const Cap = window.Capacitor;
const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const Filesystem = isNative ? Cap.registerPlugin('Filesystem') : null;
const Share = isNative ? Cap.registerPlugin('Share') : null;
const CellInfo = isNative ? Cap.registerPlugin('CellInfo') : null;

// ---------- Config ----------
const CHUNK_MS = 1000;
const VIDEO_BITRATE = 5_000_000;
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4',
  'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
];
const GEO_OPTS = { enableHighAccuracy: true, maximumAge: 0, timeout: Infinity };
const FIX_STALE_MS = 10_000;     // GPS silent this long → "signal lost"
const CELL_POLL_MS = 5_000;      // how often to scan cell towers
const CELL_STALE_MS = 15_000;
const SAVE_DIR = 'DOCUMENTS';    // Capacitor Filesystem Directory.Documents
const SAVE_FOLDER = 'FieldCam';

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const preview = $('preview'), timerEl = $('timer'), recDot = $('recDot'), locInfo = $('locInfo');
const cameraSelect = $('cameraSelect'), startCamBtn = $('startCam'), recordBtn = $('recordBtn');
const statusEl = $('status'), listEl = $('list'), storageEl = $('storage');
const setStatus = (msg, warn = false) => { statusEl.textContent = msg; statusEl.className = warn ? 'warn' : ''; };

// ---------- IndexedDB ----------
let dbPromise;
function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open('fieldcam', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('recordings', { keyPath: 'id' });
        d.createObjectStore('chunks', { autoIncrement: true }).createIndex('recId', 'recId');
        d.createObjectStore('points', { autoIncrement: true }).createIndex('recId', 'recId');
        d.createObjectStore('towers', { keyPath: 'k' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); });

async function dbPut(store, value) {
  const t = (await openDB()).transaction(store, 'readwrite');
  t.objectStore(store).put(value);
  return txDone(t);
}
async function dbPutMany(store, values) {
  const t = (await openDB()).transaction(store, 'readwrite');
  const s = t.objectStore(store);
  for (const v of values) s.put(v);
  return txDone(t);
}
async function dbGetMany(store, keys) {
  const s = (await openDB()).transaction(store).objectStore(store);
  return Promise.all(keys.map((k) => reqP(s.get(k))));
}
async function dbGetAll(store) { return reqP((await openDB()).transaction(store).objectStore(store).getAll()); }
async function dbCount(store) { return reqP((await openDB()).transaction(store).objectStore(store).count()); }
async function dbClear(store) {
  const t = (await openDB()).transaction(store, 'readwrite');
  t.objectStore(store).clear();
  return txDone(t);
}
async function dbGetByRec(store, recId) {
  return reqP((await openDB()).transaction(store).objectStore(store).index('recId').getAll(recId));
}
async function dbDeleteRecording(id) {
  const t = (await openDB()).transaction(['recordings', 'chunks', 'points'], 'readwrite');
  t.objectStore('recordings').delete(id);
  for (const s of ['chunks', 'points']) {
    const store = t.objectStore(s);
    const cur = store.index('recId').openKeyCursor(IDBKeyRange.only(id));
    cur.onsuccess = () => { const c = cur.result; if (c) { store.delete(c.primaryKey); c.continue(); } };
  }
  return txDone(t);
}

// ---------- Settings ----------
const settings = (() => {
  const defaults = { cellFallback: true, weakAcc: 50 };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('fieldcam-settings') || '{}') }; }
  catch (_) { return defaults; }
})();
function saveSettings() { try { localStorage.setItem('fieldcam-settings', JSON.stringify(settings)); } catch (_) {} }

// ---------- State ----------
let stream = null, recorder = null, current = null;
let geoWatch = null, lastFixTs = 0, lastGpsTs = 0;
let timerInt = null, wakeLock = null;
let gpsStartedAt = 0, lastFixAt = 0, lastCoords = null, gpsError = null;
let cellTimer = null;
let cellState = { at: 0, est: null, cells: [], error: null, scanning: false };
const towerCache = new Map();   // key → tower | null

const fresh = (at, ms = FIX_STALE_MS) => !!at && Date.now() - at <= ms;
const gpsWeak = () => !fresh(lastFixAt) || lastCoords.accuracy > settings.weakAcc;
const cellUsable = () => settings.cellFallback && isNative && fresh(cellState.at, CELL_STALE_MS) && cellState.est && cellState.est.lat != null;

// ---------- Camera ----------
async function startCamera() {
  stopCamera();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: cameraSelect.value }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: { echoCancellation: false, noiseSuppression: false },
    });
  } catch (e) {
    setStatus(`Camera/mic unavailable: ${e.message}`, true);
    return;
  }
  preview.srcObject = stream;
  recordBtn.disabled = false;
  startCamBtn.textContent = 'Restart camera';
  const s = stream.getVideoTracks()[0].getSettings();
  setStatus(`Camera ready (${s.width}×${s.height}). Waiting for location…`);
  startLocation();
}
function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

// ---------- Location: GPS ----------
function startLocation() {
  if (geoWatch === null && 'geolocation' in navigator) {
    gpsStartedAt = Date.now();
    geoWatch = navigator.geolocation.watchPosition(onGpsPosition, onGpsError, GEO_OPTS);
    setInterval(updateLocInfo, 1000);
  }
  if (settings.cellFallback) startCells();
}

function onGpsPosition(pos) {
  gpsError = null;
  lastFixAt = Date.now();
  lastCoords = pos.coords;
  updateLocInfo();
  if (!current || pos.timestamp === lastGpsTs) return;
  lastGpsTs = pos.timestamp;
  const c = pos.coords;
  recordPoint({
    t: pos.timestamp, source: 'gps', lon: c.longitude, lat: c.latitude, alt: c.altitude, acc: c.accuracy,
    altAcc: c.altitudeAccuracy, speed: c.speed, heading: c.heading,
  });
}
function onGpsError(err) {
  if (err.code === 3) return;
  gpsError = { 1: 'permission denied', 2: 'unavailable — is Location on?' }[err.code] || err.message;
  updateLocInfo();
  if (err.code === 1) setStatus('Location permission denied — no GPS track will be recorded.', true);
}

// ---------- Location: cell towers ----------
function startCells() {
  if (!isNative || cellTimer) return;
  pollCells();
  cellTimer = setInterval(pollCells, CELL_POLL_MS);
}
function stopCells() {
  clearInterval(cellTimer);
  cellTimer = null;
  cellState = { at: 0, est: null, cells: [], error: null, scanning: false };
  renderScan();
  updateLocInfo();
}

async function lookupTowers(keys) {
  const missing = keys.filter((k) => !towerCache.has(k));
  if (missing.length) {
    const found = await dbGetMany('towers', missing);
    missing.forEach((k, i) => towerCache.set(k, found[i] || null));
  }
  const m = new Map();
  for (const k of keys) { const t = towerCache.get(k); if (t) m.set(k, t); }
  return m;
}

async function pollCells() {
  if (cellState.scanning) return;
  cellState.scanning = true;
  try {
    const r = await CellInfo.getCells({ fresh: true });
    const cells = r.cells || [];
    const keys = [...new Set(cells.map(Towers.cellKey).filter(Boolean))];
    const lookup = await lookupTowers(keys);
    const est = Towers.estimatePosition(cells, lookup);
    let error = null;
    if (!r.locationEnabled) error = 'Location is off';
    else if (!cells.length) error = 'no cells visible';
    cellState = { at: Date.now(), est, cells, lookup, error, scanning: false };
    if (est.lat != null) onCellEstimate(est, cellState.at);
  } catch (e) {
    cellState.error = e.message || String(e);
    cellState.scanning = false;
  }
  renderScan();
  updateLocInfo();
}

function onCellEstimate(est, at) {
  if (!current || !settings.cellFallback) return;
  if (!gpsWeak()) return;                                                      // GPS good → no cell points
  if (fresh(lastFixAt) && est.accuracy >= lastCoords.accuracy) return;        // weak GPS still better
  recordPoint({
    t: at, source: 'cell', lon: est.lon, lat: est.lat, alt: null, acc: est.accuracy,
    altAcc: null, speed: null, heading: null, cellMethod: est.method, cellTowers: est.towers,
  });
}

// ---------- HUD ----------
function updateLocInfo() {
  const now = Date.now();
  const fmt = (lat, lon, acc, src) => `${lat.toFixed(5)}, ${lon.toFixed(5)} ±${Math.round(acc)} m · ${src}`;
  if (!gpsWeak()) { locInfo.textContent = fmt(lastCoords.latitude, lastCoords.longitude, lastCoords.accuracy, 'GPS'); return; }

  const e = cellState.est;
  if (cellUsable() && (!fresh(lastFixAt) || e.accuracy < lastCoords.accuracy)) {
    locInfo.textContent = fmt(e.lat, e.lon, e.accuracy, `cell (${e.known} tower${e.known === 1 ? '' : 's'})`);
    return;
  }
  let gpsText;
  if (gpsError) gpsText = `GPS: ${gpsError}`;
  else if (!lastFixAt) gpsText = `GPS: acquiring… ${fmtDuration(now - gpsStartedAt)}`;
  else if (!fresh(lastFixAt)) gpsText = `GPS: lost ${fmtDuration(now - lastFixAt)} ago`;
  else gpsText = `${fmt(lastCoords.latitude, lastCoords.longitude, lastCoords.accuracy, 'GPS')} (weak)`;

  let cellText = '';
  if (settings.cellFallback && isNative) {
    if (cellState.error) cellText = ` · cells: ${cellState.error}`;
    else if (cellState.est) cellText = ` · cells: ${cellState.est.seen} seen, ${cellState.est.known} in DB`;
    else cellText = ' · cells: scanning';
  }
  locInfo.textContent = gpsText + cellText;
}

function renderScan() {
  const tbody = document.querySelector('#scanTable tbody');
  const cells = cellState.cells || [];
  const lookup = cellState.lookup || new Map();
  tbody.replaceChildren();
  for (const c of cells) {
    const k = Towers.cellKey(c);
    const tr = document.createElement('tr');
    if (c.registered) tr.className = 'serving';
    const v = (x) => (x == null ? '–' : x);
    const known = k ? (lookup.has(k) ? '<span class="yes">✓</span>' : 'no') : 'n/a';
    tr.innerHTML = `<td>${c.type.toUpperCase()}${c.registered ? ' ★' : ''}</td><td>${v(c.mcc)}-${v(c.mnc)}</td>
      <td>${v(c.area)}</td><td>${v(c.cid)}</td><td>${v(c.dbm)}</td><td>${v(c.ta)}</td><td>${known}</td>`;
    tbody.append(tr);
  }
  const e = cellState.est;
  $('scanSummary').textContent = !isNative ? 'Android app only'
    : cellState.error ? cellState.error
    : e ? `${e.seen} seen · ${e.known} known` : (settings.cellFallback ? 'scanning…' : 'off');
  $('scanEstimate').textContent = e && e.lat != null
    ? `Cell estimate: ${e.lat.toFixed(5)}, ${e.lon.toFixed(5)} ±${e.accuracy} m (${e.method}). ★ = serving cell.`
    : (cells.length ? 'No visible tower is in the database yet. Import the OpenCelliD file for this area. Neighbour cells often show no Cell ID; that is normal.' : '');
}

// ---------- Recording ----------
function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}
const extFor = (mime) => (mime.includes('mp4') ? 'mp4' : 'webm');

function recordPoint(p) {
  const offset = p.t - current.startedAt;
  if (offset < -2000) return;
  lastFixTs = Math.max(lastFixTs, p.t);
  current.pointCount++;
  if (p.source === 'cell') current.cellPointCount++;
  dbPut('points', { recId: current.id, offset, ...p }).catch((e) => console.error('point write failed', e));
}

async function startRecording() {
  if (!stream) return;
  const mime = pickMime();
  if (mime === null) { setStatus('MediaRecorder is not supported here.', true); return; }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

  const id = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  try { recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: VIDEO_BITRATE } : {}); }
  catch (_) { recorder = new MediaRecorder(stream); }
  const mimeType = recorder.mimeType || mime || 'video/webm';
  const rec = {
    id, startedAt: Date.now(), endedAt: null, mimeType, ext: extFor(mimeType),
    chunkCount: 0, bytes: 0, pointCount: 0, cellPointCount: 0, pending: Promise.resolve(),
  };
  const meta = () => ({
    id: rec.id, startedAt: rec.startedAt, endedAt: rec.endedAt, mimeType: rec.mimeType, ext: rec.ext,
    chunkCount: rec.chunkCount, bytes: rec.bytes, pointCount: rec.pointCount, cellPointCount: rec.cellPointCount,
    cellFallback: settings.cellFallback, weakAcc: settings.weakAcc,
  });

  recorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    const seq = rec.chunkCount++;
    rec.bytes += e.data.size;
    rec.pending = rec.pending
      .then(() => dbPut('chunks', { recId: rec.id, seq, blob: e.data }))
      .then(() => { if (seq % 10 === 0) return dbPut('recordings', meta()); })
      .catch((err) => { console.error(err); setStatus(`Storage write failed: ${err.message}`, true); });
  };
  recorder.onstart = () => { rec.startedAt = Date.now(); dbPut('recordings', meta()); };
  recorder.onerror = (e) => setStatus(`Recorder error: ${e.error?.message || e}`, true);
  recorder.onstop = async () => {
    rec.endedAt = Date.now();
    await rec.pending;
    await dbPut('recordings', meta());
    setStatus(`Recorded ${fmtDuration(rec.endedAt - rec.startedAt)} · ${fmtBytes(rec.bytes)} · ${rec.pointCount} points (${rec.cellPointCount} from cells). Tap Save to export.`);
    renderList();
  };

  current = rec;
  lastFixTs = 0;
  lastGpsTs = 0;
  recorder.start(CHUNK_MS);

  recordBtn.textContent = 'Stop';
  recordBtn.classList.add('stop');
  cameraSelect.disabled = startCamBtn.disabled = true;
  recDot.classList.add('on');
  timerInt = setInterval(() => { timerEl.textContent = fmtDuration(Date.now() - rec.startedAt); }, 250);
  keepAwake(true);
  const hasFix = fresh(lastFixAt) || cellUsable();
  setStatus(hasFix ? `Recording (${rec.ext.toUpperCase()})…` : 'Recording — no location fix yet. The track starts as soon as one is found.', !hasFix);
}

function stopRecording() {
  if (!recorder || recorder.state === 'inactive') return;
  current = null;
  recorder.stop();
  clearInterval(timerInt);
  recDot.classList.remove('on');
  recordBtn.textContent = 'Record';
  recordBtn.classList.remove('stop');
  cameraSelect.disabled = startCamBtn.disabled = false;
  keepAwake(false);
  setStatus('Finishing…');
}

async function keepAwake(on) {
  try {
    if (isNative) { await CellInfo.keepAwake({ on }); return; }
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    if (!on) { wakeLock?.release(); wakeLock = null; }
  } catch (_) {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && current && !isNative) keepAwake(true);
});

// ---------- Export ----------
function toGeoJSON(meta, points, videoName) {
  const has3D = points.length > 0 && points.every((p) => p.alt != null);
  const coords = points.map((p) => (has3D ? [p.lon, p.lat, p.alt] : [p.lon, p.lat]));
  let geometry = null;
  if (coords.length >= 2) geometry = { type: 'LineString', coordinates: coords };
  else if (coords.length === 1) geometry = { type: 'Point', coordinates: coords[0] };
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry,
      properties: {
        name: `FieldCam ${new Date(meta.startedAt).toLocaleString()}`,
        app: 'FieldCam',
        video: videoName,
        videoMimeType: meta.mimeType,
        startTime: new Date(meta.startedAt).toISOString(),
        endTime: meta.endedAt ? new Date(meta.endedAt).toISOString() : null,
        durationMs: meta.endedAt ? meta.endedAt - meta.startedAt : null,
        pointCount: points.length,
        cellPointCount: points.filter((p) => p.source === 'cell').length,
        cellFallback: !!meta.cellFallback,
        weakGpsThresholdM: meta.weakAcc ?? null,
        // Per-coordinate arrays, same order/length as geometry coordinates:
        coordTimes: points.map((p) => new Date(p.t).toISOString()),
        videoOffsetMs: points.map((p) => p.offset),
        source: points.map((p) => p.source || 'gps'),            // 'gps' | 'cell'
        accuracy: points.map((p) => p.acc),
        altitudeAccuracy: points.map((p) => p.altAcc ?? null),
        speed: points.map((p) => p.speed ?? null),
        heading: points.map((p) => p.heading ?? null),
        cellMethod: points.map((p) => p.cellMethod ?? null),      // how the cell estimate was made
        cellTowers: points.map((p) => p.cellTowers ?? null),      // towers used: key "RADIO:MCC:MNC:AREA:CID", dBm, TA
      },
    }],
  };
}

async function buildFiles(meta) {
  const chunks = (await dbGetByRec('chunks', meta.id)).sort((a, b) => a.seq - b.seq);
  const points = (await dbGetByRec('points', meta.id)).sort((a, b) => a.t - b.t);
  const base = `fieldcam-${meta.id}`;
  const videoName = `${base}.${meta.ext}`;
  const video = new File(chunks.map((c) => c.blob), videoName, { type: meta.mimeType.split(';')[0] });
  const geo = new File([JSON.stringify(toGeoJSON(meta, points, videoName), null, 1)], `${base}.geojson`, { type: 'application/geo+json' });
  return [video, geo];
}

const blobToBase64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] || '');
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

/** Writes files to Documents/FieldCam on the phone. Video is streamed in 3 MB pieces. */
async function nativeSave(files) {
  try { await Filesystem.requestPermissions(); } catch (_) {}   // only matters on Android ≤ 10
  const uris = [];
  for (const f of files) {
    const path = `${SAVE_FOLDER}/${f.name}`;
    if (f.name.endsWith('.geojson')) {
      await Filesystem.writeFile({ path, data: await f.text(), directory: SAVE_DIR, encoding: 'utf8', recursive: true });
    } else {
      const CH = 3 * 1024 * 1024;
      let off = 0, first = true;
      while (first || off < f.size) {
        const data = await blobToBase64(f.slice(off, off + CH));
        if (first) await Filesystem.writeFile({ path, data, directory: SAVE_DIR, recursive: true });
        else await Filesystem.appendFile({ path, data, directory: SAVE_DIR });
        first = false;
        off += CH;
        setStatus(`Saving ${f.name}… ${Math.min(100, Math.round((off / Math.max(1, f.size)) * 100))}%`);
      }
    }
    uris.push((await Filesystem.getUri({ path, directory: SAVE_DIR })).uri);
  }
  return uris;
}

async function saveRecording(meta) {
  setStatus('Preparing files…');
  const files = await buildFiles(meta);
  if (isNative) {
    await nativeSave(files);
    setStatus(`Saved to Documents/${SAVE_FOLDER}/: ${files.map((f) => f.name).join(', ')}`);
    return;
  }
  for (const f of files) { downloadFile(f); await new Promise((r) => setTimeout(r, 400)); }
  setStatus(`Downloaded ${files.map((f) => f.name).join(' + ')}`);
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function shareRecording(meta) {
  setStatus('Preparing files…');
  const files = await buildFiles(meta);
  try {
    if (isNative) {
      const uris = await nativeSave(files);
      await Share.share({ title: files[0].name, files: uris });
    } else if (navigator.canShare?.({ files })) {
      await navigator.share({ files, title: files[0].name });
    } else {
      setStatus('Sharing files is not supported here — use Save.', true);
      return;
    }
    setStatus('Shared.');
  } catch (e) {
    const cancelled = e.name === 'AbortError' || /cancel/i.test(e.message || '');
    setStatus(cancelled ? 'Share cancelled.' : `Share failed: ${e.message}`, !cancelled);
  }
}

async function playRecording(meta) {
  if (current) return;
  const [video] = await buildFiles(meta);
  stopCamera();
  recordBtn.disabled = true;
  startCamBtn.textContent = 'Back to camera';
  preview.srcObject = null;
  if (preview.dataset.url) URL.revokeObjectURL(preview.dataset.url);
  preview.dataset.url = URL.createObjectURL(video);
  preview.src = preview.dataset.url;
  preview.muted = false;
  preview.controls = true;
  preview.play().catch(() => {});
  setStatus(`Playing ${video.name}`);
}
function resetPreview() {
  preview.pause();
  preview.removeAttribute('src');
  preview.controls = false;
  preview.muted = true;
  if (preview.dataset.url) { URL.revokeObjectURL(preview.dataset.url); delete preview.dataset.url; }
}

// ---------- Recordings list ----------
async function renderList() {
  const recs = (await dbGetAll('recordings')).sort((a, b) => b.startedAt - a.startedAt);
  listEl.replaceChildren();
  if (!recs.length) listEl.innerHTML = '<li class="muted">No recordings yet.</li>';
  for (const r of recs) {
    const li = document.createElement('li');
    const live = current && current.id === r.id;
    if (!r.endedAt && !live) r.endedAt = r.startedAt + r.chunkCount * CHUNK_MS;   // crashed session: estimate end
    li.innerHTML = `
      <div class="title">${new Date(r.startedAt).toLocaleString()}</div>
      <div class="meta">
        ${live ? 'Recording…' : fmtDuration(r.endedAt - r.startedAt)}
        · ${fmtBytes(r.bytes)} · ${r.pointCount} pts${r.cellPointCount ? ` (${r.cellPointCount} cell)` : ''} · ${r.ext.toUpperCase()}
      </div>
      <div class="actions"></div>`;
    if (!live) {
      const actions = li.querySelector('.actions');
      const btn = (label, fn, cls) => {
        const b = Object.assign(document.createElement('button'), { textContent: label });
        if (cls) b.className = cls;
        b.onclick = () => fn().catch((e) => setStatus(e.message || String(e), true));
        actions.append(b);
      };
      btn('Play', () => playRecording(r));
      btn('Save', () => saveRecording(r));
      if (isNative || navigator.canShare) btn('Share', () => shareRecording(r));
      btn('Delete', async () => {
        if (!confirm('Delete this recording from the app? (Files already saved to Documents stay.)')) return;
        await dbDeleteRecording(r.id);
        renderList();
      }, 'danger');
    }
    listEl.append(li);
  }
  updateStorage();
}

async function updateStorage() {
  if (!navigator.storage?.estimate) return;
  const { usage, quota } = await navigator.storage.estimate();
  storageEl.textContent = `${fmtBytes(usage)} used of ${fmtBytes(quota)}`;
}

// ---------- Tower database import ----------
const impStatus = $('impStatus'), impProgress = $('impProgress');

async function refreshTowerCount() {
  const n = await dbCount('towers');
  $('towerCount').textContent = n ? `${n.toLocaleString()} towers` : 'empty';
  return n;
}

async function importTowerFile(file, filter, onProgress) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const gz = head[0] === 0x1f && head[1] === 0x8b;
  let readBytes = 0;
  let s = file.stream().pipeThrough(new TransformStream({
    transform(chunk, ctl) { readBytes += chunk.byteLength; ctl.enqueue(chunk); },
  }));
  if (gz) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This device cannot unzip .gz files. Extract the .csv first.');
    s = s.pipeThrough(new DecompressionStream('gzip'));
  }
  const reader = s.pipeThrough(new TextDecoderStream()).getReader();
  const keep = filter
    ? (t) => Math.abs(t.lat - filter.lat) < filter.dLat && Towers.distanceM(filter.lat, filter.lon, t.lat, t.lon) <= filter.radiusM
    : () => true;
  let buf = '', rows = 0, kept = 0, batch = [];
  const flush = async () => { if (batch.length) { await dbPutMany('towers', batch); kept += batch.length; batch = []; } };
  const handle = (line) => {
    const t = Towers.parseTowerLine(line.trim());
    if (!t) return;
    rows++;
    if (keep(t)) batch.push(t);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) handle(line);
    if (batch.length >= 5000) await flush();
    onProgress(readBytes / file.size, rows, kept + batch.length);
  }
  if (buf) handle(buf);
  await flush();
  return { rows, kept };
}

$('importBtn').onclick = () => $('towerFile').click();
$('towerFile').onchange = async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  const lat = parseFloat($('impLat').value), lon = parseFloat($('impLon').value);
  const radiusKm = parseFloat($('impRadius').value) || 300;
  const filter = Number.isFinite(lat) && Number.isFinite(lon)
    ? { lat, lon, radiusM: radiusKm * 1000, dLat: radiusKm / 111 + 0.1 } : null;
  $('importBtn').disabled = $('clearTowers').disabled = true;
  impProgress.hidden = false;
  impProgress.value = 0;
  const t0 = Date.now();
  try {
    const { rows, kept } = await importTowerFile(file, filter, (p, rows, kept) => {
      impProgress.value = p;
      impStatus.textContent = `Reading ${file.name}: ${Math.round(p * 100)}% · ${rows.toLocaleString()} towers read · ${kept.toLocaleString()} kept`;
    });
    towerCache.clear();
    const total = await refreshTowerCount();
    impStatus.textContent = `Done in ${fmtDuration(Date.now() - t0)}: ${kept.toLocaleString()} of ${rows.toLocaleString()} towers kept`
      + `${filter ? ` (within ${radiusKm} km)` : ''}. Database now holds ${total.toLocaleString()} towers.`;
    if (!rows) impStatus.textContent = 'No towers found. Is this an OpenCelliD .csv or .csv.gz file?';
  } catch (e) {
    impStatus.textContent = `Import failed: ${e.message || e}`;
  } finally {
    impProgress.hidden = true;
    $('importBtn').disabled = $('clearTowers').disabled = false;
  }
};
$('clearTowers').onclick = async () => {
  if (!confirm('Remove all towers from the offline database?')) return;
  await dbClear('towers');
  towerCache.clear();
  refreshTowerCount();
  impStatus.textContent = 'Tower database cleared.';
};
$('useLoc').onclick = () => {
  const c = lastCoords || (cellUsable() ? { latitude: cellState.est.lat, longitude: cellState.est.lon } : null);
  if (c) { $('impLat').value = c.latitude.toFixed(4); $('impLon').value = c.longitude.toFixed(4); return; }
  impStatus.textContent = 'Getting your location…';
  navigator.geolocation.getCurrentPosition((p) => {
    $('impLat').value = p.coords.latitude.toFixed(4);
    $('impLon').value = p.coords.longitude.toFixed(4);
    impStatus.textContent = '';
  }, (e) => { impStatus.textContent = `Could not get location: ${e.message}. Type the coordinates instead.`; },
  { enableHighAccuracy: false, timeout: 60_000, maximumAge: 600_000 });
};

// ---------- Utils ----------
function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return h ? `${h}:${mmss}` : mmss;
}
function fmtBytes(b = 0) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}

// ---------- Settings UI ----------
const cellFallbackEl = $('cellFallback'), weakAccEl = $('weakAcc');
cellFallbackEl.checked = settings.cellFallback;
weakAccEl.value = String(settings.weakAcc);
cellFallbackEl.onchange = () => {
  settings.cellFallback = cellFallbackEl.checked;
  saveSettings();
  if (settings.cellFallback && geoWatch !== null) startCells();
  if (!settings.cellFallback) stopCells();
};
weakAccEl.onchange = () => { settings.weakAcc = Number(weakAccEl.value); saveSettings(); updateLocInfo(); };

// ---------- Startup ----------
startCamBtn.onclick = () => { resetPreview(); startCamera(); };
cameraSelect.onchange = () => { if (stream) startCamera(); };
recordBtn.onclick = () => (current ? stopRecording() : startRecording());

$('platform').textContent = isNative ? 'Android app' : 'browser preview';
$('cellNote').textContent = isNative
  ? 'Reads the towers your phone can hear and looks them up in the offline database below. Needs mobile signal (no data). Expect roughly 200 m–3 km accuracy.'
  : 'Cell-tower positioning needs the FieldCam Android app. In a browser only GPS is recorded.';
if (!isNative) cellFallbackEl.disabled = true;
if (!navigator.mediaDevices?.getUserMedia) setStatus('Camera access is not supported here.', true);

renderScan();
renderList();
refreshTowerCount();
