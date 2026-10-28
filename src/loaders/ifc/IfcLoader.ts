/**
 * IFC loader plugin (.ifc, STEP physical file; IFC2X3, IFC4, IFC4X3). No dependencies: a native
 * STEP reader (`step.ts`) and geometry kernel (`geometry.ts`).
 *
 * Pipeline:
 *  1. Time-sliced index of the file: id, type and byte offset per instance (`StepFile`).
 *  2. Units (lengths become metres), surface styles and material colours.
 *  3. One objectId per product with a body representation. Items are triangulated in the product's
 *     frame and merged per colour; mapped items (IfcRepresentationMap) are triangulated once and
 *     placed with one `addMeshes` per map, so repeated parts are drawn instanced. Openings
 *     (IfcRelVoidsElement) are cut from their hosts.
 *  4. Hierarchy: project / site / building / storey / elements / parts from IfcRelAggregates,
 *     IfcRelNests and IfcRelContainedInSpatialStructure. Node properties (attributes, type,
 *     material, property and quantity sets) are decoded before the file is released and answered
 *     lazily from compact columns.
 */
import type { MaterialId } from '../../types';
import type { LoadContext, LoaderPlugin, LoaderSource, NodeProperties } from '../types';
import { IfcGeometry, invert, mul, transformPlanes } from './geometry';
import { TriMesh } from './mesh';
import { Enum, StepFile, enumOf, list, num, plainValue, refId, refList, str, type Arg } from './step';

export interface IfcLoaderOptions {
  /**
   * Most segments of a full circle (round profiles, pipes, arcs). Default 24. Small circles get
   * fewer: as many as keep the tessellation within 1 mm of the true circle, at least 8.
   */
  circleSegments: number;
  /** Load the geometry of IfcSpace (rooms). Default false: spaces stay in the tree without geometry. */
  spaces: boolean;
  /** Cut openings (IfcRelVoidsElement) from their host elements. Default true. */
  openings: boolean;
  /**
   * Subtract solids in boolean differences (bolt holes, chamfers, copes). Default false: the
   * uncut solid is shown, which is much faster. Half-space clips (cut ends) are always applied.
   */
  solidCuts: boolean;
  /**
   * Draw bolts (IfcMechanicalFastener, IfcFastener) as hexagonal head, shank and nut, all
   * instances of one shared geometry; washers are left out. Default true. Bolts that are not
   * made of extrusions along one axis keep their detailed geometry.
   */
  simplifyBolts: boolean;
  /** Read property and quantity sets into the node properties. Default true. */
  properties: boolean;
}

export function createIfcLoader(defaults: Partial<IfcLoaderOptions> = {}): LoaderPlugin<IfcLoaderOptions> {
  return {
    name: 'ifc',
    extensions: ['ifc'],
    mimeTypes: ['application/x-step', 'application/ifc', 'model/ifc'],
    up: 'z',
    canLoad: ({ header }) => /^\s*ISO-10303-21\s*;/.test(new TextDecoder().decode(header)),
    load: (source, ctx) => loadIfc(source, ctx, { ...defaults, ...ctx.options }),
  };
}

/** The built-in IFC plugin with default options. */
export const ifcLoader: LoaderPlugin<IfcLoaderOptions> = createIfcLoader();

// ------------------------------------------------------------------------------------------------

const PREFIX: Record<string, number> = {
  EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 1e1,
  DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12, FEMTO: 1e-15, ATTO: 1e-18,
};

/** Spatial structure classes: attribute 7 is LongName (for elements it is Tag). */
const SPATIAL = new Set([
  'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCSPACE', 'IFCFACILITY', 'IFCFACILITYPART', 'IFCBRIDGE',
  'IFCBRIDGEPART', 'IFCROAD', 'IFCROADPART', 'IFCRAILWAY', 'IFCRAILWAYPART', 'IFCMARINEFACILITY', 'IFCMARINEPART',
  'IFCSPATIALZONE', 'IFCEXTERNALSPATIALELEMENT', 'IFCSPATIALSTRUCTUREELEMENT', 'IFCBUILDINGSECTION',
]);

/** Bolt classes (see `simplifyBolts`). */
const FASTENERS = new Set(['IFCMECHANICALFASTENER', 'IFCFASTENER']);

/** Classes whose geometry is never drawn. */
const NO_GEOMETRY = new Set(['IFCOPENINGELEMENT', 'IFCOPENINGSTANDARDCASE', 'IFCVOIDINGFEATURE', 'IFCVIRTUALELEMENT']);

