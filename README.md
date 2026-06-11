# Slides Prompt Copier (v0.19)

A small Chrome (Manifest V3) extension for running prompt demos from Google Slides.
Put a labeled block on a slide (e.g. `PROMPT: <your prompt text>`) and a copy button
lets you grab that text with one click -- ready to paste into Claude (or anywhere).

Built for live workshops: the button works in full-screen **slideshow**, so you can
present on one screen and paste into your AI tool on the other.

---

## What it does

- Adds a copy button to your Google Slides:
  - **Slideshow / present** (`/present`): a round copy button floating over the
    slide (corner of your choice). It appears **only on slides that contain your
    configured label**, so non-prompt decks and non-prompt slides stay clean.
  - **Preview** (`/preview`): a copy icon in the footer bar.
  - **Edit**: an always-visible blue **gear** button (corner of your choice).
    It opens settings -- use it to set the label/corner so the slideshow button
    will show. It does not copy.
- The floating button is pinned to the **slide rectangle**, not the screen, so it
  sits in the same spot on every slide regardless of how the slide is letterboxed
  (black margins on a laptop, full-bleed on an external monitor). The gear in edit
  view sits in that same spot, so it shows the **"keep clear" zone** -- put slide
  content elsewhere to avoid having the button cover it.
- Click the button (or press **Alt+C**) to copy the text after your label on the
  **current** slide. A brief bottom-center banner confirms: green **"Copied PROMPT"**
  on success, red **"Failed to copy PROMPT"** / **"No 'PROMPT:' on this slide"**
  otherwise.
- **Long-press** the button to open settings (label + corner).

---

## Install

1. Keep `manifest.json` and `content.js` together in this folder, saved somewhere
   permanent.
2. Go to `chrome://extensions`, turn on **Developer mode**, **Load unpacked**, and
   select this folder.
3. To update: overwrite the two files **in the exact folder Chrome loaded from**,
   click the **reload** icon on the card, then refresh the Slides tab. The card and
   the button tooltip show the version (e.g. **0.19**).

The extension requests `storage` (to remember settings) and `clipboardWrite`.

---

## Marking prompts on a slide

Put a text box on the slide that starts with your label and a colon:

```
PROMPT: Extract every named person from the letter below. Return a JSON array
with fields: name, role, date_mentioned.
```

Clicking copies everything after `PROMPT:`. Prompts may contain colons (`fields:`),
numbers, and prose -- those are kept. To cut a prompt short, add `[END]`; everything
after it is dropped. You can put several labeled boxes on one slide
(`PROMPT:`, `PROMPT1:`, ...) and choose which to copy in settings. The same label can
repeat across many slides; the button always copies the current slide's.

---

## Settings (gear button in editor, or long-press in slideshow/preview)

In the **editor**, click the blue gear to open settings. In **slideshow/preview**,
**long-press** the copy button (so a normal click still copies).

- **Select Label to Copy** -- a dropdown of the `LABEL:` tags found on the current
  slide (alphabetical). Choosing from the dropdown works in slideshow, where Slides
  blocks typing.
- **Select button corner** -- diagonal-arrow buttons (TL / TR / BL / BR) to move the
  floating button to a corner **of the slide** (not the screen).

Settings save **per deck**; a new deck inherits your last-used label and corner, and
changes sync live to any open tabs.

---

## Future improvements

- **Free-text label entry in the editor.** The settings dropdown only lists labels
  it can already detect on the current slide, so you can't pre-set a brand-new label
  on a blank slide from the dropdown alone. Consider an "add custom label" affordance
  (slideshow blocks typing, but the editor does not -- a text field there is viable).
- Internationalize the trailing-UI cutoff (currently English-only -- see Gotchas).
- Consider scoping reads to the slide container directly rather than via the
  visible-SVG heuristic, if Slides' DOM ever changes.

---

## Gotchas (read before editing -- these cost real time to discover)

These are hard-won lessons specific to instrumenting Google Slides. Ignoring them
re-introduces bugs that are slow and confusing to diagnose.

1. **Keep `content.js` pure ASCII; build every regex from escape sequences.** An
   invisible line/paragraph separator (U+2028/U+2029) pasted into a regex *literal*
   silently breaks the whole script (it terminates the literal), with no obvious
   error -- the extension just stops running everywhere. Use `new RegExp("...\\u2028...")`
   string form, never `/.../` literals containing exotic whitespace. There is a byte
   check you can run: the file must be 100% ASCII.

