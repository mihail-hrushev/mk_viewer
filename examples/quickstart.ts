// The minimal mk-viewer scene. In your own project: import { Viewer } from 'mk-viewer';
import { Viewer } from '../src/index';

const canvas = document.querySelector('canvas')!;
const viewer = new Viewer(canvas); // y is up; orbit / pan / zoom / pick are built in

// Geometry is created once and can be placed any number of times.
const ground = viewer.primitives.plane(24, 24);
const box = viewer.primitives.box([1, 1, 1]);
const grey = viewer.createMaterial({ color: [0.75, 0.76, 0.78] });
const orange = viewer.createMaterial({ color: [0.95, 0.55, 0.15], roughness: 0.5 });
const glass = viewer.createMaterial({ color: [0.4, 0.65, 1, 0.35] }); // alpha < 1: transparent

viewer.addMesh({ geometry: ground, material: grey });

// Column-major 4x4 matrices: scale (sx, sy, sz), then translate (x, y, z).
const place = (x: number, y: number, z: number, sx: number, sy: number, sz: number) =>
  [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, x, y, z, 1];

for (let i = 0; i < 10; i++) {
  for (let j = 0; j < 10; j++) {
    const h = 0.5 + ((i * 7 + j * 3) % 10) / 3;
    viewer.addMesh({ geometry: box, material: orange, transform: place(i * 2 - 9, h / 2, j * 2 - 9, 1, h, 1), objectId: i * 10 + j });
  }
}
viewer.addMesh({ geometry: box, material: glass, transform: place(0, 2.5, 0, 6, 5, 6) });

viewer.fitToView();
viewer.on('pick', (hit) => console.log(hit ? `picked object ${hit.objectId}` : 'picked nothing'));
