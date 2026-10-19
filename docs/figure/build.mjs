// Fig 1 for the sek README: a safe-deposit bench.
// node build.mjs          → ../sek-dark.svg, ../sek-light.svg (README) + sek.html, sek-light.html (review pages, git-ignored)
// node build.mjs --audit  → the same, then the geometry audit (kit/audit.mjs); exits 1 on any problem
// Line-end check (skill script): node <anatomy>/scripts/lines.mjs sek.html
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "./kit/iso-kit.mjs";
import * as G from "./kit/lathe.mjs";
import { tubePieces, tubeSvg } from "./kit/tube.mjs";
import * as A from "./kit/audit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(HERE, "..");

// ── Truth (Sources/sek) ─────────────────────────────────────────────
// sek unlock defaults to --ttl 1h; the time lock's dial is one hour.
const TTL_MIN = 60;
const LEFT_MIN = 42; // remaining session time shown
const SECRETS = 6; // envelope files ~/.sek/secrets/NAME.sek
const READS = 3; // agent.log lines: "get NAME by node (pid) ← zsh (pid)"

// ── Card and camera ─────────────────────────────────────────────────
const W = 640;
const H = 370;
const AZ = 52;

const PLATE = { x: -142, y: -58, w: 278, d: 112, r: 8 };
const PLATE_H = 12;
const FOOT_H = 5;

const P = k.fitProjection(
  [...k.boxCorners(PLATE, -PLATE_H - FOOT_H, 0), [-28, -22, 74], [-28, 14, 74], [4, -19, 67], [-134, -28, 36]],
  W,
  H,
  { pad: 32, azimuth: AZ },
);
const V = G.viewOf(P);
const KS = G.scaleOf(P);
const at = (p) => k.iso(p, P);
const S = (paths, style) => k.solidSvg(paths, style);
const Ln = (d, style) => k.lineSvg(d, style);
const Dots = (points, style) => k.dotsSvg(points, style);
const path3 = (points, closed = false) => k.pathOf(points.map(at), closed);
const byDepth = (points) => [...points].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));

// ── Recorder: every part records its true shape; settle orders them ─
const R = A.recorder(P);
const record = R.solid;
function put(name, ref, svg, shapes = [], { bias = 0 } = {}) {
  return R.put({ name, at: ref, bias, svg, shapes, piece: "bench" });
}
function box(name, plan, z, h, style = {}, { steps = 3, bevel = 0, extra = "", inner = "", bias = 0 } = {}) {
  const shape = record(A.slab(plan, z, h, { name }, steps));
  put(name, [plan.x + plan.w / 2, plan.y + plan.d / 2, z + h / 2], S(k.slabOf(plan, z, h, P, steps, bevel), { tone: "mid", ...style, inner }) + extra, [shape], { bias });
  return shape;
}
function post(name, cx, cy, r, z, h, style = {}, { steps = 32, bevel = 0, extra = "", inner = "", bias = 0 } = {}) {
  const shape = record(A.cylinder(cx, cy, r, z, h, { name }));
  put(name, [cx, cy, z + h / 2], S(k.cylinder(cx, cy, r, z, h, P, steps, bevel), { tone: "mid", ...style, inner }) + extra, [shape], { bias });
  return shape;
}
function disc(name, F, s0, s1, r, style = {}, { extra = "", inner = "", bias = 0, steps, bevel = 0 } = {}) {
  const shape = record(A.disc(F, s0, s1, r, { name }));
  const paths = G.disc(s0, s1, r, F, P, { bevel, ...(steps ? { steps } : {}) });
  put(name, G.add3(F.o, G.mul3(F.a, (s0 + s1) / 2)), S(paths, { tone: "mid", ...style, inner }) + extra, [shape], { bias });
  return shape;
}
function ball(name, c, r, style = {}) {
  const shape = record(A.ball(c, r, { name }));
  put(name, c, S(G.sphereOf(c, r, P, { steps: 32 }), { tone: "mid", ...style }), [shape]);
  return shape;
}
function cable(name, points, r, { shells = [true, true], bend = 3.2 } = {}) {
  const route = G.fillet(points, Math.max(bend, r * 2.6), 10, { P, tube: r });
  const total = G.pathLength(route);
  const SHELL = Math.max(1.8, r * 2.4);
  const gaps = [...(shells[0] ? [[0, SHELL]] : []), ...(shells[1] ? [[total - SHELL, total]] : [])];
  R.route(name, route, r, { gaps, limp: true, rims: shells.map((on) => (on ? r * 1.9 : r)), piece: "bench" });
  tubePieces(route, r, P, { maxLength: 10, spacing: 0.9, gaps }).forEach((piece, index) =>
    put(`${name}:${index}`, piece.mid, tubeSvg(piece, { tone: "mid" }), [A.tube(piece.points, piece.radii)], { bias: 0.05 }),
  );
  [0, 1].forEach((index) => {
    if (!shells[index]) return;
    const end = index ? route[route.length - 1] : route[0];
    const tangent = G.tangentAlong(route, index ? total : 0);
    const F = G.frameAlong(end, tangent);
    const [s0, s1] = index ? [-SHELL, 0] : [0, SHELL];
    const shape = record(A.disc(F, s0, s1, r * 1.9, { name: `${name}.shell${index}`, owner: name }));
    put(`${name}.shell${index}`, G.add3(end, G.mul3(tangent, (s0 + s1) / 2)), S(G.disc(s0, s1, r * 1.9, F, P, { steps: 24, bevel: 0.2 }), { tone: "mid" }), [shape], { bias: 0.15 });
  });
  return route;
}

