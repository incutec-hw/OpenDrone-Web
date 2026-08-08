// Onshape assembly GLB -> per-group web GLBs for the hero scene.
//
// The Onshape export is the single source of truth for POSITION. Geometry for
// the PCBs is not taken from it: a STEP round-trip through Onshape fragments
// each board into hundreds of occurrences and still loses nothing we want that
// kicad-cli can't produce better (see export-boards.mjs). So each board is
// located here, measured, culled, and its placement written out so the KiCad
// GLB can be dropped in at exactly the same spot.
//
// Usage:
//   node --max-old-space-size=8192 build-hero.mjs <onshape.glb> <outdir>

import {makeIO} from './io.mjs';
import {dedup, weld, prune, meshopt, simplify, instance, quantize, reorder, palette, cloneDocument,
  joinPrimitives} from '@gltf-transform/functions';
import {MeshoptEncoder, MeshoptSimplifier} from 'meshoptimizer';
import {statSync, writeFileSync, mkdirSync} from 'node:fs';
import {join as pjoin} from 'node:path';

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;

const SRC = process.argv[2];
const OUT = process.argv[3];
if (!SRC || !OUT) { console.error('usage: build-hero.mjs <onshape.glb> <outdir>'); process.exit(1); }
mkdirSync(OUT, {recursive: true});

// ---- mat4 (column-major), matching build.mjs ----
function compose(t, r, s) {
  const [x,y,z,w] = r;
  const x2=x+x,y2=y+y,z2=z+z, xx=x*x2,xy=x*y2,xz=x*z2, yy=y*y2,yz=y*z2,zz=z*z2, wx=w*x2,wy=w*y2,wz=w*z2;
  const [sx,sy,sz] = s;
  return [(1-(yy+zz))*sx,(xy+wz)*sx,(xz-wy)*sx,0, (xy-wz)*sy,(1-(xx+zz))*sy,(yz+wx)*sy,0,
          (xz+wy)*sz,(yz-wx)*sz,(1-(xx+yy))*sz,0, t[0],t[1],t[2],1];
}
function mul(a,b){const o=new Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++){let v=0;for(let k=0;k<4;k++)v+=a[k*4+r]*b[c*4+k];o[c*4+r]=v;}return o;}
const tp=(m,[x,y,z])=>[m[0]*x+m[4]*y+m[8]*z+m[12], m[1]*x+m[5]*y+m[9]*z+m[13], m[2]*x+m[6]*y+m[10]*z+m[14]];
const local = (n) => compose(n.getTranslation(), n.getRotation(), n.getScale());

function subtree(node, M, acc) {
  const W = mul(M, local(node));
  const mesh = node.getMesh();
  if (mesh) for (const p of mesh.listPrimitives()) {
    const pos = p.getAttribute('POSITION'); if (!pos) continue;
    acc.verts += pos.getCount();
    const lo = pos.getMin([]), hi = pos.getMax([]);
    for (let xi=0;xi<2;xi++) for (let yi=0;yi<2;yi++) for (let zi=0;zi<2;zi++) {
      const q = tp(W, [xi?hi[0]:lo[0], yi?hi[1]:lo[1], zi?hi[2]:lo[2]]);
      for (let i=0;i<3;i++){ acc.min[i]=Math.min(acc.min[i],q[i]); acc.max[i]=Math.max(acc.max[i],q[i]); }
    }
  }
  for (const c of node.listChildren()) subtree(c, W, acc);
  return acc;
}
const fresh = () => ({min:[Infinity,Infinity,Infinity], max:[-Infinity,-Infinity,-Infinity], verts:0});
const centre = (b) => b.min.map((v,i)=>(v+b.max[i])/2);
const dims = (b) => b.min.map((v,i)=>b.max[i]-v);

