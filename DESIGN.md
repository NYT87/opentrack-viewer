---
name: OpenTrack Viewer
description: A utilitarian, flat, one-accent instrument panel for reading activity files in the browser, in light and dark.
colors:
  canvas: "#f6f8fa"
  panel: "#ffffff"
  well: "#eef1f5"
  hairline: "#d3dae2"
  ink: "#16202b"
  ink-muted: "#5a6b7d"
  trail-blue: "#1668c4"
  on-trail-blue: "#ffffff"
  amber-warning: "#8a5300"
  signal-red: "#b3261e"
  scrim: "rgba(22, 32, 43, 0.45)"
  shadow-tint: "rgba(22, 32, 43, 0.18)"
  canvas-dark: "#0b0f14"
  panel-dark: "#131a22"
  well-dark: "#1d2733"
  hairline-dark: "#223040"
  ink-dark: "#e6edf3"
  ink-muted-dark: "#8b9bb0"
  trail-blue-dark: "#4aa3ff"
  on-trail-blue-dark: "#08111c"
  amber-warning-dark: "#ffb020"
  signal-red-dark: "#ff6b6b"
  scrim-dark: "rgba(5, 8, 12, 0.72)"
  shadow-tint-dark: "rgba(0, 0, 0, 0.5)"
  map-night: "#11161c"
  route-casing: "#0b0f14"
  lap-amber: "#ffd166"
  selection-violet: "#c77dff"
typography:
  display:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.5
  title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.5
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  reading:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.04em"
  figure:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
    fontVariation: "tabular-nums"
rounded:
  xs: "4px"
  sm: "6px"
  md: "10px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
components:
  button:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  button-primary:
    backgroundColor: "{colors.trail-blue}"
    textColor: "{colors.on-trail-blue}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.md}"
    size: "34px"
  tools-button:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
  select:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.reading}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
  box:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "16px"
  section-link:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    typography: "{typography.control}"
    padding: "6px 10px"
  dropzone:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "28px 16px"
  menu:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "4px"
  dialog:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "20px 24px 24px"
    width: "min(560px, 100%)"
---

# Design System: OpenTrack Viewer

## Overview

**Creative North Star: "The Instrument Panel"**

OpenTrack Viewer looks like the readout on a bike computer: a calm neutral chassis, numbers set first, and exactly one lit colour. The system is utilitarian, plain and honest. Every element is there because a task needs it, surfaces stay out of the way of the file's numbers and route, and nothing is decorated. The chrome is a fixed header band, one scrolling region, and a footer that only appears when the reader reaches the bottom.

Density is moderate and even. Body text runs at 14px, controls at 13px, supporting text at 12px, and every label is an 11px uppercase caption with slight tracking. Numbers are tabular so columns align in the stat grid and lap table. Structure comes from hairline borders and three background tones, never from shadow or colour fill. The one chromatic colour, Trail Blue, is reserved for action, selection and the route itself; amber and red appear only to warn and to report an error.

The system ships in light and dark from the same token names. Light is the base and the fallback; dark is resolved before first paint from a stored preference or the OS. The map is the exception to the theme: its frame is always night-dark and its route palette is fixed, so a route looks the same in both themes and the raster basemap is dimmed and desaturated to sit behind it. The confirmed anti-reference is marketing imagery: no hero photos, illustrations or device frames. Copy and one button carry the home page.

**Key Characteristics:**
- One accent, used for action, selection and the route line; everything else is neutral.
- Hairline borders and three background steps carry all structure; surfaces are flat.
- System font stack, no web fonts; hierarchy comes from size, weight and uppercase captions.
- Tabular numerals wherever a figure is shown.
- A single 10px radius on nearly every control and container; no pills.
- The map keeps its own fixed dark palette in both themes.
- Nothing renders before the data earns it: no placeholders, no empty boxes.

## Colors

A cool slate neutral scale in both themes, with Trail Blue as the single accent and two reserved status hues.

