/*
 * FieldCam — offline cell-tower positioning.
 *
 * Pure functions (no DOM / IndexedDB) so they can be unit-tested in Node:
 *   parseTowerLine(line)            → tower record from an OpenCelliD CSV line
 *   cellKey(cell)                   → lookup key for a scanned cell
 *   estimatePosition(cells, lookup) → { lat, lon, accuracy, ... } from towers we know
 *
 * OpenCelliD CSV columns:
 *   radio,mcc,net,area,cell,unit,lon,lat,range,samples,changeable,created,updated,averageSignal
 */
(function (root) {
  'use strict';

  const RADIO = { gsm: 'GSM', wcdma: 'UMTS', lte: 'LTE', nr: 'NR' };
  const TA_METERS = { lte: 78.12, gsm: 553.5 };   // one timing-advance step ≈ this many metres
  const MAX_CELL_AGE_MS = 30_000;                 // ignore neighbour reports older than this
  const EARTH_R = 6_371_000;

  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;

  function distanceM(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** Point at `dist` metres from (lat,lon) in the direction of (lat2,lon2). */
  function towardM(lat, lon, lat2, lon2, dist) {
    const total = distanceM(lat, lon, lat2, lon2);
    if (total < 1) return { lat, lon };
    const f = dist / total;
    return { lat: lat + (lat2 - lat) * f, lon: lon + (lon2 - lon) * f };   // fine at cell-tower scales
  }

  function towerKey(radio, mcc, net, area, cell) {
    return `${radio}:${mcc}:${net}:${area}:${cell}`;
  }

  /** Parses one OpenCelliD CSV line. Returns null for headers / malformed lines. */
  function parseTowerLine(line) {
    if (!line || line.charCodeAt(0) === 114 /* 'r'adio header */) return null;
    const c = line.split(',');
    if (c.length < 10) return null;
    const lon = Number(c[6]), lat = Number(c[7]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
    return {
      k: towerKey(c[0].trim().toUpperCase(), Number(c[1]), Number(c[2]), Number(c[3]), Number(c[4])),
      lat, lon,
      r: Number(c[8]) || 0,        // OpenCelliD's estimated coverage radius (m)
      n: Number(c[9]) || 0,        // number of measurements behind this estimate
    };
  }

  /** Key for a cell reported by the native plugin, or null if its identity is incomplete. */
  function cellKey(cell) {
    const radio = RADIO[cell.type];
    if (!radio || cell.mcc == null || cell.mnc == null || cell.area == null || cell.cid == null) return null;
    return towerKey(radio, cell.mcc, cell.mnc, cell.area, cell.cid);
  }

  function weightFor(cell) {
    const dbm = Number.isFinite(cell.dbm) ? Math.min(-40, Math.max(-140, cell.dbm)) : -110;
    let w = 10 ** ((dbm + 120) / 20);      // signal amplitude: -120 dBm → 1, -60 dBm → 1000
    if (cell.registered) w *= 2;           // the serving cell is usually the closest
    return w;
  }

  /**
   * Estimates position from a cell scan.
   * @param {Array} cells   cells from CellInfo.getCells()
   * @param {Map|Object} lookup  key → {lat, lon, r}
   * @returns {{lat:number|null, lon:number|null, accuracy:number|null, method:string,
   *            seen:number, known:number, towers:Array}}
   */
  function estimatePosition(cells, lookup) {
    const get = (k) => (lookup instanceof Map ? lookup.get(k) : lookup[k]);
    const usable = (cells || []).filter((c) => c.ageMs == null || c.ageMs <= MAX_CELL_AGE_MS);
    const known = [];
    for (const c of usable) {
      const k = cellKey(c);
      const t = k && get(k);
      if (t) known.push({ c, t, k, w: weightFor(c) });
    }
    const base = { seen: usable.length, known: known.length, towers: known.map((x) => ({ key: x.k, dbm: x.c.dbm ?? null, ta: x.c.ta ?? null, registered: !!x.c.registered })) };
    if (!known.length) return { lat: null, lon: null, accuracy: null, method: 'none', ...base };

    // Timing advance of the serving cell gives a distance ring around that tower.
    const serving = known.find((x) => x.c.registered) || null;
    const taDist = serving && Number.isFinite(serving.c.ta) && TA_METERS[serving.c.type]
      ? serving.c.ta * TA_METERS[serving.c.type] : null;

    if (known.length === 1) {
      const { t } = known[0];
      const accuracy = taDist != null
        ? taDist + TA_METERS[known[0].c.type] + 100            // somewhere on a ring of radius taDist
        : Math.min(15_000, Math.max(500, t.r || 3000));        // somewhere in the tower's coverage
      return { lat: t.lat, lon: t.lon, accuracy: Math.round(accuracy), method: taDist != null ? 'single-tower+ta' : 'single-tower', ...base };
    }

    // Weighted centroid of all known towers.
    let sw = 0, lat = 0, lon = 0;
    for (const x of known) { sw += x.w; lat += x.w * x.t.lat; lon += x.w * x.t.lon; }
    lat /= sw; lon /= sw;

    let spread2 = 0;
    for (const x of known) spread2 += x.w * distanceM(lat, lon, x.t.lat, x.t.lon) ** 2;
    const spread = Math.sqrt(spread2 / sw);

    let method = 'weighted-centroid';
    // Constrain to the serving cell's TA ring: slide the estimate along the line from the
    // serving tower so its distance matches the measured timing advance.
    if (taDist != null) {
      const d = distanceM(serving.t.lat, serving.t.lon, lat, lon);
      const step = TA_METERS[serving.c.type];
      if (Math.abs(d - taDist) > step * 2) {
        if (d > 1) ({ lat, lon } = towardM(serving.t.lat, serving.t.lon, lat, lon, taDist));
        method = 'weighted-centroid+ta';
      }
    }
    const accuracy = Math.max(250, taDist != null ? Math.min(spread, taDist + 300) : spread);
    return { lat, lon, accuracy: Math.round(accuracy), method, ...base };
  }

  const api = { parseTowerLine, cellKey, estimatePosition, distanceM, towerKey, RADIO, MAX_CELL_AGE_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Towers = api;
})(typeof self !== 'undefined' ? self : this);