// Board substrate fragments carry the KiCad board name as a prefix. Their union
// gives each board's true placement and extent in assembly space.
const SUBSTRATE = /^(.+?)_(pad|soldermask|silkscreen|PCB)\b/;
// Fasteners and mounting hardware: real in CAD, sub-pixel on screen.
const HARDWARE = /(screw|pressnut|press nut|washer|\bnut\b|softmount|standoff|hexalobular|hex socket|hex drive)/i;
// The structural frame. These must stay individually addressable: the exploded
// view translates each one by name. Exact match on the whole name, not a prefix:
// Onshape drops the "<1>" instance suffixes on export, so all four arms are
// simply "Arm", and a prefix match on "Top" would swallow "Top Casing" too:
// the DJI air-unit shell, 716k verts, 28% of the whole assembly by itself.
const FRAME = /^(Arm|Cross|Base-Top|Base-Bot|Top)$/i;

const io = await makeIO();
console.log(`reading ${SRC} (${(statSync(SRC).size/1024/1024).toFixed(1)} MB)`);
const doc = await io.read(SRC);
// Onshape ships some exports Draco-compressed. io.read decodes it, but the
// extension declaration lingers and makes three demand a DRACOLoader at
// runtime; we re-encode with meshopt, so drop it.
for (const ext of doc.getRoot().listExtensionsUsed())
  if (ext.extensionName === 'KHR_draco_mesh_compression') ext.dispose();

const root = doc.getRoot();
const scene = root.listScenes()[0];
const assembly = scene.listChildren()[0];
const Masm = local(assembly);
const occs = assembly.listChildren();
console.log(`assembly "${assembly.getName()}" -> ${occs.length} occurrences`);

const info = occs.map((occ) => {
  const name = (occ.getName() || '?').replace(/^occurrence of /, '');
  const bb = subtree(occ, Masm, fresh());
  return {occ, name, bb, c: Number.isFinite(bb.min[0]) ? centre(bb) : null, verts: bb.verts};
});

// Pass 1: locate each board. Prefer the board-body fragment (`<name>_PCB`),
// which is exactly the edge-cuts outline. Silkscreen and pads can overhang the
// rim by a couple of millimetres, so unioning every substrate fragment inflates
// the box and then disagrees with the same measurement taken on the KiCad side.
const boards = new Map();
const bodyOnly = new Set();
for (const o of info) {
  const m = SUBSTRATE.exec(o.name);
  if (!m || !o.c) continue;
  const key = m[1];
  const isBody = m[2] === 'PCB';
  if (isBody && !bodyOnly.has(key)) { boards.set(key, fresh()); bodyOnly.add(key); }
  if (bodyOnly.has(key) && !isBody) continue;
  if (!boards.has(key)) boards.set(key, fresh());
  const b = boards.get(key);
  for (let i=0;i<3;i++){ b.min[i]=Math.min(b.min[i],o.bb.min[i]); b.max[i]=Math.max(b.max[i],o.bb.max[i]); }
}
for (const k of boards.keys())
  if (!bodyOnly.has(k)) console.log(`  note: ${k} has no _PCB body fragment; using all substrate (outline may read large)`);
console.log(`\nBOARDS FOUND (from substrate fragments)`);
const placement = {};
for (const [k, b] of boards) {
  const c = centre(b), d = dims(b);
  placement[k] = {
    centre_m: c.map(v=>+v.toFixed(6)),
    size_mm: d.map(v=>+(v*1000).toFixed(2)),
  };
  console.log(`  ${k.padEnd(18)} centre=[${c.map(v=>v.toFixed(4)).join(', ')}] m   extent=${d.map(v=>(v*1000).toFixed(2)).join(' x ')} mm`);
}

// Pass 2: classify. A footprint-named occurrence sitting inside a board's
// expanded box belongs to that board (they are its SMD components).
const pad = 0.002; // 2 mm tolerance around each board box
const inBoard = (c) => {
  for (const [k, b] of boards) {
    if (c.every((v,i) => v >= b.min[i]-pad && v <= b.max[i]+pad)) return k;
  }
  return null;
};

// --all keeps the entire Onshape assembly: boards, screws, standoffs, camera
// mounts, everything. The owner cleaned the PCB artwork and fixed the board
// orientation in Onshape, so that export is now the single source of geometry
// AND placement, and nothing is substituted from KiCad. Only the strays with
// broken 3D-model offsets are still removed, because they sit a metre away.
const KEEP_ALL = process.argv.includes('--all');