### Primary
- **Trail Blue** (`{colors.trail-blue}` light, `{colors.trail-blue-dark}` dark): the primary button fill, the hover and active border on every control, the focus ring on everything, links in running text, the tool-row arrow and hover rule, the focused-range bar, the chart line and its tinted area fill, and the section-nav rule on hover. The dark value is the exact colour of the route line on the map, so the accent and the route are one hue.
- **On Trail Blue** (`{colors.on-trail-blue}` / `{colors.on-trail-blue-dark}`): text on the primary button only.

### Secondary
- **Amber Warning** (`{colors.amber-warning}` / `{colors.amber-warning-dark}`): warning text, the notice border with a 12% amber tint, the map's basemap notice, and the chart hover cursor and its dot. It is a status colour, never a decorative one.
- **Signal Red** (`{colors.signal-red}` / `{colors.signal-red-dark}`): error panel border and title, rejected-file messages, export errors, and the footer heart.

### Tertiary (map only)
- **Map Night** (`{colors.map-night}`): the map background in route-only mode and behind tiles, in both themes.
- **Route Casing** (`{colors.route-casing}`): the 7px, 60% casing under the route line and the stroke around every map marker. It is the same value as the dark canvas.
- **Lap Amber** (`{colors.lap-amber}`): a selected lap's stretch of route.
- **Selection Violet** (`{colors.selection-violet}`): the chart-selected section of route and its endpoints.
- **Marker** (`{colors.ink-dark}`): the hover marker, a neutral bright dot with a Route Casing stroke. Neither amber nor violet, so it never vanishes on the lap or the section it points at.

### Neutral
- **Canvas** (`{colors.canvas}` / `{colors.canvas-dark}`): the page background and the active state of toggle-style buttons.
- **Panel** (`{colors.panel}` / `{colors.panel-dark}`): header, footer, every box, the dropzone, menus and the dialog.
- **Well** (`{colors.well}` / `{colors.well-dark}`): sunken surfaces: inline codes, the selection summary, a pressed lap toggle, the dragging dropzone, and the checkerboard behind transparent previews.
- **Hairline** (`{colors.hairline}` / `{colors.hairline-dark}`): every border, divider, chart gridline and tick.
- **Ink** (`{colors.ink}` / `{colors.ink-dark}`): primary text, headings and figures.
- **Ink Muted** (`{colors.ink-muted}` / `{colors.ink-muted-dark}`): captions, labels, help text, intros, inactive controls and axis labels.
- **Scrim** (`{colors.scrim}` / `{colors.scrim-dark}`): the modal backdrop.
- **Shadow Tint** (`{colors.shadow-tint}` / `{colors.shadow-tint-dark}`): the only shadow colour, used under floating layers.

### Named Rules
**The One Lit Colour Rule.** Trail Blue means act, selected or route. If an element is none of those three, it is neutral. Amber and red are status reports, not accents.

**The Fixed Map Rule.** The map's frame and route palette do not change with the theme. Night background, Trail Blue route, amber lap, violet selection, in light and dark alike.

**The Tint Rule.** Accent fills behind text are mixes, not solids: 10% Trail Blue for the focused-range bar, 12% amber for a notice, 16% to 18% Trail Blue for chart areas and selections. Solid accent fill is for the primary button alone.

## Typography

**Display Font:** none. There is no display face.
**Body Font:** system-ui (with -apple-system, Segoe UI, Roboto, sans-serif)
**Label/Mono Font:** none distinct; figures use the body face with tabular numerals.

**Character:** The platform's own UI face, so the app reads like a native tool on every OS. Hierarchy is built from a tight size ladder, weight, and uppercase captions, not from a second family.

