// app.js — wires the engine, file tree, palette, top bar, and settings
// panel together. This is the only file that touches the DOM chrome
// outside the canvas.

(async function main() {
  const canvas = document.getElementById('drawCanvas');
  const engine = new SketchEngine(canvas);

  const settings = await window.api.settings.get();
  engine.baseWidth = settings.strokeBaseWidth;
  engine.minWidth = settings.strokeMinWidth;
  engine.maxWidth = settings.strokeMaxWidth;
  engine.dotGridEnabled = settings.dotGridEnabled;
  engine.pressureSensitivity = settings.pressureSensitivity != null ? settings.pressureSensitivity : 1;

  let exportMarginPx = settings.exportMarginPx;
  let currentFilePath = null;
  let saveTimer = null;

  const docNameEl = document.getElementById('docName');
  const saveStatusEl = document.getElementById('saveStatus');
  const unsavedDotEl = document.getElementById('unsavedDot');
  const gridToggleBtn = document.getElementById('gridToggleBtn');
  updateGridBtn();

  function updateGridBtn() {
    gridToggleBtn.style.opacity = engine.dotGridEnabled ? '1' : '0.45';
  }

  function setDocName(name) {
    docNameEl.textContent = name || 'No file open';
  }

  function setDirty(dirty) {
    unsavedDotEl.classList.toggle('visible', dirty);
  }

  let saveStatusTimer = null;
  function flashSaveStatus(text) {
    saveStatusEl.textContent = text;
    saveStatusEl.classList.add('visible');
    clearTimeout(saveStatusTimer);
    saveStatusTimer = setTimeout(() => saveStatusEl.classList.remove('visible'), 1500);
  }

  function scheduleAutosave() {
    setDirty(true);
    if (!currentFilePath) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await window.api.file.write(currentFilePath, engine.toDoc());
      setDirty(false);
      flashSaveStatus('Saved');
    }, 400);
  }
  engine.onChange = scheduleAutosave;

  // Explicit save: used by the Save button / Ctrl+S, and also the path
  // that first attaches an unsaved in-progress drawing (you can start
  // drawing on the infinite canvas immediately, before ever opening a
  // workspace or creating a file) to an actual file on disk.
  async function doSave() {
    if (!fileTree.root) {
      const root = await window.api.workspace.choose();
      if (!root) return;
      await fileTree.setRoot(root);
    }
    if (!currentFilePath) {
      const filePath = await fileTree.createFile();
      if (!filePath) return;
      currentFilePath = filePath;
      fileTree.setActive(filePath);
      setDocName(filePath.split(/[\\/]/).pop().replace(/\.skx$/, ''));
    }
    clearTimeout(saveTimer);
    await window.api.file.write(currentFilePath, engine.toDoc());
    setDirty(false);
    flashSaveStatus('Saved');
  }

  engine.onViewChange = (pct) => {
    document.getElementById('zoomIndicator').textContent = `${pct}%`;
  };

  // ---------- Palette ----------

  const DEFAULT_PALETTE = ['#1a1a1a', '#e0393e', '#2f6fed', '#2fa84f', '#f4b400'];
  let palette = [...DEFAULT_PALETTE];
  let activeSwatchIndex = 0;

  const swatchEls = [...document.querySelectorAll('.swatch')];
  function renderPalette() {
    swatchEls.forEach((el, i) => {
      el.style.background = palette[i];
      el.classList.toggle('active', i === activeSwatchIndex);
    });
    engine.currentColor = palette[activeSwatchIndex];
  }
  swatchEls.forEach((el, i) => {
    el.addEventListener('click', () => {
      activeSwatchIndex = i;
      renderPalette();
    });
    el.addEventListener('dblclick', () => {
      const input = document.createElement('input');
      input.type = 'color';
      input.value = palette[i];
      input.addEventListener('input', () => {
        palette[i] = input.value;
        renderPalette();
      });
      input.click();
    });
  });
  renderPalette();

  // ---------- File tree / workspace ----------

  const fileTree = new FileTree(document.getElementById('fileTree'), {
    onOpenFile: async (filePath) => {
      const doc = await window.api.file.read(filePath);
      engine.loadDoc(doc);
      currentFilePath = filePath;
      setDocName(filePath.split(/[\\/]/).pop().replace(/\.skx$/, ''));
      setDirty(false);
    },
  });

  if (settings.lastWorkspace) {
    await fileTree.setRoot(settings.lastWorkspace);
  }

  document.getElementById('chooseWorkspaceBtn').addEventListener('click', async () => {
    const root = await window.api.workspace.choose();
    if (root) await fileTree.setRoot(root);
  });

  document.getElementById('newFileBtn').addEventListener('click', async () => {
    // Guard against silently discarding an in-progress drawing that hasn't
    // been attached to a file yet (the canvas is drawable immediately, even
    // before a workspace/file exists).
    const hasUnsavedWork = !currentFilePath && engine.strokes.length > 0;
    if (hasUnsavedWork) {
      const proceed = window.confirm(
        'You have an unsaved drawing that isn\'t attached to a file yet. ' +
        'Starting a new file will discard it. Use Save first if you want to keep it.\n\n' +
        'Continue and discard the current drawing?'
      );
      if (!proceed) return;
    }
    const filePath = await fileTree.createFile();
    if (filePath) {
      engine.loadDoc({ version: 1, strokes: [] });
      currentFilePath = filePath;
      fileTree.setActive(filePath);
      setDocName(filePath.split(/[\\/]/).pop().replace(/\.skx$/, ''));
      setDirty(false);
    }
  });

  document.getElementById('newFolderBtn').addEventListener('click', () => fileTree.createFolder());

  // ---------- Top bar actions ----------

  document.getElementById('undoBtn').addEventListener('click', () => engine.undo());
  document.getElementById('redoBtn').addEventListener('click', () => engine.redo());

  document.getElementById('saveBtn').addEventListener('click', () => doSave());
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      doSave();
    }
  });

  gridToggleBtn.addEventListener('click', async () => {
    engine.dotGridEnabled = !engine.dotGridEnabled;
    updateGridBtn();
    engine.requestRender();
    await window.api.settings.set({ dotGridEnabled: engine.dotGridEnabled });
  });

  async function doScreenshot() {
    const dataUrl = window.exportPngDataUrl(engine, exportMarginPx);
    if (!dataUrl) return;
    if (fileTree.root) {
      await window.api.exportApi.autoScreenshot(fileTree.root, dataUrl);
    } else {
      await window.api.exportApi.savePng('screenshot.png', dataUrl);
    }
  }
  engine.onScreenshotRequested = doScreenshot;

  document.getElementById('exportPngBtn').addEventListener('click', async () => {
    const dataUrl = window.exportPngDataUrl(engine, exportMarginPx);
    if (!dataUrl) return;
    const base = currentFilePath ? currentFilePath.split(/[\\/]/).pop().replace(/\.skx$/, '') : 'sketch';
    await window.api.exportApi.savePng(`${base}.png`, dataUrl);
  });

  document.getElementById('exportSvgBtn').addEventListener('click', async () => {
    const svgText = window.exportSvgText(engine, exportMarginPx);
    if (!svgText) return;
    const base = currentFilePath ? currentFilePath.split(/[\\/]/).pop().replace(/\.skx$/, '') : 'sketch';
    await window.api.exportApi.saveSvg(`${base}.svg`, svgText);
  });

  // ---------- Settings panel ----------

  const settingsPanel = document.getElementById('settingsPanel');
  const marginInput = document.getElementById('marginInput');
  const baseWidthInput = document.getElementById('baseWidthInput');
  const pressureSensitivityInput = document.getElementById('pressureSensitivityInput');

  document.getElementById('settingsBtn').addEventListener('click', () => {
    marginInput.value = exportMarginPx;
    baseWidthInput.value = engine.baseWidth;
    pressureSensitivityInput.value = engine.pressureSensitivity;
    settingsPanel.classList.remove('hidden');
  });

  // Live-update pressure sensitivity as the slider moves, so you can feel
  // the difference immediately without closing the panel.
  pressureSensitivityInput.addEventListener('input', () => {
    engine.pressureSensitivity = Number(pressureSensitivityInput.value);
    engine.requestRender();
  });

  document.getElementById('closeSettingsBtn').addEventListener('click', async () => {
    exportMarginPx = Math.max(0, Number(marginInput.value) || 0);
    engine.baseWidth = Math.max(1, Number(baseWidthInput.value) || engine.baseWidth);
    engine.pressureSensitivity = Number(pressureSensitivityInput.value);
    await window.api.settings.set({
      exportMarginPx,
      strokeBaseWidth: engine.baseWidth,
      pressureSensitivity: engine.pressureSensitivity,
    });
    settingsPanel.classList.add('hidden');
  });

  setDocName(null);
})();