/** Representations drawn, by identifier; others are used only when a product has none of these. */
const BODY_IDS = new Set(['BODY', 'FACETATION', 'BODY-FALLBACK']);
const NON_BODY_IDS = new Set(['AXIS', 'FOOTPRINT', 'BOX', 'ANNOTATION', 'PROFILE', 'REFERENCE', 'SURVEY', 'LIGHTING', 'CLEARANCE', 'COG', 'PLAN']);
const SOLID_TYPES = new Set([
  'SWEPTSOLID', 'ADVANCEDSWEPTSOLID', 'BREP', 'ADVANCEDBREP', 'SOLIDMODEL', 'SURFACEMODEL', 'TESSELLATION', 'TRIANGULATEDFACESET',
  'MAPPEDREPRESENTATION', 'CLIPPING', 'CSG', 'ADVANCEDSURFACE', 'SECTIONEDSPINE',
]);

/** Colours of products without any style or material colour (sRGB, alpha). */
const CLASS_COLORS: Record<string, [number, number, number, number]> = {
  IFCWALL: [0.92, 0.91, 0.88, 1], IFCWALLSTANDARDCASE: [0.92, 0.91, 0.88, 1], IFCSLAB: [0.78, 0.78, 0.76, 1],
  IFCROOF: [0.62, 0.36, 0.3, 1], IFCWINDOW: [0.55, 0.72, 0.85, 0.45], IFCDOOR: [0.6, 0.45, 0.3, 1],
  IFCPLATE: [0.6, 0.62, 0.66, 1], IFCBEAM: [0.6, 0.62, 0.66, 1], IFCCOLUMN: [0.6, 0.62, 0.66, 1],
  IFCMEMBER: [0.6, 0.62, 0.66, 1], IFCSTAIR: [0.75, 0.74, 0.72, 1], IFCSTAIRFLIGHT: [0.75, 0.74, 0.72, 1],
  IFCRAILING: [0.45, 0.47, 0.5, 1], IFCSPACE: [0.55, 0.75, 0.9, 0.25], IFCFURNISHINGELEMENT: [0.72, 0.58, 0.42, 1],
  IFCMECHANICALFASTENER: [0.42, 0.44, 0.46, 1], IFCPIPESEGMENT: [0.4, 0.6, 0.45, 1], IFCPIPEFITTING: [0.4, 0.6, 0.45, 1],
  IFCDUCTSEGMENT: [0.62, 0.66, 0.72, 1], IFCDUCTFITTING: [0.62, 0.66, 0.72, 1], IFCCOVERING: [0.85, 0.84, 0.8, 1],
  IFCFOOTING: [0.7, 0.7, 0.68, 1], IFCPILE: [0.7, 0.7, 0.68, 1],
};
const DEFAULT_COLOR: [number, number, number, number] = [0.8, 0.8, 0.8, 1];

/** Proper-case class names (the file stores them upper case). */
const CLASS_NAMES = (
  'IfcProject IfcSite IfcBuilding IfcBuildingStorey IfcSpace IfcFacility IfcFacilityPart IfcBridge IfcBridgePart IfcRoad ' +
  'IfcRoadPart IfcRailway IfcRailwayPart IfcMarineFacility IfcMarinePart IfcSpatialZone IfcExternalSpatialElement IfcZone ' +
  'IfcWall IfcWallStandardCase IfcWallElementedCase IfcCurtainWall IfcSlab IfcSlabStandardCase IfcSlabElementedCase IfcRoof ' +
  'IfcWindow IfcWindowStandardCase IfcDoor IfcDoorStandardCase IfcBeam IfcBeamStandardCase IfcColumn IfcColumnStandardCase ' +
  'IfcMember IfcMemberStandardCase IfcPlate IfcPlateStandardCase IfcStair IfcStairFlight IfcRamp IfcRampFlight IfcRailing ' +
  'IfcCovering IfcFooting IfcPile IfcBuildingElementProxy IfcBuildingElementPart IfcElementAssembly IfcChimney IfcShadingDevice ' +
  'IfcOpeningElement IfcOpeningStandardCase IfcFurnishingElement IfcFurniture IfcSystemFurnitureElement IfcMechanicalFastener ' +
  'IfcFastener IfcDiscreteAccessory IfcReinforcingBar IfcReinforcingMesh IfcTendon IfcTendonAnchor IfcTransportElement ' +
  'IfcDistributionElement IfcDistributionControlElement IfcDistributionFlowElement IfcFlowSegment IfcFlowFitting ' +
  'IfcFlowTerminal IfcFlowController IfcFlowMovingDevice IfcFlowStorageDevice IfcFlowTreatmentDevice IfcEnergyConversionDevice ' +
  'IfcPipeSegment IfcPipeFitting IfcDuctSegment IfcDuctFitting IfcCableSegment IfcCableFitting IfcCableCarrierSegment ' +
  'IfcCableCarrierFitting IfcValve IfcPump IfcFan IfcTank IfcBoiler IfcChiller IfcCoil IfcAirTerminal IfcLightFixture IfcLamp ' +
  'IfcOutlet IfcSwitchingDevice IfcSanitaryTerminal IfcFlowInstrument IfcSensor IfcActuator IfcController IfcAlarm ' +
  'IfcUnitaryEquipment IfcElectricAppliance IfcDistributionPort IfcPort IfcAnnotation IfcGrid IfcProxy IfcGeographicElement ' +
  'IfcCivilElement IfcElementComponent IfcVirtualElement IfcCourse IfcPavement IfcKerb IfcEarthworksFill IfcEarthworksCut ' +
  'IfcAlignment IfcReferent IfcSign IfcSignal IfcTrackElement IfcRail IfcBearing IfcDeepFoundation IfcCaissonFoundation ' +
  'IfcMooringDevice IfcNavigationElement IfcAssembly'
).split(' ');
const CLASS_BY_UPPER = new Map(CLASS_NAMES.map((n) => [n.toUpperCase(), n]));
const className = (upper: string) => CLASS_BY_UPPER.get(upper) ?? (upper.startsWith('IFC') ? 'Ifc' + upper[3] + upper.slice(4).toLowerCase() : upper);