### Hierarchy
- **Display** (700, 24px, 1.25, -0.01em, balanced wrap): the Home title only. It is the one step above Headline, because the front door is the one page whose title must read as "this is the product" rather than "this is a section". Followed by a 15px intro capped at 60ch.
- **Headline** (700, 18px, 1.5): the page title on Tools pages and Terms. The dialog title sits one step down at 17px, as does the footer wordmark, which is uppercase with 0.06em tracking.
- **Title** (700, 15px, 1.5): a box or section title (export, prose sections). Chart, lap and editor titles drop to 13px. The activity's name in the viewer's summary is the page's title and takes the Headline step (18px, line-height 1.3).
- **Body** (400, 14px, 1.5): the base size. Prose paragraphs run in Ink Muted at line-height 1.6 and are capped at 66ch; help text at 60ch.
- **Control** (400, 13px): buttons in the header and menus, section-nav links, choices and editor status.
- **Reading** (400, 12px): supporting copy, hints, lap tables, axis options and notices.
- **Label** (400, 11px, 0.04em, UPPERCASE): the caption above every figure (stat grid, device rows, the chart readout), table headers, device and sensor headings (those at 700), axis-switch labels and chart axis labels. Never a sentence: supporting copy is Reading or larger.
- **Figure** (400, 16px, tabular-nums): the number under a label in the stat grid. Lap and overlay values are also tabular at their own sizes.

The ladder is in the stylesheet as tokens, `--text-label` through `--text-display`, one per step above.

### Named Rules
**The Caption-Over-Figure Rule.** A statistic is an 11px uppercase muted label with a 16px tabular figure beneath it, 2px apart. Nothing else is added: no icon, no tint, no unit badge.

**The No Web Font Rule.** The type is the system stack. No font is fetched; a page cannot wait on, or leak a request for, a typeface.

## Layout

The app shell is a column the full height of the viewport: a fixed header band (12px 20px padding, Panel background, hairline bottom border), one internal scroll region, and a footer at the end of the content with a 24px top margin. The footer is not pinned; the scroll region grows so it lands on the bottom edge when content is short.

Content is centred and width-capped. Routed informational pages (Terms, Tools pages) use a 620px column with 24px vertical rhythm between sections and a hairline under the page header. Home is the exception: an 820px column with 28px rhythm and a 40px top gap (28px on a phone). Its header is a lead column beside a 280px proof strip, 40px apart; below the tools, the privacy explanation and the format list run two abreast at the tools' 32px gutter. Every paragraph keeps its own 60ch measure. At 860px and below, all of it stacks into one column, the strip directly under the primary button. The loaded viewer uses an 1180px grid: a 160px sticky section sidebar and a fluid main column, 24px gutter, 20px page padding, with 20px between boxes. The footer grid is 1120px wide with a 2fr brand column and two 1fr link columns.

Breakpoints are two. At 1100px and below the section sidebar is hidden and laps move from beside the map (a 220px to 300px column) to below it. At 860px and below the footer stacks into one column and the map takes 50vh. Grids inside boxes use `auto-fit` with 150px to 240px minimums so they reflow without further breakpoints. Pre-activity, the viewer shows only the intake column at 560px wide, 40px from the top.

Spacing steps observed: 4, 6, 8, 10, 12, 14, 16, 20, 24. Box padding is 16px; panels and empty states 14px; menus 4px; the dialog 20px 24px 24px. The map is a fixed share of the viewport, `clamp(280px, 46vh, 560px)`, so adding charts never squeezes it.

## Elevation & Depth

The system is flat. Depth is conveyed by the three background tones (Well below Canvas below Panel) and by hairline borders, not by shadow. A shadow appears only when a layer is temporarily above the page.

### Shadow Vocabulary
- **Menu float** (`box-shadow: 0 12px 30px var(--shadow)`): the Tools dropdown.
- **Dialog float** (`box-shadow: 0 24px 60px var(--shadow)`): the Settings dialog, over the scrim.

### Named Rules
**The Floating-Only Rule.** Boxes, cards and controls at rest cast no shadow. A shadow means "this is above the page and will go away".

**The Border-Not-Fill Rule.** State is shown on the border. Hover, open and active turn the border Trail Blue; the background changes only for toggles, which drop to Canvas or Well.

## Shapes