// ── Bench: base plate on feet, groove, screws, ruler, label plate ────
const back = [];
back.push(`<path class="iso-halo" d="${k.haloOf(PLATE, -PLATE_H - FOOT_H, PLATE_H, P)}"/>`);
for (const [x, y] of byDepth(k.corners(PLATE, 22))) {
  back.push(S(k.cylinder(x, y, 7, -PLATE_H - FOOT_H, 1.6, P, 28), { tone: "lo" }));
  back.push(S(k.cylinder(x, y, 5.4, -PLATE_H - FOOT_H + 1.6, FOOT_H - 1.6, P, 28), { tone: "mid" }));
}
back.push(S(k.slabOf(PLATE, -PLATE_H, PLATE_H, P, 8, 1.6), { tone: "mid", inner: Ln(k.sideSeam(PLATE, -4, P, 8), { tone: "faint" }) }));
back.push(Ln(k.planOutline(k.insetPlan(PLATE, 5), 0, P), { tone: "lo" }));
const plateScrews = k.corners(PLATE, 10);
back.push(Ln(plateScrews.map(([x, y]) => k.ring(x, y, 2.2, 0, P, 16)).join(""), { tone: "lo" }));
back.push(Dots(plateScrews.map(([x, y]) => at([x, y, 0])), { size: 0.5 }));
record(A.slab(PLATE, -PLATE_H, PLATE_H, { name: "stand.plate", ground: true }, 8));

const STRIP = { x: -126, y: PLATE.y + PLATE.d - 12, w: 246, d: 6, r: 1 };
back.push(S(k.slabOf(STRIP, 0, 0.6, P, 3), { tone: "lo", crease: "none" }));
const ticks = k.topTicks(STRIP.x + 4, STRIP.x + STRIP.w - 4, 4, 5, STRIP.y, 0.6, [1.8, 3.4], P);
back.push(Ln(ticks.minor, { tone: "lo" }), Ln(ticks.major, { tone: "mid" }));
back.push(Dots([at([STRIP.x + 2, STRIP.y + 3, 0.6]), at([STRIP.x + STRIP.w - 2, STRIP.y + 3, 0.6])], { size: 0.45 }));

const LABEL = { x: -40, y: 28, w: 42, d: 11, r: 1.2 };
back.push(S(k.slabOf(LABEL, 0, 0.8, P, 3), { tone: "lo", crease: "none" }));
back.push(Ln(k.planOutline(k.insetPlan(LABEL, 1.4), 0.8, P, 3), { tone: "faint" }));
back.push(k.faceTextSvg(k.topMatrix([LABEL.x + LABEL.w / 2, LABEL.y + 6.9], 0.8, P, "x"), "SECURE ENCLAVE", { size: 3, tone: "mid", anchor: "middle" }));
back.push(Dots([at([LABEL.x + 2.6, LABEL.y + LABEL.d / 2, 0.8]), at([LABEL.x + LABEL.w - 2.6, LABEL.y + LABEL.d / 2, 0.8])], { size: 0.45 }));

