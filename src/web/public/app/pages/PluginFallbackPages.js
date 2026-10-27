import { defineComponent, h } from "/vendor/vue.esm-browser.prod.js";

/**
 * 插件页面加载失败/不可用时的兜底页。
 * 关键点:插件坏了只能坏它自己那一页,Dashboard 其余部分必须照常工作。
 */
export const NotFoundPage = defineComponent({
  name: "NotFoundPage",
  template: `<div class="page">
    <header class="page-head"><div><span class="eyebrow">404</span><h1>页面不存在</h1>
      <p class="page-sub">这个地址没有对应的核心页面或插件页面。</p></div></header>
    <div class="panel"><EmptyState title="没有找到这个页面" hint="从左侧导航选一个页面,或回到概览。" /></div>
  </div>`,
});

export function makePluginUnavailablePage(plugin) {
  return defineComponent({
    name: "PluginUnavailablePage",
    setup() {
      return () =>
        h("div", { class: "page" }, [
          h("header", { class: "page-head" }, [
            h("div", {}, [
              h("span", { class: "eyebrow" }, `插件 · ${plugin.id}`),
              h("h1", {}, plugin.panel?.title || plugin.name),
              h("p", { class: "page-sub" }, "这个插件当前未启用,页面与工具都不会加载。"),
            ]),
          ]),
          h("div", { class: "panel" }, [
            h("p", { class: "muted" }, plugin.description),
            h(
              "a",
              { class: "btn btn-primary btn-sm", href: "#/modules" },
              "去模块总览启用",
            ),
          ]),
        ]);
    },
  });
}

export function makePluginErrorPage(plugin, error) {
  return defineComponent({
    name: "PluginErrorPage",
    setup() {
      return () =>
        h("div", { class: "page" }, [
          h("header", { class: "page-head" }, [
            h("div", {}, [
              h("span", { class: "eyebrow" }, `插件 · ${plugin.id}`),
              h("h1", {}, plugin.panel?.title || plugin.name),
              h("p", { class: "page-sub" }, "插件页面加载失败。核心面板与其它插件不受影响。"),
            ]),
          ]),
          h("div", { class: "panel" }, [
            h("p", { class: "field-error" }, error?.message || String(error)),
            h("p", { class: "muted small" }, "常见原因:面板入口没有 default 导出、契约版本不兼容,或插件刚被卸载。"),
            h("a", { class: "btn btn-ghost btn-sm", href: "#/modules" }, "返回模块总览"),
          ]),
        ]);
    },
  });
}
