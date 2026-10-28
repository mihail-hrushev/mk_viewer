import { describe, expect, it } from 'vitest';
import { createMockViewer } from './__tests__/mockViewer';
import { LoaderRegistry, ifcLoader, loadModel } from './index';
import { TriMesh } from './ifc/mesh';
import { StepFile, decodeStepString } from './ifc/step';
import { triangulate } from './ifc/triangulate';

/** A small IFC4 file in millimetres: project / site / storey, a styled wall with a property set, a
 *  column clipped by a half space, two placements of one mapped item, a bolt and a cut plate. */
const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','UnitTest','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'Proj',$,$,'Project long',$,$,#2);
#2=IFCUNITASSIGNMENT((#3,#4));
#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#4=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#10=IFCSITE('0000000000000000000010',$,'Site',$,$,#20,$,$,.ELEMENT.,$,$,$,$,$);
#11=IFCBUILDINGSTOREY('0000000000000000000011',$,'Level 1',$,$,#20,$,'Ground',.ELEMENT.,3000.);
#12=IFCRELAGGREGATES('0000000000000000000012',$,$,$,#1,(#10));
#13=IFCRELAGGREGATES('0000000000000000000013',$,$,$,#10,(#11));
#14=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000014',$,$,$,(#100,#200,#300,#301,#400,#500),#11);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#23=IFCDIRECTION((0.,0.,1.));
#30=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#100=IFCWALL('0000000000000000000100',$,'Wall A',$,$,#101,#102,'W-1',$);
#101=IFCLOCALPLACEMENT(#20,#103);
#103=IFCAXIS2PLACEMENT3D(#104,$,$);
#104=IFCCARTESIANPOINT((1000.,0.,0.));
#102=IFCPRODUCTDEFINITIONSHAPE($,$,(#105,#106));
#105=IFCSHAPEREPRESENTATION(#30,'Axis','Curve2D',(#107));
#107=IFCPOLYLINE((#22,#104));
#106=IFCSHAPEREPRESENTATION(#30,'Body','SweptSolid',(#108));
#108=IFCEXTRUDEDAREASOLID(#109,$,#23,2500.);
#109=IFCRECTANGLEPROFILEDEF(.AREA.,$,#110,4000.,200.);
#110=IFCAXIS2PLACEMENT2D(#111,$);
#111=IFCCARTESIANPOINT((2000.,100.));
#120=IFCSTYLEDITEM(#108,(#121),$);
#121=IFCSURFACESTYLE('red',.BOTH.,(#122));
#122=IFCSURFACESTYLERENDERING(#123,0.,$,$,$,$,$,$,.NOTDEFINED.);
#123=IFCCOLOURRGB($,1.,0.,0.);
#130=IFCPROPERTYSET('0000000000000000000130',$,'Pset_WallCommon',$,(#131,#132));
#131=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI 60'),$);
#132=IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#133=IFCRELDEFINESBYPROPERTIES('0000000000000000000133',$,$,$,(#100),#130);
#200=IFCCOLUMN('0000000000000000000200',$,'Col \\X2\\00C4\\X0\\',$,$,#20,#201,$,$);
#201=IFCPRODUCTDEFINITIONSHAPE($,$,(#202));
#202=IFCSHAPEREPRESENTATION(#30,'Body','Clipping',(#203));
#203=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#204,#206);
#204=IFCEXTRUDEDAREASOLID(#205,$,#23,3000.);
#205=IFCCIRCLEPROFILEDEF(.AREA.,$,$,150.);
#206=IFCHALFSPACESOLID(#207,.F.);
#207=IFCPLANE(#208);
#208=IFCAXIS2PLACEMENT3D(#209,#23,$);
#209=IFCCARTESIANPOINT((0.,0.,2000.));
#300=IFCFURNISHINGELEMENT('0000000000000000000300',$,'Chair 1',$,$,#302,#304,$);
#301=IFCFURNISHINGELEMENT('0000000000000000000301',$,'Chair 2',$,$,#303,#305,$);
#302=IFCLOCALPLACEMENT(#20,#306);
#303=IFCLOCALPLACEMENT(#20,#307);
#306=IFCAXIS2PLACEMENT3D(#308,$,$);
#307=IFCAXIS2PLACEMENT3D(#309,$,$);
#308=IFCCARTESIANPOINT((0.,5000.,0.));
#309=IFCCARTESIANPOINT((2000.,5000.,0.));
#304=IFCPRODUCTDEFINITIONSHAPE($,$,(#310));
#305=IFCPRODUCTDEFINITIONSHAPE($,$,(#311));
#310=IFCSHAPEREPRESENTATION(#30,'Body','MappedRepresentation',(#312));
#311=IFCSHAPEREPRESENTATION(#30,'Body','MappedRepresentation',(#313));
#312=IFCMAPPEDITEM(#314,#315);
#313=IFCMAPPEDITEM(#314,#315);
#315=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#22,$,$);
#314=IFCREPRESENTATIONMAP(#21,#316);
#316=IFCSHAPEREPRESENTATION(#30,'Body','Tessellation',(#317));
#317=IFCTRIANGULATEDFACESET(#318,$,.T.,((1,2,3),(1,3,4),(1,2,4),(2,3,4)),$);
#318=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(500.,0.,0.),(0.,500.,0.),(0.,0.,500.)));
#400=IFCMECHANICALFASTENER('0000000000000000000400',$,'Bolt',$,$,#20,#401,$,20.,60.);
#401=IFCPRODUCTDEFINITIONSHAPE($,$,(#402));
#402=IFCSHAPEREPRESENTATION(#30,'Body','SweptSolid',(#403,#404,#405,#406));
#403=IFCEXTRUDEDAREASOLID(#407,#410,#23,60.);
#404=IFCEXTRUDEDAREASOLID(#408,#411,#23,12.);
#405=IFCEXTRUDEDAREASOLID(#408,#412,#23,16.);
#406=IFCEXTRUDEDAREASOLID(#409,#413,#23,3.);
#407=IFCCIRCLEPROFILEDEF(.AREA.,$,$,10.);
#408=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,30.,30.);
#409=IFCCIRCLEPROFILEDEF(.AREA.,$,$,20.);
#410=IFCAXIS2PLACEMENT3D(#420,$,$);
#411=IFCAXIS2PLACEMENT3D(#421,$,$);
#412=IFCAXIS2PLACEMENT3D(#422,$,$);
#413=IFCAXIS2PLACEMENT3D(#423,$,$);
#420=IFCCARTESIANPOINT((9000.,0.,0.));
#421=IFCCARTESIANPOINT((9000.,0.,-12.));
#422=IFCCARTESIANPOINT((9000.,0.,50.));
#423=IFCCARTESIANPOINT((9000.,0.,47.));
#500=IFCPLATE('0000000000000000000500',$,'Plate',$,$,#20,#501,$,$);
#501=IFCPRODUCTDEFINITIONSHAPE($,$,(#502));
#502=IFCSHAPEREPRESENTATION(#30,'Body','CSG',(#503));
#503=IFCBOOLEANRESULT(.DIFFERENCE.,#504,#506);
#504=IFCEXTRUDEDAREASOLID(#505,#510,#23,10.);
#505=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,100.,100.);
#510=IFCAXIS2PLACEMENT3D(#511,$,$);
#511=IFCCARTESIANPOINT((0.,-9000.,0.));
#506=IFCEXTRUDEDAREASOLID(#507,#512,#23,30.);
#507=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,20.,20.);
#512=IFCAXIS2PLACEMENT3D(#513,$,$);
#513=IFCCARTESIANPOINT((0.,-9000.,-10.));
ENDSEC;
END-ISO-10303-21;
`;

async function load(options: Record<string, unknown> = {}) {
  const r = new LoaderRegistry();
  r.register(ifcLoader);
  const v = createMockViewer({ keepData: true });
  const m = await loadModel(v, new TextEncoder().encode(IFC), { registry: r, name: 'test.ifc', up: 'z', options });
  return { v, m };
}

const near = (a: ArrayLike<number>, b: number[], eps = 1e-6) => b.every((x, i) => Math.abs(a[i] - x) < eps);

describe('IFC loader', () => {
  it('is detected by extension and by content', () => {
    expect(ifcLoader.canLoad!({ header: new TextEncoder().encode('ISO-10303-21;\nHEADER;') })).toBe(true);
    expect(ifcLoader.canLoad!({ header: new TextEncoder().encode('glTF') })).toBe(false);
  });

  it('builds the spatial tree with attributes and property sets', async () => {
    const { m } = await load();
    expect(m.warnings).toEqual([]);
    expect(m.info).toMatchObject({ format: 'IFC', schema: 'IFC4', lengthUnit: 'MILLIMETRE', application: 'UnitTest' });
    const h = m.hierarchy;
    const root = h.roots()[0];
    expect(h.name(root)).toBe('Proj');
    expect(h.properties(root)).toMatchObject({ Class: 'IfcProject', LongName: 'Project long' });
    const site = h.children(root)[0];
    const storey = h.children(site)[0];
    expect(h.name(storey)).toBe('Level 1');
    expect(h.properties(storey)).toMatchObject({ Class: 'IfcBuildingStorey', LongName: 'Ground', Elevation: 3000 });
    const names = Array.from(h.children(storey), (n) => h.name(n));
    expect(names).toEqual(['Wall A', 'Col Ä', 'Chair 1', 'Chair 2', 'Bolt', 'Plate']);
    const wall = h.children(storey)[0];
    expect(h.properties(wall)).toEqual({
      Class: 'IfcWall',
      GlobalId: '0000000000000000000100',
      Name: 'Wall A',
      Tag: 'W-1',
      Pset_WallCommon: { FireRating: 'REI 60', IsExternal: true },
    });
    expect(m.properties.find({ key: 'Pset_WallCommon.FireRating', equals: 'REI 60' }).objectIds).toEqual(Float64Array.from([h.objectId(wall)]));
  });

  it('converts millimetres to metres, uses the body representation and the surface style', async () => {
    const { v, m } = await load();
    const h = m.hierarchy;
    const wall = h.children(h.children(h.children(h.roots()[0])[0])[0])[0];
    const mesh = v.meshes.find((x) => x.objectId === h.objectId(wall))!;
    // 4 m x 0.2 m x 2.5 m box at x = 1 m: one box = 12 triangles (the Axis polyline is not drawn)
    expect(v.geometries[mesh.geometry].triangles).toBe(12);
    expect(v.materials[mesh.material].color).toEqual([1, 0, 0, 1]);
    const g = v.geometries[mesh.geometry];
    let minx = Infinity, maxx = -Infinity, maxz = -Infinity;
    for (let i = 0; i < g.positions!.length; i += 3) {
      const x = g.positions![i] + mesh.transform[12];
      minx = Math.min(minx, x);
      maxx = Math.max(maxx, x);
      maxz = Math.max(maxz, g.positions![i + 2] + mesh.transform[14]);
    }
    expect(minx).toBeCloseTo(1, 6);
    expect(maxx).toBeCloseTo(5, 6);
    expect(maxz).toBeCloseTo(2.5, 6);
  });

  it('clips with half spaces and places mapped items as instances of one geometry', async () => {
    const { v, m } = await load();
    const h = m.hierarchy;
    const storey = h.children(h.children(h.roots()[0])[0])[0];
    const [, col, chair1, chair2] = h.children(storey);
    // the column (3 m) is clipped at 2 m and capped
    const cm = v.meshes.find((x) => x.objectId === h.objectId(col))!;
    const cg = v.geometries[cm.geometry];
    let top = -Infinity;
    for (let i = 2; i < cg.positions!.length; i += 3) top = Math.max(top, cg.positions![i] + cm.transform[14]);
    expect(top).toBeCloseTo(2, 6);
    // both chairs reuse one geometry, added with one addMeshes call
    const a = v.meshes.find((x) => x.objectId === h.objectId(chair1))!;
    const b = v.meshes.find((x) => x.objectId === h.objectId(chair2))!;
    expect(a.geometry).toBe(b.geometry);
    expect(b.transform[12] - a.transform[12]).toBeCloseTo(2, 6);
  });

  it('simplifies bolts to a hexagonal head, shank and nut of one shared geometry', async () => {
    const { v, m } = await load();
    const h = m.hierarchy;
    const bolt = Array.from(h.children(h.children(h.children(h.roots()[0])[0])[0])).find((n) => h.name(n) === 'Bolt')!;
    const parts = v.meshes.filter((x) => x.objectId === h.objectId(bolt));
    expect(parts.length).toBe(3); // the washer is left out
    expect(new Set(parts.map((p) => p.geometry)).size).toBe(1);
    expect(v.geometries[parts[0].geometry].triangles).toBe(20);
    // the shank: radius 10 mm (scale of x), length 60 mm (scale of z) at x = 9 m; the matrix scales
    // in file units because the shared geometry is already in metres
    const shank = parts.find((p) => Math.abs(Math.hypot(p.transform[8], p.transform[9], p.transform[10]) - 60) < 1e-9)!;
    expect(Math.hypot(shank.transform[0], shank.transform[1], shank.transform[2])).toBeCloseTo(10, 9);
    expect(shank.transform[12]).toBeCloseTo(9, 6);
    // detailed when asked
    const { v: v2, m: m2 } = await load({ simplifyBolts: false });
    const id2 = m2.hierarchy.objectId(Array.from({ length: m2.hierarchy.nodeCount }, (_, i) => i).find((n) => m2.hierarchy.name(n) === 'Bolt')!);
    expect(v2.meshes.filter((x) => x.objectId === id2).length).toBe(1);
  });

  it('subtracts solids only when solidCuts is on', async () => {
    const plateTris = async (solidCuts: boolean) => {
      const { v, m } = await load({ solidCuts });
      const h = m.hierarchy;
      const n = Array.from({ length: h.nodeCount }, (_, i) => i).find((i) => h.name(i) === 'Plate')!;
      return v.geometries[v.meshes.find((x) => x.objectId === h.objectId(n))!.geometry];
    };
    expect((await plateTris(false)).triangles).toBe(12);
    const cut = await plateTris(true);
    expect(cut.triangles).toBeGreaterThan(12);
    // the hole's walls face into the hole: no vertex of the cut solid lies strictly inside it
    for (let i = 0; i < cut.positions!.length; i += 3) {
      // positions are recentred on the plate's centre, which is the hole's centre
      const x = cut.positions![i], y = cut.positions![i + 1];
      expect(Math.abs(x) < 0.01 - 1e-6 && Math.abs(y) < 0.01 - 1e-6).toBe(false);
    }
  });
});

describe('IFC building blocks', () => {
  it('reads STEP records lazily and decodes strings', () => {
    const s = new StepFile(new TextEncoder().encode(IFC));
    while (!s.scan(7));
    expect(s.schema).toBe('IFC4');
    expect(s.type(108)).toBe('IFCEXTRUDEDAREASOLID');
    expect(s.idsOf('IFCCARTESIANPOINT').length).toBe(12);
    const pts = { a: new Float64Array(1) };
    const n = s.numbers(318, 0, pts); // may grow pts.a
    expect(Array.from(pts.a.subarray(0, n))).toEqual([0, 0, 0, 500, 0, 0, 0, 500, 0, 0, 0, 500]);
    expect(decodeStepString("it''s \\X2\\00C400D6\\X0\\ \\X\\E9")).toBe("it's ÄÖ é");
  });

  it('triangulates polygons with holes', () => {
    const square = [0, 0, 10, 0, 10, 10, 0, 10, 3, 3, 3, 7, 7, 7, 7, 3];
    const tris = triangulate(square, [4]);
    expect(tris.length / 3).toBe(8);
    let area = 0;
    for (let i = 0; i < tris.length; i += 3) {
      const [a, b, c] = [tris[i] * 2, tris[i + 1] * 2, tris[i + 2] * 2];
      area += Math.abs((square[b] - square[a]) * (square[c + 1] - square[a + 1]) - (square[c] - square[a]) * (square[b + 1] - square[a + 1])) / 2;
    }
    expect(area).toBeCloseTo(84, 9);
  });

  it('clips a closed mesh and caps the cut', () => {
    const m = new TriMesh();
    // unit cube, outward faces
    const f = (pts: number[], n: number[]) => m.polygon([pts], n[0], n[1], n[2]);
    f([0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0], [0, 0, -1]);
    f([0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1], [0, 0, 1]);
    f([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1], [0, -1, 0]);
    f([0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0], [0, 1, 0]);
    f([0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0], [-1, 0, 0]);
    f([1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1], [1, 0, 0]);
    m.clip(0, 0, 1, 0.5, new TriMesh());
    const b = m.bounds()!;
    expect(near(b, [0, 0, 0, 1, 1, 0.5])).toBe(true);
    // closed again: the cap covers the cut, facing +z
    let capArea = 0;
    for (let i = 0; i < m.ni; i += 3) {
      const [a, b, c] = [m.idx[i] * 3, m.idx[i + 1] * 3, m.idx[i + 2] * 3];
      if (m.pos[a + 2] !== 0.5 || m.pos[b + 2] !== 0.5 || m.pos[c + 2] !== 0.5) continue;
      capArea += ((m.pos[b] - m.pos[a]) * (m.pos[c + 1] - m.pos[a + 1]) - (m.pos[c] - m.pos[a]) * (m.pos[b + 1] - m.pos[a + 1])) / 2;
    }
    expect(capArea).toBeCloseTo(1, 9);
  });
});