/** Scratch meshes per colour slot, reused from product to product. */
class SlotMeshes {
  private meshes: TriMesh[] = [];
  /** Slots with content since the last reset. */
  readonly used: number[] = [];
  get(slot: number): TriMesh {
    let m = this.meshes[slot];
    if (!m) m = this.meshes[slot] = new TriMesh();
    if (!this.used.includes(slot)) this.used.push(slot);
    return m;
  }
  reset(): void {
    for (const s of this.used) this.meshes[s].reset();
    this.used.length = 0;
  }
}

interface Instanced {
  /** Per colour part: geometry, material and the recentring offset (file units). */
  parts: { geometry: number; material: MaterialId; c: [number, number, number] }[];
  matrices: number[];
  objectIds: number[];
}

async function loadIfc(source: LoaderSource, ctx: LoadContext<IfcLoaderOptions>, opt: Partial<IfcLoaderOptions>) {
  ctx.progress(0, 'read');
  const step = new StepFile(await source.bytes());
  ctx.throwIfAborted();
  if (!step.schema) ctx.warn('IFC: no FILE_SCHEMA in the header');
  while (!step.scan(1 << 14)) {
    if (ctx.shouldYield()) {
      ctx.progress(0.3 * step.scanned, 'index');
      await ctx.yield();
    }
  }
  ctx.progress(0.3, 'prepare');

  // --- warnings, aggregated per kind ---------------------------------------------------------
  const unsupported = new Map<string, number>();
  const report = (what: string) => unsupported.set(what, (unsupported.get(what) ?? 0) + 1);

  // --- units ---------------------------------------------------------------------------------
  const units = readUnits(step);
  const scale = units.length;
  const geo = new IfcGeometry(step, {
    circleSegments: Math.max(8, Math.round(opt.circleSegments ?? 24)),
    lengthScale: scale,
    angleScale: units.angle,
    solidCuts: opt.solidCuts ?? false,
    unsupported: report,
  });

  // --- colours: slot = distinct RGBA, one material each (created on first use) -----------------
  const slotKey = new Map<string, number>();
  const slotColor: [number, number, number, number][] = [];
  const slotMaterial: (MaterialId | undefined)[] = [];
  const slotOf = (c: [number, number, number, number]) => {
    const k = c.map((v) => Math.round(v * 1000)).join(',');
    let s = slotKey.get(k);
    if (s === undefined) {
      slotKey.set(k, (s = slotColor.length));
      slotColor.push(c);
    }
    return s;
  };
  const materialOf = (slot: number): MaterialId => {
    let m = slotMaterial[slot];
    if (m === undefined) {
      const c = slotColor[slot];
      m = slotMaterial[slot] = ctx.createMaterial({ color: c, roughness: 0.75, metalness: 0 });
    }
    return m;
  };
  const styleSlot = new Map<number, number>();
  const slotOfStyles = (styles: Arg): number => {
    for (const st of list(styles)) {
      const id = refId(st);
      if (!id) continue;
      let r = styleSlot.get(id);
      if (r === undefined) {
        r = -1;
        const t = step.type(id);
        if (t === 'IFCPRESENTATIONSTYLEASSIGNMENT') r = slotOfStyles(step.args(id)[0]);
        else if (t === 'IFCSURFACESTYLE') {
          for (const e of refList(step.args(id)[2])) {
            const et = step.type(e);
            if (et !== 'IFCSURFACESTYLERENDERING' && et !== 'IFCSURFACESTYLESHADING') continue;
            const ea = step.args(e);
            const ca = step.args(refId(ea[0]));
            if (ca.length < 4) continue;
            const alpha = 1 - Math.min(1, Math.max(0, num(ea[1], 0)));
            r = slotOf([clamp01(num(ca[1])), clamp01(num(ca[2])), clamp01(num(ca[3])), alpha]);
            break;
          }
        }
        styleSlot.set(id, r);
      }
      if (r >= 0) return r;
    }
    return -1;
  };
  const itemSlot = new Map<number, number>();
  for (const id of step.idsOf('IFCSTYLEDITEM')) {
    const a = step.args(id);
    const item = refId(a[0]);
    if (!item) continue;
    const s = slotOfStyles(a[1]);
    if (s >= 0) itemSlot.set(item, s);
  }
  // material colours (IfcMaterialDefinitionRepresentation)
  const materialSlot = new Map<number, number>();
  for (const id of step.idsOf('IFCMATERIALDEFINITIONREPRESENTATION')) {
    const a = step.args(id);
    for (const rep of refList(a[2])) {
      for (const si of refList(step.args(rep)[3])) {
        const s = slotOfStyles(step.args(si)[1]);
        if (s >= 0 && !materialSlot.has(refId(a[3]))) materialSlot.set(refId(a[3]), s);
      }
    }
  }
  await ctx.yieldIfNeeded();

  // --- one pass over the rooted instances: relations, products --------------------------------
  const aggParent = new Map<number, number>();
  const containedIn = new Map<number, number>();
  const psetsOf = new Map<number, number[]>();
  const typeOf = new Map<number, number>();
  const materialOfObject = new Map<number, number>();
  const openingsOf = new Map<number, number[]>();
  const products: number[] = [];
  const productArgs = new Map<number, Arg[]>();
  const projects: number[] = [];
  const multi = <K>(m: Map<K, number[]>, k: K, v: number) => {
    const l = m.get(k);
    if (l) l.push(v);
    else m.set(k, [v]);
  };
  const rooted = step.rooted;
  for (let r = 0; r < rooted.length; r++) {
    const id = rooted[r];
    const t = step.type(id);
    if (t.startsWith('IFCREL')) {
      const a = step.args(id);
      switch (t) {
        case 'IFCRELAGGREGATES':
        case 'IFCRELNESTS':
          for (const c of refList(a[5])) aggParent.set(c, refId(a[4]));
          break;
        case 'IFCRELCONTAINEDINSPATIALSTRUCTURE':
          for (const c of refList(a[4])) containedIn.set(c, refId(a[5]));
          break;
        case 'IFCRELDEFINESBYPROPERTIES': {
          const defs = a[5] instanceof Array ? refList(a[5]) : [refId(a[5])];
          for (const o of refList(a[4])) for (const d of defs) multi(psetsOf, o, d);
          break;
        }
        case 'IFCRELDEFINESBYTYPE':
          for (const o of refList(a[4])) typeOf.set(o, refId(a[5]));
          break;
        case 'IFCRELASSOCIATESMATERIAL':
          for (const o of refList(a[4])) materialOfObject.set(o, refId(a[5]));
          break;
        case 'IFCRELVOIDSELEMENT':
          multi(openingsOf, refId(a[4]), refId(a[5]));
          break;
      }
    } else if (t === 'IFCPROJECT') projects.push(id);
    else if (!t.endsWith('TYPE') && !t.startsWith('IFCPROPERTY') && t !== 'IFCELEMENTQUANTITY' && t !== 'IFCOWNERHISTORY') {
      const a = step.args(id);
      if (a.length >= 7 && refId(a[6]) && step.type(refId(a[6])) === 'IFCPRODUCTDEFINITIONSHAPE') {
        products.push(id);
        productArgs.set(id, a);
      }
    }
    if ((r & 1023) === 0 && ctx.shouldYield()) await ctx.yield();
  }

  const colourOfMaterial = (sel: number, depth = 0): number => {
    if (!sel || depth > 4) return -1;
    const own = materialSlot.get(sel);
    if (own !== undefined) return own;
    const a = step.args(sel);
    let subs: number[] = [];
    switch (step.type(sel)) {
      case 'IFCMATERIALLAYERSETUSAGE':
      case 'IFCMATERIALPROFILESETUSAGE':
        subs = [refId(a[0])];
        break;
      case 'IFCMATERIALLAYERSET':
      case 'IFCMATERIALLIST':
        subs = refList(a[0]);
        break;
      case 'IFCMATERIALLAYER':
        subs = [refId(a[0])];
        break;
      case 'IFCMATERIALCONSTITUENTSET':
      case 'IFCMATERIALPROFILESET':
        subs = refList(a[2]);
        break;
      case 'IFCMATERIALCONSTITUENT':
      case 'IFCMATERIALPROFILE':
        subs = [refId(a[2])];
        break;
    }
    for (const s of subs) {
      const c = colourOfMaterial(s, depth + 1);
      if (c >= 0) return c;
    }
    return -1;
  };

  // --- geometry ------------------------------------------------------------------------------
  ctx.progress(0.35, 'geometry');
  const includeSpaces = opt.spaces ?? false;
  const cutOpenings = opt.openings ?? true;
  const simplifyBolts = opt.simplifyBolts ?? true;
  const boltCache = new Map<number, Float64Array[] | null>();
  let unitHex: { geometry: number; c: [number, number, number] } | null = null;
  /** The instances of the shared bolt part in colour `slot`. */
  const boltsOf = (slot: number): Instanced => {
    const key = `bolt:${slot}`;
    let inst = instanced.get(key);
    if (!inst) {
      if (!unitHex) {
        const m = new TriMesh();
        geo.unitHexPrism(m);
        unitHex = emit(m);
      }
      inst = { parts: [{ ...unitHex, material: materialOf(slot) }], matrices: [], objectIds: [] };
      instanced.set(key, inst);
    }
    return inst;
  };
  const firstId = ctx.allocObjectIds(products.length);
  const productObjectId = new Map<number, number>();
  const own = new SlotMeshes(); // the current product's items
  const shared = new SlotMeshes(); // a representation map being triangulated
  const instanced = new Map<string, Instanced>();
  const subtractPool: TriMesh[] = [];
  const bodyCache = new Map<number, number[]>();
  const bodyItems = (shape: number): number[] => {
    let items = bodyCache.get(shape);
    if (items) return items;
    const reps = refList(step.args(shape)[2]);
    const ident = (r: number) => str(step.args(r)[1]).toUpperCase();
    const rtype = (r: number) => str(step.args(r)[2]).toUpperCase();
    let chosen = reps.filter((r) => ident(r) === 'BODY');
    if (!chosen.length) chosen = reps.filter((r) => BODY_IDS.has(ident(r)));
    if (!chosen.length) chosen = reps.filter((r) => !NON_BODY_IDS.has(ident(r)) && SOLID_TYPES.has(rtype(r)));
    items = chosen.flatMap((r) => geo.representationItems(r));
    bodyCache.set(shape, items);
    return items;
  };

  /** Creates the geometry of a mesh (metres, recentred); returns it with its offset in file units. */
  const emit = (mesh: TriMesh) => {
    const b = mesh.bounds()!;
    const c: [number, number, number] = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
    const n = mesh.nv * 3;
    const positions = new Float32Array(n);
    const normals = new Float32Array(n);
    for (let i = 0; i < n; i += 3) {
      positions[i] = (mesh.pos[i] - c[0]) * scale;
      positions[i + 1] = (mesh.pos[i + 1] - c[1]) * scale;
      positions[i + 2] = (mesh.pos[i + 2] - c[2]) * scale;
      normals[i] = mesh.nrm[i];
      normals[i + 1] = mesh.nrm[i + 1];
      normals[i + 2] = mesh.nrm[i + 2];
    }
    const geometry = ctx.createGeometry({ positions, normals, indices: mesh.idx.subarray(0, mesh.ni) });
    return { geometry, c };
  };
  /** Model transform for geometry recentred by c: P · T(c), translation in metres. */
  const placed = (P: ArrayLike<number>, c: ArrayLike<number>, out: number[] | Float64Array, o = 0) => {
    for (let k = 0; k < 12; k++) out[o + k] = P[k];
    for (let r = 0; r < 3; r++) out[o + 12 + r] = (P[r] * c[0] + P[4 + r] * c[1] + P[8 + r] * c[2] + P[12 + r]) * scale;
    out[o + 15] = 1;
  };
  let meshCount = 0;
  const tmpMatrix = new Float64Array(16);

  for (let k = 0; k < products.length; k++) {
    const id = products[k];
    const t = step.type(id);
    if (NO_GEOMETRY.has(t) || (t === 'IFCSPACE' && !includeSpaces)) continue;
    const a = productArgs.get(id)!;
    const objectId = firstId + k;
    const P = geo.placement(refId(a[5]));
    const items = bodyItems(refId(a[6]));
    if (!items.length) continue;
    let fallback = -1;
    const mat = materialOfObject.get(id) ?? materialOfObject.get(typeOf.get(id) ?? 0);
    if (mat) fallback = colourOfMaterial(mat);
    if (fallback < 0) fallback = slotOf(CLASS_COLORS[t] ?? DEFAULT_COLOR);
    const openings = cutOpenings ? openingsOf.get(id) : undefined;
    let any = false;
    const bolt = simplifyBolts && FASTENERS.has(t);
    try {
      if (bolt && !items.some((it) => step.type(it) === 'IFCMAPPEDITEM')) {
        // bolt modelled in place: simplified as a whole
        const parts = geo.boltParts(items);
        if (parts) {
          const inst = boltsOf(itemSlot.get(items[0]) ?? fallback);
          for (const part of parts) {
            mul(P, part, tmpMatrix);
            for (let i = 0; i < 16; i++) inst.matrices.push(tmpMatrix[i]);
            inst.objectIds.push(objectId);
          }
          productObjectId.set(id, objectId);
          continue;
        }
      }
      for (const it of items) {
        const slot = itemSlot.get(it) ?? fallback;
        if (bolt && step.type(it) === 'IFCMAPPEDITEM') {
          const ia = step.args(it);
          const map = refId(ia[0]);
          let parts = boltCache.get(map);
          if (parts === undefined) {
            parts = geo.boltParts(geo.representationItems(refId(step.args(map)[1])));
            boltCache.set(map, parts);
          }
          if (parts) {
            const subs = geo.representationItems(refId(step.args(map)[1]));
            const inst = boltsOf(itemSlot.get(it) ?? itemSlot.get(subs[0]) ?? fallback);
            const M = mul(P, mul(geo.placement(refId(ia[1])), geo.placement(refId(step.args(map)[0]))));
            for (const part of parts) {
              mul(M, part, tmpMatrix);
              for (let i = 0; i < 16; i++) inst.matrices.push(tmpMatrix[i]);
              inst.objectIds.push(objectId);
            }
            any = true;
            continue;
          }
        }
        if (step.type(it) === 'IFCMAPPEDITEM' && !openings) {
          // shared representation: triangulated once, placed per product
          const ia = step.args(it);
          const map = refId(ia[0]);
          const key = `${map}:${slot}`;
          let inst = instanced.get(key);
          if (!inst) {
            inst = { parts: [], matrices: [], objectIds: [] };
            instanced.set(key, inst);
            try {
              for (const sub of geo.representationItems(refId(step.args(map)[1]))) geo.item(sub, shared.get(itemSlot.get(sub) ?? slot));
              for (const s of shared.used) {
                const m = shared.get(s);
                if (m.ni) inst.parts.push({ ...emit(m), material: materialOf(s) });
              }
            } finally {
              shared.reset();
            }
          }
          if (!inst.parts.length) continue;
          mul(P, mul(geo.placement(refId(ia[1])), geo.placement(refId(step.args(map)[0]))), tmpMatrix);
          for (let i = 0; i < 16; i++) inst.matrices.push(tmpMatrix[i]);
          inst.objectIds.push(objectId);
          any = true;
          continue;
        }
        geo.item(it, own.get(slot));
      }
      if (openings) for (const op of openings) cutOpening(op, P);
      for (const s of own.used) {
        const m = own.get(s);
        if (!m.ni) continue;
        const { geometry, c } = emit(m);
        const tr = new Float64Array(16);
        placed(P, c, tr);
        ctx.addMesh({ geometry, material: materialOf(s), transform: tr, objectId });
        meshCount++;
        any = true;
      }
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      report(`failed product geometry (${(e as Error)?.message ?? e})`);
    } finally {
      own.reset();
    }
    if (any) productObjectId.set(id, objectId);
    if (ctx.shouldYield()) {
      ctx.progress(0.35 + 0.55 * ((k + 1) / products.length), 'geometry');
      await ctx.yield();
    }
  }

  /** Subtracts an opening element's body from the meshes of the current product (frame P). */
  function cutOpening(opening: number, P: Float64Array): void {
    const oa = step.args(opening);
    const O = geo.placement(refId(oa[5]));
    const toHost = mul(invert(P), O);
    for (const it of refId(oa[6]) ? bodyItems(refId(oa[6])) : []) {
      const parts = geo.convexParts(it);
      if (!parts) {
        report('opening with a non-convex shape (not cut)');
        continue;
      }
      for (const planes of parts) {
        const hp = transformPlanes(planes, toHost);
        for (const s of own.used) own.get(s).subtractConvex(hp, subtractPool);
      }
    }
  }

  // shared geometry: one addMeshes per part
  for (const inst of instanced.values()) {
    const n = inst.objectIds.length;
    if (!n) continue;
    for (const part of inst.parts) {
      const tr = new Float64Array(n * 16);
      for (let i = 0; i < n; i++) placed(inst.matrices.slice(i * 16, i * 16 + 16), part.c, tr, i * 16);
      ctx.addMeshes({ geometry: part.geometry, material: part.material, transforms: tr, objectIds: Float64Array.from(inst.objectIds) });
      meshCount += n;
    }
    await ctx.yieldIfNeeded();
  }
  ctx.progress(0.92, 'metadata');

  // --- hierarchy -----------------------------------------------------------------------------
  const parentOf = (e: number) => aggParent.get(e) ?? containedIn.get(e) ?? 0;
  const children = new Map<number, number[]>();
  const inTree = new Set<number>(projects);
  const attach = (e: number) => {
    // walk up, adding the chain to the tree (cycle-safe)
    let cur = e;
    for (let guard = 0; guard < 64 && cur && !inTree.has(cur); guard++) {
      inTree.add(cur);
      const p = parentOf(cur);
      if (!p) break;
      multi(children, p, cur);
      cur = p;
    }
  };
  for (const e of aggParent.keys()) attach(e);
  for (const e of containedIn.keys()) attach(e);
  for (const e of productObjectId.keys()) attach(e);
  const project = projects.length === 1 ? projects[0] : 0;
  const roots: number[] = [...projects];
  for (const e of inTree) {
    if (projects.includes(e) || parentOf(e)) continue;
    // parentless: under the single project, else a root of its own
    if (project) multi(children, project, e);
    else roots.push(e);
  }
  const elevation = (e: number) => (step.type(e) === 'IFCBUILDINGSTOREY' ? num(step.args(e)[9], 0) : 0);
  for (const list of children.values()) list.sort((x, y) => elevation(x) - elevation(y) || x - y);

  const nodeEntity: number[] = [];
  const parents: number[] = [];
  const nodeOf = new Map<number, number>();
  const stack: [number, number][] = roots.slice().reverse().map((e) => [e, -1]);
  while (stack.length) {
    const [e, p] = stack.pop()!;
    if (nodeOf.has(e)) continue;
    nodeOf.set(e, nodeEntity.length);
    nodeEntity.push(e);
    parents.push(p);
    const ch = children.get(e);
    if (ch) for (let i = ch.length - 1; i >= 0; i--) stack.push([ch[i], nodeOf.get(e)!]);
  }
  const N = nodeEntity.length;

  // compact node columns, decoded now: the file is released when load() returns
  const cls: string[] = new Array(N);
  const attrs: (NodeProperties | undefined)[] = new Array(N);
  const names: string[] = new Array(N);
  const oids = new Float64Array(N).fill(NaN);
  const psetIndex = new Map<number, number>();
  const psets: (NodeProperties | null)[] = [];
  const psetStart = new Int32Array(N + 1);
  const psetList: number[] = [];
  const readProps = opt.properties ?? true;
  const decodedPset = (p: number) => {
    let i = psetIndex.get(p);
    if (i === undefined) {
      psetIndex.set(p, (i = psets.length));
      psets.push(decodePset(step, p));
    }
    return i;
  };
  for (let n = 0; n < N; n++) {
    const e = nodeEntity[n];
    const t = step.type(e);
    const a = step.args(e);
    cls[n] = className(t);
    const oid = productObjectId.get(e);
    if (oid !== undefined) oids[n] = oid;
    const name = str(a[2]);
    const at: NodeProperties = { Class: cls[n] };
    if (str(a[0])) at.GlobalId = str(a[0]);
    if (name) at.Name = name;
    if (str(a[3])) at.Description = str(a[3]);
    if (str(a[4])) at.ObjectType = str(a[4]);
    const long = t === 'IFCPROJECT' ? str(a[5]) : SPATIAL.has(t) ? str(a[7]) : '';
    if (long) at.LongName = long;
    else if (!SPATIAL.has(t) && typeof a[7] === 'string' && a[7]) at.Tag = a[7];
    if (t === 'IFCBUILDINGSTOREY' && typeof a[9] === 'number') at.Elevation = a[9];
    const type = typeOf.get(e);
    if (type) {
      const tn = str(step.args(type)[2]);
      if (tn) at.TypeName = tn;
    }
    const mat = materialOfObject.get(e) ?? (type ? materialOfObject.get(type) : undefined);
    if (mat) {
      const mn = materialNames(step, mat);
      if (mn) at.Material = mn;
    }
    attrs[n] = at;
    names[n] = name || long || cls[n];
    if (readProps) {
      // type sets first, so the occurrence's own sets win on merge
      if (type) for (const p of refList(step.args(type)[5])) psetList.push(decodedPset(p));
      for (const p of psetsOf.get(e) ?? []) psetList.push(decodedPset(p));
    }
    psetStart[n + 1] = psetList.length;
    if ((n & 255) === 0) await ctx.yieldIfNeeded();
  }
  const psetCols = Int32Array.from(psetList);
  ctx.hierarchy.addNodes(
    parents,
    oids,
    (i) => names[i],
    (i) => {
      const out: NodeProperties = { ...attrs[i] };
      for (let k = psetStart[i]; k < psetStart[i + 1]; k++) {
        const ps = psets[psetCols[k]];
        if (!ps) continue;
        for (const [name, props] of Object.entries(ps)) out[name] = { ...(out[name] as object | undefined), ...(props as object) };
      }
      return out;
    },
  );

  // --- warnings ------------------------------------------------------------------------------
  for (const [what, n] of unsupported) ctx.warn(`IFC: ${what} (${n}×)`);

  return {
    info: {
      format: 'IFC',
      schema: step.schema,
      application: step.application,
      lengthUnit: units.lengthName,
      entities: step.count,
      products: productObjectId.size,
      meshes: meshCount,
    },
  };
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Length scale to metres and radians per plane angle unit, from the project's unit assignment. */
function readUnits(step: StepFile): { length: number; lengthName: string; angle: number } {
  let length = 1, lengthName = 'METRE', angle = 1;
  const unitScale = (u: number, depth = 0): number => {
    const a = step.args(u);
    const t = step.type(u);
    if (t === 'IFCSIUNIT') return a[2] instanceof Enum ? PREFIX[a[2].value] ?? 1 : 1;
    if (t.startsWith('IFCCONVERSIONBASEDUNIT') && depth < 4) {
      const m = step.args(refId(a[3]));
      return num(m[0], 1) * unitScale(refId(m[1]), depth + 1);
    }
    return 1;
  };
  let unitIds: number[] = [];
  for (const p of step.idsOf('IFCPROJECT')) {
    const ua = refId(step.args(p)[8]);
    if (ua) unitIds = refList(step.args(ua)[0]);
  }
  if (!unitIds.length) unitIds = [...step.idsOf('IFCSIUNIT'), ...step.idsOf('IFCCONVERSIONBASEDUNIT')];
  for (const u of unitIds) {
    const a = step.args(u);
    const kind = enumOf(a[1]);
    if (kind === 'LENGTHUNIT') {
      length = unitScale(u);
      lengthName = step.type(u) === 'IFCSIUNIT' ? (a[2] instanceof Enum ? a[2].value : '') + enumOf(a[3]) : str(a[2]).toUpperCase();
    } else if (kind === 'PLANEANGLEUNIT') angle = unitScale(u);
  }
  return { length, lengthName, angle };
}

/** Material name(s) of a material select, joined with ' / '. */
function materialNames(step: StepFile, sel: number): string {
  const out: string[] = [];
  const visit = (id: number, depth: number) => {
    if (!id || depth > 4) return;
    const a = step.args(id);
    switch (step.type(id)) {
      case 'IFCMATERIAL':
        if (str(a[0])) out.push(str(a[0]));
        break;
      case 'IFCMATERIALLAYERSETUSAGE':
      case 'IFCMATERIALPROFILESETUSAGE':
      case 'IFCMATERIALLAYER':
        visit(refId(a[0]), depth + 1);
        break;
      case 'IFCMATERIALLAYERSET':
      case 'IFCMATERIALLIST':
        for (const m of refList(a[0])) visit(m, depth + 1);
        break;
      case 'IFCMATERIALCONSTITUENTSET':
      case 'IFCMATERIALPROFILESET':
        for (const m of refList(a[2])) visit(m, depth + 1);
        break;
      case 'IFCMATERIALCONSTITUENT':
      case 'IFCMATERIALPROFILE':
        visit(refId(a[2]), depth + 1);
        break;
    }
  };
  visit(sel, 0);
  return [...new Set(out)].join(' / ');
}

/** A property or quantity set as { [setName]: { property: value } }, or null for other definitions. */
function decodePset(step: StepFile, id: number): NodeProperties | null {
  const t = step.type(id);
  const a = step.args(id);
  let props: number[];
  if (t === 'IFCPROPERTYSET') props = refList(a[4]);
  else if (t === 'IFCELEMENTQUANTITY') props = refList(a[5]);
  else return null;
  const values: NodeProperties = {};
  for (const p of props) decodeProperty(step, p, values, 0);
  return { [str(a[2]) || className(t)]: values };
}

function decodeProperty(step: StepFile, id: number, out: NodeProperties, depth: number): void {
  const t = step.type(id);
  const a = step.args(id);
  const name = str(a[0]);
  if (!name) return;
  let v: unknown;
  switch (t) {
    case 'IFCPROPERTYSINGLEVALUE':
    case 'IFCPROPERTYENUMERATEDVALUE':
    case 'IFCPROPERTYLISTVALUE':
      v = plainValue(a[2]);
      break;
    case 'IFCPROPERTYBOUNDEDVALUE': {
      const up = plainValue(a[2]), lo = plainValue(a[3]);
      v = up !== undefined || lo !== undefined ? { Upper: up, Lower: lo } : undefined;
      break;
    }
    case 'IFCCOMPLEXPROPERTY':
    case 'IFCPHYSICALCOMPLEXQUANTITY': {
      if (depth > 4) return;
      const sub: NodeProperties = {};
      for (const p of refList(a[t === 'IFCCOMPLEXPROPERTY' ? 3 : 2])) decodeProperty(step, p, sub, depth + 1);
      v = sub;
      break;
    }
    default:
      if (t.startsWith('IFCQUANTITY')) v = plainValue(a[3]);
  }
  if (v !== undefined) out[name] = v;
}