One radius does nearly all the work: 10px on buttons, inputs, selects, boxes, the dropzone, the menu, the dialog, notices, the map frame and preview canvases. Menu items and lap toggles use 6px; the brand focus ring and inline codes use 4px. There are no pills. Borders are 1px hairline, with the dropzone at 1.5px dashed. The chart's SVG plot is edge to edge within its box, and the map fills its box with the padding removed. Nothing is clipped into a non-rectangular shape.

## Components

Quiet and precise. Controls are bordered rectangles with exact alignment; state is shown by border colour and text colour, and nothing moves on hover.

### Buttons
- **Shape:** rounded rectangle (10px), 1px hairline border.
- **Default:** transparent background, Ink text, 6px 12px padding, inherits the body font.
- **Primary:** Trail Blue fill and border, On Trail Blue text at weight 600. Used once per page at most: "Open an activity" on Home. Hover is a brightness tick (`filter: brightness(1.08)`), the one filter in the system.
- **Hover / Focus:** hover turns the border Trail Blue. Focus-visible is a 2px Trail Blue outline with a 2px offset, on every interactive element in the app.
- **Icon button:** 34px square, same border and radius, Ink Muted glyph at 18px that turns Ink on hover. The Settings gear is the canonical instance.
- **Tools button:** the header dropdown trigger, 13px, 6px 10px padding, with a 10px caret. Open state matches hover.
- **Axis switch and segmented options:** 12px, 4px 10px padding; the active option drops to Canvas background with a Trail Blue border; disabled is 45% opacity.
- **Lap toggle:** one name ("Highlight lap 2") with its state in `aria-pressed`; a hairline border at rest, so the lap a reader can press looks pressable; hover turns it Trail Blue; pressed shows Trail Blue border, Well background and weight 600. A lap that cannot be highlighted shows its number plainly, with the reason in a Reading-size note under the table, never in a tooltip.
- **Disabled:** every button, the primary one included, fades to 45% with a not-allowed cursor and no hover change.

### Status Captions
- **Style:** a status is an 11px uppercase Ink Muted caption at 0.04em, set inline with no border or fill: "Read · Write", "Read only". A status that would read the same on every row is not shown.
- **Inline codes:** a 4px-radius Well tile at 11px.

### Cards / Containers
- **Corner Style:** 10px.
- **Background:** Panel. Empty states and error panels are the same box on Canvas with no fill.
- **Shadow Strategy:** none at rest; see Elevation.
- **Border:** 1px hairline; the error panel's border is Signal Red; a notice's border is Amber with a 12% amber tint behind it.
- **Internal Padding:** 16px for a viewer box, 14px for a panel, 0 for the map box.
- **Sunken variant:** the selection summary sits in Well with an 8px radius inside its box.

### Inputs / Fields
- **Style:** the select is a 10px-radius hairline field on Canvas at 12px. Number and text inputs in the editor are narrow (10ch) and stack on a phone. Radios and checkboxes are native, with a 6px gap to their label.
- **Focus:** 2px Trail Blue outline, 1px offset.
- **Error / Disabled:** errors are reported as text beneath in Signal Red; disabled options fade to 45%.
- **Dropzone:** a 1.5px dashed hairline box on Panel, 28px 16px padding, centred title at 600 with a 12px muted subtitle. Dragging turns the border Trail Blue and the fill Well.

### Navigation
- **Header:** the brand title at 16px with 0.01em tracking is the home link; it turns Trail Blue on hover. At 420px and below it shortens to "OpenTrack" so the header keeps one line; its accessible name stays "OpenTrack Viewer". The Tools dropdown opens a 180px Panel menu with a 4px inset, 6px-radius items at 13px, the current item in Ink at 600. Settings is the icon button on the right.
- **Section sidebar:** sticky, a column of 13px links with a 2px hairline left rule that turns Trail Blue on hover. A link scrolls to its section and moves focus into it; the scroll is instant under reduced motion. At 1100px and below the same links run as one row above the content, scrolling sideways, with the rule underneath instead.
- **Drop to replace:** a file dragged over an open activity dims the page under a 1.5px dashed Trail Blue frame with "Drop to open this file instead. This one stays open if it cannot be read." The new file is parsed first and replaces the open one only on success; a failure or a refused type is a dismissible notice above the activity it left alone.
- **Footer:** Panel with a hairline top, an uppercase 17px wordmark beside a 26px Trail Blue route glyph, 12px uppercase column headings at 0.09em, and muted links that turn Ink on hover.

