// Build web-ready board GLBs straight from KiCad, bypassing Onshape.
//
// Why this exists: routing a PCB through Onshape loses silkscreen, soldermask
// and per-material colour (STEP carries none of it), which is why the older
// Onshape-sourced fc*/esc*.glb render as flat grey-green with no legend.
// kicad-cli emits all of it, and smaller, once traces and via holes are dropped.
//
// Export flags, and why:
//   --include-pads          exposed copper (recoloured to ENIG gold below)
//   --include-silkscreen    the legend
//   --include-soldermask    green surface with cutouts around pads and text
//   --fill-all-vias         do NOT cut via holes in the copper layer
//   --no-dnp --no-unspecified   never render unpopulated parts
// Deliberately omitted: --include-tracks (41 MB vs 6.9 MB, invisible under
// mask), --include-zones, --include-inner-copper, --cut-vias-in-body.
//
// Usage:
//   node export-boards.mjs <board.kicad_pcb> <out.glb> [--ratio 0.5] [--keep-vias]

import {makeIO} from './io.mjs';
import {dedup, weld, prune, meshopt, flatten, join, simplify} from '@gltf-transform/functions';
import {MeshoptEncoder, MeshoptSimplifier} from 'meshoptimizer';
import {execFileSync} from 'node:child_process';
import {statSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join as pjoin} from 'node:path';

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;

const KICAD_CLI = process.env.KICAD_CLI
  ?? '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli';

// ENIG gold. KiCad exports pads as 0.5 grey, which reads as bare tin.
const GOLD = [0.90, 0.72, 0.36, 1.0];
const GOLD_METALLIC = 1.0;
const GOLD_ROUGHNESS = 0.30;

// Meshes whose materials belong to the bare board rather than a component.
// KiCad names them "<boardname>_pad" / "_silkscreen" / "_soldermask" / "_PCB".
const BOARD_MESH = /_(pad|silkscreen|soldermask|PCB)$/;
const PAD_MESH = /_pad$/;

// World-space bbox of the BARE BOARD, walking node transforms. kicad-cli emits
// glTF in metres, so this returns metres.
//
// Substrate meshes only (_PCB/_soldermask/_silkscreen/_pad). Component models
// are excluded on purpose: several boards carry footprints whose 3D model has a
// bogus offset baked in by easyeda2kicad (OpenFC-Lite-Mini D10/D3 and
// OpenRX-Mono U4 sit ~1.2 m off), which would blow up the bounding box. Those
// strays are culled separately below; this measurement must not see them.
//
// Must run before meshopt(), which quantizes each mesh into its own unit cube
// with the real scale parked on that mesh's node.
// Board BODY only. Silkscreen legend and pads can overhang the edge cuts by a
// couple of millimetres (reference designators near the rim), which inflates
// the outline and breaks the cross-check against Onshape.
const SUBSTRATE_MESH = /_PCB$/;
function measureMM(doc) {
  const compose = (t, r, sc) => {
    const [x,y,z,w] = r;
    const x2=x+x,y2=y+y,z2=z+z, xx=x*x2,xy=x*y2,xz=x*z2, yy=y*y2,yz=y*z2,zz=z*z2, wx=w*x2,wy=w*y2,wz=w*z2;
    const [sx,sy,sz] = sc;
    return [(1-(yy+zz))*sx,(xy+wz)*sx,(xz-wy)*sx,0, (xy-wz)*sy,(1-(xx+zz))*sy,(yz+wx)*sy,0,
            (xz+wy)*sz,(yz-wx)*sz,(1-(xx+yy))*sz,0, t[0],t[1],t[2],1];
  };
  const mul = (a,b) => { const o=new Array(16);
    for(let c=0;c<4;c++)for(let r=0;r<4;r++){let v=0;for(let k=0;k<4;k++)v+=a[k*4+r]*b[c*4+k];o[c*4+r]=v;} return o; };
  const tp = (m,[x,y,z]) => [m[0]*x+m[4]*y+m[8]*z+m[12], m[1]*x+m[5]*y+m[9]*z+m[13], m[2]*x+m[6]*y+m[10]*z+m[14]];
  const I4 = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity];
  const walk = (node, M) => {
    const W = mul(M, compose(node.getTranslation(), node.getRotation(), node.getScale()));
    const mesh = node.getMesh();
    if (mesh && SUBSTRATE_MESH.test(mesh.getName() ?? '')) for (const p of mesh.listPrimitives()) {
      const pos = p.getAttribute('POSITION'); if (!pos) continue;
      const lo = pos.getMin([]), hi = pos.getMax([]);
      for (let xi=0;xi<2;xi++) for (let yi=0;yi<2;yi++) for (let zi=0;zi<2;zi++) {
        const q = tp(W, [xi?hi[0]:lo[0], yi?hi[1]:lo[1], zi?hi[2]:lo[2]]);
        for (let i=0;i<3;i++){ min[i]=Math.min(min[i],q[i]); max[i]=Math.max(max[i],q[i]); }
      }
    }
    for (const c of node.listChildren()) walk(c, W);
  };
  for (const sc of doc.getRoot().listScenes()) for (const n of sc.listChildren()) walk(n, I4);
  return {
    centre_m: min.map((v,i) => +((v + max[i]) / 2).toFixed(6)),
    size_mm:  min.map((v,i) => +((max[i] - v) * 1000).toFixed(2)),
  };
}

