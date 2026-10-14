/** Styles of the optional viewer UI (toolbar, panels, menu), injected once per document. */
const STYLE_ID = 'mkv-ui-style';

const CSS = `
.mkv-overlay{position:fixed;pointer-events:none;z-index:10;font:13px/1.4 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#e8eaed}
.mkv-overlay *{box-sizing:border-box}
.mkv-toolbar{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);display:flex;gap:4px;padding:4px;max-width:calc(100% - 16px);
  pointer-events:auto;touch-action:manipulation;background:rgba(20,22,26,.82);border:1px solid #3c4043;border-radius:8px;
  -webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.mkv-btn{font:inherit;color:inherit;min-width:40px;min-height:36px;padding:4px 12px;border:1px solid transparent;border-radius:6px;
  background:transparent;cursor:pointer;white-space:nowrap}
.mkv-btn:hover{background:#3c4043}
.mkv-btn:active{background:#4a4e53}
.mkv-btn.mkv-on{background:#1a73e8}
.mkv-panel{position:absolute;top:8px;width:min(340px,calc(100% - 16px));display:flex;flex-direction:column;
  pointer-events:auto;touch-action:manipulation;background:rgba(20,22,26,.9);border:1px solid #3c4043;border-radius:8px;overflow:hidden;
  -webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.mkv-panel[hidden]{display:none}
.mkv-panel.mkv-dock-right{right:8px}
.mkv-panel.mkv-dock-left{left:8px}
.mkv-panel:not(.mkv-auto){bottom:68px}
.mkv-panel.mkv-auto{max-height:calc(100% - 76px)}
.mkv-panel-head{display:flex;align-items:center;gap:6px;padding:6px 6px 6px 10px;font-weight:600;cursor:move;touch-action:none;user-select:none;-webkit-user-select:none}
.mkv-panel-head span{flex:1}
.mkv-panel-body{flex:1;min-height:0;display:flex;flex-direction:column}
.mkv-panel-foot{flex:0 0 auto;display:flex;justify-content:flex-end;height:12px;border-top:1px solid #3c4043}
.mkv-panel-grip{width:14px;height:11px;cursor:nwse-resize;touch-action:none;opacity:.6;
  background:linear-gradient(135deg,transparent 0 50%,#9aa0a6 50% 60%,transparent 60% 72%,#9aa0a6 72% 82%,transparent 82%) no-repeat right bottom/10px 10px}
.mkv-panel-grip:hover{opacity:1}
.mkv-panel-body.mkv-pad{padding:0 10px 10px;overflow:auto;gap:6px}
.mkv-line{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.mkv-grow{flex:1 1 120px;overflow-wrap:anywhere}
.mkv-dim{color:#9aa0a6;font-size:12px}
.mkv-panel a{color:#8ab4f8}
.mkv-btn.mkv-outline{border-color:#5f6368;background:#303338}
.mkv-btn.mkv-outline:hover{background:#3c4043}
.mkv-model-item{display:flex;flex-direction:column;gap:4px;padding:6px 0;border-top:1px solid #3c4043}
.mkv-panel input[type=checkbox]{width:18px;height:18px;margin:0}
.mkv-settings{display:flex;flex-direction:column}
.mkv-switch{display:flex;align-items:center;gap:10px;min-height:36px;cursor:pointer;user-select:none;-webkit-user-select:none}
.mkv-panel .mkv-switch input{appearance:none;-webkit-appearance:none;flex:0 0 36px;width:36px;height:20px;margin:0;position:relative;border-radius:10px;
  background:#5f6368;cursor:pointer;transition:background .15s}
.mkv-panel .mkv-switch input::before{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#e8eaed;transition:left .15s}
.mkv-panel .mkv-switch input:checked{background:#1a73e8}
.mkv-panel .mkv-switch input:checked::before{left:18px}
.mkv-panel .mkv-switch input:focus-visible{outline:2px solid #8ab4f8;outline-offset:2px}
.mkv-colors-label{cursor:default;min-height:28px}
.mkv-colors{display:flex;flex-wrap:wrap;gap:6px}
.mkv-panel .mkv-color{box-sizing:border-box;flex:0 0 22px;width:22px;height:22px;min-width:0;min-height:0;padding:0;border-radius:50%;border:2px solid transparent;cursor:pointer;box-shadow:0 0 0 1px rgba(255,255,255,.25)}
.mkv-panel .mkv-color.mkv-on{border-color:#fff;box-shadow:0 0 0 2px #1a73e8}
.mkv-panel .mkv-color:focus-visible{outline:2px solid #8ab4f8;outline-offset:2px}
.mkv-panel progress{flex:1;min-width:60px}
.mkv-errors{color:#ff8a80;white-space:pre-wrap}
.mkv-errors:empty,.mkv-footer:empty{display:none}
.mkv-footer{border-top:1px solid #3c4043;padding-top:6px;display:flex;flex-direction:column;gap:6px}
.mkv-search{margin:0 8px 4px;display:flex;gap:6px;align-items:center}
.mkv-search input{flex:1;min-width:0;font:inherit;color:inherit;min-height:32px;padding:4px 8px;border:1px solid #5f6368;border-radius:6px;background:#202124;outline:none}
.mkv-search input:focus{border-color:#8ab4f8}
.mkv-count{color:#9aa0a6;font-size:12px;white-space:nowrap}
.mkv-tree{position:relative;flex:1;overflow:auto;overscroll-behavior:contain;border-top:1px solid #3c4043}
.mkv-tree-spacer{position:relative;width:100%}
.mkv-row{position:absolute;left:0;right:0;display:flex;align-items:center;white-space:nowrap;cursor:pointer;user-select:none;-webkit-user-select:none}
.mkv-row:hover{background:#2d3035}
.mkv-row.mkv-active{background:#1a4a8a}
.mkv-row.mkv-model{font-weight:600}
.mkv-caret{flex:0 0 22px;height:100%;display:flex;align-items:center;justify-content:center;color:#9aa0a6;font-size:10px}
.mkv-label{overflow:hidden;text-overflow:ellipsis;padding-right:8px}
.mkv-row.mkv-match .mkv-label{color:#fdd663}
.mkv-menu{position:absolute;min-width:170px;padding:4px;display:flex;flex-direction:column;pointer-events:auto;touch-action:manipulation;
  background:rgba(32,33,36,.97);border:1px solid #3c4043;border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.45)}
.mkv-menu[hidden]{display:none}
.mkv-menu-item{font:inherit;color:inherit;text-align:left;min-height:34px;padding:4px 12px;border:0;border-radius:5px;background:transparent;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:10px}
.mkv-menu-item:hover:not(:disabled),.mkv-menu-sub[aria-expanded=true]{background:#3c4043}
.mkv-menu-item:disabled{color:#80868b;cursor:default}
.mkv-menu-sub::after{content:'›';margin-left:auto;padding-left:16px;color:#9aa0a6;font-size:16px;line-height:1}
.mkv-menu-swatch{flex:0 0 14px;height:14px;border-radius:3px;border:1px solid rgba(255,255,255,.25)}
.mkv-menu-item:disabled .mkv-menu-swatch{opacity:.4}
.mkv-submenu{top:0;left:100%;margin-left:2px}
.mkv-menu-sep{height:1px;margin:4px 2px;background:#3c4043}
.mkv-empty{padding:12px;color:#9aa0a6}
.mkv-panel [hidden]{display:none}
.mkv-propbody>*{flex-shrink:0}
.mkv-subhead{font-weight:600;padding-top:8px;border-top:1px solid #3c4043}
.mkv-slider{display:grid;grid-template-columns:92px minmax(0,1fr) 52px;align-items:center;gap:8px;min-height:32px}
.mkv-panel .mkv-slider input{width:100%;min-width:0;margin:0;accent-color:#1a73e8;cursor:pointer}
.mkv-panel .mkv-slider input:disabled{opacity:.4;cursor:default}
.mkv-slider output{text-align:right;color:#9aa0a6;font-size:12px;font-variant-numeric:tabular-nums}
.mkv-seg{display:flex}
.mkv-seg .mkv-btn{flex:1 1 0;min-width:0;border-radius:0}
.mkv-seg .mkv-btn+.mkv-btn{margin-left:-1px}
.mkv-seg .mkv-btn:first-child{border-radius:6px 0 0 6px}
.mkv-seg .mkv-btn:last-child{border-radius:0 6px 6px 0}
.mkv-seg .mkv-btn.mkv-on{background:#1a73e8;border-color:#1a73e8}
.mkv-views{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px}
.mkv-views .mkv-btn{min-width:0;padding:4px}
.mkv-field{font:inherit;color:inherit;min-width:0;min-height:32px;padding:4px 8px;border:1px solid #5f6368;border-radius:6px;background:#202124;outline:none}
.mkv-field:focus{border-color:#8ab4f8}
textarea.mkv-field{width:100%;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:12px}
.mkv-panel input[type=color]{width:40px;height:32px;padding:2px;border:1px solid #5f6368;border-radius:6px;background:#202124;cursor:pointer}
.mkv-props{width:100%;border-collapse:collapse;table-layout:fixed}
.mkv-props td{padding:3px 6px 3px 0;vertical-align:top;overflow-wrap:anywhere;border-top:1px solid #2d3035}
.mkv-props td:first-child{width:38%;color:#9aa0a6}
.mkv-props tr.mkv-props-meta td:last-child{font-weight:600}
.mkv-missing summary{cursor:pointer;color:#fdd663}
.mkv-missing pre{margin:4px 0;max-height:160px;overflow:auto;padding:4px 8px;border:1px solid #3c4043;border-radius:6px;background:#202124;
  font:12px/1.4 ui-monospace,Consolas,monospace;user-select:text;-webkit-user-select:text}
`;

export function ensureStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}
