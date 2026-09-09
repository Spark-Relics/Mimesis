# Collection workspace V3

Supersedes the sidebar composition in enterprise-v2. Design generated before implementation: `single-workspace.png`.

Use a horizontal app bar and one full-width workspace. No sidebar, secondary inspector column, metric dashboard or simulated AI controls. Use warm white, dark charcoal, restrained teal, thin borders and generous spacing. Existing Lucide icons are the code-native assets; no decorative bitmap is required in the working surface.

Four modes: website and recording, reusable workflow, configuration, results. The browser occupies the full content width. Workflow editing proceeds vertically: initialization actions → repeated extraction → pagination and stopping → parameters → validation/save/run. Show actual schema validation and execution results. JSON is the executable declarative workflow, not arbitrary JavaScript. Agent review currently happens during development, not through a pretend product button.

The Quotes to Scrape preset is explicitly a user-selected experiment, never a fake successful run. Record one next-page click, move it into pagination, configure quote/author extraction, then execute from the original URL. Preserve the saved workflow per instance and snapshot it for queued API jobs.

Verified implementation: `implemented-workflow.png` and `implemented-results.png` are renderer screenshots. `implemented-browser.png` captures the real embedded website surface separately. The external Quotes experiment returned 20 records across two pages with an explicit page-limit marker. Full checks: 49 unit tests and four Electron tests, including the opt-in external-site case.