### Links
A link in running text is Trail Blue with a 1px underline offset 0.15em, drawn in a 60% Trail Blue mix so it reads as a link without its colour; the underline turns full accent on hover. Focus is the 2px ring. Navigation links (section sidebar, footer, tool rows) are not underlined; they are identified by position and the row they sit in.

### Tool List (Home)
Four entries in a two-column grid (one column at 860px and below), each a hairline-topped row of a 14px bold name with a 14px Trail Blue arrow glyph (drawn, round-capped, like the footer mark) and a muted one-line description capped at 48ch. The name is the link and stretches over its whole row, so the description is part of the target without joining the accessible name. Hover or focus turns the row's top hairline Trail Blue and the name with it, per the Border-Not-Fill Rule. The same name-over-detail recipe as the format list, so the two read as one family. No boxes.

### Proof Strip (Home)
What the browser tests hold at zero, set in the stat idiom rather than as a sentence. An 11px uppercase 700 Ink Muted heading ("Held at zero by the browser tests"), then three hairline-topped rows, each an 11px uppercase Ink Muted caption over a 16px tabular Ink figure "0" with a 13px muted "allowed". One 13px text link closes it. No tint, no box, no accent except the link. The figures are what the suite enforces, not a live measurement, and each caption claims exactly what its test asserts: never "nothing leaves the page", since with the basemap on, tiles do once a file is open.

### Stat Grid (signature)
The overview leads with three primary fields, the bike computer's: distance, duration, and the sport's pace or speed (averaged over moving time and captioned so), as captions over 24px figures in their own row (18px, still one row, on a phone). A file without one of them leads with the next figure it has rather than a dash. The rest follow in a grid of `auto-fit, minmax(150px, 1fr)` cells, 12px 16px apart (two fixed columns at 480px and below), below a hairline. Both sit under a hairline-divided header carrying the activity title at 18px and its source at 12px; the source line also carries the point count, which describes the file rather than the effort. A title that is only a timestamp, as TCX writes it, reads as the sport and date it is ("Run on 1 May 2024, 08:00"). Each cell is a caption over a figure. The device card below repeats the pattern with a 700-weight uppercase heading, 20px below the grid.

### Chart (signature)
An SVG whose viewBox is 1:1 with pixels so text is never stretched. Hairline gridlines and ticks, 11px tabular axis labels in Ink Muted, a 2px Trail Blue line over a 16% Trail Blue area, an amber cursor with a canvas-stroked dot, and an 18% Trail Blue selection rectangle with a 1px accent stroke. A near-flat series is drawn flat with one label. The focused-range bar above is a 10% Trail Blue tint with a Trail Blue border.

Every chart in the panel shares one x extent and one left gutter (the widest any chart needs), so one vertical line reads all of them. Both ends of the x axis are written in the scale's unit. A flat series is a level line with no area beneath it. The shared x axis is labelled once, under the last chart; the others keep its tick marks. A greyed axis option says why beside it. Each plot is a keyboard slider with the 2px focus ring drawn inset: the arrows move the shared cursor, Shift extends a section, Enter keeps it, Escape lets go. Only charts the data supports are drawn; an unavailable one takes no title, message or space.

### Chart Readout (signature)
The instrument panel's readout, between the chart controls and the first chart, sticky at the top of the scroll region while the charts pass under it. Two rows:

- **Scope** (on Well): what the figures describe. At rest, "Whole activity · N points" and how to look at a section. With a section, the section itself: its title, "N of M points", "Your file is unchanged.", its figures inline (14px, captions over figures, scrolling sideways) and Reset View at the row's end. The row keeps its height either way, so selecting moves nothing below it, and Reset View never scrolls away.
- **Values** (on Panel): "At" over the cursor's position, then every drawn chart's value there, captions over 16px figures; a chart with no reading at that point shows the missing dash. With no cursor, one line says how to get one.