// ── Envelope card: thin in x, face (+x) carries the flap and wax seal ─
function envelope(name, x, y0, d, z0, h, { tab = null, style = { tone: "hi" } } = {}) {
  const T = 1.2;
  const plan = { x, y: y0, w: T, d, r: 0.3 };
  const fx = x + T;
  const apex = [fx, y0 + d / 2, z0 + h - d * 0.36];
  const flap = path3([[fx, y0, z0 + h], apex, [fx, y0 + d, z0 + h]]);
  const card = record(A.slab(plan, z0, h, { name }, 2));
  put(name, [x + T / 2, y0 + d / 2, z0 + h / 2], S(k.slabOf(plan, z0, h, P, 2), { ...style, inner: Ln(flap, { tone: "lo" }) }), [card]);
  const F = G.frameAlong([fx, apex[1], apex[2]], [1, 0, 0]);
  disc(`${name}.seal`, F, 0, 0.7, 2.1, { tone: "mid" }, { steps: 28, extra: Ln(G.circleOf(F, 0.7, 1.2, P), { tone: "lo" }) });
  if (tab !== null) {
    const tplan = { x, y: y0 + tab, w: T, d: 10, r: 0.3 };
    const rule = path3([[fx, y0 + tab + 2, z0 + h + 2.4], [fx, y0 + tab + 7.4, z0 + h + 2.4]]);
    box(`${name}.tab`, tplan, z0 + h, 4.4, { tone: "hi" }, { steps: 2, extra: Ln(rule, { tone: "mid", free: true }) });
  }
}

// ── Card file of sealed .sek envelopes (left) ───────────────────────
const FILE = { x: -134, y: -28, w: 64, d: 54, r: 2 };
box("file.floor", FILE, 0, 3, { tone: "lo" }, { steps: 4, bevel: 0.5 });
box("file.back", { x: FILE.x, y: FILE.y, w: FILE.w, d: 2.4, r: 0.6 }, 3, 21, { tone: "mid" }, { steps: 2 });
box("file.left", { x: FILE.x, y: FILE.y + 2.4, w: 2.4, d: FILE.d - 4.8, r: 0.6 }, 3, 21, { tone: "mid" }, { steps: 2 });
box("file.front", { x: FILE.x, y: FILE.y + FILE.d - 2.4, w: FILE.w, d: 2.4, r: 0.6 }, 3, 9, { tone: "mid" }, {
  steps: 2,
  extra: Dots([FILE.x + 6, FILE.x + FILE.w - 6].map((x) => at([x, FILE.y + FILE.d, 7.5])), { size: 0.45 }),
});
box("file.right", { x: FILE.x + FILE.w - 2.4, y: FILE.y + 2.4, w: 2.4, d: FILE.d - 4.8, r: 0.6 }, 3, 9, { tone: "mid" }, { steps: 2 });
// pull on the front wall
box("file.pull", { x: FILE.x + 26, y: FILE.y + FILE.d, w: 12, d: 1.6, r: 0.6 }, 6.2, 2.4, { tone: "mid" }, { steps: 2 });
const TABS = [2, 16, 30];
const CARD_X = (i) => FILE.x + 8 + i * 8.4;
for (let i = 0; i < SECRETS; i++) {
  if (i === 3) continue; // its card is in the enclave slot
  envelope(`card.${i}`, CARD_X(i), FILE.y + 5, 44, 3, 28, { tab: TABS[i % 3], style: { tone: "mid" } });
}

