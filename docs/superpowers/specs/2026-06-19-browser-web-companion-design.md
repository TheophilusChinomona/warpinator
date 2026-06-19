# Warpinator Web Companion — Design Spec

**Date:** 2026-06-19
**Status:** Approved for implementation

---

## Problem

When working on frontend code with AI assistance in Warpinator, there is no way to send a live DOM element — its markup, visual appearance, and location — directly into the AI context. The user must manually copy-paste HTML from DevTools, describe the element in words, or share a full-page screenshot. This friction breaks the flow of frontend development.

## Goal

A Chrome extension ("Warpinator Web Companion") that lets the user click any element on any page (localhost or external) and immediately inject it as rich context into the active Warpinator AI conversation (Pi, Claude, Codex, or any other backend routed through the bridge).

---

## Architecture

Three components, no changes to the Rust application:

```
projects/warpinator/
  browser-extension/       ← new Chrome extension (Manifest V3)
    manifest.json
    background.js          ← service worker; owns WebSocket connection to bridge
    content.js             ← picker overlay injected into pages
    popup.html             ← toolbar popup UI
    popup.js
    styles/
      picker.css           ← highlight ring, banner, tooltip styles
      popup.css
    icons/
      icon16.png
      icon48.png
      icon128.png

  bridge/
    server.js              ← add WebSocket /browser-context endpoint + element buffer
    inference.js           ← prepend buffered browser elements into buildContext()
```

---

## Component Design

### Chrome Extension

**manifest.json** — Manifest V3
- Permissions: `activeTab`, `scripting`, `storage`, `tabs`
- Host permissions: `<all_urls>` (needed to inject content script on any page)
- Background: service worker (`background.js`)
- Action: toolbar button with popup (`popup.html`)
- Content scripts: none declared (injected programmatically on demand)

**background.js** (service worker)
- On startup: open WebSocket to `ws://localhost:8787/browser-context`
- Retry with exponential backoff (1s, 2s, 4s, max 30s) if bridge is not running
- Track connection state; broadcast to popup via `chrome.runtime.sendMessage`
- On `browser_element` message from content script: forward to bridge via WebSocket
- Buffer last 5 received acknowledgements from bridge (for popup "recent picks" display)

**content.js** (injected on demand when picker activates)
- Inject picker overlay: crosshair cursor on `<body>`, blue highlight ring following mouse, banner at page top ("Warpinator picker active — click an element  ✕")
- On `mouseover`: compute full CSS selector path, show tooltip (selector + `W × H`)
- On `click` (picker active):
  1. Prevent default event propagation
  2. Record `element.outerHTML` and `element.innerText`
  3. Compute full unique CSS selector path (walk DOM to root, include nth-child for disambiguation)
  4. Resolve any `<img src>` inside element to absolute URLs; fetch as base64 if same-origin
  5. Call `chrome.tabs.captureVisibleTab()` → crop to element's `getBoundingClientRect()` using an offscreen Canvas → base64 PNG
  6. If user clicked "+" computed styles button in tooltip: call `window.getComputedStyle(element)`, extract layout-relevant properties (display, position, width, height, flex, grid, margin, padding, color, background, font)
  7. Send complete payload to `background.js` via `chrome.runtime.sendMessage`
  8. Show toast bottom-right: "Added to [AI name] context"
- `Escape` or toolbar button click again: deactivate picker, remove overlay

**popup.html/js**
- Shows: connection status dot (green = connected, grey = disconnected), active AI name (received from bridge on connect), last 3 picked elements (selector + page title), "Pick element" button (activates picker on current tab), "Clear context" button (sends clear signal to bridge)

---

### Bridge — WebSocket Endpoint

