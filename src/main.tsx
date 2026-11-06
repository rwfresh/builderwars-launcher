import "./zod-config";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource-variable/inter";
import "./styles.css";
import { isThemeId } from "./themes";

// Main passes the saved theme as ?theme=, so the boot screen paints in it before launcherInfo() resolves (App keeps
// data-theme in sync after that, including runtime switches). Anything else keeps the CSS default, Lights out.
const bootTheme = new URLSearchParams(window.location.search).get("theme");
if (isThemeId(bootTheme)) document.documentElement.dataset.theme = bootTheme;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
