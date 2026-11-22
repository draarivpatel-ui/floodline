# FloodLine

FloodLine is a small, offline, dependency-free training workbench for flood-evacuation
reasoning. It lets a class or a family watch a synthetic storm raise water in a fictional
basin, compare a shortest route against a route that stays dry, and print a bilingual
(English/Spanish) go-card. Everything on screen is a teaching artifact: the basin, the
places, the roads, and the storm are invented, and the app issues no forecasts, warnings,
or evacuation orders.

**Live demo:** [https://aariv.me/floodline/](https://aariv.me/floodline/)

## Run

```
npm start
```

serves the app at `http://127.0.0.1:4173/` (plain `node:http`, allowlisted paths only,
also handles a `/floodline/` base path).

```
npm test
```

runs the Node test suite (`node --test`). Node 20 or newer is required; there are no
package dependencies.

## What the model does, in plain terms

- **Rainfall to runoff.** Each entered rainfall bin is treated as a synthetic pulse that
  lands at the end of its 15-minute interval. Cumulative rainfall is partitioned into
  initial abstraction, continuing storage, and runoff excess using the TR-55 curve-number
  relations (Eq. 2-1 through 2-4) audited in
  <https://www.nrc.gov/docs/ML1421/ML14219A437.pdf>; a connected-impervious percentage is
  blended toward curve number 98 as in that document. Runoff depth (mm) is converted to a
  volume over the watershed area (mm x km² x 1000 = m³) and spread through a unit-volume
  triangular pulse kernel, producing a discharge value at every integer minute with linear
  interpolation between minutes.
- **Discharge to stage.** Stage comes from Manning's equation in SI form, audited in
  <https://pubs.usgs.gov/of/1988/0707/report.pdf>, solved by bisection for a trapezoidal
  channel; the channel keeps its own bed slope for that flow computation. The flooded
  extent is a different thing entirely: not a sloped water surface and not a flat-slope
  channel spread, but a horizontal synthetic surface at the computed stage, measured
  over one shared reference datum that every road and floor elevation in the fictional
  basin is also measured against. When discharge exceeds bankfull, that same horizontal
  stage value is used as a synthetic overtopping depth against each road's floor. This
  is an illustrative extension, not a surveyed or hydraulically modeled floodplain, and
  the map's widening spread around the channel is a stylized, capped visual rather than
  a modeled inundation boundary.
- **Roughness.** The blockage slider multiplies Manning's n by (1 + blockage). It is an
  illustrative sensitivity knob, not culvert or bridge hydraulics. "Clear drains"
  restores the clean-channel n, "permeable pavement" subtracts 8 from the curve number,
  and "raise bridge" lifts only the road segment flagged as a bridge by 0.65 m.
- **No design recurrence.** The storms are invented pulses for training; no return period
  or design-storm status is established or claimed.
- **Routing.** Three different route computations are shown and should not be conflated:
  (1) a snapshot Dijkstra shortest path at the scrubbed minute, drawn as the amber dashed
  "shortest route"; (2) a dry-at-this-instant shortest path whose chosen legs are then
  checked for wetness across the actual traversal window, which is what "verified dry
  modeled trip" means; (3) a best initial continuous-window departure cutoff computed over
  all routes that open dry at minute zero, reported in the metrics as the departure
  window. A route that is dry in a snapshot can still flood mid-trip, and the UI says so.
  What the workbench does not do is search for a better plan when the chosen shortest
  path floods mid-trip: it does not explore wait-and-go departures or routes that reopen
  later; the departure-window metrics are the closest thing to a reroute search it
  performs. Travel speeds are fixed model constants for comparing scenarios (80 m/min
  on foot, 400 m/min by car), not road-speed estimates.
- **Volume bookkeeping.** The exported CSV carries the full simulated hydrograph,
  including the tail beyond the 360-minute workbench horizon, and evaluates its route
  columns at each row's own minute. It is per-minute synthetic telemetry, never
  navigation data. The metrics panel reports discharged volume against runoff volume;
  the small nonzero difference is a floating-point and trapezoid-integration residual,
  shown as the numerical tolerance it is.
- **Safety wording.** In-app references (15 cm walking, 30 cm car) are comparison depths
  for the exercise, not clearance thresholds. The National Weather Service warns never to
  enter floodwater: the 6-inch and 12-inch figures in its materials describe water that is
  already dangerous, not depths that are safe to cross. Source:
  <https://www.weather.gov/safety/flood-turn-around-dont-drown>.

## Files

- `index.html`, `styles.css`: the single-page workbench and the printable go-card.
- `src/hydrology.js`, `src/routing.js`, `src/presets.js`: model, routing, and scenario data.
- `src/viz.js`: the dark survey-sheet map and the hydrograph, drawn as SVG.
- `src/exports.js`: CSV telemetry, GeoJSON route snapshot, and a SHA-256 audit bundle with
  canonical (key-sorted, deterministic) JSON serialization.
- `src/card.js`: the bilingual go-card model and renderer.
- `src/controls.js`: opt-in keyboard shortcuts (P for play, G for the go-card).
- `sw.js`: scoped service worker that precaches the local shell for offline use.
- `tools/serve.mjs`: the zero-dependency dev server.
- `tools/browser-check.mjs`: optional end-to-end verifier (requires Chrome and Node 22+).

## Offline and security notes

Offline use needs one first load on the same origin so the scoped service worker can
precache the shell; bump the version in `sw.js` after shell changes so the next load
refreshes the cache. The page's `connect-src 'none'` CSP blocks data network calls from
the app; the initial static file download still happens over HTTP before the worker can
serve anything.

All coordinates, place names, and road names are fictional. Exported GeoJSON is anchored
near Null Island, marked `synthetic_coordinates`, and must never be used for navigation.