A row that scrolls sideways fades at its right edge, so hidden values are seen to be there.

### Overlay Workspace
With a video, the overlay page is a workspace: at 1100px and wider a 1180px grid of a sticky stage (the picture, its transport and a one-line sync summary, never scrolling inside itself) beside a scrolling column that opens with the sync panel (the full line, the "Video starts at" field and its four steps, the line-up form), then the files as a line each with their details folded, the overlay controls and the exports; narrower, the stage sticks to the top of a flex column. Under the transport sit a one-line 11px Ink Muted key hint (hidden on touch screens) and the sync bar. The bar is a 14px Well track with the activity's span in a 22% Trail Blue tint, the video's span as a solid Trail Blue block within it, and an Ink playhead. Above it, a 1.25px Ink Muted trace of the activity's speed or elevation, and beneath it a caption key that ends in how to use it. The bar is a slider, with a grab cursor and the 2px focus ring. A video that does not overlap the activity gets an amber line in the stage, under the bar, with its one-press fix, and the longer amber notice in the sync panel, in Ink at 60ch. The metric strip is one row of tiles a hair apart, with its type shrinking to no less than 60% before it wraps and says so, and its route a square as tall as the figures. Figures on a background under 30% carry a dark halo. The overlay's own palette (its accent, its route markers) is the reader's choice for their video and is not bound by the One Lit Colour Rule.

### Map (signature)
The map fills its box edge to edge at `clamp(280px, 46vh, 560px)`. Night background, dimmed raster tiles, a 3.5px Trail Blue route on a 7px 60% Route Casing, round caps and joins. Lap highlight in Lap Amber at 4.5px; chart selection in Selection Violet at 5px; the hover marker is a neutral bright circle and every marker has a Route Casing stroke. The route's start is a Trail Blue dot and its finish a night dot, both ringed in the marker's light (not in Route Builder, whose handles mark every point). A scale sits top left. MapLibre's controls take the night frame's colours in both themes, the canvas announces the route and how to move along it, and in the dark theme the map box gets a lighter edge so the night frame does not merge into the page. Raster tiles are dimmed hard (saturation −0.75, brightness capped at 0.6) so the route stays the brightest line on a light street map. MapLibre's own controls take the app's 2px focus ring. A file with no coordinates gets no map box: one sentence in the overview says why. The basemap notice is a 12px amber-bordered Panel chip at the bottom left.

## Do's and Don'ts

### Do:
- **Do** build every new control from the same recipe: 1px hairline border, 10px radius, transparent fill, border to Trail Blue on hover, 2px Trail Blue focus-visible outline.
- **Do** show every statistic as an 11px uppercase muted caption over a 16px tabular figure.
- **Do** use the three neutral tones for structure (Well, Canvas, Panel) and reserve shadow for the menu and the dialog.
- **Do** keep Trail Blue to action, selection and route, and tint it (10% to 18%) when it sits behind text or data.
- **Do** keep the map's night frame and route palette identical in both themes.
- **Do** omit a section, chart or card when the data cannot support it, rather than rendering a placeholder.
- **Do** cap prose at 66ch and help text at 60ch, in Ink Muted at line-height 1.6.
- **Do** keep desktop density, and give a coarse pointer 44px targets (buttons, fields, selects, tabs, switches, choice rows, the map's zoom, standalone links) and 16px text in fields, so iOS does not zoom the page on focus. At every size, a standalone target is at least 24px. On screens of 520px and narrower, the caption (`--text-label`) is 12px.

### Don't:
- **Don't** add hero photographs, illustrations or device mock-ups to the home page or any tool page. Copy and one primary button carry it.
- **Don't** fetch a web font; the type is the system stack.
- **Don't** introduce a second radius for a new control; 10px is the system, 6px for menu items.
- **Don't** put a shadow under a box or card at rest.
- **Don't** use Amber or Signal Red for anything but a warning or an error.
