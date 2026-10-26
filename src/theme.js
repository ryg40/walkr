export const THEMES = Object.freeze([
  { value: "plum", label: "Fleet / Plum Dusk" },
  { value: "night", label: "Fleet / Soft Night" },
  { value: "day", label: "Fleet / Soft Day" },
  { value: "statue-light", label: "Statue Light" },
  { value: "statue-dark", label: "Statue Dark" },
  { value: "light", label: "Original Light" },
  { value: "dark", label: "Original Dark" },
]);

export const THEME_KEY = "human-review:theme";
export const DEFAULT_THEME = "plum";

export function normalizeTheme(value) {
  return THEMES.some((theme) => theme.value === value) ? value : DEFAULT_THEME;
}

export function initTheme(win) {
  const pickers = [...win.document.querySelectorAll("[data-theme-picker]")];
  function apply(value) {
    const theme = normalizeTheme(value);
    win.document.documentElement.dataset.theme = theme;
    for (const picker of pickers) picker.value = theme;
  }
  let saved;
  try { saved = win.localStorage.getItem(THEME_KEY); } catch {}
  apply(saved);

  function change(event) {
    const theme = normalizeTheme(event.target.value);
    apply(theme);
    try { win.localStorage.setItem(THEME_KEY, theme); } catch {}
  }
  function sync(event) {
    if (event.key === THEME_KEY || event.key === null) apply(event.newValue);
  }
  for (const picker of pickers) picker.addEventListener("change", change);
  win.addEventListener("storage", sync);
  return () => {
    for (const picker of pickers) picker.removeEventListener("change", change);
    win.removeEventListener("storage", sync);
  };
}

// Theme preferences belong to the shell, never to the reviewed document.
if (typeof window !== "undefined") initTheme(window);
