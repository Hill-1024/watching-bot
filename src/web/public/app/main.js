import { createApp } from "/vendor/vue.esm-browser.prod.js";
import { captureUrlToken } from "./api.js";
import { applyTheme } from "./store.js";
import { AppShell } from "./components/AppShell.js";
import * as UI from "./components/ui.js";
import * as Controls from "./components/controls.js";
import * as Charts from "./components/charts.js";

captureUrlToken();
applyTheme();

const app = createApp(AppShell);
for (const [name, component] of Object.entries({ ...UI, ...Controls, ...Charts })) {
  app.component(name, component);
}
app.mount("#app");
