/**
 * Double frame SDK. The server injects this classic script into each accepted
 * static review copy as a classic script element with an end tag:
 *
 *   <script src="/double-sdk.js" data-comparison-id="trial-1" data-pane="left">
 *
 * The source contains no script end tag, so it can also be inlined.
 * The frame is an opaque-origin sandbox. This script never calls an API and
 * never receives a token. It shows keeper and delete controls for the known
 * components that the trusted parent names, sends intentions to the parent,
 * and applies only saved state that the parent sends back.
 *
 * The controls live in a separate host element under <html>, in a closed
 * shadow root, so a component marker on html, head, or body cannot hide or
 * remove the control and state channel.
 *
 * The SDK never changes the reviewed root at boot. A root that is hidden,
 * not displayed, or inert also hides or disables these controls; the trusted
 * parent shell has its own component controls for that case. The only
 * reviewed-DOM change is the inline display of saved deletions, which Undo
 * restores exactly. Session review keeps discards visible until the final
 * page. Reticles follow the actual component under the pointer or keyboard
 * focus, rather than covering every component at rest.
 */
(function () {
  "use strict";

  var CHANNEL = "human-review-double";
  var HOST_TAG = "human-review-double";
  // The input validator's identity contract: nonempty, no whitespace, no Unicode category C.
  var ID_FORBIDDEN = /[\s\p{C}]/u;
  var PANES = { left: "Left", right: "Right" };

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function hasExactKeys(value, keys) {
    var own = Object.keys(value);
    if (own.length !== keys.length) return false;
    for (var i = 0; i < keys.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, keys[i])) return false;
    }
    return true;
  }

  function validId(value) {
    return typeof value === "string" && value.length > 0 && !ID_FORBIDDEN.test(value);
  }

  /** Validate a parent state message. Returns the component list or null. */
  function parseState(data, comparisonId, pane) {
    if (!isRecord(data) || !hasExactKeys(data, ["channel", "type", "comparisonId", "pane", "components", "busy", "readOnly", ...(data.controls === "shell" ? ["controls", "showDiscards"] : [])])) return null;
    if (data.channel !== CHANNEL || data.type !== "state") return null;
    if (data.comparisonId !== comparisonId || data.pane !== pane) return null;
    if (typeof data.busy !== "boolean" || typeof data.readOnly !== "boolean") return null;
    if (data.controls === "shell" && typeof data.showDiscards !== "boolean") return null;
    if (!Array.isArray(data.components)) return null;
    var seen = Object.create(null);
    var components = [];
    for (var i = 0; i < data.components.length; i++) {
      var c = data.components[i];
      if (!isRecord(c) || !hasExactKeys(c, ["id", "label", "keeper", "deleted", ...(c.scope ? ["scope"] : []), ...(c.parentId ? ["parentId"] : [])])) return null;
      if (c.scope && !["group", "frame"].includes(c.scope) || c.parentId && !validId(c.parentId)) return null;
      if (!validId(c.id) || seen[c.id]) return null;
      if (typeof c.label !== "string" || typeof c.keeper !== "boolean" || typeof c.deleted !== "boolean") return null;
      if (c.parentId && !components.some(function (parent) { return parent.id === c.parentId && ["group", "frame"].includes(parent.scope); })) return null;
      seen[c.id] = true;
      components.push({ id: c.id, label: c.label, keeper: c.keeper, deleted: c.deleted, ...(c.scope ? { scope: c.scope } : {}), ...(c.parentId ? { parentId: c.parentId } : {}) });
    }
    return { components: components, busy: data.busy, readOnly: data.readOnly, shellControls: data.controls === "shell", showDiscards: data.controls === "shell" && data.showDiscards };
  }

  function randomInstance(win) {
    var bytes = new Uint8Array(12);
    if (win.crypto && win.crypto.getRandomValues) {
      win.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    var out = "";
    for (var j = 0; j < bytes.length; j++) out += (bytes[j] + 256).toString(16).slice(1);
    return out;
  }

  var STYLE = [
    ":host { all: initial; }",
    ".layer { position: fixed; inset: 0; pointer-events: none; font: 12px/1.3 \"Avenir Next\", \"Nunito Sans\", \"Lato\", \"Trebuchet MS\", sans-serif; color: #1b1a16; }",
    ".outline { position: absolute; box-sizing: border-box; border: 1px dashed rgba(27, 26, 22, 0.35); border-radius: 4px; pointer-events: none; }",
    ".outline.keeper { border: 2px solid #3f7a52; }",
    ".outline.reticle { border: 0; border-radius: 0; color: #15803d; filter: drop-shadow(0 0 1px white); }",
    ".outline.reticle.discard { color: #dc2626; }",
    ".outline.reticle.neutral { color: #64748b; }",
    ".reticle.interactive .corner { pointer-events: auto; cursor: pointer; }",
    ".reticle.frame { border: 1px dashed currentColor; }",
    ".reticle.group .corner { border-width: 0; }",
    ".reticle.group .corner.tl { border-top-width: 4px; border-left-width: 4px; }",
    ".reticle.group .corner.tr { border-top-width: 4px; border-right-width: 4px; }",
    ".reticle.group .corner.bl { border-bottom-width: 4px; border-left-width: 4px; }",
    ".reticle.group .corner.br { border-bottom-width: 4px; border-right-width: 4px; }",
    ".reticle .corner { position: absolute; width: min(18px, 40%); height: min(18px, 40%); border: 0 solid currentColor; box-sizing: border-box; }",
    ".corner.tl { top: 0; left: 0; border-top-width: 3px; border-left-width: 3px; }",
    ".corner.tr { top: 0; right: 0; border-top-width: 3px; border-right-width: 3px; }",
    ".corner.bl { bottom: 0; left: 0; border-bottom-width: 3px; border-left-width: 3px; }",
    ".corner.br { bottom: 0; right: 0; border-bottom-width: 3px; border-right-width: 3px; }",
    ".cluster { position: absolute; display: flex; align-items: center; gap: 4px; padding: 3px; border: 1px solid #d9d5c9; border-radius: 999px; background: #fbfaf7; box-shadow: 0 4px 14px -6px rgba(0, 0, 0, 0.35); pointer-events: auto; }",
    ".cluster .name { max-width: 14em; padding: 0 6px 0 8px; overflow: hidden; color: #6b6862; white-space: nowrap; text-overflow: ellipsis; }",
    "button { box-sizing: border-box; width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; margin: 0; padding: 0; border: 1px solid #d9d5c9; border-radius: 50%; background: #ffffff; color: #6b6862; font-family: inherit; font-size: 15px; font-weight: 600; line-height: 1; cursor: pointer; }",
    "button:hover:not(:disabled) { border-color: #1b1a16; color: #1b1a16; }",
    "button:focus-visible { outline: 2px solid #255441; outline-offset: 2px; }",
    "button:disabled { cursor: default; opacity: 0.5; }",
    "button.keep[aria-pressed=\"true\"] { border-color: #3f7a52; background: #3f7a52; color: #ffffff; }",
    "button.delete:hover:not(:disabled) { border-color: #b23b2e; color: #b23b2e; }",
    ".dock { position: absolute; top: 8px; left: 8px; display: flex; flex-direction: column; gap: 6px; pointer-events: none; }",
    ".dock .cluster { position: static; }",
    ".mask { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: #eceae4; color: #6b6862; font-size: 14px; pointer-events: none; }",
  ].join("\n");

  function boot(win, config) {
    var doc = win.document;
    var comparisonId = config.comparisonId;
    var pane = config.pane;
    var parentWindow = win.parent;
    if (!validId(comparisonId) || !Object.prototype.hasOwnProperty.call(PANES, pane)) return null;
    if (!parentWindow || parentWindow === win) return null;

    var instance = randomInstance(win);
    var host = doc.createElement(HOST_TAG);
    var root = host.attachShadow({ mode: "closed" });
    var style = doc.createElement("style");
    style.textContent = STYLE;
    var layer = doc.createElement("div");
    layer.className = "layer";
    var dock = doc.createElement("div");
    dock.className = "dock";
    root.append(style, layer);

    var HOST_STYLE = {
      display: "block", position: "fixed", inset: "0", width: "auto", height: "auto",
      margin: "0", padding: "0", border: "0", "pointer-events": "none", "z-index": "2147483647",
      visibility: "visible", opacity: "1", transform: "none", filter: "none", contain: "strict",
    };
    for (var key in HOST_STYLE) host.style.setProperty(key, HOST_STYLE[key], "important");

    var state = { components: [], busy: false, readOnly: false };
    // Original inline display values of elements this SDK hid, for exact restore.
    var hidden = new Map();
    var strippedFrames = new Map();
    var FRAME_RESET = { background: "transparent", border: "0", "border-radius": "0", "box-shadow": "none", outline: "none", padding: "0" };
    var layoutQueued = false;
    // The control that had keyboard focus before a re-render: { id, cls }.
    var wantFocus = null;
    var pointer = null;
    // True after this frame told the parent it holds the hover, until the parent ends it.
    var hoverAnnounced = false;
    var focusTarget = null;

    function post(message) {
      message.channel = CHANNEL;
      message.comparisonId = comparisonId;
      message.pane = pane;
      message.instance = instance;
      // Opaque frames cannot name the parent origin; the parent checks the source window.
      parentWindow.postMessage(message, "*");
    }

    function attachHost() {
      var rootElement = doc.documentElement;
      if (host.parentNode !== rootElement) rootElement.appendChild(host);
    }

    function findElement(id) {
      var marked = doc.querySelectorAll("[data-double-id]");
      for (var i = 0; i < marked.length; i++) {
        if (marked[i].getAttribute("data-double-id") === id && marked[i].hasAttribute("data-container")) return marked[i];
      }
      return null;
    }

    function componentAt(target) {
      for (var node = target; node && node !== doc; node = node.parentElement) {
        if (node === host) return null;
        if (!node.getAttribute || !node.hasAttribute("data-container")) continue;
        var id = node.getAttribute("data-double-id");
        if (state.components.some(function (c) { return c.id === id && (!c.deleted || state.showDiscards); }) && findElement(id) === node) return id;
      }
      return null;
    }

    function activeComponent() {
      // Re-hit-test after scrolling or resizing: the pointer may now cover
      // another component even though the mouse itself has not moved.
      var target = pointer && (typeof doc.elementFromPoint === "function"
        ? doc.elementFromPoint(pointer.x, pointer.y) : pointer.target);
      if (target === host) target = pointer.target;
      return componentAt(target) || componentAt(focusTarget);
    }

    /**
     * Safety rule for awkward markers: never hide <html>, because the host
     * lives under it. A deleted html component hides <body> and shows a mask
     * in the host instead. A deleted <head> is hidden like any other element:
     * a copy can display head with CSS. Its metadata, styles, and scripts stay
     * connected, and the host and state channel are not inside it.
     */
    function hideTarget(element) {
      if (element.localName === "html") return doc.body;
      return element;
    }

    function setHidden(element, hide) {
      if (!element || element === host) return;
      if (hide) {
        if (hidden.has(element)) return;
        hidden.set(element, {
          value: element.style.getPropertyValue("display"),
          priority: element.style.getPropertyPriority("display"),
        });
        element.style.setProperty("display", "none", "important");
      } else if (hidden.has(element)) {
        var prior = hidden.get(element);
        hidden.delete(element);
        if (prior.value) element.style.setProperty("display", prior.value, prior.priority);
        else element.style.removeProperty("display");
        if (element.getAttribute("style") === "") element.removeAttribute("style");
      }
    }

    function controllingGroup(c) {
      var parentId = c.parentId;
      var winner = null;
      var seen = new Set();
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        var parent = state.components.find(function (item) { return item.id === parentId; });
        if (!parent) break;
        if (parent.scope === "group" && (parent.keeper || parent.deleted)) winner = parent;
        parentId = parent.parentId;
      }
      return winner;
    }

    function applyVisibility() {
      var wanted = new Set();
      var frameTargets = new Set();
      var masked = false;
      for (var i = 0; i < state.components.length; i++) {
        var c = state.components[i];
        if (!c.deleted || state.showDiscards || controllingGroup(c)) continue;
        var element = findElement(c.id);
        if (!element) continue;
        if (c.scope === "frame") { frameTargets.add(element); continue; }
        var target = hideTarget(element);
        if (target) wanted.add(target);
        if (element.localName === "html") masked = true;
      }
      hidden.forEach(function (_prior, element) {
        if (!wanted.has(element)) setHidden(element, false);
      });
      wanted.forEach(function (element) { setHidden(element, true); });
      strippedFrames.forEach(function (prior, element) {
        if (frameTargets.has(element)) return;
        if (prior === null) element.removeAttribute("style");
        else element.setAttribute("style", prior);
        strippedFrames.delete(element);
      });
      frameTargets.forEach(function (element) {
        if (!strippedFrames.has(element)) strippedFrames.set(element, element.getAttribute("style"));
        Object.keys(FRAME_RESET).forEach(function (property) { element.style.setProperty(property, FRAME_RESET[property], "important"); });
      });
      return masked;
    }

    function makeButton(className, text, label, pressed) {
      var button = doc.createElement("button");
      button.type = "button";
      button.className = className;
      button.textContent = text;
      button.setAttribute("aria-label", label);
      button.title = label;
      if (pressed !== undefined) button.setAttribute("aria-pressed", pressed ? "true" : "false");
      button.disabled = state.busy || state.readOnly;
      return button;
    }

    function cluster(c) {
      var group = doc.createElement("div");
      group.className = "cluster";
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", PANES[pane] + " component: " + c.label);
      group.dataset.componentId = c.id;
      var name = doc.createElement("span");
      name.className = "name";
      name.textContent = c.label;
      var keep = makeButton("keep", "\u2713", (c.keeper ? "Keeper: " : "Keep: ") + c.label, c.keeper);
      keep.addEventListener("click", function () { post({ type: "intent", intent: "keeper", componentId: c.id }); });
      group.append(name, keep);
      if (!state.readOnly) {
        var del = makeButton("delete", "\u2715", "Delete: " + c.label);
        del.setAttribute("aria-haspopup", "dialog");
        del.addEventListener("click", function () { post({ type: "intent", intent: "delete", componentId: c.id }); });
        group.append(del);
      }
      return group;
    }

    function render() {
      var active = root.activeElement;
      if (active && active.parentNode && active.parentNode.dataset) {
        wantFocus = { id: active.parentNode.dataset.componentId, cls: active.className };
      }
      attachHost();
      var masked = applyVisibility();
      layer.textContent = "";
      dock.textContent = "";
      if (masked) {
        var mask = doc.createElement("div");
        mask.className = "mask";
        mask.textContent = "This page component is deleted in the review.";
        layer.append(mask);
      }
      for (var i = 0; i < state.components.length; i++) {
        var c = state.components[i];
        // One-shot review keeps its old rule: a deleted component has no
        // cluster, because the parent refuses keeper and delete intents for it.
        if (c.deleted && (!state.shellControls || !state.showDiscards && c.scope !== "frame" && !controllingGroup(c))) continue;
        var element = findElement(c.id);
        if (!element) continue;
        var group = state.shellControls ? null : cluster(c);
        if (group) group.dataset.tag = element.localName;
        var outline = doc.createElement("div");
        var override = controllingGroup(c);
        var displayed = override || c;
        outline.className = state.shellControls
          ? "outline reticle " + (displayed.deleted ? "discard" : displayed.keeper ? "keeper" : "neutral") + (c.scope ? " " + c.scope : "")
          : c.keeper ? "outline keeper" : "outline";
        outline.dataset.componentId = c.id;
        if (state.shellControls && !state.busy && !state.readOnly && !override) outline.classList.add("interactive");
        outline.setAttribute("aria-hidden", "true");
        if (state.shellControls) {
          ["tl", "tr", "bl", "br"].forEach(function (position) {
            var corner = doc.createElement("span");
            corner.className = "corner " + position;
            outline.append(corner);
          });
        }
        layer.append(outline);
        if (group) layer.append(group);
      }
      layer.append(dock);
      layout();
      // Keep keyboard focus on the same control across re-renders, but never
      // pull focus back from the parent (for example, its delete popup).
      if (wantFocus && doc.hasFocus()) {
        var groups = layer.querySelectorAll(".cluster");
        for (var j = 0; j < groups.length; j++) {
          if (groups[j].dataset.componentId !== wantFocus.id) continue;
          var again = groups[j].querySelector("button." + wantFocus.cls);
          if (again && !again.disabled) again.focus();
        }
      }
    }

    /** Place each control cluster at its component's top-right corner, clamped to the viewport. */
    function layout() {
      layoutQueued = false;
      var width = win.innerWidth || doc.documentElement.clientWidth || 0;
      var height = win.innerHeight || doc.documentElement.clientHeight || 0;
      var outlines = layer.querySelectorAll(".outline");
      var activeId = state.shellControls ? activeComponent() : null;
      var activeElement = activeId && findElement(activeId);
      for (var n = 0; n < outlines.length; n++) {
        var marked = findElement(outlines[n].dataset.componentId);
        var box = marked && marked.localName !== "head" ? marked.getBoundingClientRect() : null;
        var component = state.components.find(function (item) { return item.id === outlines[n].dataset.componentId; });
        var show = !state.shellControls || component.id === activeId ||
          component.scope && activeElement && marked.contains(activeElement);
        outlines[n].style.display = show && box && (box.width || box.height) ? "block" : "none";
        if (box) {
          outlines[n].style.left = box.left + "px";
          outlines[n].style.top = box.top + "px";
          outlines[n].style.width = box.width + "px";
          outlines[n].style.height = box.height + "px";
        }
      }
      var groups = layer.querySelectorAll(".cluster");
      for (var i = 0; i < groups.length; i++) {
        var group = groups[i];
        if (group.parentNode === dock) continue;
        var id = group.dataset.componentId;
        var element = findElement(id);
        var outline = layer.querySelector(".outline[data-component-id=\"" + id.replace(/["\\]/g, "\\$&") + "\"]");
        var rect = element && element.localName !== "head" ? element.getBoundingClientRect() : null;
        if (!rect || (rect.width === 0 && rect.height === 0)) {
          // No box to anchor to (head, zero-size, or no layout): use the dock.
          dock.append(group);
          if (outline) outline.style.display = "none";
          continue;
        }
        if (outline) {
          outline.style.display = "block";
          outline.style.left = rect.left + "px";
          outline.style.top = rect.top + "px";
          outline.style.width = rect.width + "px";
          outline.style.height = rect.height + "px";
        }
        var top = Math.min(Math.max(rect.top, 0), Math.max(rect.bottom - 40, 0)) + 6;
        var right = Math.min(Math.max(width - rect.right, 0), Math.max(width - 120, 0)) + 6;
        if (height && top > height - 40) top = Math.max(height - 40, 0);
        group.style.top = top + "px";
        group.style.right = right + "px";
      }
    }

    function queueLayout() {
      if (layoutQueued) return;
      layoutQueued = true;
      (win.requestAnimationFrame || win.setTimeout).call(win, layout);
    }

    win.addEventListener("message", function (event) {
      if (event.source !== parentWindow) return;
      var data = event.data;
      if (isRecord(data) && hasExactKeys(data, ["channel", "type", "comparisonId", "pane"]) &&
          data.channel === CHANNEL && data.type === "hover-end" && data.comparisonId === comparisonId && data.pane === pane) {
        pointer = null;
        hoverAnnounced = false;
        if (state.shellControls) queueLayout();
        return;
      }
      var next = parseState(data, comparisonId, pane);
      if (!next) return;
      state = next;
      render();
    });
    // Chromium sends no mouseover when the pointer re-enters a frame over the
    // element it last hovered, so every pointer move can announce the hover.
    function trackPointer(event) {
      if (event.target === host) return;
      pointer = { target: event.target, x: event.clientX, y: event.clientY };
      if (!state.shellControls) return;
      queueLayout();
      if (!hoverAnnounced) {
        hoverAnnounced = true;
        post({ type: "hover" });
      }
    }
    function cycle(id) {
      var c = state.components.find(function (item) { return item.id === id; });
      if (!state.shellControls || state.busy || state.readOnly || !c || controllingGroup(c)) return;
      post({ type: "intent", intent: "cycle", componentId: id });
    }
    root.addEventListener("click", function (event) {
      var outline = event.target.closest && event.target.closest(".reticle");
      if (!outline || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      cycle(outline.dataset.componentId);
    });
    doc.addEventListener("click", function (event) {
      if (!state.shellControls || event.target === host || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      var id = componentAt(event.target);
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      cycle(id);
    }, true);
    doc.addEventListener("mouseover", trackPointer);
    doc.addEventListener("mousemove", trackPointer);
    doc.addEventListener("mouseout", function (event) {
      if (event.relatedTarget === host) return;
      pointer = event.relatedTarget ? { target: event.relatedTarget, x: event.clientX, y: event.clientY } : null;
      if (state.shellControls) queueLayout();
    });
    doc.addEventListener("mouseleave", function () {
      pointer = null;
      if (state.shellControls) queueLayout();
    });
    win.addEventListener("blur", function () {
      wantFocus = null;
      pointer = null;
      focusTarget = null;
      if (state.shellControls) queueLayout();
    });
    doc.addEventListener("focusin", function (event) {
      if (event.target !== host) wantFocus = null;
      focusTarget = event.target;
      if (state.shellControls) queueLayout();
    });
    doc.addEventListener("focusout", function (event) {
      focusTarget = event.relatedTarget;
      if (state.shellControls) queueLayout();
    });
    win.addEventListener("scroll", queueLayout, true);
    win.addEventListener("resize", queueLayout);

    function start() {
      attachHost();
      if (typeof win.ResizeObserver === "function") {
        var observer = new win.ResizeObserver(queueLayout);
        observer.observe(doc.documentElement);
      }
      post({ type: "ready" });
    }
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", start, { once: true });
    else start();

    return { instance: instance };
  }

  var script = typeof document !== "undefined" ? document.currentScript : null;
  if (script && script.dataset) {
    boot(window, { comparisonId: script.dataset.comparisonId, pane: script.dataset.pane });
  }
})();
