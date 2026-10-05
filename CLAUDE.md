# mk-viewer

Dependency-free WebGL2 3D viewer library for very large scenes, with a runtime geometry API,
loader plugins and multi-model federation. TypeScript, built with Vite as ESM + UMD.

- `README.md` is for library clients. `docs/ARCHITECTURE.md` is the design. `src/loaders/README.md`
  is the guide for loader plugin authors. Read the architecture doc before changing `src/core`,
  `src/gl` or `src/render`.
- `docs/PLUGIN_API.md` is the guide for viewer plugin authors; keep it in step with `src/plugins/types.ts`.

## Commands

- `npm run typecheck` — strict, `noUnusedLocals`
- `npm test` — Vitest, node environment (no DOM, no real WebGL)
- `npm run build` — `dist/mk-viewer.js`, `dist/mk-viewer.umd.cjs`, `dist/types/`
- `npm run dev` — serves the project root; examples at `/examples/index.html`

All three of typecheck, test and build must pass before a change is done.

## Rules

- Zero runtime dependencies. No Three.js, no proprietary formats or code. Do not add packages
  without asking.
- `src/types.ts` is the public API and `src/layout.ts` is the binary layout shared by the CPU core,
  the GL layer and the GLSL. Change `layout.ts` only together with every reader and writer,
  including the shaders in `src/gl/shaders/`. Public API changes should be additive.
- Hot paths (per frame, per fragment, per event) use typed arrays and do not allocate. No
  per-object JS objects for scene data.
- Loaders may only use the public `ViewerApi` through the load context; they must not import
  from `src/core`, `src/gl` or `src/render`.
- Examples import only from `../src/index`.
- Members of `Viewer` tagged `@internal` are stripped from the published typings.

## Layout

- `src/math`, `src/camera` (Camera, OrbitControls, gesture recognizer), `src/primitives`
- `src/core` — CPU scene data: FragmentList, GeometryStore, MaterialStore, Batcher, draw-item BVH
- `src/gl` — WebGL2 wrappers, uber-shader, render targets, post passes, pixel reader
- `src/render` — progressive renderer, budget controller, GPU mirroring, scene origin
- `src/loaders` — plugin contract, registry, glTF/GLB and OBJ plugins
- `src/Viewer.ts`, `src/index.ts` — public class and library entry

## Verifying rendering changes

Unit tests cannot see pixels. Anything that touches shaders, passes, batching or the frame loop
must be checked in a real browser: run `npx vite`, drive system Chrome over the DevTools protocol
(node 22 has global `fetch` and `WebSocket`, so no extra packages), look at screenshots, and treat
any WebGL console warning as a bug.

- Hardware GPU in headless Chrome: `--headless=new --use-angle=d3d11 --force_high_performance_gpu`.
  Without the last flag Chrome picks the integrated GPU; without `--use-angle` it may fall back to
  SwiftShader. Confirm the renderer through `WEBGL_debug_renderer_info` and state it with any
  performance number.
- Headless `requestAnimationFrame` is vsync-capped at 60 Hz, so report GPU time (`stats.gpuMs`) and
  CPU time (`stats.frameMs`), not just frame intervals.
- `examples/stress.html?bench=1` runs a scripted camera path and writes `window.benchmark`.
- Stop any dev server or test process you start. Orphaned `vite` and `vitest` processes have been
  left behind before.

## Test data

`TestModels/` is git-ignored. `TestModels/FactoryDemo.glb` (262 MB, 9.46M triangles, Z-up
Navisworks export) is the heavy reference model; tests that use it skip when it is absent. View it
at `/examples/models.html?url=/TestModels/FactoryDemo.glb`.

## Git

Local repository only, branch `main`, no remote. Commit each completed unit of work.
