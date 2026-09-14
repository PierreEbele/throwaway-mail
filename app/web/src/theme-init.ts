// Runs before React to avoid a flash of the wrong theme (external file: CSP forbids inline scripts).
const pref = localStorage.getItem("theme") ?? "system";
const dark = pref === "dark" || (pref === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
document.documentElement.classList.toggle("dark", dark);