2. **Slides blocks keyboard input in slideshow.** In `/present`, Slides intercepts
   key events for navigation, so a text `<input>` cannot be typed into (even inside an
   iframe). UI that needs user choice in slideshow must be **click-based** (that's why
   the label picker is a `<select>` dropdown, not a text field).

3. **Trusted Types: no `innerHTML`.** Slides enforces Trusted Types, so assigning
   `innerHTML` throws. Build all DOM/SVG via `createElement` / `createElementNS`.

4. **Full-screen renders only the fullscreen element's subtree.** A floating overlay
   must be attached to `document.fullscreenElement` (when set) or it won't paint in
   full-screen slideshow. Re-place it on `fullscreenchange`.

5. **Read only VISIBLE, in-viewport elements.** Slideshow keeps previous/next slides
   in the DOM (off-screen) for transitions. Reading the whole document copies a
   neighbouring slide's prompt. Filter by viewport rect + `checkVisibility`.

6. **Read inside the slide `<svg>` only.** Slide text lives in SVG `<text>/<tspan>`
   and SVG `aria-label`s. Reading arbitrary HTML `[aria-label]`s pulls in Google's UI
   chrome (account chip, "Status", filmstrip, speaker-notes placeholder) and pollutes
   the labels. Scope the query to `svg text, svg tspan, svg [aria-label]`.

7. **Label and content can be on SEPARATE lines.** In full-screen, `PROMPT:` and its
   text often land on different lines of accessible text. Do NOT stop extraction at
   the first line break. Stop at: the next *other* label that begins a line, `[END]`,
   a keyboard-shortcut hint, or Slides' trailing UI (filmstrip number line / fixed UI
   phrases). Do NOT stop at a mid-line `word:` (prompts legitimately contain colons).

8. **Trailing-UI phrase matching is English-only.** The cutoff for Slides' own UI text
   keys off English phrases ("screen reader", "speaker notes", ...). Another UI
   language would need new phrases; the number-filmstrip cut and `[END]` still work.

9. **Rebuild the matcher from the current label at copy time, and trim the label.** A
   cached/stale regex (or a label with a stray trailing space, e.g. from old typing)
   produces the maddening "scanner finds it but copy says it's missing" symptom.

10. **`preventDefault` on the button's `mousedown`** so it doesn't steal focus from
    the slideshow (focus target is the page `<body>`, tabindex 0); also refocus the
    body after a copy so nav controls keep responding.

11. **Environment traps when debugging:** (a) the extension lives per Chrome *profile*
    -- it must be installed in the profile you present from; (b) after editing files,
    overwrite the *exact* folder Chrome loaded from and reload the card AND refresh the
    tab; (c) `WebFetch`-style raw reads of present mode see a near-empty shell --
    inspect the live DOM instead.

12. **Anchor the floating button to the slide page, and mind the present iframe.**
    Slides letterboxes the slide differently per display and mode, so a viewport
    corner lands in the margin in one place and on the slide in another. Do NOT guess
    the slide as "the largest `<svg>`" -- in the editor the largest SVG is the gray
    `.workspace` (taller than the page), so the button floats above the slide. Use the
    real page element (all verified live against Slides' DOM):
    - **Editor** -> `.canvas` (the white page, in the top document).
    - **Windowed preview** (`/present` in a tab) -> `.punch-viewer-svgpage-svgcontainer`
      in the top document.
    - **True full-screen slideshow** (the "Slideshow" button) -> the viewer runs in
      an `<iframe class="punch-present-iframe">` that fills the window, and the slide
      (`.punch-viewer-svgpage-svgcontainer`) lives INSIDE that iframe. You must search
      same-origin iframes too and ADD the iframe's offset to convert to top-window
      coordinates. This is the case earlier versions missed: they searched only the
      top document, found nothing, and fell back to the full-window overlay -- putting
      the button in the black letterbox margin.

    Off-screen siblings (adjacent slides, thumbnails) are filtered per-window; keep
    the largest visible match. Fallback: the largest visible `<svg>` across frames
    that does NOT fill its own window (the letterboxed slide, never a wrapper/overlay),
    then the viewport. When re-placing each tick, set only `top`/`left` -- an
    *attribute* change, which the childList MutationObserver ignores, so it won't
    re-enter; changing children would loop.

---

## Troubleshooting

- **"No 'LABEL:' on this slide":** the slide has no box starting with that label +
  colon; long-press to pick a detected label.
- **Button missing:** confirm the tab is `docs.google.com/presentation` and the
  extension is enabled **in this Chrome profile**; refresh the tab.
- **Edited code, no change:** reload the card, then refresh; confirm the version on
  the card/tooltip updated.