**server.js** additions:
- On HTTP Upgrade to `/browser-context`: accept WebSocket connection from extension
- Maintain `browserContextBuffer: []` (max 5 elements, FIFO eviction)
- On incoming JSON message: validate `type === "browser_element"`, push to buffer, send ACK `{ "type": "ack", "ai": currentAiName, "count": buffer.length }`
- On `{ "type": "clear" }` from extension: empty buffer
- On HTTP POST to `/browser-context/clear`: empty buffer (for Warpinator terminal command integration later)
- Only one extension connection at a time; close previous if new one connects

**Wire format (extension → bridge):**
```json
{
  "type": "browser_element",
  "url": "http://localhost:3000/shop",
  "page_title": "Shop — Anchored Uniforms",
  "selector": "div.product-grid > .card:nth-child(1) > button.cta",
  "html": "<button class=\"cta w-10 h-10 rounded-lg border-none\">Shop Now</button>",
  "text": "Shop Now",
  "screenshot": "data:image/png;base64,iVBORw0...",
  "images": ["data:image/png;base64,..."],
  "computed_styles": null
}
```

`computed_styles` is `null` by default; populated only when the user clicks "+" in the picker tooltip.

---

### Bridge — Context Injection

**inference.js — `buildContext()` additions:**
- Before assembling the messages array, check `browserContextBuffer`
- If non-empty, prepend a system message block for each buffered element:

```
[Web context — http://localhost:3000/shop]
Page: Shop — Anchored Uniforms
Element: div.product-grid > .card:nth-child(1) > button.cta

HTML:
<button class="cta w-10 h-10 rounded-lg border-none">Shop Now</button>

Text content: Shop Now
```

- If `screenshot` is present, append as an image content block (base64 PNG, `image/png` media type) — same format used by Claude vision API and OpenRouter vision models
- If `images` array is non-empty, append each as an image content block
- If `computed_styles` is present, append as a fenced JSON block
- After consuming the buffer in a request, clear it (prevents stale context in subsequent requests)

---

## UX Flow

```
1. Warpinator starts → bridge on :8787
2. Extension background.js connects → ws://localhost:8787/browser-context
3. Toolbar icon: green dot (connected) or grey (disconnected / Warpinator not running)

[Picking an element]
4. User navigates to any page (localhost:3000, docs site, production URL)
5. Click toolbar button (or keyboard shortcut TBD) → content.js injected
6. Banner appears: "Warpinator picker active — click an element  ✕"
7. Hover elements → blue highlight ring + tooltip showing selector and dimensions
8. Optional: click "+" in tooltip → computed styles will be included
9. Click element:
   a. Screenshot captured and cropped to element bounds
   b. HTML and selector extracted
   c. Payload sent to background.js → WebSocket → bridge buffer
   d. Toast: "Added to Pi context" (or Claude / Codex)
10. User can pick additional elements (they accumulate in the buffer)
11. Escape or click toolbar button → picker exits
12. Switch to Warpinator, type prompt → AI receives all picked elements as context
13. Buffer auto-clears after the request
```

---

## Installation

No Web Store required. Load as unpacked extension:

```
1. Open chrome://extensions
2. Enable "Developer mode" (top right toggle)
3. Click "Load unpacked"
4. Select: projects/warpinator/browser-extension/
```

The extension persists across Chrome restarts. It auto-reconnects to the bridge whenever Warpinator is running.

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Bridge not running | Extension shows grey dot; retries silently in background; picker is disabled |
| Screenshot capture fails | Send HTML-only payload; log warning in background.js console |
| Same-origin image fetch fails | Skip that image; include `<img>` tag in HTML so AI sees the src URL |
| Element has no meaningful HTML | Send text content only with a note |
| Buffer full (>5 elements) | Evict oldest; toast warns "Context updated (5 max)" |
| Extension disconnects mid-session | Bridge drops stale buffer; logs disconnect |

---

## Out of Scope (this iteration)

- Firefox / Safari support (MV3 WebExtensions compatible but not tested)
- Full-page screenshot mode
- Network request capture
- Console error forwarding
- Web Store publishing
- Keyboard shortcut to activate picker (can add as follow-up)
- Warpinator terminal command to trigger picker (e.g. `browse pick`)
