/**
 * A small third-party viewer plugin, written only against the public exports: a "Cut" toolbar
 * button that cuts the scene away above the selected objects (a section plane at the top of their
 * bounding box, along the viewer's up axis), following the selection while it is on. With nothing
 * selected it cuts at the middle of the scene height.
 *
 *   new Viewer(canvas, { plugins: [sectionPlugin()] });
 */
import type { ViewerPlugin, PluginInstance } from '../src/index';

export interface SectionPlugin extends PluginInstance {
  readonly on: boolean;
  setOn(on: boolean): void;
}

export function sectionPlugin(): ViewerPlugin<SectionPlugin> {
  return {
    name: 'section-at-selection',
    install({ viewer }) {
      const axis = viewer.up === 'z' ? 2 : 1;
      let on = false;
      let button: { on: boolean } | null = null;
      const apply = (): void => {
        const sel = viewer.getSelection();
        const box = viewer.getBounds(sel.length ? sel : undefined);
        if (!on || !box) return viewer.setSectionPlanes([]);
        const height = sel.length ? box[axis + 3] : (box[axis] + box[axis + 3]) / 2;
        const normal: [number, number, number] = [0, 0, 0];
        normal[axis] = 1; // cut away what is above
        const point: [number, number, number] = [box[0], box[1], box[2]];
        point[axis] = height;
        viewer.setSectionPlanes([{ normal, point }]);
      };
      const offSelection = viewer.on('selection', apply);
      const api: SectionPlugin = {
        get on() {
          return on;
        },
        setOn(v) {
          on = v;
          if (button) button.on = v;
          apply();
        },
        ui(ui) {
          const toggle = ui.addToggle({ label: 'Cut', title: 'Cut away everything above the selection', onClick: () => api.setOn(!on) });
          button = toggle;
          return () => {
            toggle.remove();
            button = null;
          };
        },
        dispose() {
          offSelection();
          if (on) viewer.setSectionPlanes([]);
        },
      };
      return api;
    },
  };
}