// Remove nodes whose geometry sits beyond `radius` metres of the origin,
// measured in world space over the whole tree.
function cullFarNodes(doc, radius) {
  const compose = (t, r, sc) => {
    const [x,y,z,w] = r;
    const x2=x+x,y2=y+y,z2=z+z, xx=x*x2,xy=x*y2,xz=x*z2, yy=y*y2,yz=y*z2,zz=z*z2, wx=w*x2,wy=w*y2,wz=w*z2;
    const [sx,sy,sz] = sc;
    return [(1-(yy+zz))*sx,(xy+wz)*sx,(xz-wy)*sx,0, (xy-wz)*sy,(1-(xx+zz))*sy,(yz+wx)*sy,0,
            (xz+wy)*sz,(yz-wx)*sz,(1-(xx+yy))*sz,0, t[0],t[1],t[2],1];
  };
  const mul = (a,b) => { const o=new Array(16);
    for(let c=0;c<4;c++)for(let r=0;r<4;r++){let v=0;for(let k=0;k<4;k++)v+=a[k*4+r]*b[c*4+k];o[c*4+r]=v;} return o; };
  const I4 = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const doomed = [];
  const visit = (node, M) => {
    const W = mul(M, compose(node.getTranslation(), node.getRotation(), node.getScale()));
    const dist = Math.hypot(W[12], W[13], W[14]);
    if (node.getMesh() && dist > radius) {
      doomed.push({node, name: node.getName() || node.getMesh().getName() || '?', dist});
      return; // whole subtree goes
    }
    for (const c of node.listChildren()) visit(c, W);
  };
  for (const sc of doc.getRoot().listScenes()) for (const n of [...sc.listChildren()]) visit(n, I4);
  const seen = new Set();
  const out = [];
  for (const d of doomed) {
    if (seen.has(d.name)) continue;
    seen.add(d.name);
    out.push(d);
  }
  for (const d of doomed) disposeSubtree(d.node);
  return out;
}

function disposeSubtree(node) {
  for (const c of [...node.listChildren()]) disposeSubtree(c);
  node.dispose();
}

const argv = process.argv.slice(2);
const src = argv[0];
const out = argv[1];
if (!src || !out) {
  console.error('usage: node export-boards.mjs <board.kicad_pcb> <out.glb> [--ratio N] [--keep-vias]');
  process.exit(1);
}
const ratioArg = argv.indexOf('--ratio');
const ratio = ratioArg === -1 ? 1 : parseFloat(argv[ratioArg + 1]);
const keepVias = argv.includes('--keep-vias');

const tmp = mkdtempSync(pjoin(tmpdir(), 'kicad-glb-'));
const raw = pjoin(tmp, 'raw.glb');

