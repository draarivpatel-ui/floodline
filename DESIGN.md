# DESIGN.md

## World

A printed survey field sheet. FloodLine reads like a page pulled from a field surveyor's
folder: cream stock, hairline rules, labeled controls set in a workhorse sans, measured
values in monospace, and one immersive artifact at the center - a dark topographic plate
of the fictional basin. The mode is Operate: the page is a working instrument first, and
the world supplies only type, palette, density, and the dark map plate as its signature.

## Palette

| Token | Value | Role |
| --- | --- | --- |
| `--ground` | `#f4f1e7` | page ground, the folder stock |
| `--paper` | `#fffdf7` | control rail, panels, card |
| `--ink` | `#142b2b` | primary text, primary button fill |
| `--muted` | `#465f57` | labels, legends, secondary text |
| `--hair` | `#c3c9b9` | hairline rules and borders |
| `--map` / `--map-edge` | `#112f31` / `#0c302f` | the topo plate |
| `--mint` | `#bdeba7` | verified dry route, origin ring |
| `--flood` | `#ffb279` | flooded road dashes, school flag |
| `--amber` | `#efdfae` | shortest (naive) route dashes |
| `--water` | `#409eaa` | channel, focus rings, accents |
| `--alert` / `--bad` / `--ok` | `#a8563c` / `#9c3b2e` / `#2d6e51` | state colors |

State is always doubled in form: the dry route is mint *and* solid, the shortest route
amber *and* dashed, flooded roads orange *and* dashed with a dark halo.

## Type

- Georgia / Baskerville: the FloodLine wordmark and the print card title only.
- Gill Sans / Trebuchet MS: all UI copy, labels, and map lettering.
- Menlo: measured values only (readouts, metric rows, scale bar, card status line).

Labels and legends are small, bold, letterspaced uppercase - the field-sheet annotation
voice. The H1 stands alone: no kicker, no tagline.

## Layout

- Page column 1196px max (about 42px side margins at a 1280px viewport).
- Masthead: wordmark left, `Family go-card` button and `Download data` anchor right; one
  hairline rule under it.
- A single full-width inline safety notice sits above the workbench.
- Main grid: 250px control rail left, fluid stage right. The rail is one paper sheet with
  sections separated by hairlines - the Scenario fieldset, then a single
  `Storm Settings and Mitigation` `<details>` wrapper holding the overrides `<details>`,
  mitigation checkboxes, shortcuts, and downloads - not a stack of cards. The wrapper is
  open on desktop and closed under 720px so the map stays near the fold.
- Stage order: map plate, legend, timeline (Back 5 / slider / readout / Fwd 5 / Peak /
  Play), stage-now line, route verdict, hydrograph panel, run metrics panel. The first
  desktop viewport holds scenario controls, the notice, the map, the scrubber, and the
  verdict.
- The verdict is a state headline (ok / warn / bad color plus words) over an auto-fit
  grid of `data-row` term/measure pairs; the metrics panel uses the same pairing on a
  wider grid.

## The map plate (signature)

`viewBox 0 0 840 415` on `#112f31`: faint graticule, layered contour bands, hatched park
blocks, a sheared channel ribbon running roughly x=320 at the top to x=500 at the bottom,
pale road tracks, and the three route overlays. When stage exceeds bankfull a translucent
spread widens the channel; it is stylized and capped under 220 view units so the plate
stays readable under maximum synthetic stress. Homes, school, and shelters get drawn
icons and labels; junctions stay as dots. Two roads carry direct midpoint labels -
Canal Underpass in flood orange, High Bridge in mint, haloed with `paint-order: stroke`
so they read over road lines. Atlas ornaments: an in-plate legend, a north arrow, a 200 m
scale bar (4 m per view unit), a storm-minute stamp, and a SYNTHETIC TRAINING BASIN mark.
Decorative groups are `aria-hidden`; the svg carries a live `desc` reporting the wet-road
count and whether a dry route is available, never any safety approval.

## The go-card

A `<dialog>` with a top toolbar (dialog label, language select, Copy text, Print, Close) and a paper
sheet inside. The toolbar and language-option labels localize with the card. A collapsed plain-text
export mirrors the card for SMS or WhatsApp and is hidden from print. The card is set for print: serif title, a boxed `TRAINING EXERCISE ONLY` /
`SOLO PARA PRÁCTICA` stamp, From/To lines, a monospace status line that names the travel
mode on verified trips, the cutoff (floored to tenths and localized, never rounded up),
a semantically numbered route-step list, and a bold warning footer that always ends with
the fictional-simulation notice. `@media print` hides the whole GUI and prints only the
card on one Letter page, English or Spanish.

## Responsive

- Below 940px: single column, the rail moves above the map, numeric override fields go
  three-across.
- Under 720px: the settings wrapper starts closed (script sets `open` by matchMedia) and
  the Scenario fieldset lays out two-across with the basin select on its own row.
- At 390px: the masthead wraps, rail controls compact above the map, primary controls keep at least
  44px touch height, and nothing clips horizontally (verified at 390x844).

## Interaction and accessibility

- Native controls everywhere: selects, text inputs, checkboxes, a native range slider as
  the scrubber, `<details>` for secondary settings, `<dialog>` for the card.
- Focus is a 2px solid channel-blue outline on every interactive element.
- Validation is explicit: overrides apply through the Apply button with an inline
  `role="alert"` error and the last valid run preserved.
- Keyboard shortcuts are off by default behind the `#shortcuts` checkbox and ignore
  typing contexts, modifiers, repeats, and open dialogs. The cutoff chart itself is focusable:
  arrow keys move the starting zone and Enter jumps to its first cutoff minute. Dialog close returns
  focus to its opener.
- Reduced-motion media query kills transitions; playback never writes to live regions.
- No smooth scrolling, no external requests, no icon fonts or emoji - the one glyph on
  the page is a hand-drawn SVG warning triangle in the notice.
