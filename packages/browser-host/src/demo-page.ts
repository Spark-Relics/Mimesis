/** Deliberately static third-party-like fixture. Website content is not application UI copy. */
/** Shared chrome for the nested list → detail fixture. Static website content, not UI copy. */
function fixture(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
*{box-sizing:border-box}body{margin:0;background:#f7f7f4;color:#2b3a33;font-family:system-ui,sans-serif;padding:30px 32px}
nav{display:flex;justify-content:space-between;font-size:11px;color:#7c8981;border-bottom:1px solid #e5e6de;padding-bottom:16px}
nav strong{color:#364c3f;letter-spacing:2px;font-size:12px}
h1{font-family:Georgia,serif;font-size:26px;font-weight:400;margin:26px 0 18px}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:16px;background:#fff;border:1px solid #e6e9e1;border-radius:8px;padding:14px 16px;margin-bottom:10px}
.row h2{font-size:14px;font-weight:500;margin:0}
.row a{font-size:11px;color:#6f8a7c}
main{max-width:560px}p{font-size:13px;color:#5d6a62;line-height:1.7}
.price{display:inline-block;font-size:12px;color:#a37b48;letter-spacing:1px}
</style></head><body>${body}</body></html>`;
}

/** List page for the nested traversal regression; each row links to its own detail page. */
export const detailListPage = fixture(
  "Clawler Detail Demo",
  `<nav><strong>FIELDNOTES</strong><span>NESTED TRAVERSAL</span></nav>
<h1>Field notes index</h1>
<article class="row"><h2 class="name">Cedar</h2><a class="detail-link" href="/detail/1/">Open note</a></article>
<article class="row"><h2 class="name">Birch</h2><a class="detail-link" href="/detail/2/">Open note</a></article>
<article class="row"><h2 class="name">Alder</h2><a class="detail-link" href="/detail/3/">Open note</a></article>`,
);

/** Detail pages keyed by pathname, including an explicit back control as a history fallback. */
export const detailPages: Record<string, string> = {
  "/detail/1/": fixture(
    "Cedar",
    `<nav><strong>FIELDNOTES</strong><span>NOTE 01</span></nav><main><h1 class="title">Cedar</h1>
<p class="summary">A slow-growing evergreen used for the first field experiment.</p>
<span class="price">18.00</span></main>
<p><a class="back" href="/detail/">Back to index</a></p>`,
  ),
  "/detail/2/": fixture(
    "Birch",
    `<nav><strong>FIELDNOTES</strong><span>NOTE 02</span></nav><main><h1 class="title">Birch</h1>
<p class="summary">A fast pioneer species recorded during the second pass.</p>
<span class="price">12.50</span></main>
<p><a class="back" href="/detail/">Back to index</a></p>`,
  ),
  "/detail/3/": fixture(
    "Alder",
    `<nav><strong>FIELDNOTES</strong><span>NOTE 03</span></nav><main><h1 class="title">Alder</h1>
<p class="summary">A riparian tree that closes the index of this fixture.</p>
<span class="price">9.75</span></main>
<p><a class="back" href="/detail/">Back to index</a></p>`,
  ),
};

export const demoPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clawler Playground</title><style>
*{box-sizing:border-box}body{margin:0;background:#f9f8f4;color:#293731;font-family:system-ui,sans-serif;padding:30px 32px}nav{display:flex;justify-content:space-between;font-size:11px;color:#78857c;border-bottom:1px solid #e6e7df;padding-bottom:18px}nav strong{color:#364c3f;letter-spacing:2px;font-size:12px}header{padding:35px 0 25px}small{color:#a37b48;letter-spacing:2px;font-size:10px}h1{font-family:Georgia,serif;font-size:40px;letter-spacing:-1.5px;line-height:1.08;font-weight:400;margin:15px 0}p{font-size:12px;color:#889188;line-height:1.7;max-width:390px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.card{background:#fff;border:1px solid #e6e9e1;border-radius:9px;overflow:hidden}.art{height:83px;display:grid;place-items:center;background:#e9eee4}.card:nth-child(2) .art{background:#f0e9df}.card:nth-child(3) .art{background:#e6ecef}.shape{height:36px;width:36px;border:8px solid #7c9078;border-radius:10px;transform:rotate(-12deg)}.card:nth-child(2) .shape{border-color:#bba287;border-radius:50%;transform:none}.card:nth-child(3) .shape{border-color:#8fa8b7;transform:rotate(15deg)}.copy{padding:12px}h2{font-size:11px;font-weight:500;margin:0 0 8px}a{font-size:10px;color:#8c9c8a;text-decoration:none}footer{font-size:10px;color:#a2aaa1;margin-top:25px;display:flex;justify-content:space-between}
</style></head><body><nav><strong>FIELDNOTES</strong><span>THE LOCAL PLAYGROUND</span></nav>
<header><small>A SPACE TO EXPERIMENT</small><h1>Small scripts.<br>Useful results.</h1><p>A quiet place to try your first automation. Inspect this page, collect its content, and make something reusable.</p></header>
<div class="grid"><article class="card"><div class="art"><div class="shape"></div></div><div class="copy"><h2>Automation basics</h2><a href="https://example.com/automation">Explore guide →</a></div></article><article class="card"><div class="art"><div class="shape"></div></div><div class="copy"><h2>Reusable scripts</h2><a href="https://example.com/scripts">Explore library →</a></div></article><article class="card"><div class="art"><div class="shape"></div></div><div class="copy"><h2>Isolated profiles</h2><a href="https://example.com/profiles">Explore profiles →</a></div></article></div>
<footer><span>THREE IDEAS. ONE WORKSPACE.</span><span>LOCAL DEMO / 01</span></footer></body></html>`;