// ── The enclave: a vault block bolted to a plinth (the lit part) ────
const PLINTH = { x: -46, y: -42, w: 72, d: 64, r: 3 };
const BODY = { x: -38, y: -34, w: 56, d: 50, r: 4 };
const BZ0 = 6;
const BZ1 = 56;
box("enclave.plinth", PLINTH, 0, BZ0, { tone: "mid" }, { steps: 4, bevel: 0.8, inner: Ln(k.sideSeam(PLINTH, 2.4, P, 4), { tone: "faint" }) });
for (const [x, y] of byDepth(k.corners(PLINTH, 3.6))) {
  post("enclave.bolt", x, y, 2.1, BZ0, 1.8, { tone: "mid" }, { steps: 6, extra: Dots([at([x, y, BZ0 + 1.8])], { size: 0.5, tone: "lo" }) });
}
const SLOT = { x: -28.6, y: -22.6, w: 3.6, d: 36.4, r: 1.2 };
const slotFill = `<path class="iso-shade" data-shade="0" d="${k.pathOf(k.ringOf(SLOT, 3).map(([x, y]) => at([x, y, BZ1])), true)}"/>`;
box("enclave.body", BODY, BZ0, BZ1 - BZ0, { tone: "hi", lit: true }, {
  steps: 6,
  bevel: 1.2,
  inner: Ln(k.sideSeam(BODY, BZ1 - 6, P, 6), { tone: "lo" }),
  extra: slotFill + Ln(k.planOutline(SLOT, BZ1, P, 3), { tone: "lo" }) + Dots(k.corners(BODY, 4.5).map(([x, y]) => at([x, y, BZ1])), { size: 0.5 }),
});
// the card being opened, standing in the slot
envelope("card.3", SLOT.x + 1.2, SLOT.y + 1.2, 34, BZ1, 15, { style: { tone: "hi" } });

// round vault door on the front face, with frame ring, hub and three spokes
const DOOR_C = [-10, BODY.y + BODY.d, 31];
const DF = G.frameOf(DOOR_C, [0, 1, 0], [1, 0, 0], [0, 0, 1]);
const DOOR_R = 15.2;
{
  const shape = record(A.body(DF, [[0, 15.9], [0, 17.9], [0.8, 17.9], [0.8, 15.9]], { name: "enclave.frame" }));
  put("enclave.frame", G.add3(DOOR_C, [0, 0.4, 0]), S(G.ringBand(0, 0.8, 15.9, 17.9, DF, P), { tone: "mid" }), [shape]);
}
disc("enclave.door", DF, 0, 2.4, DOOR_R, { tone: "hi" }, {
  bevel: 0.6,
  extra: Ln(G.circleOf(DF, 2.4, 13.4, P), { tone: "faint" }) + Dots(G.dotsOf(DF, 2.4, 11.6, 16, P, { all: true }), { size: 0.45, tone: "mid" }),
});
disc("enclave.hub", DF, 2.4, 5.4, 4.6, { tone: "mid" }, { bevel: 0.4, extra: Ln(G.circleOf(DF, 5.4, 1.6, P), { tone: "lo" }) });
for (const deg of [90, 210, 330]) {
  const a = (deg * Math.PI) / 180;
  const dir = [Math.cos(a), 0, Math.sin(a)];
  const o = G.add3(DOOR_C, [0, 3.9, 0]);
  const F = G.frameAlong(o, dir);
  const BALL = 1.5;
  const end = 12.4;
  disc("enclave.spoke", F, 4.3, end - Math.sqrt(BALL * BALL - 0.7 * 0.7), 0.7, { tone: "mid" }, { steps: 16 });
  ball("enclave.knob", G.add3(o, G.mul3(dir, end)), BALL, { tone: "mid" });
}
for (const [z0, z1] of [[19, 25], [37, 43]]) {
  post("enclave.hinge", DOOR_C[0] - 18.4, BODY.y + BODY.d + 1.4, 1.4, z0, z1 - z0, { tone: "mid" }, { steps: 16, inner: Ln(k.sideArc(DOOR_C[0] - 18.4, BODY.y + BODY.d + 1.4, 1.4, (z0 + z1) / 2, P, 12), { tone: "faint" }) });
}
// cable port on the right face
const PORT = [BODY.x + BODY.w, 2, 18];
const PF = G.frameAlong(PORT, [1, 0, 0]);
disc("enclave.port", PF, 0, 2.2, 3, { tone: "mid" }, { steps: 28, extra: Ln(G.circleOf(PF, 2.2, 2.1, P), { tone: "faint" }) });