try {
  const flags = [
    'pcb', 'export', 'glb', '-o', raw,
    '--include-pads', '--include-silkscreen', '--include-soldermask',
    '--no-dnp', '--no-unspecified', '-f',
  ];
  if (!keepVias) flags.splice(-1, 0, '--fill-all-vias');
  execFileSync(KICAD_CLI, [...flags, src], {stdio: ['ignore', 'ignore', 'ignore']});
  console.log(`  kicad-cli   ${(statSync(raw).size / 1024 / 1024).toFixed(2)} MB raw`);

  const io = await makeIO();
  const doc = await io.read(raw);
  // Measure straight off the kicad-cli output, before any transform runs.
  // Downstream (place-boards.mjs) needs honest millimetres to check the outline
  // against pcbnew, and every later stage muddies that: flatten()/join() rewrite
  // the node graph, and meshopt() quantizes each mesh into its own unit cube
  // with the real scale parked on that mesh's node.
  const bounds = measureMM(doc);

  // Drop anything parked absurdly far from the board. Those are the broken
  // easyeda2kicad model offsets described above; left in, they wreck the camera
  // framing and every downstream bounding box. Tested in WORLD space and
  // recursively: the offending nodes are nested, so checking a top-level node's
  // own translation misses them entirely.
  const CULL_RADIUS_M = 0.25;
  const strays = cullFarNodes(doc, CULL_RADIUS_M);
  if (strays.length) {
    for (const s of strays) console.log(`  stray       "${s.name}" at ${s.dist.toFixed(2)} m -> culled`);
    console.log(`  culled      ${strays.length} node(s) with bad 3D-model offsets`);
  }

  // Collect the materials actually used by bare-board meshes. Doing this by
  // mesh name (not by colour or alpha) means a change to KiCad's default board
  // colours can't silently retarget the fix onto a component material.
  const boardMats = new Set(), padMats = new Set();
  for (const mesh of doc.getRoot().listMeshes()) {
    const name = mesh.getName() ?? '';
    if (!BOARD_MESH.test(name)) continue;
    for (const prim of mesh.listPrimitives()) {
      const m = prim.getMaterial();
      if (!m) continue;
      boardMats.add(m);
      if (PAD_MESH.test(name)) padMats.add(m);
    }
  }

  for (const m of padMats) {
    m.setBaseColorFactor(GOLD).setMetallicFactor(GOLD_METALLIC).setRoughnessFactor(GOLD_ROUGHNESS);
  }
  // Soldermask ships at alpha 0.83 and silkscreen at 0.90 so copper reads
  // through them in KiCad's own viewer. We export no copper under the mask, so
  // the blend buys nothing and costs depth-sorting artifacts in three.js.
  for (const m of boardMats) {
    const c = m.getBaseColorFactor();
    m.setBaseColorFactor([c[0], c[1], c[2], 1.0]).setAlphaMode('OPAQUE');
  }
  console.log(`  materials   ${padMats.size} pad -> gold, ${boardMats.size} board surfaces -> OPAQUE`);

  const ops = [
    prune({keepAttributes: false}),
    flatten(),
    join({keepNamed: false}),
    weld({tolerance: 0.0001}),
  ];
  if (ratio < 1) ops.push(simplify({simplifier: MeshoptSimplifier, ratio, error: 0.004}));
  ops.push(dedup(), prune({keepAttributes: false}));
  await doc.transform(...ops);

  // meshopt, not Draco: its decoder runs on the main thread, so it survives
  // Hydrogen's CSP (which blocks worker-src blob: and hangs Draco's worker).
  await doc.transform(meshopt({encoder: MeshoptEncoder, level: 'high'}));
  await io.write(out, doc);
  writeFileSync(out.replace(/\.glb$/, '.bounds.json'), JSON.stringify(bounds, null, 2));
  console.log(`  bounds      ${bounds.size_mm.slice(0,2).join(' x ')} mm`);

  let verts = 0, tris = 0;
  for (const m of doc.getRoot().listMeshes())
    for (const p of m.listPrimitives()) {
      verts += p.getAttribute('POSITION')?.getCount() ?? 0;
      tris += (p.getIndices()?.getCount() ?? 0) / 3;
    }
  console.log(`  -> ${out}  ${(statSync(out).size / 1024).toFixed(0)} KB  ${verts.toLocaleString()} verts  ${tris.toLocaleString()} tris`);
} finally {
  rmSync(tmp, {recursive: true, force: true});
}
