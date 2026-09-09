# Image generation prompts

Tool: built-in image_gen.imagegen (no CLI fallback). Overview: new generation. Workbench: overview used only as style reference.

## Overview

Use case: ui-mockup.
Asset type: high fidelity desktop application design reference for Mimesis, a Chinese enterprise browser automation and data collection gateway.
Create one beautifully restrained, production plausible, front-on application screenshot, landscape 1600x1000 composition, no device frame or perspective, crisp readable Chinese sans-serif typography. This is the INSTANCE OVERVIEW screen. Calm light theme, warm near-white #f7f8f8 canvas, white panels, charcoal #172322 text, cool grey secondary text, hairline #e3e8e6 dividers, subtle teal #187b66 only for active state and tiny intelligent signals, black primary action. No gradients, neon, glassmorphism, robots, huge artwork, chat panel, decorative charts, fake dramatic metrics.
Layout: narrow light-grey left sidebar width 204 with small existing command-key style symbol and wordmark "Mimesis", subtitle "数据采集网关". Workspace label "本地工作空间". Exactly four nav entries, "自动化实例" selected, "浏览器环境", "运行记录", "设置". Bottom of sidebar shows small outlined activity icon "本机运行" and muted "脚本优先 · AI 可选". Native minimal window controls top right.
Content begins 36px to right of sidebar. Upper breadcrumb "工作空间 / 自动化实例", right small label "设计预览 · 示例数据". Large page heading "自动化实例", small subtitle "管理采集任务、浏览器环境与执行结果。" One black button "+ 新建实例" at right.
Below header: one unified white summary strip with three equal cells separated by fine vertical lines, not three big cards: "已启用实例  3 / 4", "正在执行  1", "最近运行成功率  96%" and small footnote "基于最近 50 条记录".
Main section row: heading "全部实例" with muted "4 个实例", right compact search "搜索实例或目标网址", tabs "全部 4", "已启用 3", "已暂停 1". Below a full-width precise table: columns "实例 / 目标网站", "浏览器环境", "最近运行", "状态", unlabeled actions. Four generous 80px rows: "商品目录采集" catalog.example.com with profile "默认环境" and green outlined dot success "已完成"; "供应商目录同步" supplier.example.com profile "采购账号" small teal dot "运行中"; "行业资讯归档" news.example.com profile "默认环境" "已完成"; "价格变动监测" prices.example.com profile "测试环境" muted "已暂停". Right each row shows small play outline and "打开 →". Keep statuses simple, quiet, meaningful.
Below table: one compact full-width diagnostic notice with an elegant 18px connected-nodes outline icon, heading "运行洞察" and an understated pill "规则分析". Text "1 个实例尚未验证。建议先运行一次，确认目标网站和浏览器环境。" one text action "查看实例 →". Small footer "洞察来自运行记录，不调用 AI 模型。"
Rest of canvas generous empty breathing room. Enterprise polish comes from alignment, typography, real information hierarchy and restrained components. No unsupported navigation features, no fake chat experience, no full-screen dashboard collage. Render one finished single screen.

## Instance workbench

Use case: ui-mockup.
Create a second high-fidelity desktop application design screen for Mimesis, an enterprise browser automation data gateway. Use the provided image ONLY as style reference. Match its calm light sidebar, charcoal Chinese typography, teal status, hairline borders, strict enterprise layout. This new screen is INSTANCE DETAIL rather than overview. Front-on single screenshot landscape 1600x1000, no perspective, no device frame, no gradients or huge illustration.
Keep exactly same sidebar wordmark Mimesis, subtitle 数据采集网关, navigation 自动化实例 selected, 浏览器环境, 运行记录, 设置, bottom 本机运行 and 脚本优先 · AI 可选.
Top breadcrumb 工作空间 / 自动化实例 / 商品目录采集. Upper right 设计预览 · 示例数据 and native window controls. Page header back arrow, title 商品目录采集, small pill 已完成, subtitle catalog.example.com. Right a black button 运行实例 and secondary 查看结果. Metadata strip 浏览器环境 默认环境 | 脚本 page-inspector v1.0.0 | 最近运行 14:32.
Tabs 任务流程, 脚本与浏览器 selected, 实例配置, 运行记录.
Main workspace two columns: left 40% a restrained code editor white/light background with header 已发布源码 and pill 无需 AI. Display small syntax highlighted TypeScript function with readable lines:
export async function inspectPage(ctx, input) {
  await ctx.step("navigate", async () => {
    await ctx.browser.navigate(input.url, ctx.signal);
  });
  return ctx.step("inspect", async () => {
    return ctx.browser.inspect(ctx.signal);
  });
}
Below editor quiet footer 已发布脚本可以独立运行. Right 60% actual browser panel with narrow address bar lock icon catalog.example.com and simple webpage mock: heading 商品目录, three clean textual product list rows (机械键盘 ¥399, 无线耳机 ¥899, 便携音箱 ¥599). No product photography necessary, keep browser distinct from application chrome by one thin border.
Bottom shared result panel: header 运行结果, badge 已完成, copy icon 复制 JSON at right. Left narrow execution steps column: green checks 打开页面 and 提取页面数据 with tiny durations; right wide neatly formatted JSON title 商品目录, headings array, links array, white background monospace. Small quiet note 本次运行无需 AI.
No chatbot, no AI suggestions pretending to be running, no unimplemented RPA toolbar, no giant telemetry metrics. Compact but breathable layout. Follow the style reference faithfully while designing the new detail screen.