// maker's plate on the right face: four screws and three engraved rules
{
  const fx = BODY.x + BODY.w;
  const MP = { x: fx, y: -8, w: 0.8, d: 17, r: 0.4 };
  const rules = [[12, 33.2], [9, 30.6], [11, 28]].map(([w, z]) => path3([[fx + 0.8, MP.y + 2.6, z], [fx + 0.8, MP.y + 2.6 + w, z]])).join("");
  const screws = [[MP.y + 1.3, 35.6], [MP.y + MP.d - 1.3, 35.6], [MP.y + 1.3, 25.4], [MP.y + MP.d - 1.3, 25.4]].map(([y, z]) => at([fx + 0.8, y, z]));
  box("enclave.plate", MP, 24, 13, { tone: "mid" }, { steps: 2, extra: Ln(rules, { tone: "lo", free: true }) + Dots(screws, { size: 0.45 }) });
}

// session lamp on the right face: on while the agent holds the session
{
  const LF = G.frameAlong([BODY.x + BODY.w, -20, 44], [1, 0, 0]);
  disc("enclave.lamp.bezel", LF, 0, 1.2, 3.2, { tone: "mid" }, { steps: 28 });
  disc("enclave.lamp", LF, 1.2, 2, 2.1, { tone: "hi" }, { steps: 28, extra: Ln(G.circleOf(LF, 2, 1, P), { tone: "hi" }) });
}

// time lock: a one-hour dial on the lid, needle at the session time left
const DIAL = [4, -19];
const DIAL_R = 10.4;
const DZ0 = BZ1 + 2;
const DZ1 = DZ0 + 8;
box("timer.pad", { x: -8.5, y: -31.5, w: 25, d: 25, r: 3 }, BZ1, 2, { tone: "mid" }, {
  steps: 4,
  extra: Dots(k.corners({ x: -8.5, y: -31.5, w: 25, d: 25 }, 2.4).map(([x, y]) => at([x, y, BZ1 + 2])), { size: 0.45 }),
});
{
  const [x, y] = DIAL;
  const tk = k.radialTicks(x, y, DIAL_R - 3, TTL_MIN, 5, DZ1, [1.2, 2.6], P);
  const extra = [
    Ln(k.knurl(x, y, DIAL_R, DZ1 - 3.2, DZ1, 84, P, 0.3), { tone: "lo" }),
    Ln(k.ring(x, y, DIAL_R - 2.2, DZ1, P, 64), { tone: "lo" }),
    Ln(tk.minor, { tone: "lo" }),
    Ln(tk.major, { tone: "mid" }),
  ].join("");
  post("timer.dial", x, y, DIAL_R, DZ0, DZ1 - DZ0, { tone: "hi", crease: "lo" }, { steps: 64, bevel: 0.6, extra, inner: Ln(k.sideArc(x, y, DIAL_R, DZ1 - 3.2, P, 40), { tone: "faint" }) });
  box("timer.neck", { x: x + DIAL_R - 0.25, y: y - 1.4, w: 4.25, d: 2.8, r: 0.8 }, DZ0 + 2.4, 3, { tone: "mid" }, { steps: 2 });
  const cx = x + DIAL_R + 6;
  post("timer.crown", cx, y, 2.2, DZ0 + 1.6, 4.6, { tone: "mid" }, { steps: 20, extra: Ln(k.knurl(cx, y, 2.2, DZ0 + 1.6, DZ0 + 6.2, 18, P), { tone: "lo" }) });
}

