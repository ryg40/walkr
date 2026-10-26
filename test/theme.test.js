import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";
import { initTheme, normalizeTheme, THEMES, THEME_KEY } from "../src/theme.js";

function fixture() {
  return new JSDOM(`<select data-theme-picker>${THEMES.map(({ value, label }) => `<option value="${value}">${label}</option>`).join("")}</select>`, { url: "https://review.test" });
}

test("theme choices preserve legacy light/dark and reject unknown values", () => {
  assert.equal(normalizeTheme("light"), "light");
  assert.equal(normalizeTheme("dark"), "dark");
  for (const unknown of [null, undefined, "", "sepia", "__proto__"]) assert.equal(normalizeTheme(unknown), "plum");
  for (const { value } of THEMES) assert.equal(normalizeTheme(value), value);
});

test("Statue palettes provide readable text, actions, and focus colors", () => {
  const css = fs.readFileSync(new URL("../src/theme.css", import.meta.url), "utf8");
  const dom = new JSDOM(`<style>${css}</style>`);
  const root = dom.window.document.documentElement;
  const luminance = (hex) => {
    const rgb = hex.slice(1).match(/../g).map((part) => {
      const value = Number.parseInt(part, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  for (const theme of ["statue-light", "statue-dark"]) {
    root.dataset.theme = theme;
    const style = dom.window.getComputedStyle(root);
    const color = (name) => style.getPropertyValue(`--${name}`).trim();
    const contrast = (foreground, background) => {
      const values = [luminance(color(foreground)), luminance(color(background))].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    };
    assert.equal(style.colorScheme, theme.endsWith("light") ? "light" : "dark");
    assert.equal(color("brand"), "#ffd000");
    for (const background of ["canvas", "card", "rail", "input-bg", "soft", "chip"]) {
      for (const foreground of ["txt", "strong-txt", "mute", "faint", "accent", "danger", "green", "amber"]) {
        assert.ok(contrast(foreground, background) >= 4.5, `${theme}: ${foreground} on ${background}`);
      }
      assert.ok(contrast("focus", background) >= 3, `${theme}: focus on ${background}`);
    }
    assert.ok(contrast("btn-fg", "btn-bg") >= 4.5, `${theme}: button text`);
    assert.ok(contrast("brand-ink", "brand") >= 4.5, `${theme}: brand text`);
  }
  dom.window.close();
});

test("theme selection restores preferences, persists changes, and syncs tabs", () => {
  const dom = fixture();
  const win = dom.window;
  win.localStorage.setItem(THEME_KEY, "dark");
  const dispose = initTheme(win);
  const picker = win.document.querySelector("select");
  assert.equal(win.document.documentElement.dataset.theme, "dark");
  assert.equal(picker.value, "dark");
  for (const { value } of THEMES) {
    picker.value = value;
    picker.dispatchEvent(new win.Event("change"));
    assert.equal(win.localStorage.getItem(THEME_KEY), value);
    assert.equal(win.document.documentElement.dataset.theme, value);
  }
  win.dispatchEvent(new win.StorageEvent("storage", { key: THEME_KEY, newValue: "night" }));
  assert.equal(picker.value, "night");
  win.dispatchEvent(new win.StorageEvent("storage", { key: "unrelated", newValue: "light" }));
  assert.equal(picker.value, "night");
  win.dispatchEvent(new win.StorageEvent("storage", { key: THEME_KEY, newValue: "invalid" }));
  assert.equal(picker.value, "plum");
  win.dispatchEvent(new win.StorageEvent("storage", { key: null, newValue: null }));
  assert.equal(picker.value, "plum");
  dispose();
  dom.window.close();
});

test("theme selection works when browser storage is blocked", () => {
  const dom = fixture();
  Object.defineProperty(dom.window, "localStorage", { get() { throw new Error("Blocked storage"); } });
  const dispose = initTheme(dom.window);
  const picker = dom.window.document.querySelector("select");
  assert.equal(picker.value, "plum");
  picker.value = "light";
  picker.dispatchEvent(new dom.window.Event("change"));
  assert.equal(dom.window.document.documentElement.dataset.theme, "light");
  dispose();
  dom.window.close();
});

test("home, review, and Double shells expose the same labeled theme choices", () => {
  for (const file of ["hosted-home.html", "chrome.html", "double.html", "double-session-shell.html"]) {
    const dom = new JSDOM(fs.readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"));
    const picker = dom.window.document.querySelector("[data-theme-picker]");
    assert.ok(picker.closest("label"));
    assert.deepEqual([...picker.options].map((option) => ({ value: option.value, label: option.textContent })), THEMES);
    assert.ok(dom.window.document.querySelector('link[href="/theme.css"]'));
    if (file.startsWith("double")) {
      assert.equal(dom.window.document.title, "Double · Walkr");
      assert.equal(dom.window.document.querySelector(".double-brand").textContent, "Walkr");
    }
    dom.window.close();
  }
});
