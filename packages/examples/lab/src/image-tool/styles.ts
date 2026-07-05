/** Inline CSS for the image-tool guest UI (layout C, progressive-reveal, mobile-first). */
export const STYLES = `
:root { color-scheme: dark; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: ui-sans-serif, system-ui, sans-serif; background: #11111b; color: #cdd6f4; padding: 16px; }
h1 { font-size: 20px; color: #89b4fa; text-align: center; }
.sub { font-size: 12px; color: #a6adc8; text-align: center; margin-bottom: 16px; }
.privacy { display: flex; gap: 8px; align-items: flex-start; font-size: 11px; color: #a6adc8; background: #1e1e2e; border: 1px solid #313244; border-radius: 8px; padding: 8px 10px; margin-bottom: 12px; }
.privacy button { flex: none; min-width: 28px; min-height: 28px; background: none; border: none; color: #6c7086; font: inherit; cursor: pointer; }
#drop { border: 2px dashed #585b70; border-radius: 12px; padding: 40px 16px; text-align: center; color: #a6adc8; background: #181825; cursor: pointer; }
#drop.drag { border-color: #89b4fa; background: #1e1e2e; }
.hidden { display: none !important; }
.controls { margin-top: 12px; }
.row { display: flex; gap: 6px; margin: 6px 0; align-items: center; flex-wrap: wrap; }
.chip, .fmt { flex: 1; min-width: 44px; min-height: 44px; background: #313244; border: none; border-radius: 6px; color: #cdd6f4; font: inherit; cursor: pointer; }
.chip.sel, .fmt.sel { background: #89b4fa; color: #11111b; font-weight: 700; }
input[type=range] { flex: 1; min-height: 44px; }
input[type=number] { width: 72px; min-height: 44px; background: #1e1e2e; border: 1px solid #45475a; border-radius: 6px; color: #cdd6f4; font: inherit; text-align: right; padding: 4px 8px; }
.label { font-size: 11px; color: #a6adc8; text-transform: uppercase; letter-spacing: .05em; }
#run, #download { width: 100%; min-height: 48px; border: none; border-radius: 8px; font: inherit; font-weight: 800; cursor: pointer; margin-top: 12px; }
#run { background: #a6e3a1; color: #11111b; }
#download { background: #a6e3a1; color: #11111b; }
#preview { max-width: 100%; border-radius: 8px; margin-top: 8px; }
.stats { display: flex; gap: 8px; margin-top: 8px; }
.stat { flex: 1; background: #1e1e2e; border: 1px solid #45475a; border-radius: 6px; padding: 10px; text-align: center; font-size: 12px; }
.stat.after { border-color: #a6e3a1; color: #a6e3a1; }
.cta { margin-top: 16px; background: #313244; border-radius: 8px; padding: 12px; text-align: center; }
.cta b { color: #f9e2af; display: block; margin-bottom: 6px; }
.cta button, .cta-link { background: #89b4fa; color: #11111b; border: none; border-radius: 6px; padding: 8px 14px; font: inherit; font-weight: 700; cursor: pointer; }
.cta-link { background: none; color: #89b4fa; text-decoration: underline; font-size: 12px; }
`;