// ── Sealing stamp: the public key; anyone can seal, no prompt ──────
{
  const REST = { x: -128, y: 29, w: 14, d: 11, r: 2 };
  box("stamp.rest", REST, 0, 1.2, { tone: "lo" }, { steps: 4, bevel: 0.3 });
  const [x, y] = [REST.x + 7, REST.y + 5.5];
  post("stamp.face", x, y, 4.3, 1.2, 2.2, { tone: "mid" }, { steps: 40, bevel: 0.4 });
  post("stamp.collar", x, y, 3.2, 3.4, 1.4, { tone: "mid" }, { steps: 32 });
  post("stamp.handle", x, y, 2.5, 4.8, 7, { tone: "mid" }, { steps: 28, inner: Ln(k.sideArc(x, y, 2.5, 8.3, P, 16), { tone: "faint" }) });
  post("stamp.cap", x, y, 3.4, 11.8, 2.6, { tone: "hi" }, { steps: 32, bevel: 0.6 });
}

// ── Touch ID reader, wired to the port ──────────────────────────────
const PED = { x: 34, y: 17, w: 26, d: 22, r: 3 };
const PAD = [48, 29];
box("reader.base", PED, 0, 6, { tone: "mid" }, {
  steps: 4,
  bevel: 0.6,
  extra: Dots(k.corners(PED, 2.6).map(([x, y]) => at([x, y, 6])), { size: 0.45 }),
});
{
  const [x, y] = PAD;
  const whorl = [1.3, 2.5, 3.7, 4.9].map((r) => k.ring(x, y, r, 8.6, P, 40)).join("");
  post("reader.pad", x, y, 7.6, 6, 2.6, { tone: "hi", crease: "lo" }, { steps: 56, bevel: 0.4, extra: Ln(k.ring(x, y, 6.4, 8.6, P, 56), { tone: "mid" }) + Ln(whorl, { tone: "faint" }) });
}
post("reader.led", PED.x + PED.w - 3.4, PED.y + 3.4, 1, 6, 0.8, { tone: "hi" }, { steps: 16 });
const STRAIN = [PED.x + 3.6, PED.y + 3.6];
post("reader.strain", STRAIN[0], STRAIN[1], 1.9, 6, 3, { tone: "mid" }, { steps: 20 });
cable("reader.cable", [G.add3(PORT, [2.2, 0, 0]), [STRAIN[0], PORT[1], PORT[2]], [STRAIN[0], STRAIN[1], PORT[2]], [STRAIN[0], STRAIN[1], 9]], 0.8);

// ── Agent log: a tape printer, one printed line per read ─────────────
const PR = { x: 30, y: -52, w: 26, d: 22, r: 3 };
const PRZ = 16;
const ROLL = { y: -41, z: 25, r: 6.2, x0: 35, x1: 51 };
box("log.housing", PR, 0, PRZ, { tone: "mid" }, {
  steps: 4,
  bevel: 0.8,
  extra:
    Ln(path3([[PR.x + PR.w, -47.5, 0.6], [PR.x + PR.w, -34.5, 0.6], [PR.x + PR.w, -34.5, 2.2], [PR.x + PR.w, -47.5, 2.2]], true), { tone: "lo" }) +
    Dots([at([PR.x + PR.w, PR.y + 3, PRZ - 3]), at([PR.x + PR.w, PR.y + PR.d - 3, PRZ - 3])], { size: 0.45 }),
  inner: Ln(k.sideSeam(PR, 6, P, 4), { tone: "faint" }),
});
for (const x of [32, 51]) box("log.cheek", { x, y: ROLL.y - 7, w: 3, d: 14, r: 1 }, PRZ, 17, { tone: "mid" }, { steps: 3 });
{
  const RF = G.frameAlong([0, ROLL.y, ROLL.z], [1, 0, 0]);
  disc("log.roll", RF, ROLL.x0, ROLL.x1, ROLL.r, { tone: "hi" }, { steps: 56 });
  disc("log.nut", RF, 54, 55.2, 1.9, { tone: "mid" }, { steps: 6 });
}
const TAPE = { x: PR.x + PR.w, y: -46.5, w: 62, d: 11, r: 0.4 };
{
  const lines = [];
  for (let i = 0; i < READS; i++) {
    const x = TAPE.x + 8 + i * 13;
    lines.push(k.lineOnTop([x, TAPE.y + 2], [x, TAPE.y + 9], 0.4, P));
    lines.push(k.lineOnTop([x + 2.6, TAPE.y + 2], [x + 2.6, TAPE.y + 6.4 - (i % 2) * 1.6], 0.4, P));
  }
  box("log.tape", TAPE, 0, 0.4, { tone: "hi", crease: "none" }, { steps: 2, extra: Ln(lines.join(""), { tone: "lo", free: true }) });
}

