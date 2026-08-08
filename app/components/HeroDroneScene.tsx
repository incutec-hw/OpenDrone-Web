/**
 * Scroll-driven hero built from the Onshape assembly.
 *
 * This is the studio's proven scene core (public/models/od3/_studio.html) minus
 * the tuning panel. It is deliberately vanilla three.js inside a ref container
 * rather than react-three-fiber: the studio version is the one that has been
 * tuned and debugged against the real assembly, and reimplementing it in r3f
 * would mean re-finding all of the same bugs.
 *
 * Tunables come from /models/<model>/studio.json, which is what the studio
 * writes. Structure (which parts form a beat, the teardown choreography) is
 * still in code here; see that file's _status field.
 */
import {useEffect, useRef, useState} from 'react';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';

export type HeroBeat = {id: string; title: string; note: string};

/** One streamed piece of the assembly, as written by build-hero.mjs --split. */
type Chunk = {id: string; label: string; file: string; bytes: number};
type ChunkManifest = {chunks?: Chunk[]};

/** Progress of the model download, for the splash. */
export type HeroLoadState = {
  /** Human-readable name of the piece currently arriving. */
  label: string;
  /** 0..1 across the whole assembly, weighted by real byte counts. */
  frac: number;
  /** Chunk id, so a caller can react to a specific piece landing. */
  chunk: string;
  /** True on the event that fires once this chunk is in the scene. */
  done: boolean;
  /** Every piece in load order, so the splash can show the full manifest. */
  pieces: Array<{id: string; label: string}>;
};

/** The one design that is always present. */
const FALLBACK_MODEL = 'od3';

export type HeroDroneSceneProps = {
  /** Folder under /public/models holding drone.glb + studio.json. */
  model?: string;
  /** Fires as the reader moves through the sequence, 0..1. */
  onProgress?: (frac: number) => void;
  /** Fires when the presented beat changes; null while the drone rests whole. */
  onBeat?: (beat: HeroBeat | null, index: number) => void;
  /** The list of beats, once known. */
  onBeats?: (beats: HeroBeat[]) => void;
  /** Fires as the model streams in, for the splash progress. */
  onLoad?: (state: HeroLoadState) => void;
  /** Fires once the model is on screen. */
  onReady?: () => void;
  /** Handed a jump function once ready, so the rail dots can seek. */
  onSeeker?: (goTo: (i: number) => void) => void;
};

/* three.js mangles imported names three ways: it appends _1/_2 to duplicates,
 * turns spaces into underscores, and DELETES [ ] . : / entirely. Onshape also
 * wraps each part in occurrence_of_<name>. Undo all of it before matching, or
 * name-based rules silently miss most of the assembly. */
const tidy = (n?: string | null) =>
  (n ?? '')
    .replace(/_\d+$/, '')
    .replace(/_/g, ' ')
    .replace(/^occurrence of /i, '')
    .trim();

/* Onshape writes 8-bit sRGB into baseColorFactor, which glTF defines as linear.
 * Measured on this export: 183 of 183 components are exact n/255. Without this
 * every albedo renders overbright, worst on dark surfaces. */
const s2l = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

type MatProfile = {
  id: string;
  match: string | null;
  tint: string | null;
  metalness: number;
  roughness: number;
  env: number;
  sat: number;
};
type StudioConfig = {
  model?: string;
  lighting: any;
  spotlight: any;
  sequence: any;
  camera?: any;
  scroll?: {
    springHz?: number;
    gain?: number;
    magnet?: number;
    commitAt?: number;
    minDwellS?: number;
  };
  materials: MatProfile[];
  boards: Array<{id: string; title: string; note: string}>;
  boardExclude: string;
  videoModule: string;
  notFrame: string;
  beats: any[];
};