// --split emits the same complete assembly as --all, but as several files the
// runtime can stream in order instead of one 6 MB stall. Nothing is dropped:
// every occurrence lands in exactly one chunk, and the runtime reparents them
// all under one occurrence root, so the scene sees the same tree either way.
//
// Order is chosen so the silhouette appears first and the reader watches the
// drone assemble while the rest arrives. The airframe is the cheapest and the
// most recognisable; the DJI air-unit shell is 28% of the assembly's vertices
// on its own, so it goes last.
const SPLIT = process.argv.includes('--split');
// Matched against the occurrence name with the "occurrence of " prefix already
// stripped. Kept in sync with public/models/<design>/studio.json by hand: these
// decide which file a part ships in, that file decides how it is lit.
const CHUNK_MATCH = {
  video: /^(Top Casing|Bottom Casing|DJI|VTX-Mount|USB C|Body|Lens|BM6B)/i,
  drive: /^(Admi|softmount|[0-9]+$)/i,
};
// Each PCB is its own chunk. Together they are ~70% of the download (2048
// occurrences of SMD parts), so one "electronics" chunk would be a single long
// stall with nothing happening; one per board lets each appear as it lands, and
// it lines up with the three board beats the walkthrough opens on.
const chunkOf = (o) => {
  if (CHUNK_MATCH.video.test(o.name)) return 'video';
  if (CHUNK_MATCH.drive.test(o.name)) return 'drive';
  const sub = SUBSTRATE.exec(o.name);
  if (sub) return `board-${sub[1]}`;
  // SMD parts carry footprint names, not a board prefix, so they are found by
  // position instead. Hardware is excluded: a stack screw passes through the
  // board plane but belongs to the airframe.
  if (!HARDWARE.test(o.name)) {
    const b = inBoard(o.c);
    if (b) return `board-${b}`;
  }
  return 'frame';
};
const CHUNK_LABEL = {
  frame: 'airframe',
  drive: 'motors and props',
  video: 'video system',
};
// Cheap and recognisable first: the airframe alone reads as a drone, so the
// reader watches it fill in rather than watching a spinner. The DJI air-unit
// shell is 20% of the bytes by itself and goes last.
const chunkRank = (id) =>
  id === 'frame' ? 0 : id === 'drive' ? 1 : id.startsWith('board-') ? 2 : 3;

const groups = SPLIT
  ? {}   // filled below, once every occurrence has been classified
  : KEEP_ALL
    ? {drone: []}
    : {frame: [], payload: []};
const culled = {board: 0, hardware: 0, far: 0};
const culledVerts = {board: 0, hardware: 0, far: 0};
// The Onshape export carries its own outliers (construction geometry, stray
// imports). A 3-inch airframe is ~0.14 m corner to corner, so anything whose
// centre is past 0.25 m of the origin is not part of the drone.
const FAR_RADIUS = 0.25;
for (const o of info) {
  if (!o.c) continue;
  if (Math.hypot(o.c[0], o.c[1], o.c[2]) > FAR_RADIUS) {
    culled.far++; culledVerts.far += o.verts;
    console.log(`  far: "${o.name}" at ${Math.hypot(o.c[0],o.c[1],o.c[2]).toFixed(2)} m -> culled`);
    continue;
  }
  if (SPLIT) {
    const k = chunkOf(o);
    (groups[k] ??= []).push(o);
    continue;
  }
  if (KEEP_ALL) { groups.drone.push(o); continue; }
  if (SUBSTRATE.test(o.name) || inBoard(o.c)) { culled.board++; culledVerts.board += o.verts; continue; }
  if (HARDWARE.test(o.name)) { culled.hardware++; culledVerts.hardware += o.verts; continue; }
  groups[FRAME.test(o.name) ? 'frame' : 'payload'].push(o);
}

// Emit in load order, so chunks.json needs no sort of its own and the build log
// reads the way the browser will fetch them.
if (SPLIT) {
  const sorted = Object.keys(groups).sort((a, b) => chunkRank(a) - chunkRank(b) || a.localeCompare(b));
  const reordered = {};
  for (const k of sorted) reordered[k] = groups[k];
  for (const k of Object.keys(groups)) delete groups[k];
  Object.assign(groups, reordered);
}

