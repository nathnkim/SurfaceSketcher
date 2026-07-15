# App icon

Drop your custom icon here as `icon.ico` (this exact filename — it's already
wired up in `package.json`'s `build.win.icon` and in `main/main.js`'s
`BrowserWindow` options, so both the packaged installer/exe and the app
window/taskbar icon during `npm start` will pick it up automatically).

Requirements for `icon.ico`:
- Windows `.ico` format, ideally a multi-resolution ICO containing at least
  16x16, 32x32, 48x48, and 256x256 sizes (256x256 is required for the
  taskbar/Start Menu tile to look sharp).
- If you only have a `.png`, convert it — e.g. https://icoconvert.com or
  `magick icon.png -define icon:auto-resize=256,48,32,16 icon.ico` if you
  have ImageMagick installed.

No file here yet, so the app currently falls back to Electron's default icon.
