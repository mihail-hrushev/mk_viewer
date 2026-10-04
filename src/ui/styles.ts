/** Styles of the optional viewer UI (toolbar, hierarchy panel), injected once per document. */
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
.mkv-panel{position:absolute;right:8px;top:8px;bottom:68px;width:min(340px,calc(100% - 16px));display:flex;flex-direction:column;
  pointer-events:auto;touch-action:manipulation;background:rgba(20,22,26,.9);border:1px solid #3c4043;border-radius:8px;overflow:hidden;
  -webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
.mkv-panel[hidden]{display:none}
.mkv-panel-head{display:flex;align-items:center;gap:6px;padding:6px 6px 6px 10px;font-weight:600}
.mkv-panel-head span{flex:1}
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
.mkv-empty{padding:12px;color:#9aa0a6}
`;

export function ensureStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}
