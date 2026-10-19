// Run: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const zlib = require('node:zlib');
const T = require('../www/towers.js');

const truth = { lat: 26.1445, lon: 91.7362 };            // test point
const off = (dLatM, dLonM) => ({ lat: truth.lat + dLatM / 111_320, lon: truth.lon + dLonM / (111_320 * Math.cos(truth.lat * Math.PI / 180)) });
const line = (radio, mcc, net, area, cell, p, range = 1500) => `${radio},${mcc},${net},${area},${cell},0,${p.lon},${p.lat},${range},12,1,1500000000,1700000000,0`;

test('parseTowerLine handles data, header and junk', () => {
  const t = T.parseTowerLine(line('LTE', 405, 857, 1234, 98765432, truth));
  assert.equal(t.k, 'LTE:405:857:1234:98765432');
  assert.ok(Math.abs(t.lat - truth.lat) < 1e-9 && t.r === 1500);
  assert.equal(T.parseTowerLine('radio,mcc,net,area,cell,unit,lon,lat,range,samples,changeable,created,updated,averageSignal'), null);
  assert.equal(T.parseTowerLine(''), null);
  assert.equal(T.parseTowerLine('LTE,405,857'), null);
  assert.equal(T.parseTowerLine('GSM,404,1,1,1,0,0,0,100,1,1,1,1,0'), null);   // 0,0 coordinates
});

test('cellKey maps Android types to OpenCelliD radios and rejects incomplete cells', () => {
  assert.equal(T.cellKey({ type: 'wcdma', mcc: 404, mnc: 45, area: 200, cid: 1234567 }), 'UMTS:404:45:200:1234567');
  assert.equal(T.cellKey({ type: 'gsm', mcc: 404, mnc: 45, area: 200, cid: 77 }), 'GSM:404:45:200:77');
  assert.equal(T.cellKey({ type: 'lte', pci: 120, dbm: -95 }), null);           // neighbour with no CI
  assert.equal(T.cellKey({ type: 'cdma', mcc: 1, mnc: 1, area: 1, cid: 1 }), null);
});

const towers = new Map();
const add = (radio, net, area, cell, p, r) => { const t = T.parseTowerLine(line(radio, 405, net, area, cell, p, r)); towers.set(t.k, t); return t; };
const A = add('LTE', 857, 10, 1001, off(1200, 0));      // 1.2 km N
const B = add('LTE', 857, 10, 1002, off(-900, 800));    // SE
const C = add('LTE', 857, 10, 1003, off(-300, -1500));  // W
const cell = (cid, dbm, extra = {}) => ({ type: 'lte', mcc: 405, mnc: 857, area: 10, cid, dbm, ...extra });

test('no known towers → no estimate but counts what was seen', () => {
  const e = T.estimatePosition([cell(9999, -80), { type: 'lte', pci: 3, dbm: -100 }], towers);
  assert.equal(e.lat, null); assert.equal(e.seen, 2); assert.equal(e.known, 0); assert.equal(e.method, 'none');
});

test('single tower → tower position, accuracy from coverage radius', () => {
  const e = T.estimatePosition([cell(1001, -85, { registered: true })], towers);
  assert.equal(e.method, 'single-tower');
  assert.ok(Math.abs(e.lat - A.lat) < 1e-9);
  assert.equal(e.accuracy, 1500);
});

test('single tower + timing advance → ring accuracy', () => {
  const e = T.estimatePosition([cell(1001, -85, { registered: true, ta: 15 })], towers);
  assert.equal(e.method, 'single-tower+ta');
  assert.equal(e.accuracy, Math.round(15 * 78.12 + 78.12 + 100));
});

test('three towers → weighted centroid lands near the truth and honest accuracy covers the error', () => {
  const e = T.estimatePosition([cell(1001, -80, { registered: true }), cell(1002, -92), cell(1003, -95)], towers);
  const err = T.distanceM(truth.lat, truth.lon, e.lat, e.lon);
  assert.equal(e.method, 'weighted-centroid'); assert.equal(e.known, 3);
  assert.ok(err < 1500, `error ${err.toFixed(0)} m`);
  assert.ok(e.accuracy >= err * 0.6, `accuracy ${e.accuracy} vs error ${err.toFixed(0)}`);
  console.log(`    centroid error ${err.toFixed(0)} m, reported ±${e.accuracy} m`);
});

test('timing advance pulls the estimate onto the serving-tower ring', () => {
  const ta = Math.round(1200 / 78.12);   // true distance to A ≈ 1.2 km
  const e = T.estimatePosition([cell(1001, -80, { registered: true, ta }), cell(1002, -92), cell(1003, -95)], towers);
  const dA = T.distanceM(A.lat, A.lon, e.lat, e.lon);
  assert.ok(Math.abs(dA - ta * 78.12) < 5, `distance to serving tower ${dA.toFixed(0)}`);
  const err = T.distanceM(truth.lat, truth.lon, e.lat, e.lon);
  console.log(`    with TA: error ${err.toFixed(0)} m, reported ±${e.accuracy} m (${e.method})`);
  assert.ok(err < 1200);
});

test('stale neighbour reports are ignored', () => {
  const e = T.estimatePosition([cell(1001, -80, { registered: true, ageMs: 500 }), cell(1002, -70, { ageMs: 120000 })], towers);
  assert.equal(e.known, 1); assert.equal(e.seen, 1);
});

// ---- the real importTowerFile() from app.js, run against a gzipped OpenCelliD-style file ----
test('importTowerFile streams .csv.gz, skips header, applies radius filter', async () => {
  const src = fs.readFileSync(__dirname + '/../www/app.js', 'utf8');
  const fnSrc = src.slice(src.indexOf('async function importTowerFile'), src.indexOf("$('importBtn').onclick"));
  const stored = [];
  const importTowerFile = new Function('Towers', 'dbPutMany', `${fnSrc}; return importTowerFile;`)(
    T, async (_store, rows) => { stored.push(...rows); });

  const rows = ['radio,mcc,net,area,cell,unit,lon,lat,range,samples,changeable,created,updated,averageSignal'];
  for (let i = 0; i < 20000; i++) rows.push(line('LTE', 405, 857, i % 50, 100000 + i, off((i % 200) * 50, (i % 7) * 40)));
  rows.push(line('GSM', 404, 45, 1, 1, { lat: 28.61, lon: 77.21 }));   // Delhi: outside 300 km of Guwahati
  const gz = zlib.gzipSync(rows.join('\n') + '\n');
  const file = new File([gz], '405.csv.gz');

  let lastP = 0;
  const res = await importTowerFile(file, { lat: truth.lat, lon: truth.lon, radiusM: 300_000, dLat: 300 / 111 + 0.1 }, (p) => { lastP = p; });
  assert.equal(res.rows, 20001);
  assert.equal(res.kept, 20000);
  assert.equal(stored.length, 20000);
  assert.ok(lastP > 0.99, 'progress reaches 100%');

  stored.length = 0;
  const plain = new File([rows.slice(1, 11).join('\n')], 'x.csv');           // no header, no trailing newline
  const r2 = await importTowerFile(plain, null, () => {});
  assert.equal(r2.rows, 10); assert.equal(stored.length, 10);
});
