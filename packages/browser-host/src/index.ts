import {
  AppError,
  type BrowserBounds,
  DEMO_URL,
  documentSchema,
  type Profile,
  validateNavigationUrl,
  z,
} from "@clawler/contracts";
import type { BrowserPort } from "@clawler/script-sdk";
import { type BrowserWindow, session, WebContentsView } from "electron";
import { BrowserAutomation } from "./automation";
import { demoPage } from "./demo-page";
import { BrowserRecorder } from "./recorder";

const inspectionExpression = `(() => ({
  title: document.title,
  url: location.href,
  headings: Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 50).map(node => node.textContent.trim().slice(0, 500)),
  links: Array.from(document.querySelectorAll('a[href]')).slice(0, 100).map(node => ({text: node.textContent.trim().slice(0, 500), href: node.href.slice(0, 4096)}))
}))()`;
const hiddenScrollbarCss = `
  * { scrollbar-width: none !important; }
  *::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
`;
const configuredProfiles = new Set<string>();

/** Privileged adapter; the renderer only receives validated, narrow browser operations. */
export class BrowserHost implements BrowserPort {
  readonly automation = new BrowserAutomation(() => this.getContents());
  readonly recorder = new BrowserRecorder();
  async startRecording(): Promise<void> {
    await this.recorder.start(this.getContents());
  }
  private readonly views = new Map<string, WebContentsView>();
  private current: WebContentsView | undefined;
  private bounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0, visible: false };

  constructor(private readonly window: BrowserWindow) {}

  selectProfile(profile: Profile): void {
    let view = this.views.get(profile.id);
    if (!view) {
      const profileSession = session.fromPartition(`persist:profile-${profile.id}`);
      profileSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      profileSession.setPermissionCheckHandler(() => false);
      if (!configuredProfiles.has(profile.id))
        profileSession.protocol.handle("clawler-demo", (request) => {
          if (request.url !== DEMO_URL) return new Response(null, { status: 404 });
          return new Response(demoPage, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Content-Security-Policy":
                "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
            },
          });
        });
      configuredProfiles.add(profile.id);
      view = new WebContentsView({
        webPreferences: {
          session: profileSession,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      const contents = view.webContents;
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      const validateNavigation = (event: Electron.Event, url: string) => {
        try {
          validateNavigationUrl(url);
        } catch {
          event.preventDefault();
        }
      };
      contents.on("will-navigate", validateNavigation);
      contents.on("will-redirect", validateNavigation);
      contents.on("did-finish-load", () => {
        void contents.insertCSS(hiddenScrollbarCss, { cssOrigin: "user" }).catch(() => undefined);
      });
      this.views.set(profile.id, view);
      void view.webContents.loadURL(DEMO_URL).catch(() => undefined);
    }
    if (this.current) this.window.contentView.removeChildView(this.current);
    this.current = view;
    this.window.contentView.addChildView(view);
    this.setBounds(this.bounds);
  }

  setBounds(bounds: BrowserBounds): void {
    this.bounds = bounds;
    if (!this.current) return;
    const { width: windowWidth, height: windowHeight } = this.window.getContentBounds();
    const x = Math.min(Math.round(bounds.x), windowWidth);
    const y = Math.min(Math.round(bounds.y), windowHeight);
    let width = Math.max(0, Math.min(Math.round(bounds.width), windowWidth - x));
    let height = Math.max(0, Math.min(Math.round(bounds.height), windowHeight - y));
    if (!bounds.visible) {
      width = 1024;
      height = 768;
    }
    this.current.setBounds({
      x,
      y,
      width,
      height,
    });
    this.current.setVisible(bounds.visible && bounds.width > 0 && bounds.height > 0);
  }

  private getContents() {
    if (!this.current || this.current.webContents.isDestroyed()) throw new AppError("NOT_FOUND");
    return this.current.webContents;
  }

  async navigate(value: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const url = validateNavigationUrl(value);
    const contents = this.getContents();
    const onAbort = () => contents.stop();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await contents.loadURL(url);
      signal.throwIfAborted();
    } catch (error) {
      signal.throwIfAborted();
      throw new AppError("NAVIGATION_FAILED", { cause: error });
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async inspect(signal: AbortSignal) {
    signal.throwIfAborted();
    const contents = this.getContents();
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    const response: unknown = await contents.debugger.sendCommand("Runtime.evaluate", {
      expression: inspectionExpression,
      returnByValue: true,
    });
    signal.throwIfAborted();
    return z.object({ result: z.object({ value: documentSchema }) }).parse(response).result.value;
  }

  dispose(): void {
    if (this.recorder.active) void this.recorder.stop();
    for (const view of this.views.values()) {
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    this.views.clear();
    this.current = undefined;
  }
}
