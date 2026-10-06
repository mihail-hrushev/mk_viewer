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
.mkv-panel-body.mkv-pad{padding:0 10px 10px;overflow:auto;gap:6px}
.mkv-line{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.mkv-grow{flex:1 1 120px;overflow-wrap:anywhere}
.mkv-dim{color:#9aa0a6;font-size:12px}
.mkv-btn.mkv-outline{border-color:#5f6368;background:#303338}
.mkv-btn.mkv-outline:hover{background:#3c4043}
.mkv-model-item{display:flex;flex-direction:column;gap:4px;padding:6px 0;border-top:1px solid #3c4043}
.mkv-panel input[type=checkbox]{width:18px;height:18px;margin:0}
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
.mkv-menu-item{font:inherit;color:inherit;text-align:left;min-height:34px;padding:4px 12px;border:0;border-radius:5px;background:transparent;cursor:pointer;white-space:nowrap}
.mkv-menu-item:hover:not(:disabled){background:#3c4043}
.mkv-menu-item:disabled{color:#80868b;cursor:default}
.mkv-menu-sep{height:1px;margin:4px 2px;background:#3c4043}
.mkv-empty{padding:12px;color:#9aa0a6}
.mkv-panel [hidden]{display:none}
.mkv-propbody>*{flex-shrink:0}
.mkv-subhead{font-weight:600;padding-top:8px;border-top:1px solid #3c4043}
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
