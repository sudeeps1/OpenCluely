const { desktopCapturer, screen, BrowserWindow } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../core/logger').createServiceLogger('CAPTURE');

class CaptureService {
  constructor() {
    this.isProcessing = false;
  }

  listDisplays() {
    try {
      const displays = screen.getAllDisplays().map(d => ({
        id: d.id,
        bounds: d.bounds,
        size: d.size,
        scaleFactor: d.scaleFactor,
        rotation: d.rotation,
        touchSupport: d.touchSupport || 'unknown'
      }));
      return { success: true, displays };
    } catch (error) {
      logger.error('Failed to list displays', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Capture screenshot and return an image buffer.
   * options: { displayId?: number, area?: { x, y, width, height } }
   */
  async captureAndProcess(options = {}) {
    if (this.isProcessing) throw new Error('Capture already in progress');
    this.isProcessing = true;
    const startTime = Date.now();
    try {
      const { image, metadata } = await this.captureScreenshot(options);

      // Crop if area specified
      let finalImage = image;
      if (options.area && this._isValidArea(options.area)) {
        try {
          finalImage = image.crop(options.area);
        } catch (e) {
          logger.warn('Crop failed, returning full image', { error: e.message, area: options.area });
        }
      }

      const buffer = finalImage.toPNG();
      logger.logPerformance('Screenshot capture', startTime, {
        bytes: buffer.length,
        dimensions: finalImage.getSize()
      });

      return {
        imageBuffer: buffer,
        mimeType: 'image/png',
        metadata: {
          timestamp: new Date().toISOString(),
          source: metadata,
          processingTime: Date.now() - startTime
        }
      };
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Let the user drag out a part of the screen and return it as an image.
   * Resolves to null if the user cancels (Esc).
   * macOS uses the system's own selection tool; other platforms get a
   * full-screen selection overlay.
   */
  async captureRegion() {
    if (this.isProcessing) throw new Error('Capture already in progress');
    this.isProcessing = true;
    const startTime = Date.now();
    try {
      if (process.platform === 'darwin') {
        const imageBuffer = await this._captureRegionMac();
        if (!imageBuffer) return null;
        logger.logPerformance('Area screenshot capture', startTime, { bytes: imageBuffer.length });
        return {
          imageBuffer,
          mimeType: 'image/png',
          metadata: { timestamp: new Date().toISOString(), area: 'interactive', processingTime: Date.now() - startTime }
        };
      }

      const selection = await this._selectAreaWithOverlay();
      if (!selection) return null;
      // Give the overlay a moment to disappear before capturing
      await new Promise((resolve) => setTimeout(resolve, 150));
      const { image, metadata } = await this.captureScreenshot({ displayId: selection.displayId });
      const cropped = image.crop(selection.area);
      const imageBuffer = cropped.toPNG();
      logger.logPerformance('Area screenshot capture', startTime, { bytes: imageBuffer.length, dimensions: cropped.getSize() });
      return {
        imageBuffer,
        mimeType: 'image/png',
        metadata: { timestamp: new Date().toISOString(), source: metadata, area: selection.area, processingTime: Date.now() - startTime }
      };
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Area snip on macOS: our own helper (native/snip) when it has been built,
   * otherwise the system screenshot tool.
   */
  async _captureRegionMac() {
    const helper = path.join(__dirname, '..', '..', 'native', 'build', 'snip')
      .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    if (!fs.existsSync(helper)) {
      return this._captureRegionSystemTool();
    }

    const file = path.join(os.tmpdir(), `opencluely-area-${process.pid}-${Date.now()}.png`);
    const code = await new Promise((resolve) => {
      execFile(helper, [file], (error) => resolve(error ? (typeof error.code === 'number' ? error.code : 2) : 0));
    });
    if (code === 1) return null; // cancelled
    if (code === 0) {
      try {
        const buffer = fs.readFileSync(file);
        fs.unlink(file, () => {});
        if (buffer.length) return buffer;
      } catch (_) { /* fall through */ }
    }
    logger.warn('Snip helper failed; using the system screenshot tool', { code });
    return this._captureRegionSystemTool();
  }

  _captureRegionSystemTool() {
    const file = path.join(os.tmpdir(), `opencluely-area-${process.pid}-${Date.now()}.png`);
    return new Promise((resolve) => {
      // -i: drag to select (Space switches to window mode, Esc cancels); -x: no sound
      execFile('/usr/sbin/screencapture', ['-i', '-x', file], () => {
        try {
          const buffer = fs.readFileSync(file);
          fs.unlink(file, () => {});
          resolve(buffer.length ? buffer : null);
        } catch (_) {
          resolve(null); // no file: the user cancelled
        }
      });
    });
  }

  _selectAreaWithOverlay() {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x, y, width, height } = display.bounds;
    const overlay = new BrowserWindow({
      x, y, width, height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');

    // The page reports the result through its title: "area:x,y,w,h" or "cancel"
    const html = `<!doctype html><html><head><title>select</title><style>
      html,body{margin:0;height:100%;cursor:crosshair;background:rgba(0,0,0,0.25);user-select:none;overflow:hidden}
      #box{position:fixed;border:2px solid #4da3ff;background:rgba(77,163,255,0.15);display:none}
      #hint{position:fixed;top:16px;left:50%;transform:translateX(-50%);color:#fff;font:13px -apple-system,Segoe UI,sans-serif;background:rgba(0,0,0,0.6);padding:6px 12px;border-radius:6px}
    </style></head><body><div id="hint">Drag to select an area. Esc to cancel.</div><div id="box"></div><script>
      let start = null; const box = document.getElementById('box');
      const rect = (e) => ({ x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY), w: Math.abs(e.clientX - start.x), h: Math.abs(e.clientY - start.y) });
      addEventListener('mousedown', (e) => { start = { x: e.clientX, y: e.clientY }; box.style.display = 'block'; });
      addEventListener('mousemove', (e) => { if (!start) return; const r = rect(e); Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' }); });
      addEventListener('mouseup', (e) => { if (!start) return; const r = rect(e); start = null; document.title = (r.w > 4 && r.h > 4) ? 'area:' + [r.x, r.y, r.w, r.h].map(Math.round).join(',') : 'cancel'; });
      addEventListener('keydown', (e) => { if (e.key === 'Escape') document.title = 'cancel'; });
    </script></body></html>`;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (!overlay.isDestroyed()) overlay.close();
        resolve(result);
      };
      overlay.on('page-title-updated', (event, title) => {
        event.preventDefault();
        if (title === 'cancel') return finish(null);
        if (title.startsWith('area:')) {
          const [ax, ay, aw, ah] = title.slice(5).split(',').map(Number);
          finish({ displayId: display.id, area: { x: ax, y: ay, width: aw, height: ah } });
        }
      });
      overlay.on('closed', () => finish(null));
      overlay.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      overlay.once('ready-to-show', () => overlay.focus());
    });
  }

  async captureScreenshot(options = {}) {
    const targetDisplay = this._getTargetDisplay(options.displayId);
    const { width, height } = targetDisplay.size || { width: 1920, height: 1080 };

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height }
    });

    if (sources.length === 0) {
      throw new Error('No screen sources available for capture');
    }

    // Find source matching the target display by comparing sizes as heuristic
    let source = sources[0];
    const match = sources.find(s => {
      const size = s.thumbnail.getSize();
      return size.width === width && size.height === height;
    });
    if (match) source = match;

    const image = source.thumbnail;
    if (!image) throw new Error('Failed to capture screen thumbnail');

    logger.debug('Screenshot captured successfully', {
      sourceName: source.name,
      imageSize: image.getSize()
    });

    return {
      image,
      metadata: {
        displayId: targetDisplay.id,
        sourceName: source.name,
        dimensions: image.getSize(),
        captureTime: new Date().toISOString()
      }
    };
  }

  _getTargetDisplay(displayId) {
    const all = screen.getAllDisplays();
    if (!all || all.length === 0) return screen.getPrimaryDisplay();
    if (displayId == null) return screen.getPrimaryDisplay();
    const found = all.find(d => d.id === displayId);
    return found || screen.getPrimaryDisplay();
  }

  _isValidArea(area) {
    return area && Number.isFinite(area.x) && Number.isFinite(area.y) &&
      Number.isFinite(area.width) && Number.isFinite(area.height) &&
      area.width > 0 && area.height > 0;
  }
}

module.exports = new CaptureService();