export function HeroDroneScene({
  model = 'od3',
  onProgress,
  onBeat,
  onBeats,
  onLoad,
  onReady,
  onSeeker,
}: HeroDroneSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    const cleanup: Array<() => void> = [];

    const TEST = typeof location !== 'undefined' && new URLSearchParams(location.search).has('herotest');

    (async () => {
      // Only some sizes have an assembly built. Fall back rather than 404ing,
      // so the size selector keeps working before the other models exist.
      let folder = model;
      let res = await fetch(`/models/${folder}/studio.json`);
      if (!res.ok && folder !== FALLBACK_MODEL) {
        console.warn(`[hero] no assembly for "${folder}", showing ${FALLBACK_MODEL}`);
        folder = FALLBACK_MODEL;
        res = await fetch(`/models/${folder}/studio.json`);
      }
      if (!res.ok) throw new Error(`studio.json ${res.status}`);
      const cfg = (await res.json()) as StudioConfig;

      if (disposed) return;
      const renderer = new THREE.WebGLRenderer({antialias: true, alpha: true});
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = cfg.lighting.exposure;
      el.append(renderer.domElement);
      renderer.domElement.style.display = 'block';
      cleanup.push(() => {
        // dispose() alone does not release the WebGL context, and browsers cap
        // them at around 16 per page. Without forceContextLoss a few remounts
        // take out every canvas on the page.
        renderer.setAnimationLoop(null);
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
      });

      const scene = new THREE.Scene();
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
      scene.environment = envRT.texture;
      cleanup.push(() => {
        envRT.dispose();
        pmrem.dispose();
      });
      scene.environmentIntensity = cfg.lighting.environment;

      const camera = new THREE.PerspectiveCamera(34, 1, 0.002, 60);

      const aim = (l: THREE.DirectionalLight, az: number, elv: number) => {
        const a = THREE.MathUtils.degToRad(az);
        const e = THREE.MathUtils.degToRad(elv);
        l.position.set(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a));
        l.target.position.set(0, 0, 0);
      };
      const L = cfg.lighting;
      const hemi = new THREE.HemisphereLight(0x94b8e8, 0x181410, L.ambient);
      const keyL = new THREE.DirectionalLight(L.key.colour, L.key.power);
      const fillL = new THREE.DirectionalLight(L.fill.colour, L.fill.power);
      const rimL = new THREE.DirectionalLight(L.rim.colour, L.rim.power);
      const bncL = new THREE.DirectionalLight(L.bounce.colour, L.bounce.power);
      bncL.position.set(0.05, -0.5, 0.15);
      scene.add(hemi, keyL, keyL.target, fillL, fillL.target, rimL, rimL.target, bncL, bncL.target);
      aim(keyL, L.key.azimuth, L.key.elevation);
      aim(fillL, L.fill.azimuth, L.fill.elevation);
      aim(rimL, L.rim.azimuth, L.rim.elevation);
      const BASE = {
        hemi: hemi.intensity,
        key: keyL.intensity,
        fill: fillL.intensity,
        rim: rimL.intensity,
        bounce: bncL.intensity,
      };

      const S = cfg.spotlight;
      // The feathered shader multiplies alpha by a fresnel and a length falloff,
      // so at the studio's opacity it reads far dimmer. Gain compensates so the
      // same studio.json number means the same apparent brightness.
      const BEAM_GAIN = S.beamGain ?? 4.0;
      const spotL = new THREE.SpotLight(S.colour ?? 0xffd7a0, S.power, 0, 0.5, S.softness, 2);
      scene.add(spotL, spotL.target);
      // A flat additive cone reads as a hard grey wedge. This fakes a real
      // light shaft: alpha falls off toward the cone's silhouette (a fresnel
      // term, so the rim is feathered rather than a visible edge), fades along
      // its length, and is dithered slightly so it does not band on a dark
      // background. No texture, so nothing to download.
      const beamMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        uniforms: {
          uOpacity: {value: 0},
          uColor: {value: new THREE.Color(S.beamColour ?? 0xffcf96)},
        },
        vertexShader: `
          varying vec3 vNormalW;
          varying vec3 vViewDir;
          varying float vAlong;
          void main() {
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vNormalW = normalize(mat3(modelMatrix) * normal);
            vViewDir = normalize(cameraPosition - wp.xyz);
            vAlong = uv.y;                 // 0 at the base, 1 at the apex
            gl_Position = projectionMatrix * viewMatrix * wp;
          }
        `,
        fragmentShader: `
          uniform float uOpacity;
          uniform vec3 uColor;
          varying vec3 vNormalW;
          varying vec3 vViewDir;
          varying float vAlong;
          void main() {
            // Grazing angles are where a real shaft is densest, so feather the
            // silhouette instead of leaving a hard rim.
            float rim = 1.0 - abs(dot(normalize(vNormalW), normalize(vViewDir)));
            rim = pow(clamp(rim, 0.0, 1.0), 4.0);
            // vAlong is 1 at the apex (the lamp). Bright there, gone well
            // before the open end so the shaft has no visible termination.
            float along = pow(clamp(vAlong, 0.0, 1.0), 2.5);
            float a = uOpacity * rim * along;
            // Cheap dither: additive blending on near-black bands badly.
            a += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * 0.004;
            gl_FragColor = vec4(uColor, max(a, 0.0));
          }
        `,
      });
      // openEnded, and long enough that its rim falls outside the viewport, so
      // the geometry never terminates in a visible circle.
      const beamGeo = new THREE.ConeGeometry(1, 1, 64, 1, true);
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.frustumCulled = false;
      beam.visible = false;
      scene.add(beam);
      cleanup.push(() => {
        beamGeo.dispose();
        beamMat.dispose();
      });

      // Motes drifting in the beam. A shaft of light is only visible because of
      // what is floating in it, so a handful of additive points sell it far
      // better than making the cone brighter. Positioned inside the cone each
      // frame in the loop, in the cone's own space.
      const MOTES = 220;
      const moteGeo = new THREE.BufferGeometry();
      const motePos = new Float32Array(MOTES * 3);
      const moteSeed = new Float32Array(MOTES);
      for (let i = 0; i < MOTES; i++) {
        // Uniform in a cone of unit height: bias radius by sqrt for area, and
        // by height so the wide end is not overpopulated.
        const h = Math.cbrt(Math.random());
        const r = Math.sqrt(Math.random()) * h;
        const th = Math.random() * Math.PI * 2;
        motePos[i * 3] = Math.cos(th) * r;
        motePos[i * 3 + 1] = h;
        motePos[i * 3 + 2] = Math.sin(th) * r;
        moteSeed[i] = Math.random();
      }
      moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
      moteGeo.setAttribute('aSeed', new THREE.BufferAttribute(moteSeed, 1));
      const moteMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {uOpacity: {value: 0}, uTime: {value: 0}, uSize: {value: 1}},
        vertexShader: `
          attribute float aSeed;
          uniform float uTime;
          uniform float uSize;
          varying float vFade;
          void main() {
            vec3 p = position;
            // Slow drift, seeded per mote so they do not move as a block.
            p.x += sin(uTime * 0.25 + aSeed * 31.4) * 0.06;
            p.z += cos(uTime * 0.21 + aSeed * 17.7) * 0.06;
            p.y = fract(p.y + uTime * 0.012 + aSeed);
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            // Densest mid-shaft, gone at both ends.
            vFade = smoothstep(0.0, 0.2, p.y) * (1.0 - smoothstep(0.6, 1.0, p.y));
            gl_PointSize = uSize * (300.0 / max(-mv.z, 0.001));
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: `
          uniform float uOpacity;
          varying float vFade;
          void main() {
            vec2 d = gl_PointCoord - 0.5;
            float a = smoothstep(0.5, 0.0, length(d));   // soft round mote
            gl_FragColor = vec4(vec3(1.0, 0.88, 0.72), a * a * vFade * uOpacity);
          }
        `,
      });
      const motes = new THREE.Points(moteGeo, moteMat);
      motes.frustumCulled = false;
      motes.visible = false;
      scene.add(motes);
      cleanup.push(() => {
        moteGeo.dispose();
        moteMat.dispose();
      });

      // Onshape is Z-up, three is Y-up. `pivot` scales the drone about its own
      // centre so the airframe can recede without dragging the shown part.
      const world = new THREE.Group();
      world.rotation.x = -Math.PI / 2;
      scene.add(world);
      const pivot = new THREE.Group();
      world.add(pivot);
      const rig = new THREE.Group();
      pivot.add(rig);

      /* ------------------------------------------------------- materials */
      const profiles = new Map<string, MatProfile>(cfg.materials.map((m) => [m.id, m]));
      const classMats = new Map<string, THREE.MeshStandardMaterial[]>();
      const nameRules = cfg.materials.filter((m) => m.match);

      function classOf(raw0: string) {
        const raw = (raw0 || '').replace(/_\d+$/, '');
        if (/_PCB\b/i.test(raw)) return 'fr4';
        if (/_pad\b/i.test(raw)) return 'padgold';
        if (/_silkscreen\b/i.test(raw)) return 'silk';
        if (/_soldermask\b/i.test(raw)) return 'mask';
        const n = tidy(raw);
        for (const r of nameRules) if (new RegExp(r.match as string, 'i').test(n)) return r.id;
        return 'smd';
      }
      const hsl = {h: 0, s: 0, l: 0};
      function applyProfile(mat: THREE.MeshStandardMaterial, key: string) {
        const p = profiles.get(key);
        if (!p) return;
        const c = mat.color;
        c.setRGB(s2l(c.r), s2l(c.g), s2l(c.b));
        mat.metalness = p.metalness;
        mat.roughness = p.roughness;
        mat.envMapIntensity = p.env;
        if (p.tint) mat.color.set(p.tint);
        if (p.sat !== 1) {
          mat.color.getHSL(hsl);
          mat.color.setHSL(hsl.h, Math.min(1, hsl.s * p.sat), hsl.l);
        }
        const list = classMats.get(key) ?? [];
        list.push(mat);
        classMats.set(key, list);
      }

      /* ------------------------------------------------------------ load
       * The assembly ships as several GLBs (build-hero.mjs --split) so the
       * browser streams it instead of stalling on one 6 MB file, and the reader
       * watches the drone build up while it arrives. They are reassembled here
       * into exactly the tree a single-file load produced -- one root, one
       * assembly node, every occurrence under it -- so nothing below this point
       * knows or cares which file a part came from.
       */
      const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder as any);
      const cache = new Map<string, THREE.MeshStandardMaterial>();
      const paint = (sub: THREE.Object3D, root: THREE.Object3D) => {
        sub.traverse((o: any) => {
          if (!o.isMesh || o.userData.painted) return;
          o.userData.painted = true;
          o.frustumCulled = false;
          let name = '';
          let n: THREE.Object3D | null = o;
          while (n && n !== root) {
            if (n.name && !/^mesh/i.test(n.name)) {
              name = n.name;
              break;
            }
            n = n.parent;
          }
          const key = classOf(name || o.name || '');
          const ck = `${o.material.uuid}|${key}`;
          let m = cache.get(ck);
          if (!m) {
            m = o.material.clone();
            applyProfile(m as THREE.MeshStandardMaterial, key);
            cache.set(ck, m as THREE.MeshStandardMaterial);
          }
          o.material = m;
        });
      };

      const droneRoot = new THREE.Group();
      droneRoot.name = 'assembly-root';
      rig.add(droneRoot);
      cleanup.push(() => {
        for (const m of cache.values()) m.dispose();
        droneRoot.traverse((o: any) => {
          if (o.isMesh) o.geometry?.dispose?.();
        });
      });

      /* --------------------------------------------------- assembling view
       * The real loop cannot start until the rigging is done, and the rigging
       * cannot start until every chunk has landed. Without something here the
       * whole download is a blank canvas. So run a minimal loop that frames
       * whatever has arrived and turns it slowly: each chunk visibly drops into
       * place, which is the honest progress indicator.
       */
      let previewOn = true;
      const previewClock = new THREE.Clock();
      let previewAngle = 0.9;
      // Framed on the finished drone from the first frame, not on the airframe
      // alone, so the camera does not lurch outward as the heavy chunks land.
      // 0.075 m is a 3 inch airframe's bounding radius; refined once measured.
      let previewRadius = 0.075;
      const previewCentre = new THREE.Vector3();
      const previewFit = () => {
        const b = new THREE.Box3().setFromObject(rig);
        if (b.isEmpty()) return;
        b.getCenter(previewCentre);
        previewRadius = Math.max(previewRadius, b.getBoundingSphere(new THREE.Sphere()).radius);
      };
      const previewFrame = () => {
        if (!previewOn) return;
        const w = Math.round(el.clientWidth);
        const h = Math.round(el.clientHeight);
        if (w && h) {
          renderer.setSize(w, h, true);
          camera.aspect = w / h;
          camera.near = previewRadius / 300;
          camera.far = previewRadius * 60;
          camera.updateProjectionMatrix();
        }
        previewAngle += Math.min(previewClock.getDelta(), 0.05) * 0.24;
        const off = new THREE.Vector3(Math.cos(previewAngle), 0.5, Math.sin(previewAngle))
          .normalize()
          .multiplyScalar(previewRadius * (cfg.camera?.distance ?? 2.15));
        camera.position.copy(previewCentre.clone().add(off));
        camera.lookAt(previewCentre);
        renderer.render(scene, camera);
      };
      renderer.setAnimationLoop(previewFrame);

      const manifest = await fetch(`/models/${folder}/chunks.json`)
        .then((r) => (r.ok ? (r.json() as Promise<ChunkManifest>) : null))
        .catch(() => null);
      // No manifest means an older single-file build. Still supported.
      // Smallest chunks first: the whole download happens behind the splash,
      // so the order's only job is to get the first pieces in fast and keep
      // the pipe busy, not to tell a story.
      const chunks: Chunk[] = manifest?.chunks?.length
        ? [...manifest.chunks].sort((a, b) => (a.bytes || 1) - (b.bytes || 1))
        : [{id: 'drone', label: 'drone', file: cfg.model ?? 'drone.glb', bytes: 1}];
      const totalBytes = chunks.reduce((s, c) => s + (c.bytes || 1), 0);
      const pieces = chunks.map((c) => ({id: c.id, label: c.label}));
      let bytesDone = 0;
      let asm: THREE.Group | null = null;
      for (const c of chunks) {
        onLoad?.({label: c.label, frac: bytesDone / totalBytes, chunk: c.id, done: false, pieces});
        const g = await new Promise<{scene: THREE.Group}>((resolve, reject) =>
          loader.load(
            `/models/${folder}/${c.file}`,
            resolve as any,
            (e) => {
              if (!e.total) return;
              const frac = (bytesDone + (c.bytes || 1) * (e.loaded / e.total)) / totalBytes;
              onLoad?.({label: c.label, frac, chunk: c.id, done: false, pieces});
            },
            reject,
          ),
        );
        if (disposed) return;   // torn down mid-download
        const src = g.scene.children.length === 1 ? g.scene.children[0] : g.scene;
        if (!asm) {
          // Every chunk is a clone of one source document, so they all carry the
          // same assembly transform. Take it from the first, verify the rest.
          asm = new THREE.Group();
          asm.name = src.name || 'assembly';
          asm.position.copy(src.position);
          asm.quaternion.copy(src.quaternion);
          asm.scale.copy(src.scale);
          droneRoot.add(asm);
        } else if (!asm.position.equals(src.position) || !asm.quaternion.equals(src.quaternion)) {
          console.warn(`[hero] chunk "${c.id}" assembly transform differs from the first chunk`);
        }
        for (const child of [...src.children]) asm.add(child);
        paint(asm, droneRoot);
        previewFit();
        bytesDone += c.bytes || 1;
        onLoad?.({label: c.label, frac: bytesDone / totalBytes, chunk: c.id, done: true, pieces});
        // Hand the main thread back so the preview loop paints the part that
        // just landed. Without this the whole sequence of chunks decodes in one
        // unbroken task and the drone appears complete in a single jump.
        //
        // Raced against a timer on purpose: requestAnimationFrame does not fire
        // in a backgrounded tab, so awaiting it alone hangs the rest of the
        // download until the reader comes back to the page.
        await new Promise((r) => {
          const t = setTimeout(r, 50);
          requestAnimationFrame(() => {
            clearTimeout(t);
            r(undefined);
          });
        });
        if (disposed) return;
      }
      if (!asm) throw new Error('no geometry loaded');
      previewOn = false;

      const occRoot: THREE.Object3D = asm;
      const underPivot = (o: THREE.Object3D) => {
        for (let p = o.parent; p; p = p.parent) if (p.name === 'prop-pivot') return true;
        return false;
      };
      const pick = (re: RegExp) => {
        const out: THREE.Object3D[] = [];
        droneRoot.traverse((o) => {
          // Nothing inside a prop pivot is selectable on its own: the prop and
          // the motor's rotating parts ride the spinner, and the pivot group is
          // what a beat moves. Selecting both would move them twice.
          if (o.name && re.test(tidy(o.name)) && !underPivot(o)) out.push(o);
        });
        return out;
      };
      const topLevel = (nodes: THREE.Object3D[]) => {
        const set = new Set(nodes);
        return nodes.filter((n) => {
          for (let p = n.parent; p; p = p.parent) if (set.has(p)) return false;
          return true;
        });
      };

      /* ------------------------------------------- boards merged to 1 group
       * A board is ~1900 occurrences that always move together, so each one
       * costs a draw call for nothing. Bake to one mesh per material. */
      const EXCLUDE = new RegExp(cfg.boardExclude, 'i');
      function boardMembers(prefix: string) {
        const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_(pad|silkscreen|soldermask|PCB)`, 'i');
        const frags: THREE.Object3D[] = [];
        droneRoot.traverse((o) => {
          if (o.name && re.test(o.name.replace(/_\d+$/, ''))) frags.push(o);
        });
        if (!frags.length) return [];
        const bb = new THREE.Box3();
        for (const f of frags) bb.expandByObject(f);
        bb.min.x -= 0.0025;
        bb.max.x += 0.0025;
        bb.min.y -= 0.0025;
        bb.max.y += 0.0025;
        bb.min.z -= 0.0015;
        bb.max.z += 0.006;
        const out: THREE.Object3D[] = [];
        for (const c of occRoot.children) {
          if (EXCLUDE.test(tidy(c.name))) continue;
          const centre = new THREE.Box3().setFromObject(c).getCenter(new THREE.Vector3());
          if (bb.containsPoint(centre)) out.push(c);
        }
        return out;
      }
      scene.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(occRoot.matrixWorld).invert();
      const merged = new Map<string, THREE.Group>();
      for (const b of cfg.boards) {
        const members = boardMembers(b.id);
        if (!members.length) {
          console.warn(`[hero] board "${b.id}" matched no substrate fragments`);
          continue;
        }
        const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
        for (const node of members) {
          node.traverse((o: any) => {
            if (!o.isMesh) return;
            const g = o.geometry.clone();
            g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
            for (const k of Object.keys(g.attributes))
              if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
            if (!g.getAttribute('normal')) g.computeVertexNormals();
            const arr = byMat.get(o.material) ?? [];
            arr.push(g);
            byMat.set(o.material, arr);
          });
        }
        const group = new THREE.Group();
        group.name = `BOARD_${b.id}`;
        for (const [mat, geos] of byMat) {
          const g = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
          if (!g) continue;
          const mesh = new THREE.Mesh(g, mat);
          mesh.frustumCulled = false;
          group.add(mesh);
        }
        occRoot.add(group);
        // removeFromParent leaves the source buffers referenced by detached
        // nodes, so ~1900 occurrences' worth of geometry per board would never
        // free. Dispose them explicitly.
        for (const node of members) {
          node.traverse((o: any) => {
            if (o.isMesh) o.geometry?.dispose?.();
          });
          node.removeFromParent();
        }
        merged.set(b.id, group);
        cleanup.push(() => {
          for (const m of group.children as THREE.Mesh[]) m.geometry?.dispose?.();
        });
      }

      /* --------------------------------------------------------- geometry */
      const box = new THREE.Box3().setFromObject(rig);
      const droneCentre = box.getCenter(new THREE.Vector3());
      const droneRadius = box.getBoundingSphere(new THREE.Sphere()).radius;
      const centreLocal = pivot.worldToLocal(droneCentre.clone());
      pivot.position.copy(centreLocal);
      rig.position.copy(centreLocal.clone().negate());

      // Props spin on the motor axis. A tri-blade's bbox centre is ~7 mm off its
      // hub, so the pivot is placed on the motor's own axis instead. The spinner
      // is a child of the pivot so a beat moving the pivot cannot cancel the spin.
      const propPivots: THREE.Group[] = [];
      {
        scene.updateMatrixWorld(true);
        const motors: THREE.Vector3[] = [];
        for (const b of topLevel(pick(/^Admi/i))) {
          const c = new THREE.Box3().setFromObject(b).getCenter(new THREE.Vector3());
          const hit = motors.find((m) => Math.hypot(m.x - c.x, m.z - c.z) < 0.015);
          if (!hit) motors.push(c);
        }
        const propNodes = occRoot.children.filter((c) =>
          /^occurrence[_ ]of[_ ][0-9]+(_[0-9]+)?$/i.test(c.name || ''),
        );
        for (const p of propNodes) {
          const pc = new THREE.Box3().setFromObject(p).getCenter(new THREE.Vector3());
          let axis: THREE.Vector3 | null = null;
          let best = Infinity;
          for (const m of motors) {
            const d = Math.hypot(m.x - pc.x, m.z - pc.z);
            if (d < best) {
              best = d;
              axis = m;
            }
          }
          const hub = axis ? new THREE.Vector3(axis.x, pc.y, axis.z) : pc;
          const g = new THREE.Group();
          // Named because `notFrame` in the config excludes "prop-pivot": an
          // unnamed group falls through and the props get swept into the
          // airframe teardown.
          g.name = 'prop-pivot';
          occRoot.add(g);
          g.position.copy(occRoot.worldToLocal(hub.clone()));
          g.updateMatrixWorld(true);
          const sp = new THREE.Group();
          g.add(sp);
          sp.updateMatrixWorld(true);
          sp.attach(p);
          const dx = hub.x - droneCentre.x;
          const dz = hub.z - droneCentre.z;
          (g as any).userData = {spin: sp, dir: dx * dz < 0 ? 1 : -1};
          propPivots.push(g);
        }
        if (propPivots.length !== 4)
          console.warn(`[hero] expected 4 props, rigged ${propPivots.length}`);

        // The bell and shaft spin with the prop; only the stator side stays
        // still. The motor's five occurrences all share one part name, so they
        // are told apart by shape: the shaft is tall and thin (it tops the
        // cluster too, since the prop mounts on it), and the bell is the piece
        // with the largest bounding volume (the can wraps the whole motor;
        // measured on this export it is 2x the runner-up). They join the prop
        // on its spinner.
        scene.updateMatrixWorld(true);
        const byMotor = new Map<number, Array<{node: THREE.Object3D; vol: number; size: THREE.Vector3}>>();
        for (const n of topLevel(pick(/^Admi/i))) {
          const bb = new THREE.Box3().setFromObject(n);
          const c = bb.getCenter(new THREE.Vector3());
          const mi = motors.findIndex((m) => Math.hypot(m.x - c.x, m.z - c.z) < 0.015);
          if (mi < 0) continue;
          const size = bb.getSize(new THREE.Vector3());
          const arr = byMotor.get(mi) ?? [];
          arr.push({node: n, vol: size.x * size.y * size.z, size});
          byMotor.set(mi, arr);
        }
        for (const [mi, pieces] of byMotor) {
          const m = motors[mi];
          let bestG: THREE.Group | null = null;
          let bestD = Infinity;
          for (const g of propPivots) {
            const p = g.getWorldPosition(new THREE.Vector3());
            const d = Math.hypot(p.x - m.x, p.z - m.z);
            if (d < bestD) {
              bestD = d;
              bestG = g;
            }
          }
          if (!bestG || bestD > 0.03) continue;
          const spin = (bestG as any).userData.spin as THREE.Group;
          const bell = pieces.reduce((a, b) => (b.vol > a.vol ? b : a));
          for (const p of pieces) {
            const thin = p.size.y > 2.5 * Math.max(p.size.x, p.size.z);
            if (p === bell || thin) spin.attach(p.node);
          }
        }
      }

      /* ------------------------------------------------------------ beats */
      const VIDEO_RE = new RegExp(cfg.videoModule, 'i');
      const NOT_FRAME = new RegExp(cfg.notFrame, 'i');
      const frameGroup = () =>
        occRoot.children.filter(
          (c) => !/^BOARD_/.test(c.name) && !VIDEO_RE.test(tidy(c.name)) && !NOT_FRAME.test(tidy(c.name)),
        );

      type Node = {
        node: THREE.Object3D;
        pos: THREE.Vector3;
        quat: THREE.Quaternion;
        scl: THREE.Vector3;
        worldOrigin: THREE.Vector3;
        worldCentre: THREE.Vector3;
        withTop?: boolean;
        withVideo?: boolean;
      };
      type Beat = {
        id: string;
        title: string;
        note: string;
        faceOn?: boolean;
        fade?: number;
        /** Per-beat override of sequence.partSize: how much of the viewport
         *  height the part fills under the spotlight. >0.9 deliberately
         *  crops (the airframe reads better close, top plate off screen). */
        partSize?: number;
        stops?: Array<{at: number; title: string; note: string}>;
        choreo?: string;
        nodes: Node[];
        centre?: THREE.Vector3;
        radius?: number;
        dim?: THREE.Mesh[];
      };

      function selectFor(spec: any): THREE.Object3D[] {
        if (!spec || spec.none) return [];
        if (spec.board) {
          const g = merged.get(spec.board);
          return g ? [g] : [];
        }
        if (spec.cluster) {
          const all = topLevel(pick(new RegExp(spec.cluster, 'i')));
          if (!all.length) return [];
          const seed = new THREE.Box3().setFromObject(all[0]).getCenter(new THREE.Vector3());
          const cluster = all.filter((n) => {
            const c = new THREE.Box3().setFromObject(n).getCenter(new THREE.Vector3());
            return Math.hypot(c.x - seed.x, c.z - seed.z) < 0.012;
          });
          if (spec.withProp) {
            let bestG: THREE.Group | null = null;
            let bestD = Infinity;
            for (const g of propPivots) {
              const p = g.getWorldPosition(new THREE.Vector3());
              const d = Math.hypot(p.x - seed.x, p.z - seed.z);
              if (d < bestD) {
                bestD = d;
                bestG = g;
              }
            }
            if (bestG && bestD < 0.03) cluster.push(bestG);
          }
          return cluster;
        }
        if (spec.complement) {
          const out = frameGroup();
          if (spec.plus === 'videoModule') out.push(...topLevel(pick(VIDEO_RE)));
          return out;
        }
        return [];
      }

      const BEATS: Beat[] = cfg.beats.map((b: any) => {
        const nodes: Node[] = selectFor(b.select).map((n) => ({
          node: n,
          pos: n.position.clone(),
          quat: n.quaternion.clone(),
          scl: n.scale.clone(),
          worldOrigin: n.getWorldPosition(new THREE.Vector3()),
          worldCentre: new THREE.Box3().setFromObject(n).getCenter(new THREE.Vector3()),
        }));
        const beat: Beat = {
          id: b.id,
          title: b.title,
          note: b.note,
          fade: b.fade,
          partSize: b.partSize,
          stops: b.stops,
          choreo: b.choreo,
          faceOn: !!b.select?.board,
          nodes,
        };
        if (nodes.length) {
          const bb = new THREE.Box3();
          for (const p of nodes) bb.expandByObject(p.node);
          beat.centre = bb.getCenter(new THREE.Vector3());
          beat.radius = Math.max(bb.getBoundingSphere(new THREE.Sphere()).radius, 1e-4);
          const plate = nodes.find((p) => tidy(p.node.name) === 'Top');
          if (plate) {
            const pbb = new THREE.Box3().setFromObject(plate.node);
            for (const p of nodes) {
              const n = tidy(p.node.name);
              if (n === 'Top') {
                p.withTop = true;
                continue;
              }
              if (!/(screw|hex nut|pressnut|press nut|washer)/i.test(n)) continue;
              const c = new THREE.Box3().setFromObject(p.node).getCenter(new THREE.Vector3());
              if (c.y >= pbb.min.y - 0.0015) p.withTop = true;
            }
          }
          const cradle = nodes.filter((p) => /^VTX-Mount/i.test(tidy(p.node.name)));
          if (cradle.length) {
            const vbb = new THREE.Box3();
            for (const p of cradle) vbb.expandByObject(p.node);
            vbb.min.x -= 0.002;
            vbb.max.x += 0.002;
            vbb.min.z -= 0.002;
            vbb.max.z += 0.002;
            vbb.min.y += 0.001;
            for (const p of nodes) {
              if (!/(screw|hex nut|pressnut|press nut|washer)/i.test(tidy(p.node.name))) continue;
              const c = new THREE.Box3().setFromObject(p.node).getCenter(new THREE.Vector3());
              if (vbb.containsPoint(c)) p.withVideo = true;
            }
          }
        } else if (!b.select?.none) {
          console.warn(`[hero] beat "${b.id}" resolved to 0 nodes`);
        }
        return beat;
      });
      onBeats?.(BEATS.map((b) => ({id: b.id, title: b.title, note: b.note})));

      /* --------------------------------------------- dim everything else */
      const twin = new Map<THREE.Material, THREE.MeshStandardMaterial>();
      const twinOf = (m: any) => {
        let t = twin.get(m);
        if (!t) {
          t = m.clone();
          (t as any).userData = {
            normal: m,
            baseColor: m.color.clone(),
            baseEnv: m.envMapIntensity ?? 1,
            baseMetal: m.metalness,
          };
          twin.set(m, t!);
          twin.set(t!, t!);
        }
        return t!;
      };
      let dimmed: any[] = [];
      cleanup.push(() => {
        for (const t of twin.values()) t.dispose();
      });
      const dimSetFor = (b: Beat) => {
        if (b.dim) return b.dim;
        const keep = new Set<THREE.Object3D>();
        for (const p of b.nodes) p.node.traverse((o) => keep.add(o));
        const out: any[] = [];
        droneRoot.traverse((o: any) => {
          if (o.isMesh && !keep.has(o)) out.push(o);
        });
        b.dim = b.nodes.length ? out : [];
        return b.dim;
      };
      function setDim(b: Beat | null) {
        for (const m of dimmed) if (m.material.userData?.normal) m.material = m.material.userData.normal;
        dimmed = b ? dimSetFor(b) : [];
        for (const m of dimmed) m.material = twinOf(m.material);
      }

      /* ------------------------------------------------------- sequencing */
      const Q = cfg.sequence;
      const TRAVEL = Q.travel;
      const HOLD = Q.hold;
      const dur = () => TRAVEL * 2 + HOLD;
      const ease = (x: number) => x * x * (3 - 2 * x);
      const envelope = (l: number) =>
        l < TRAVEL ? ease(l / TRAVEL) : l < TRAVEL + HOLD ? 1 : 1 - ease(Math.min(1, (l - TRAVEL - HOLD) / TRAVEL));

      let beatIdx = 0;
      let t = 0;
      let camH = cfg.camera?.height ?? 0.5;
      let orbitAngle = 0;
      const _q = new THREE.Quaternion();
      const restore = (b: Beat) => {
        for (const p of b.nodes) {
          p.node.position.copy(p.pos);
          p.node.quaternion.copy(p.quat);
          p.node.scale.copy(p.scl);
        }
      };

      function present(b: Beat, k: number, elapsed: number) {
        if (!b.nodes.length) {
          spotL.intensity = 0;
          beam.visible = false;
          motes.visible = false;
          return;
        }
        restore(b);
        if (k <= 0.0001) {
          spotL.intensity = 0;
          beam.visible = false;
          motes.visible = false;
          return;
        }
        const fwd = camera.getWorldDirection(new THREE.Vector3());
        const rightv = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
        const dist = droneRadius * 2.55;
        const anchor = camera.position
          .clone()
          .addScaledVector(fwd, dist)
          .addScaledVector(rightv, -dist * S.stageLeft)
          .addScaledVector(camera.up, dist * (S.stageLift ?? 0));
        if (b.faceOn) anchor.addScaledVector(camera.up, dist * (S.boardTilt ?? 0));
        const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * dist;
        const wantScale =
          THREE.MathUtils.clamp((halfH * (b.partSize ?? Q.partSize)) / (b.radius as number), 0.2, 80) / pivot.scale.x;
        const spin = new THREE.Quaternion().setFromAxisAngle(camera.up, elapsed * Q.inspectSpin);
        const SS = wantScale * pivot.scale.x;

        // The spotlight strikes only once the part has arrived, and cuts as it
        // leaves. That cut is the cue for the copy on the right.
        const arrived = elapsed >= TRAVEL && elapsed <= TRAVEL + HOLD;
        const strike = arrived
          ? THREE.MathUtils.clamp((elapsed - TRAVEL) / Math.max(S.strike * HOLD, 1e-3), 0, 1)
          : 0;
        const shoot = 1 - (1 - strike) ** 3;
        const ignite = 1 + 0.9 * Math.exp(-7 * strike);
        const sideAng = THREE.MathUtils.degToRad(S.sideAngle);
        const lampPos = anchor
          .clone()
          .addScaledVector(camera.up, dist * S.height)
          .addScaledVector(rightv, dist * 0.55 * Math.sin(sideAng))
          .addScaledVector(fwd, -dist * 0.55 * Math.cos(sideAng));
        spotL.position.copy(lampPos);
        spotL.target.position.copy(anchor);
        spotL.target.updateMatrixWorld();
        spotL.angle = THREE.MathUtils.degToRad(S.coneAngle);
        spotL.penumbra = S.softness;
        spotL.intensity = S.power * shoot * ignite * droneRadius * droneRadius;
        const dirv = anchor.clone().sub(lampPos).normalize();
        const span = lampPos.distanceTo(anchor) * 6.0 * shoot;
        const rad = Math.tan(THREE.MathUtils.degToRad(S.coneAngle)) * span * 0.55 * shoot;
        beam.visible = strike > 0.01;
        beamMat.uniforms.uOpacity.value = 0.085 * S.beam * shoot * ignite * BEAM_GAIN;
        beam.scale.set(rad, Math.max(span, 1e-5), rad);
        beam.position.copy(lampPos).addScaledVector(dirv, span * 0.5);
        beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dirv);
        motes.visible = beam.visible;
        motes.position.copy(beam.position);
        motes.quaternion.copy(beam.quaternion);
        // The mote cloud is authored in a unit cone with y from 0 to 1, and the
        // beam mesh is a unit cone centred on its own origin, so shift by half.
        motes.scale.set(rad, span, rad);
        motes.position.addScaledVector(dirv, -span * 0.5);
        moteMat.uniforms.uOpacity.value = 0.22 * S.beam * shoot;
        moteMat.uniforms.uTime.value = elapsed;
        moteMat.uniforms.uSize.value = Math.max(0.6, droneRadius * 6);

        const holdT = THREE.MathUtils.clamp((elapsed - TRAVEL) / Math.max(HOLD, 1e-3), 0, 1);
        const open = holdT < 0.45 ? ease(holdT / 0.45) : holdT < 0.7 ? 1 : 1 - ease((holdT - 0.7) / 0.3);
        const ref = (b.radius as number) * SS;

        for (const p of b.nodes) {
          // Teardown: the plate and its screws lift, the video stack lifts less,
          // then the frame goes home while the video stack stays lit.
          let kk = k;
          if (b.choreo === 'frame-teardown') {
            const isVideo = p.withVideo || VIDEO_RE.test(tidy(p.node.name));
            if (!isVideo && holdT > 0.55) {
              const back = 1 - Math.min(1, (holdT - 0.55) / 0.25);
              kk = k * (back * back * (3 - 2 * back));
            }
          }
          const off = p.worldCentre.clone().sub(b.centre as THREE.Vector3).multiplyScalar(SS).applyQuaternion(spin);
          if (b.choreo === 'frame-teardown') {
            if (p.withTop) off.addScaledVector(camera.up, ref * 1.15 * open);
            else if (p.withVideo || VIDEO_RE.test(tidy(p.node.name)))
              off.addScaledVector(camera.up, ref * 0.55 * open);
          }
          const targetCentre = anchor.clone().add(off);
          const o2c = p.worldCentre.clone().sub(p.worldOrigin).multiplyScalar(SS).applyQuaternion(spin);
          const wantLocal = p.node.parent!.worldToLocal(targetCentre.sub(o2c));
          p.node.position.lerpVectors(p.pos, wantLocal, kk);
          p.node.parent!.getWorldQuaternion(_q);
          const target = _q.clone().invert().multiply(spin).multiply(_q).multiply(p.quat);
          p.node.quaternion.copy(p.quat).slerp(target, kk);
          p.node.scale.copy(p.scl).lerp(p.scl.clone().multiplyScalar(wantScale), kk);
        }
      }

      /* ----------------------------------------------------------- scroll
       * The reader's wheel moves a TARGET; a critically damped spring moves the
       * position. No velocity clamp: throttling input feels broken. On release
       * the destination is committed ONCE in the direction of travel, so the
       * timeline can never reverse under someone mid-transition.
       *
       * Stops come in two kinds. A PART stop is the middle of a beat's hold,
       * part under the spotlight. Between two part stops sits a REST stop at
       * the beat boundary, where the envelope is exactly zero: the part has
       * flown home and the whole drone reads for a breath before the next
       * scroll pulls the next part out. Without these the sequence chains
       * spotlight into spotlight and the return-home never gets seen. */
      const stopForBeat = (i: number) => i * dur() + TRAVEL + HOLD * 0.5;
      type Stop = {pos: number; beat: number; part: boolean};
      const STOPS: Stop[] = [];
      for (let i = 0; i < BEATS.length; i++) {
        STOPS.push({pos: stopForBeat(i), beat: i, part: true});
        // A rest only earns its place between two beats that both pull a part
        // out; next to a whole-drone beat it would be the same shot twice.
        if (i < BEATS.length - 1 && BEATS[i].nodes.length && BEATS[i + 1].nodes.length)
          STOPS.push({pos: (i + 1) * dur(), beat: i + 1, part: false});
      }
      const stopPos = (si: number) => STOPS[si].pos;
      const partStopIdx = (beat: number) => STOPS.findIndex((s) => s.part && s.beat === beat);
      const nearestIdx = (x: number) => {
        let best = 0;
        let bd = Infinity;
        for (let i = 0; i < STOPS.length; i++) {
          const d = Math.abs(STOPS[i].pos - x);
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
        return best;
      };
      // Start AT the first stop, not at zero. Zero is not a stop, so the
      // "absorb input until the current beat has been seen" guard could never
      // be satisfied and the hero ignored scrolling entirely.
      let target = stopPos(0);
      let pos = stopPos(0);
      let vel = 0;
      let lastWheel = 0;
      let everScrolled = false;
      let gestureFrom = 0;
      let gestureDir = 0;
      let committed: number | null = null;
      const GESTURE_GAP_MS = 220;
      const MIN_DWELL_S = cfg.scroll?.minDwellS ?? 1.4;    // seconds a part must be presented before you can move on
      const REST_DWELL_S = 0.45;                           // a rest is a breath, not a chapter
      // A beat is unskippable. Once committed, input is absorbed until the part
      // has arrived AND its hold has run, so nobody can flick past a product
      // without its spotlight moment. This is the "plays at its own pace" rule:
      // scrolling chooses WHICH beat, the animation owns HOW it gets there.
      let settledAt = 0;       // stop index the sequence has finished playing
      let dwell = 0;           // seconds the current stop has been presented
      // Only render, and only take keys, when the hero is actually on screen.
      let onScreen = true;
      const io = new IntersectionObserver(
        (es) => {
          onScreen = es[0]?.isIntersecting ?? true;
        },
        {threshold: 0},
      );
      io.observe(el);
      cleanup.push(() => io.disconnect());

      const onWheel = (e: WheelEvent) => {
        // ctrl+wheel is pinch-zoom and browser zoom. Never swallow it.
        if (e.ctrlKey) return;

        const now = performance.now();
        if (now - lastWheel > GESTURE_GAP_MS) {
          gestureFrom = nearestIdx(pos);
          gestureDir = 0;
          committed = null;
        }

        // Release the page at the ends, with a margin. Keyed off which stop the
        // gesture began at rather than a raw position threshold, so the exit is
        // not sensitive to exactly where the spring settles.
        const first = 0;
        const last = STOPS.length - 1;
        const eps = dur() * 0.08;
        const atLast = gestureFrom >= last && pos >= stopPos(last) - eps && e.deltaY > 0;
        const atFirst = gestureFrom <= first && pos <= stopPos(first) + eps && e.deltaY < 0;
        if (atLast || atFirst) return;   // do not preventDefault: page scrolls on

        e.preventDefault();
        everScrolled = true;

        // Absorb everything until the current beat has been seen. Without this,
        // repeated flicks (or one long momentum tail broken into several
        // gestures) walk straight through the sequence.
        const cur = committed ?? nearestIdx(pos);
        if (settledAt !== cur) {
          lastWheel = now;
          return;
        }

        if (e.deltaY !== 0) gestureDir = Math.sign(e.deltaY);
        lastWheel = now;

        // Firefox reports lines, not pixels; Chrome reports pixels; some mice
        // report pages. Normalise before scaling or Firefox scrolls ~20x slower.
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
        const px = e.deltaY * unit;
        const step = Math.sign(px) * Math.min(Math.abs(px), 60) * (cfg.scroll?.gain ?? 0.0016) * dur();

        // THE important bound. A trackpad's momentum tail fires at frame rate
        // for a second or more after the finger lifts, and no time-based
        // "gesture ended" test can distinguish it from real input. So do not
        // try: bound the DISTANCE instead. Within one gesture the target can
        // never travel more than one stop from where it began, which makes one
        // flick equal exactly one stop (part or rest) no matter how long the
        // tail runs.
        const lo = stopPos(Math.max(first, gestureFrom - 1));
        const hi = stopPos(Math.min(last, gestureFrom + 1));
        target = Math.max(lo, Math.min(hi, target + step));
      };
      el.addEventListener('wheel', onWheel, {passive: false});
      cleanup.push(() => el.removeEventListener('wheel', onWheel));

      /* ---------------------------------------------------- drag to rotate
       * Matches the old hero: 0.004 rad per pixel, horizontal drag turns the
       * drone and KEEPS the new heading (the auto-orbit simply resumes from
       * there). Vertical drag tilts, holds the tilt while the timeline rests,
       * and eases home once the sequence travels to the next stop.
       *
       * The old scene rotated the model; this one orbits the camera, so a
       * horizontal drag goes straight into orbitAngle -- which is what makes the
       * heading persist for free. The tilt needs its own offset because camH is
       * lerped toward a per-beat target every frame and would fight a direct
       * write. Vertical page scrolling is untouched: this is pointer input, the
       * wheel handler above is separate.
       */
      let dragging = false;
      let dragTilt = 0;
      let lastPtr = {x: 0, y: 0};
      const onPtrDown = (e: PointerEvent) => {
        // Left button / touch / pen only, and never on the rail's buttons.
        if (e.button !== 0) return;
        dragging = true;
        lastPtr = {x: e.clientX, y: e.clientY};
        el.setPointerCapture?.(e.pointerId);
      };
      const onPtrMove = (e: PointerEvent) => {
        if (!dragging) return;
        const dx = e.clientX - lastPtr.x;
        const dy = e.clientY - lastPtr.y;
        lastPtr = {x: e.clientX, y: e.clientY};
        // Sign chosen so the drone reads as GRABBED: drag right pulls the face
        // under the cursor to the right (the camera orbits the other way).
        orbitAngle += dx * 0.004;
        // The tilt is the y-component of the orbit offset before normalising,
        // and the horizontal component is always unit length, so the view can
        // never cross the pole. +-2.5 lets a drag reach ~60 degrees below the
        // drone (enough to read the underside of a spotlit part) while keeping
        // the asymptote comfortably away.
        dragTilt = THREE.MathUtils.clamp(dragTilt + dy * 0.007, -2.5, 2.5);
      };
      const onPtrUp = () => {
        dragging = false;
      };
      el.addEventListener('pointerdown', onPtrDown);
      window.addEventListener('pointermove', onPtrMove);
      window.addEventListener('pointerup', onPtrUp);
      window.addEventListener('pointercancel', onPtrUp);
      el.style.cursor = 'grab';
      cleanup.push(() => {
        el.removeEventListener('pointerdown', onPtrDown);
        window.removeEventListener('pointermove', onPtrMove);
        window.removeEventListener('pointerup', onPtrUp);
        window.removeEventListener('pointercancel', onPtrUp);
      });

      // Keyboard: arrows, PageUp/Down, Home/End step between stops. Without
      // this a keyboard user simply scrolls past and never sees five of the six
      // beats. The rail dots call goTo with a BEAT index; the keyboard walks
      // the stop list itself so it gets the rests too.
      const goToStop = (si: number) => {
        const idx = Math.max(0, Math.min(STOPS.length - 1, si));
        gestureFrom = idx;
        gestureDir = 0;
        committed = idx;
        everScrolled = true;
        lastWheel = performance.now() - 2000;
        target = stopPos(idx);
      };
      const goTo = (i: number) =>
        goToStop(partStopIdx(Math.max(0, Math.min(BEATS.length - 1, i))));
      const onKey = (e: KeyboardEvent) => {
        const cur = nearestIdx(target);
        let next: number | null = null;
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'PageDown') next = cur + 1;
        else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'PageUp') next = cur - 1;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = STOPS.length - 1;
        if (next === null) return;
        // At the ends, let the key do its normal thing and leave the hero.
        if (next < 0 || next > STOPS.length - 1) return;
        e.preventDefault();
        goToStop(next);
      };
      // Listen on the document, gated on the hero being on screen: the canvas
      // is not focusable, and a reader using the rail should still be able to
      // arrow between stops.
      const onDocKey = (e: KeyboardEvent) => {
        if (!onScreen) return;
        const t = e.target as HTMLElement | null;
        if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
        onKey(e);
      };
      document.addEventListener('keydown', onDocKey);
      cleanup.push(() => document.removeEventListener('keydown', onDocKey));

      /* ------------------------------------------------------------- loop */
      // A GPU reset or a backgrounded mobile tab kills the context. Without
      // this the hero is permanently blank with no signal.
      const onLost = (ev: Event) => {
        ev.preventDefault();
        setError('graphics context lost, reloading the view');
      };
      const onRestored = () => setError(null);
      renderer.domElement.addEventListener('webglcontextlost', onLost);
      renderer.domElement.addEventListener('webglcontextrestored', onRestored);
      cleanup.push(() => {
        renderer.domElement.removeEventListener('webglcontextlost', onLost);
        renderer.domElement.removeEventListener('webglcontextrestored', onRestored);
      });

      const clock = new THREE.Clock();
      let lastBeat = -1;
      let lastDimBeat = -1;
      let sizedTo = '';
      const resizeIfNeeded = () => {
        const w = Math.round(el.clientWidth);
        const h = Math.round(el.clientHeight);
        if (!w || !h) return;
        const dpr = Math.min(devicePixelRatio, 2);
        const key = `${w}x${h}@${dpr}`;
        if (key === sizedTo) return;
        sizedTo = key;
        renderer.setPixelRatio(dpr);
        renderer.setSize(w, h, true);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };

      camera.position.copy(droneCentre).add(new THREE.Vector3(1, 0.5, 1).normalize().multiplyScalar(droneRadius * 2.15));
      camera.near = droneRadius / 300;
      camera.far = droneRadius * 60;
      resizeIfNeeded();

      let loopErrors = 0;
      let testDt: number | null = null;
      const frame = () => {
       try {
        if (!TEST && (!onScreen || document.hidden)) return;
        resizeIfNeeded();
        const dt = testDt ?? Math.min(clock.getDelta(), 0.05);
        if (testDt !== null) clock.getDelta();   // keep the clock in step

        const idle = performance.now() - lastWheel;
        if (everScrolled && idle > 120) {
          if (committed === null) {
            const fromPos = stopPos(gestureFrom);
            const moved = (target - fromPos) * (gestureDir || 1);
            // Stops are no longer evenly spaced (rest-to-part is closer than
            // part-to-part), so the intent threshold is a fraction of THIS
            // gap, not of a beat length.
            const nextIdx = Math.max(0, Math.min(STOPS.length - 1, gestureFrom + (gestureDir || 1)));
            const gap = Math.abs(stopPos(nextIdx) - fromPos) || dur();
            const advance = moved > gap * (cfg.scroll?.commitAt ?? 0.28) || Math.abs(vel) > dur() * 0.6;
            committed = Math.max(0, Math.min(STOPS.length - 1, gestureFrom + (advance ? gestureDir || 1 : 0)));
          }
          const snap = stopPos(committed);
          const settle = Math.min(1, (idle - 120) / 260);
          target += (snap - target) * (1 - (1 - (cfg.scroll?.magnet ?? 0.14) * settle) ** (dt * 60));
        }
        const omega = 2 * Math.PI * (cfg.scroll?.springHz ?? 0.55);
        const f = 1 + 2 * dt * omega;
        const oo = omega * omega;
        const hoo = dt * oo;
        const hhoo = dt * hoo;
        const det = 1 / (f + hhoo);
        const nx = (f * pos + dt * vel + hhoo * target) * det;
        const nv = (vel + hoo * (target - pos)) * det;
        pos = nx;
        vel = nv;

        beatIdx = Math.min(BEATS.length - 1, Math.max(0, Math.floor(pos / dur())));
        t = pos - beatIdx * dur();
        const b = BEATS[beatIdx];

        if (beatIdx !== lastDimBeat) {
          lastDimBeat = beatIdx;
          setDim(b);
        }
        // Report progress across the STOPS, not the raw timeline: the first
        // stop sits at 8% and the last at 92% of the span, so pos/span never
        // reaches either end and the rail never lines up with its own dots.
        const p0 = stopPos(0);
        const p1 = stopPos(STOPS.length - 1);
        onProgress?.(THREE.MathUtils.clamp((pos - p0) / Math.max(p1 - p0, 1e-6), 0, 1));

        // The hold is "seen" once the part has arrived and its hold has run
        // long enough for the spotlight to strike and settle. A rest just has
        // to read as the whole drone for a moment.
        {
          const cur = committed ?? nearestIdx(pos);
          const atStop = Math.abs(pos - stopPos(cur)) < dur() * 0.06;
          if (atStop) {
            dwell += dt;
            if (dwell > (STOPS[cur].part ? MIN_DWELL_S : REST_DWELL_S)) settledAt = cur;
          } else if (settledAt !== cur) {
            dwell = 0;
          }
        }

        const kRaw = envelope(t);
        const k = b.nodes.length ? kRaw : 0;

        // The copy panel follows the SPOTLIGHT, not the timeline: it shows a
        // part while that part is out (k high) and clears during travel and
        // rests, so a rest reads as the whole drone with no caption racing
        // ahead to the next part. Whole-drone beats get no caption at all:
        // the size tab already names what is on screen.
        {
          const display = b.nodes.length && kRaw > 0.3 ? beatIdx : -1;
          if (display !== lastBeat) {
            lastBeat = display;
            onBeat?.(display >= 0 ? {id: b.id, title: b.title, note: b.note} : null, display);
          }
        }

        for (const g of propPivots)
          (g as any).userData.spin.rotation.z += dt * Q.propRate * (1 - k) * (g as any).userData.dir * Q.propHanded;

        for (const other of BEATS) if (other !== b) restore(other);
        pivot.scale.setScalar(THREE.MathUtils.lerp(1, S.shrinkDrone, k));
        const bright = THREE.MathUtils.lerp(1, 1 - (b.fade ?? S.darkenRest), k);
        for (const m of twin.values()) {
          const u = (m as any).userData;
          if (!u?.baseColor) continue;
          m.color.copy(u.baseColor).multiplyScalar(bright);
          m.envMapIntensity = u.baseEnv * bright;
          // Albedo alone is not enough: a metal with a black base colour still
          // returns a full specular highlight, so the spotlight was blowing the
          // backgrounded drone out to white. Fade metalness out with it.
          if (u.baseMetal === undefined) u.baseMetal = m.metalness;
          m.metalness = u.baseMetal * bright;
        }
        const d = THREE.MathUtils.lerp(1, 1 - S.dimLights, k);
        hemi.intensity = BASE.hemi * d;
        keyL.intensity = BASE.key * d;
        fillL.intensity = BASE.fill * d;
        rimL.intensity = BASE.rim * d;
        bncL.intensity = BASE.bounce * d;

        // Auto-orbit pauses while the hand is on the drone. The tilt persists
        // while the timeline rests, so a reader can hold a view of the part's
        // underside; it eases home once the sequence travels again.
        const travelling = Math.abs(target - pos) > dur() * 0.01 || Math.abs(vel) > dur() * 0.01;
        if (!dragging) {
          orbitAngle += dt * Q.autoOrbit;
          if (travelling) {
            dragTilt *= (1 - Math.min(1, 3 * dt));
            if (Math.abs(dragTilt) < 0.0005) dragTilt = 0;
          }
        }
        el.style.cursor = dragging ? 'grabbing' : 'grab';
        const wantH = b.faceOn ? (cfg.camera?.heightOnBoard ?? 0.72) : (cfg.camera?.height ?? 0.5);
        camH += (THREE.MathUtils.lerp(cfg.camera?.height ?? 0.5, wantH, k) - camH) * (1 - 0.35 ** dt);
        const back = droneRadius * ((cfg.camera?.distance ?? 2.15) + (cfg.camera?.dollyOnShow ?? 0.92) * k);
        const off = new THREE.Vector3(Math.cos(orbitAngle), camH + dragTilt, Math.sin(orbitAngle)).normalize().multiplyScalar(back);
        // The framing point sits a little below the drone's centre (camera and
        // lookAt shift together), which lifts the drone up the viewport: the
        // bottom strip (wordmark, rail, Shop) eats into the lower frame, so
        // dead centre reads as sitting too low.
        const focus = droneCentre.clone();
        focus.y -= droneRadius * (cfg.camera?.lift ?? 0.24);
        // A drag has to track the hand 1:1, so it writes the position directly.
        // The eased lerp is for the auto-orbit and the per-beat dolly, where the
        // smoothing is the point.
        if (dragging) camera.position.copy(focus.clone().add(off));
        else camera.position.lerp(focus.clone().add(off), 1 - 0.004 ** dt);
        camera.lookAt(focus);

        // The camera must be posed BEFORE the presentation: a spotlit part is
        // anchored to the camera, so presenting against last frame's pose makes
        // the part chase the camera one frame behind. Under a drag (camera
        // written directly, no smoothing) that lag reads as vibration.
        scene.updateMatrixWorld(true);
        present(b, k, t);

        renderer.render(scene, camera);
       } catch (err) {
        // One throw in here would otherwise repeat 60 times a second forever
        // with nothing visible to the reader.
        if (loopErrors++ < 3) console.error('[hero] render loop:', err);
        if (loopErrors === 3) {
          renderer.setAnimationLoop(null);
          setError('animation stopped');
        }
       }
      };
      renderer.setAnimationLoop(frame);
      cleanup.push(() => renderer.setAnimationLoop(null));

      // requestAnimationFrame is suspended in a backgrounded tab, so an
      // automated check cannot integrate the scroll spring at all. In test mode
      // only, keep a timer ticking so the sequence is drivable headlessly.
      if (TEST) {
        const t = setInterval(() => {
          if (document.hidden) frame();
        }, 16);
        cleanup.push(() => clearInterval(t));
      }

      onSeeker?.(goTo);
      if (TEST) {
        (window as Window & {__hero?: unknown}).__hero = {
          goTo,
          // Advance n frames at a fixed 16 ms, ignoring wall clock.
          step: (n = 60) => {
            for (let i = 0; i < n; i++) {
              testDt = 1 / 60;
              frame();
            }
            testDt = null;
          },
          state: () => ({
            pos,
            target,
            beat: beatIdx,
            committed,
            settledAt,
            stops: STOPS.map((s) => s.pos),
            partStops: STOPS.map((s) => s.part),
          }),
          wheel: (deltaY: number, deltaMode = 0) =>
            renderer.domElement.dispatchEvent(
              new WheelEvent('wheel', {deltaY, deltaMode, bubbles: true, cancelable: true}),
            ),
          scene,
          camera,
          THREE,
          beats: BEATS.map((b) => b.id),
          dur: dur(),
        };
      }
      onReady?.();
    })().catch((e: unknown) => {
      console.error('[hero]', e);
      setError(e instanceof Error ? e.message : String(e));
      // Always release the splash, or a 404 leaves the page reading LOADING
      // forever behind a dim layer.
      onReady?.();
    });

    return () => {
      disposed = true;
      for (const fn of cleanup.reverse()) fn();
      // Belt and braces: if an in-flight instance still managed to append, do
      // not leave a dead canvas stacked over the live one.
      for (const c of Array.from(el.querySelectorAll('canvas'))) c.remove();
    };
  }, [model, onBeat, onBeats, onLoad, onProgress, onReady, onSeeker]);

  return (
    // Decorative: every beat's copy is in the DOM in .hp-fallback, and
    // keyboard control is the rail's real buttons, so the canvas itself carries
    // no semantics and is not a tab stop.
    <div ref={host} aria-hidden="true" style={{position: 'absolute', inset: 0}}>
      {error ? (
        <div style={{position: 'absolute', left: 16, bottom: 16, color: '#ff8574', font: '12px ui-monospace'}}>
          hero: {error}
        </div>
      ) : null}
    </div>
  );
}
