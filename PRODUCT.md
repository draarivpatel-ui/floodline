# PRODUCT.md

## What FloodLine is

A self-contained, offline training workbench for flood-evacuation reasoning. One page:
scenario controls, an atlas-style basin map, a hydrograph and metric panels, a scrubbable
storm timeline, a severity-tier mitigation comparator, an evacuation cutoff timeline with
per-zone alert strips, a signed-brief and self-check panel, and a printable bilingual
go-card. It exists so a student or a family can practice one question: when is it too late
to leave, and which way stays dry?

## Audience and use scene

Students and families in a guided training setting, run locally or from a static host, on
a laptop or a printed card. The operator is a learner, not a forecaster: they scrub the
storm, read a verdict, and take a card home.

## Non-negotiable product truths

- **Synthetic and educational only.** The basin, places, roads, and storms are fictional.
  The app issues no forecasts, warnings, or evacuation orders and says so in the UI, on
  the card, and in every export.
- **Never enter floodwater.** The standing safety line appears on screen and on the card;
  comparison depths in the UI are teaching references, never "safe to cross" thresholds.
- **Everything is derived.** Every displayed number, cutoff, and counterfactual comes from
  the model modules' returned values; the UI hardcodes no results.
- **Offline and dependency-free.** Plain HTML, CSS, and ES modules; no build step, no
  packages, no network calls for data, no external assets or fonts. A scoped service
  worker precaches the shell.
- **Honest exports.** CSV telemetry, a synthetic-coordinates GeoJSON snapshot, a SHA-256
  audit bundle over deterministic canonical JSON, and signed resilience briefs that verify
  and fail on any edit in-page; no timestamps, no local paths.
- **Bilingual where it counts.** The app runs in English; the family go-card and neighborhood buddy
  card render fully in English or Spanish, including their dialog controls and plain-text exports.

## Constraints

- Node >= 20, zero dependencies, `npm start` (127.0.0.1:4173) and `npm test` (`node --test`).
- Strict CSP: `default-src 'none'`, self-only scripts/styles, no connections, no objects.
- noindex. No analytics, no uploads, no external services.
- Native controls and real text throughout; the go-card must print on one Letter page.

## Sources audited for the model layer

- TR-55 curve-number relations (Eq. 2-1 to 2-4) and connected impervious CN 98:
  <https://www.nrc.gov/docs/ML1421/ML14219A437.pdf>
- Manning's equation in SI form:
  <https://pubs.usgs.gov/of/1988/0707/report.pdf>
- Flood safety wording ("Never enter floodwater"; the 6/12-inch figures describe danger,
  not safe crossing depths):
  <https://www.weather.gov/safety/flood-turn-around-dont-drown>
