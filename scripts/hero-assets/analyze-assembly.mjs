// Inventory an Onshape assembly GLB/GLTF: what's in it, where each part sits,
// and which occurrences actually cost geometry. Read-only, writes nothing.
import {makeIO} from './io.mjs';

const src = process.argv[2];
const io = await makeIO();
console.log(`reading ${src} ...`);
const doc = await io.read(src);
const root = doc.getRoot();

// ---- mat4 helpers (column-major), same convention as build.mjs ----
function compose(t, r, s) {
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}
const I4 = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let v = 0; for (let k = 0; k < 4; k++) v += a[k*4+r] * b[c*4+k]; o[c*4+r] = v;
  }
  return o;
}
const tp = (m, [x,y,z]) => [
  m[0]*x+m[4]*y+m[8]*z+m[12], m[1]*x+m[5]*y+m[9]*z+m[13], m[2]*x+m[6]*y+m[10]*z+m[14],
];
const local = (n) => compose(n.getTranslation(), n.getRotation(), n.getScale());

// Accumulate world bbox + vertex/triangle counts over a subtree.
function walk(node, M, acc) {
  const W = mul(M, local(node));
  const mesh = node.getMesh();
  if (mesh) for (const p of mesh.listPrimitives()) {
    const pos = p.getAttribute('POSITION');
    if (!pos) continue;
    acc.verts += pos.getCount();
    acc.tris += (p.getIndices()?.getCount() ?? pos.getCount()) / 3;
    acc.prims += 1;
    const lo = pos.getMin([]), hi = pos.getMax([]);
    for (let xi = 0; xi < 2; xi++) for (let yi = 0; yi < 2; yi++) for (let zi = 0; zi < 2; zi++) {
      const q = tp(W, [xi?hi[0]:lo[0], yi?hi[1]:lo[1], zi?hi[2]:lo[2]]);
      for (let i = 0; i < 3; i++) {
        acc.min[i] = Math.min(acc.min[i], q[i]);
        acc.max[i] = Math.max(acc.max[i], q[i]);
      }
    }
  }
  for (const c of node.listChildren()) walk(c, W, acc);
  return acc;
}
const fresh = () => ({min:[Infinity,Infinity,Infinity], max:[-Infinity,-Infinity,-Infinity], verts:0, tris:0, prims:0});

const scene = root.listScenes()[0];
const top = scene.listChildren();
console.log(`scenes=${root.listScenes().length} topLevelNodes=${top.length} meshes=${root.listMeshes().length} materials=${root.listMaterials().length}`);

// Onshape nests everything under a single assembly node.
const assembly = top.length === 1 ? top[0] : null;
const Masm = assembly ? local(assembly) : I4;
const occurrences = assembly ? assembly.listChildren() : top;
console.log(`assembly node: ${assembly ? (assembly.getName() || '(unnamed)') : 'none'} -> ${occurrences.length} occurrences\n`);

const rows = occurrences.map((occ) => {
  const name = (occ.getName() || '?').replace(/^occurrence of /, '');
  const a = walk(occ, Masm, fresh());
  const finite = Number.isFinite(a.min[0]);
  return {
    name,
    verts: a.verts, tris: a.tris, prims: a.prims,
    centre: finite ? a.min.map((v,i)=>(v+a.max[i])/2) : null,
    size: finite ? a.min.map((v,i)=>a.max[i]-v) : null,
  };
});

const totalV = rows.reduce((s,r)=>s+r.verts, 0);

// Group by a coarse family name so 60 screws collapse into one line.
const family = (n) => n
  .replace(/\s*<\d+>\s*$/, '')
  .replace(/^(Hexalobular socket pan head screw|Hex socket countersunk head screw|Hex socket head cap screw).*/i, '$1')
  .replace(/\s*\(.*$/, '')
  .trim();

const fam = new Map();
for (const r of rows) {
  const k = family(r.name);
  if (!fam.has(k)) fam.set(k, {n:0, verts:0, tris:0, ex:r});
  const f = fam.get(k);
  f.n++; f.verts += r.verts; f.tris += r.tris;
}

console.log('FAMILY                                    count      verts        tris    %verts');
console.log('-'.repeat(84));
for (const [k, f] of [...fam.entries()].sort((a,b)=>b[1].verts-a[1].verts)) {
  console.log(
    `${k.slice(0,40).padEnd(40)} ${String(f.n).padStart(6)} ${f.verts.toLocaleString().padStart(11)} ${Math.round(f.tris).toLocaleString().padStart(11)} ${(100*f.verts/totalV).toFixed(1).padStart(8)}%`
  );
}
console.log('-'.repeat(84));
console.log(`${'TOTAL'.padEnd(40)} ${String(rows.length).padStart(6)} ${totalV.toLocaleString().padStart(11)}`);

// Positions of the parts the hero animation needs to move individually.
const KEY = /^(Arm|Cross|Base-Top|Base-Bot|Top|OpenFC|OpenESC|4in1|OpenRX|P1604|Camera|DJI|VTX-Mount|AirTag|Airtag|Bumper|Softmount|Standoff)/i;
console.log('\nKEY PARTS (world centre / bbox size, metres)');
console.log('NAME                                 centre x,y,z                      size x,y,z');
for (const r of rows.filter(r=>KEY.test(r.name) && r.centre).sort((a,b)=>a.name.localeCompare(b.name))) {
  const c = r.centre.map(v=>v.toFixed(4).padStart(8)).join(',');
  const s = r.size.map(v=>v.toFixed(4).padStart(8)).join(',');
  console.log(`${r.name.slice(0,36).padEnd(36)} ${c}   ${s}`);
}
