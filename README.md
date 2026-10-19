# FieldCam

An Android app that records video with a synchronized location track. Where GPS is weak or missing,
it falls back to **offline cell-tower positioning**. It reads the towers your phone can hear and
looks them up in an OpenCelliD database stored on the phone. No internet is needed in the field.

Outputs per recording, saved to **Documents/FieldCam/** on the phone:

- `fieldcam-<time>.mp4` (or `.webm`): the video
- `fieldcam-<time>.geojson`: the track, with each point tagged `gps` or `cell`

---

## 1. Get the APK (no Android Studio needed)

The repo includes a GitHub Actions workflow that builds the app for free:

1. Create a new **empty** GitHub repository (private is fine).
2. Upload this folder's contents: drag and drop on github.com, or
   `git init && git add . && git commit -m "FieldCam" && git branch -M main && git remote add origin <url> && git push -u origin main`.
3. Open the repo's **Actions** tab. The *Build FieldCam APK* run starts by itself and takes about 5 minutes.
4. When it's green, open **Releases → "FieldCam — latest debug build"** on your phone and download
   `FieldCam-debug.apk`. The same file is also attached to the Actions run as an artifact.
5. Install it. Android will ask you to allow installs from your browser or file manager. It's a debug
   build signed with a debug key, so Play Protect may warn you; choose *Install anyway*.

Every push to `main` rebuilds the APK.

**Building locally instead:** install Android Studio (JDK 21, Android SDK 36), then run
`npm ci && npm run sync`, and either `cd android && ./gradlew assembleDebug` or open `android/` in
Android Studio and press Run.

## 2. Before a trip (with internet)

1. **Load the tower database.** Cell positioning only works for towers in this database.
   - Sign up at <https://opencellid.org> and get a free API token.
   - On the phone, download your country's file from the OpenCelliD **Downloads** page. India is
     MCC **404** and **405**, so get both `404.csv.gz` and `405.csv.gz`.
   - In FieldCam, open **Offline tower database**. Enter the centre of your travel area (or tap
     *Use current location*) and a radius, such as 300 km. Then **Import** each file.
     The `.gz` is unpacked on the phone. Filtering by radius keeps the import fast; a whole-country
     file without a filter can take a long time.
2. Tap **Start camera** once and allow camera, microphone and location.
3. **Check coverage.** Open **Live cell scan**. The ★ row is your serving cell, and **In DB ✓** means
   the tower is in the database. OpenCelliD is crowd-sourced, so very remote towers may be missing.
   It's worth checking at your destination's nearest town.

## 3. In the field (no internet)

- Keep **Use cell towers when GPS is weak** switched on (the default). Choose the weak-GPS threshold.
- Location: **On**. Mobile network: **On**, so the phone keeps hearing towers. Mobile data can be off.
- The HUD shows the current source:
  - `±6 m · GPS`
  - `±900 m · cell (3 towers)`
  - `GPS: acquiring… · cells: 4 seen, 2 in DB`
- **Recording rules:**
  - GPS fixes are always recorded.
  - Cell estimates (every 5 s) are recorded only when GPS has been silent for 10 s, or when GPS
    accuracy is worse than your threshold *and* the cell estimate is better.
- The screen stays on while recording. Keep the app in the foreground.
- **Save** writes both files to `Documents/FieldCam/`. **Share** sends them to another app.

## How the cell positioning works

- The native plugin (`CellInfoPlugin.java`) asks the modem for every cell it can hear, using
  `TelephonyManager.requestCellInfoUpdate` on Android 10+ and `getAllCellInfo` on older versions.
  For each cell it gets the radio type, MCC, MNC, LAC/TAC, cell ID, signal (dBm) and timing advance.
- Cells with a complete identity are looked up as `RADIO:MCC:MNC:AREA:CID` in the on-phone
  OpenCelliD table.
- **Position estimate:**
  - **1 known tower:** the tower's position. Accuracy comes from its coverage radius, or from the
    timing-advance distance if the network reports it.
  - **2+ known towers:** a centroid weighted by signal strength. The serving cell gets double weight.
  - **Timing advance:** if the serving LTE/GSM cell reports it, the estimate is moved onto the
    distance ring around that tower (LTE about 78 m per step, GSM about 550 m).
- **Typical accuracy:** 200 m–3 km, depending on tower density, versus 3–10 m for GPS. Each point
  carries its accuracy.

## GeoJSON format

A `FeatureCollection` with one `LineString` (a `Point` for a single fix, `null` geometry for none).
Arrays in `properties` line up 1:1 with the coordinates:

| property | meaning |
|---|---|
| `coordTimes` | ISO timestamps |
| `videoOffsetMs` | ms from the first video frame; seek the video here |
| `source` | `"gps"` or `"cell"` |
| `accuracy` | metres (horizontal) |
| `altitudeAccuracy`, `speed`, `heading` | GPS only, else `null` |
| `cellMethod` | `single-tower`, `single-tower+ta`, `weighted-centroid`, `weighted-centroid+ta` |
| `cellTowers` | towers used: `{ key, dbm, ta, registered }` |

The raw tower keys are kept, so tracks can be re-processed later against a better database.

## Limits

- **Android only.** iPhones don't let apps read cell-tower data.
- Neighbour LTE/5G cells often report only a physical cell ID, not a full cell ID. Those can't be
  looked up, so in practice the serving cell plus GSM/3G neighbours do most of the work.
- Some phone makers restrict or cache cell scans. Android 10+ gives the freshest data.
- With no signal at all, there are no towers to measure, so the track relies on GPS alone.
- Recording pauses if the app goes to the background or the phone sleeps.
- Video is copied to Documents in 3 MB pieces, so saving a long recording takes a little while.

## Project layout

```
www/                      the app UI (plain HTML/JS, no build step)
  app.js                  recording, GPS, cell polling, tower import, saving
  towers.js               OpenCelliD parsing + position estimation (unit-tested)
  capacitor.js            Capacitor runtime (copied from node_modules by `npm run sync`)
android/                  native Android project (Capacitor 8)
  app/src/main/java/com/fieldcam/app/
    CellInfoPlugin.java   native cell-tower scanner + keep-screen-on
    MainActivity.java     registers the plugin
test/towers.test.js       `npm test`
.github/workflows/android.yml   builds the APK on GitHub
```

Opening `www/index.html` in a desktop browser gives a UI preview with GPS only, since cell scanning
needs the Android app.