// tape clip holding the free end
{
  const CL = { x: TAPE.x + TAPE.w - 9, y: TAPE.y - 2, w: 6, d: TAPE.d + 4, r: 1 };
  box("log.clip", CL, 0.4, 2.6, { tone: "mid" }, { steps: 3, bevel: 0.3, extra: Dots([at([CL.x + 3, CL.y + 1.6, 3]), at([CL.x + 3, CL.y + CL.d - 1.6, 3])], { size: 0.45 }) });
}

// ── Output tray: the opened envelope presented to the process ───────
const TRAY = { x: 76, y: -4, w: 50, d: 40, r: 2 };
box("tray.floor", TRAY, 0, 2, { tone: "lo" }, { steps: 4, bevel: 0.5 });
box("tray.back", { x: TRAY.x, y: TRAY.y, w: TRAY.w, d: 1.6, r: 0.5 }, 2, 4.4, { tone: "mid" }, { steps: 2 });
box("tray.left", { x: TRAY.x, y: TRAY.y + 1.6, w: 1.6, d: TRAY.d - 3.2, r: 0.5 }, 2, 4.4, { tone: "mid" }, { steps: 2 });
box("tray.front", { x: TRAY.x, y: TRAY.y + TRAY.d - 1.6, w: TRAY.w, d: 1.6, r: 0.5 }, 2, 2.6, { tone: "mid" }, { steps: 2 });
box("tray.right", { x: TRAY.x + TRAY.w - 1.6, y: TRAY.y + 1.6, w: 1.6, d: TRAY.d - 3.2, r: 0.5 }, 2, 2.6, { tone: "mid" }, { steps: 2 });
{
  const C = { x: 92, y: 4, w: 26, d: 26, r: 0.4 };
  const rules = [16, 12, 18].map((w, i) => k.lineOnTop([C.x + 4 + i * 6, C.y + 3], [C.x + 4 + i * 6, C.y + 3 + w], 2.6, P)).join("");
  box("tray.card", C, 2, 0.6, { tone: "hi" }, { steps: 2, extra: Ln(rules, { tone: "mid", free: true }) });
  const flap = [[C.x, C.y], [C.x, C.y + C.d], [C.x - 10, C.y + C.d / 2]];
  const shape = record(A.extruded(flap, 2, 0.6, { name: "tray.flap" }));
  put("tray.flap", [C.x - 4, C.y + C.d / 2, 2.3], S(k.extrude(flap, 2, 0.6, P), { tone: "hi" }), [shape]);
}

A.settle(R, P);
R.items.sort((a, b) => a.key - b.key);
const groups = R.items.map((item) => `<g data-name="${item.name}">${item.svg}</g>`);

// ── Needle (static: 42 of 60 minutes left) ──────────────────────────
const needle = (() => {
  const t = (TTL_MIN - LEFT_MIN) / TTL_MIN; // dial counts down from 0 at the top
  const angle = -t * Math.PI * 2 + Math.PI * 2;
  const [x, y] = DIAL;
  const tail = [x - Math.sin(angle) * 2.6, y + Math.cos(angle) * 2.6];
  const tip = [x + Math.sin(angle) * (DIAL_R - 3.6), y - Math.cos(angle) * (DIAL_R - 3.6)];
  // the session time still left: a band from zero round to the needle
  const arc = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * angle;
    arc.push([x + Math.sin(a) * 3.9, y - Math.cos(a) * 3.9]);
  }
  const zero = k.lineOnTop([x, y - (DIAL_R - 3)], [x, y - 3.2], DZ1, P);
  return (
    `<path class="iso-line" data-tone="mid" d="${k.onTop(arc, DZ1, P)}" style="stroke-width:1.5"/>` +
    Ln(zero, { tone: "hi" }) +
    `<path class="iso-line" data-tone="hi" data-free="start" d="${k.lineOnTop(tail, tip, DZ1 + 0.2, P)}" style="stroke-width:1.1"/>` +
    Ln(k.ring(x, y, 1.4, DZ1 + 0.2, P, 16), { tone: "mid" })
  );
})();