const totalV = info.reduce((s,o)=>s+o.verts, 0);
console.log(`\nCLASSIFICATION  (total ${totalV.toLocaleString()} verts)`);
for (const [k,v] of Object.entries(culled))
  console.log(`  cull ${k.padEnd(9)} ${String(v).padStart(5)} occ  ${culledVerts[k].toLocaleString().padStart(10)} verts  ${(100*culledVerts[k]/totalV).toFixed(1)}%`);
for (const [k,v] of Object.entries(groups))
  console.log(`  keep ${k.padEnd(9)} ${String(v.length).padStart(5)} occ  ${v.reduce((s,o)=>s+o.verts,0).toLocaleString().padStart(10)} verts`);

writeFileSync(pjoin(OUT, 'placement.json'), JSON.stringify(placement, null, 2));
console.log(`\nwrote ${pjoin(OUT, 'placement.json')}`);

// Pass 3: emit one GLB per kept group.
//
// Deliberately NO flatten()/join(). Those bake node transforms into geometry,
// which would turn the four identical arms (and four motors, four props) into
// four separate copies of the same vertices. dedup() does the opposite: it
// collapses identical meshes so N placements share ONE mesh and cost only a
// node transform each. That is the single biggest bandwidth win on a symmetric
// airframe, and it keeps every part individually addressable by name so the
// exploded view and the spinning props can still move them.
//
// EXT_mesh_gpu_instancing (via instance()) would additionally collapse those N
// nodes into one draw call, but it makes per-part animation harder. Enable with
// --instance to measure the tradeoff.
const WANT_INSTANCE = process.argv.includes('--instance');
const argNum = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? dflt : parseFloat(process.argv[i + 1]);
};
const RATIO = argNum('--ratio', 0.4);
const ERROR = argNum('--error', 0.005);
const keepIds = new Map();
for (const [gname, members] of Object.entries(groups))
  for (const o of members) keepIds.set(o.occ, gname);

const emitted = [];
for (const [gname, members] of Object.entries(groups)) {
  if (!members.length) continue;
  const clone = cloneDocument(doc);
  const cRoot = clone.getRoot();
  const cScene = cRoot.listScenes()[0];
  const cAsm = cScene.listChildren()[0];

  // cloneDocument preserves child order, so select this group's occurrences by
  // index rather than by identity (clone nodes are different objects).
  const wanted = new Set(members.map((m) => occs.indexOf(m.occ)));
  const cOccs = cAsm.listChildren();
  cOccs.forEach((n, i) => { if (!wanted.has(i)) disposeTree(n); });

  await clone.transform(prune({keepAttributes: false}));
  const merged = mergePrimitives(clone);
  // The dedicated 'frame' group is left un-decimated because it is already
  // tiny. The whole-assembly 'drone' group must be decimated (2.5M verts) but
  // gently: silkscreen legend and pad edges are the first thing to smear, and
  // those are exactly what the boards are here to show.
  // In --split mode 'frame' is one chunk of the whole assembly, not the old
  // slimmed-down frame group, so it gets decimated like everything else.
  const isFrameLike = !SPLIT && gname === 'frame';
  // No floor here. An earlier guard clamped the whole-assembly ratio to 0.5,
  // which silently ignored anything lower passed on the command line.
  const ratio = RATIO;
  const error = ERROR;
  const ops = [
    weld({tolerance: 0.0001}),
    dedup(),                                   // <- N placements, ONE mesh
  ];
  if (!isFrameLike) {
    // Payload is scenery: motors, props, camera, VTX, mounts. Halve it.
    // ratio is a floor, error is the real governor: meshoptimizer stops early
    // on parts that cannot decimate further without exceeding the deviation
    // bound. So a low ratio collapses the dense DJI casing hard while leaving
    // an already-simple carbon plate essentially untouched.
    ops.push(simplify({simplifier: MeshoptSimplifier, ratio, error}), dedup());
  }
  if (WANT_INSTANCE) ops.push(instance({min: 2}));
  // palette() folds flat colours into a texture atlas to cut draw calls, but it
  // adds a UV pair to every vertex. On CAD geometry (many verts, few colours)
  // that can cost more bytes than the materials it saves, so it is opt-in.
  if (process.argv.includes('--palette')) ops.push(palette({min: 5}));
  ops.push(
    reorder({encoder: MeshoptEncoder}),        // vertex-cache order
    quantize({quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12}),
  );
  await clone.transform(...ops);
  await clone.transform(meshopt({encoder: MeshoptEncoder, level: 'high'}));

  const out = pjoin(OUT, `${gname}${WANT_INSTANCE ? '-inst' : ''}.glb`);
  console.log(`  ${gname}: primitives ${merged.before} -> ${merged.after}`);
  await io.write(out, clone);
  let verts = 0, nodes = 0, meshes = cRoot.listMeshes().length;
  for (const m of cRoot.listMeshes()) for (const p of m.listPrimitives()) verts += p.getAttribute('POSITION')?.getCount() ?? 0;
  const countNodes = (n) => { nodes++; n.listChildren().forEach(countNodes); };
  cRoot.listScenes().forEach((s) => s.listChildren().forEach(countNodes));
  console.log(`  -> ${out.split('/').pop().padEnd(16)} ${(statSync(out).size/1024).toFixed(0).padStart(6)} KB  ${verts.toLocaleString().padStart(9)} verts  ${meshes} meshes / ${nodes} nodes`);
  emitted.push({id: gname, file: out.split('/').pop(), bytes: statSync(out).size, verts});
}