const LABEL_TEXT =
  "A safe-deposit bench. A heavy vault block, the Secure Enclave, is bolted to a plinth; its key never leaves it. On the left a card file holds sealed envelope cards, one per secret, each with a name tab; one card stands in the block's slot being opened. A fingerprint reader is wired to the block, a one-hour time-lock dial on its lid shows 42 minutes of session left, a tape printer logs each read, and the opened envelope lies in a tray for the process.";
const body = [...back, `<g class="sek-parts">${groups.join("")}</g>`, needle];

const FIG = "Fig 1";
const TITLE = "sek · secrets in the enclave";
const HINT = "one touch · then reads until lock";
const READOUT = `unlocked · ${LEFT_MIN}m left · ${READS} reads`;

// HTML review page (the kit's card)
for (const theme of ["dark", "light"]) {
  const svg = k.figureSvg({ width: W, height: H, label: LABEL_TEXT, body });
  const plate = k.plateHtml({
    fig: FIG,
    title: TITLE,
    hint: HINT,
    readout: READOUT,
    keys: [
      { mark: "lit", label: "The enclave: a non-exportable P-256 key that never leaves the block" },
      { mark: "raised", label: "Sealed envelopes: one .sek file per secret, sealed with the public key alone" },
      { mark: "edge", label: "Touch ID reader, time lock (session TTL) and the access-log tape" },
    ],
    caption:
      "sek seals each API key in its own envelope (ECDH + HKDF + AES-GCM, name bound in) using only the enclave's public key, so storing never prompts. Opening needs the enclave, and the enclave needs your finger: one Touch ID starts a session that relocks when the timer runs out, the screen locks or the Mac sleeps, and every read is logged with the process that asked.",
    body: `<div class="iso-stage">${svg}</div>`,
  });
  writeFileSync(join(HERE, theme === "light" ? "sek-light.html" : "sek.html"), k.pageHtml({ title: "sek figure", theme, body: plate }));
}

// Standalone SVGs for the README: the card frame is drawn inside the SVG.
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const CARD_CSS = `<style>
.sek-card{fill:var(--anatomy-card);stroke:var(--anatomy-mid);stroke-width:1;vector-effect:non-scaling-stroke}
.sek-corner{font-family:var(--anatomy-mono);font-size:10.5px;letter-spacing:.04em;fill:var(--anatomy-muted)}
.sek-corner[data-k="fig"],.sek-corner[data-k="readout"]{fill:var(--anatomy-text)}
.sek-corner[data-k="title"],.sek-corner[data-k="hint"]{letter-spacing:.1em;text-transform:uppercase}
.iso-halo{filter:url(#sek-blur)}
</style>`;
const frame = [
  CARD_CSS,
  `<defs><filter id="sek-blur" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="9"/></filter></defs>`,
  `<rect class="sek-card" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}"/>`,
  `<text class="sek-corner" data-k="fig" x="20" y="28">${FIG}</text>`,
  `<text class="sek-corner" data-k="title" x="${W - 20}" y="28" text-anchor="end">${esc(TITLE.toUpperCase())}</text>`,
  `<text class="sek-corner" data-k="hint" x="20" y="${H - 20}">${esc(HINT.toUpperCase())}</text>`,
  `<text class="sek-corner" data-k="readout" x="${W - 20}" y="${H - 20}" text-anchor="end">${esc(READOUT)}</text>`,
];
for (const theme of ["dark", "light"]) {
  const svg = k.figureSvg({ width: W, height: H, label: LABEL_TEXT, body: [...frame, ...body], standalone: theme });
  writeFileSync(join(DOCS, `sek-${theme}.svg`), svg);
}
console.log(`wrote sek.html, sek-light.html, ../sek-dark.svg, ../sek-light.svg · ${R.items.length} items · ${R.solids.length} solids · scale ${KS.toFixed(3)}`);

A.auditOrExit(R, P, {});