// The runtime needs the byte weights to show honest progress across several
// files: without them a four-chunk load reports 25% steps, and the last chunk
// (the DJI shell) is half the download on its own. Written only for --split,
// and its absence is what tells the scene to load the single-file model.
if (SPLIT) {
  const manifest = {
    _note: 'Written by build-hero.mjs --split. Array order is load order: the runtime shows each chunk as it lands.',
    chunks: emitted.map((e) => ({
      id: e.id,
      // Board chunks are labelled from the KiCad board name in the occurrence
      // prefix, which is what studio.json's `boards` list uses too.
      label: CHUNK_LABEL[e.id] ?? e.id.replace(/^board-/, ''),
      file: e.file,
      bytes: e.bytes,
      verts: e.verts,
    })),
  };
  writeFileSync(pjoin(OUT, 'chunks.json'), JSON.stringify(manifest, null, 2));
  const total = manifest.chunks.reduce((s, c) => s + c.bytes, 0);
  console.log(`\nwrote chunks.json  ${manifest.chunks.length} chunks, ${(total / 1024 / 1024).toFixed(2)} MB total`);
  for (const c of manifest.chunks)
    console.log(`  ${c.id.padEnd(8)} ${(c.bytes / 1024).toFixed(0).padStart(6)} KB  ${((100 * c.bytes) / total).toFixed(0).padStart(3)}%  ${c.label}`);
}

// Onshape emits one primitive per B-rep face: a single payload mesh arrived
// with 3340 primitives spanning just 2 materials. Every primitive costs an
// accessor plus a bufferView in the JSON chunk, which is why the payload was
// ~9.8 MB of JSON wrapped around ~1.9 MB of real vertex data. Merging them per
// material WITHIN each mesh fixes that while leaving the mesh/node graph alone,
// so shared meshes and per-part names both survive. join() would also fix it,
// but only by flattening the node graph and duplicating the shared arm mesh.
function mergePrimitives(doc) {
  let before = 0, after = 0;
  const mats = doc.getRoot().listMaterials();
  for (const mesh of doc.getRoot().listMeshes()) {
    const prims = mesh.listPrimitives();
    before += prims.length;
    const groups = new Map();
    for (const p of prims) {
      // Key on everything joinPrimitives validates: material, draw mode, the
      // exact attribute set, and whether indices are present.
      const key = [
        mats.indexOf(p.getMaterial()),
        p.getMode(),
        p.listSemantics().sort().join(','),
        p.getIndices() ? 'idx' : 'noidx',
      ].join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      try {
        const joined = joinPrimitives(group);
        for (const p of group) { mesh.removePrimitive(p); p.dispose(); }
        mesh.addPrimitive(joined);
      } catch {
        // Incompatible despite the key; leave this group untouched.
      }
    }
    after += mesh.listPrimitives().length;
  }
  return {before, after};
}

function disposeTree(node) {
  for (const c of [...node.listChildren()]) disposeTree(c);
  node.dispose();
}
