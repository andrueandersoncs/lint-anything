// Interactive background: a field of items waiting to be judged. Each node
// carries a hidden violation probability; waves sweep across the field and
// every node they cross flashes its verdict and briefly shows its score.

const canvas = document.querySelector(".field");
const context = canvas?.getContext("2d");

const KEYWORD = "#c4b5fd";
const STRING = "#a5d6ff";
const NUMBER = "#79c0ff";
const COMMENT = "#6e7681";
const PUNCTUATION = "#a1a1aa";

const TOKENS = [
  ["TODO", COMMENT],
  ["FIXME", COMMENT],
  ["// why?", COMMENT],
  ["any", KEYWORD],
  ["retry: boolean", KEYWORD],
  ["catch (e) {}", KEYWORD],
  ['"wip"', STRING],
  ["data2", KEYWORD],
  ["handle()", KEYWORD],
  ["doStuff()", KEYWORD],
  ["=>", PUNCTUATION],
  ["{ }", PUNCTUATION],
  ["?", PUNCTUATION],
  ["42", NUMBER],
  ["0x1F", NUMBER],
  ["new Error()", KEYWORD],
  ["git log", KEYWORD],
  ["rg", KEYWORD],
  ["jq", KEYWORD],
  ["ast-grep", KEYWORD],
  ["select:", KEYWORD],
  ["criteria:", KEYWORD],
];

const NEUTRAL = { rgb: "161, 161, 170", hex: "#a1a1aa" };
const COLORS = {
  accent: { rgb: "167, 139, 250", hex: "#c4b5fd" },
  violation: { rgb: "248, 113, 113", hex: "#f87171" },
  review: { rgb: "251, 191, 36", hex: "#fbbf24" },
  pass: { rgb: "74, 222, 128", hex: "#4ade80" },
  inconclusive: NEUTRAL,
};
const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

const AREA_PER_NODE = 8500;
const MIN_NODES = 55;
const MAX_NODES = 240;
const TOKEN_RATIO = 0.34;
const DOT_LABEL_RATIO = 0.3;
const MARGIN = 80;
const SPRING = 0.012;
const DAMPING = 0.9;
const DRIFT = 0.2;
const PARALLAX = 0.35;
const PUSH = 1.5;
const SWIRL = 0.95;
const WAVE_SPEED = 10;
const WAVE_BAND = 55;
const WAVE_FORCE = 2.4;
const WAVE_DECAY = 0.012;
const MAX_WAVES = 6;
const EDGE_BUCKETS = 8;
const MAX_EDGE_ALPHA = 0.75;

// Clef-like answers: mostly confident either way, a few in the review band.
const VIOLATION_SHARE = 0.28;
const REVIEW_SHARE = 0.08;
const PASS_MAX = 0.5;
const VIOLATION_MIN = 0.65;
// Judging: a node flashes and shows its score for JUDGE_FRAMES (60 = 1 s).
const JUDGE_FRAMES = 95;
const JUDGE_MIN_LIFE = 0.12;
const LABEL_ALPHA = 0.8;
const LABEL_FONT = `500 10px ${MONO}`;
const LABEL_GAP = 6;
const SQUIGGLE_STEP = 2.5;
const SQUIGGLE_AMPLITUDE = 1.3;
// Hover inspect: nearest node within HOVER_RADIUS, held fairly still.
const HOVER_RADIUS = 60;
const HOVER_HOLD = 0.15;

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const state = {
  width: 0,
  height: 0,
  dpr: 1,
  linkDistance: 130,
  radius: 180,
  scroll: window.scrollY,
  time: 0,
  nodes: [],
  waves: [],
  waveId: 0,
  hovered: null,
  pointer: {
    x: -9999,
    y: -9999,
    active: 0,
    target: 0,
    down: false,
    hover: false,
  },
  frame: 0,
  last: 0,
};

// One reusable set of alpha buckets per edge color, cleared every frame.
const edgeBuckets = new Map(
  [NEUTRAL, ...Object.values(COLORS)].map((color) => [
    color,
    Array.from({ length: EDGE_BUCKETS }, () => []),
  ])
);

const wrap = (value, min, span) =>
  ((((value - min) % span) + span) % span) + min;

const flowAngle = (x, y, t) =>
  (Math.sin(x * 0.0021 + t * 0.000_11) +
    Math.cos(y * 0.0027 - t * 0.000_09) +
    Math.sin((x + y) * 0.0013 + t * 0.000_07)) *
  1.2;

const drawProbability = () => {
  const roll = Math.random();
  if (roll < REVIEW_SHARE) {
    return PASS_MAX + 0.01 + Math.random() * (VIOLATION_MIN - PASS_MAX - 0.02);
  }
  if (roll < REVIEW_SHARE + VIOLATION_SHARE) {
    return 0.98 - Math.random() ** 2 * 0.13;
  }
  return 0.02 + Math.random() ** 2 * 0.08;
};

const verdictOf = (p) => {
  if (p <= PASS_MAX) {
    return "pass";
  }
  return p >= VIOLATION_MIN ? "violation" : "review";
};

const measure = (node) => {
  if (node.token) {
    context.font = `500 ${node.fontSize}px ${MONO}`;
    node.halfWidth = context.measureText(node.token).width / 2;
  } else {
    node.halfWidth = node.radius;
  }
};

const createNode = (originX, originY) => {
  const z = 0.35 + Math.random() ** 1.6 * 0.65;
  const token =
    Math.random() < TOKEN_RATIO
      ? TOKENS[Math.floor(Math.random() * TOKENS.length)]
      : null;
  const hx = Math.random() * (state.width + MARGIN * 2) - MARGIN;
  const hy = Math.random() * (state.height + MARGIN * 2) - MARGIN;
  const p = drawProbability();
  const node = {
    hx,
    hy,
    tx: hx,
    ty: hy,
    x: originX ?? hx,
    y: originY ?? hy,
    vx: 0,
    vy: 0,
    z,
    token: token?.[0] ?? null,
    color: token?.[1] ?? NEUTRAL.hex,
    fontSize: Math.round(10 + z * 6),
    radius: 0.8 + z * 1.5,
    halfWidth: 0,
    glow: 0,
    glowColor: COLORS.accent,
    verdict: COLORS[verdictOf(p)],
    label: p.toFixed(2),
    labeled: token !== null || Math.random() < DOT_LABEL_RATIO,
    judge: 0,
    judgedBy: -1,
    inspect: 0,
  };
  measure(node);
  return node;
};

const syncNodeCount = (originX, originY) => {
  const target = Math.max(
    MIN_NODES,
    Math.min(
      MAX_NODES,
      Math.round((state.width * state.height) / AREA_PER_NODE)
    )
  );
  while (state.nodes.length < target) {
    const jitter = () => (Math.random() - 0.5) * 40;
    state.nodes.push(
      originX === undefined
        ? createNode()
        : createNode(originX + jitter(), originY + jitter())
    );
  }
  state.nodes.length = target;
  if (!state.nodes.includes(state.hovered)) {
    state.hovered = null;
  }
  // Group tokens by font size so drawing switches fonts as rarely as possible.
  state.nodes.sort((a, b) => a.fontSize - b.fontSize);
};

const resize = () => {
  state.width = window.innerWidth;
  state.height = window.innerHeight;
  state.dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(state.width * state.dpr);
  canvas.height = Math.round(state.height * state.dpr);
  const shortSide = Math.min(state.width, state.height);
  state.linkDistance = Math.min(150, Math.max(100, shortSide * 0.15));
  state.radius = Math.min(240, Math.max(140, shortSide * 0.24));
};

const spawnWave = (x, y, color = COLORS.accent, strength = 1) => {
  state.waveId += 1;
  state.waves.push({ id: state.waveId, x, y, r: 0, life: strength, color });
  if (state.waves.length > MAX_WAVES) {
    state.waves.shift();
  }
};

const applyPointer = (node, pointer) => {
  const dx = node.x - pointer.x;
  const dy = node.y - pointer.y;
  const distanceSquared = dx * dx + dy * dy;
  const { radius } = state;
  if (distanceSquared >= radius * radius) {
    return [0, 0];
  }
  const distance = Math.sqrt(distanceSquared) || 1;
  const falloff = (1 - distance / radius) ** 2 * pointer.active;
  // The inspected node mostly holds still so it can be read.
  const depth =
    (0.5 + node.z * 0.5) * (node === state.hovered ? HOVER_HOLD : 1);
  const push = (pointer.down ? 2.4 : 1) * PUSH * falloff * depth;
  const swirl = (pointer.down ? 2.6 : 1) * SWIRL * falloff * depth;
  if (falloff * 0.9 > node.glow) {
    node.glow = falloff * 0.9;
    node.glowColor = COLORS.accent;
  }
  return [
    (dx / distance) * push - (dy / distance) * swirl,
    (dy / distance) * push + (dx / distance) * swirl,
  ];
};

const applyWaves = (node) => {
  let ax = 0;
  let ay = 0;
  for (const wave of state.waves) {
    const dx = node.x - wave.x;
    const dy = node.y - wave.y;
    const distance = Math.sqrt(dx * dx + dy * dy) || 1;
    const band = Math.abs(distance - wave.r);
    if (band < WAVE_BAND) {
      const strength = (1 - band / WAVE_BAND) * wave.life;
      ax += (dx / distance) * strength * WAVE_FORCE;
      ay += (dy / distance) * strength * WAVE_FORCE;
      if (strength > node.glow) {
        node.glow = strength;
        node.glowColor = wave.color;
      }
      if (node.judgedBy !== wave.id && wave.life > JUDGE_MIN_LIFE) {
        node.judgedBy = wave.id;
        node.judge = 1;
      }
    }
  }
  return [ax, ay];
};

const step = (dt) => {
  const { pointer } = state;
  const spanX = state.width + MARGIN * 2;
  const spanY = state.height + MARGIN * 2;
  pointer.active += (pointer.target - pointer.active) * Math.min(1, 0.08 * dt);
  const damping = DAMPING ** dt;
  const glowDecay = 0.955 ** dt;
  const judgeDecay = dt / JUDGE_FRAMES;
  const inspectEase = Math.min(1, 0.15 * dt);
  const inspecting = pointer.hover && pointer.active > 0.5;
  let hovered = null;
  let hoveredScore = Infinity;

  for (const node of state.nodes) {
    const angle = flowAngle(node.hx, node.hy, state.time);
    node.hx = wrap(
      node.hx + Math.cos(angle) * DRIFT * node.z * dt,
      -MARGIN,
      spanX
    );
    node.hy = wrap(
      node.hy + Math.sin(angle) * DRIFT * node.z * dt,
      -MARGIN,
      spanY
    );
    const tx = node.hx;
    const ty = wrap(node.hy - state.scroll * PARALLAX * node.z, -MARGIN, spanY);
    // When a home position wraps around an edge, carry the node with it
    // instead of springing it across the whole screen.
    if (Math.abs(tx - node.tx) > spanX / 2) {
      node.x += tx - node.tx;
    }
    if (Math.abs(ty - node.ty) > spanY / 2) {
      node.y += ty - node.ty;
    }
    node.tx = tx;
    node.ty = ty;

    let ax = (tx - node.x) * SPRING;
    let ay = (ty - node.y) * SPRING;
    if (pointer.active > 0.01) {
      const [px, py] = applyPointer(node, pointer);
      ax += px;
      ay += py;
    }
    if (state.waves.length > 0) {
      const [wx, wy] = applyWaves(node);
      ax += wx;
      ay += wy;
    }
    node.vx = (node.vx + ax * dt) * damping;
    node.vy = (node.vy + ay * dt) * damping;
    node.x += node.vx * dt;
    node.y += node.vy * dt;
    node.glow *= glowDecay;
    node.judge = Math.max(0, node.judge - judgeDecay);
    node.inspect +=
      ((node === state.hovered ? 1 : 0) - node.inspect) * inspectEase;

    if (inspecting) {
      // Pick by home position: the pointer pushes nodes away, but the
      // inspected one is held near home, so it settles under the cursor.
      const dx = node.tx - pointer.x;
      const dy = node.ty - pointer.y;
      // Bias toward the current pick so the inspector doesn't flicker.
      const sticky = node === state.hovered;
      const reach = HOVER_RADIUS * (sticky ? 1.4 : 1);
      const distanceSquared = dx * dx + dy * dy;
      const score = distanceSquared * (sticky ? 0.5 : 1);
      if (distanceSquared < reach * reach && score < hoveredScore) {
        hovered = node;
        hoveredScore = score;
      }
    }
  }
  state.hovered = hovered;

  for (const wave of state.waves) {
    wave.r += WAVE_SPEED * dt;
    wave.life -= WAVE_DECAY * dt;
  }
  state.waves = state.waves.filter((wave) => wave.life > 0);
};

const drawPointerGlow = () => {
  const { pointer } = state;
  if (pointer.active <= 0.01) {
    return;
  }
  const reach = state.radius * 1.6;
  const gradient = context.createRadialGradient(
    pointer.x,
    pointer.y,
    0,
    pointer.x,
    pointer.y,
    reach
  );
  const { rgb } = COLORS.accent;
  gradient.addColorStop(0, `rgba(${rgb}, ${0.1 * pointer.active})`);
  gradient.addColorStop(1, `rgba(${rgb}, 0)`);
  context.fillStyle = gradient;
  context.fillRect(pointer.x - reach, pointer.y - reach, reach * 2, reach * 2);
};

// Adds the segment between two nodes to the matching alpha bucket, if they are
// close enough (in screen space and depth) to be linked.
const collectEdge = (a, b) => {
  const { linkDistance } = state;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  if (Math.abs(dx) > linkDistance || Math.abs(dy) > linkDistance) {
    return;
  }
  const distanceSquared = dx * dx + dy * dy;
  if (
    distanceSquared > linkDistance * linkDistance ||
    Math.abs(a.z - b.z) > 0.4
  ) {
    return;
  }
  const lead = a.glow >= b.glow ? a : b;
  const strength =
    (1 - Math.sqrt(distanceSquared) / linkDistance) * Math.min(a.z, b.z);
  const alpha = Math.min(MAX_EDGE_ALPHA, strength * (0.28 + lead.glow * 0.9));
  const bucket = Math.min(
    EDGE_BUCKETS - 1,
    Math.floor((alpha / MAX_EDGE_ALPHA) * EDGE_BUCKETS)
  );
  const color = lead.glow > 0.18 ? lead.glowColor : NEUTRAL;
  edgeBuckets.get(color)[bucket].push(a.x, a.y, b.x, b.y);
};

const drawEdges = () => {
  const { nodes } = state;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      collectEdge(nodes[i], nodes[j]);
    }
  }

  context.lineWidth = 1;
  for (const [color, buckets] of edgeBuckets) {
    for (let bucket = 0; bucket < EDGE_BUCKETS; bucket++) {
      const segments = buckets[bucket];
      if (segments.length === 0) {
        continue;
      }
      const alpha = ((bucket + 0.5) / EDGE_BUCKETS) * MAX_EDGE_ALPHA;
      context.strokeStyle = `rgba(${color.rgb}, ${alpha.toFixed(3)})`;
      context.beginPath();
      for (let k = 0; k < segments.length; k += 4) {
        context.moveTo(segments[k], segments[k + 1]);
        context.lineTo(segments[k + 2], segments[k + 3]);
      }
      context.stroke();
      segments.length = 0;
    }
  }
};

const drawPointerLinks = () => {
  const { pointer } = state;
  if (pointer.active <= 0.01) {
    return;
  }
  const reach = state.radius * 0.85;
  context.strokeStyle = `rgb(${COLORS.accent.rgb})`;
  context.lineWidth = 1;
  for (const node of state.nodes) {
    const dx = node.x - pointer.x;
    const dy = node.y - pointer.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < reach) {
      context.globalAlpha = (1 - distance / reach) * 0.45 * pointer.active;
      context.beginPath();
      context.moveTo(pointer.x, pointer.y);
      context.lineTo(node.x, node.y);
      context.stroke();
    }
  }
  context.globalAlpha = 1;
};

const drawWaves = () => {
  context.lineWidth = 1.5;
  for (const wave of state.waves) {
    const alpha = (wave.life * 0.45).toFixed(3);
    context.strokeStyle = `rgba(${wave.color.rgb}, ${alpha})`;
    context.beginPath();
    context.arc(wave.x, wave.y, wave.r, 0, Math.PI * 2);
    context.stroke();
  }
};

const drawNodes = () => {
  context.textAlign = "center";
  context.textBaseline = "middle";
  let font = 0;
  for (const node of state.nodes) {
    const glow = Math.min(1, node.glow);
    // A verdict flash outlasts the wave's glow; inspect holds it while hovered.
    const verdict = Math.max(node.judge ** 1.5, node.inspect);
    // Tokens rest fainter than dots so they never compete with page text.
    const resting = node.token ? 0.08 + node.z * 0.2 : 0.14 + node.z * 0.32;
    context.globalAlpha = Math.min(
      1,
      resting + Math.max(glow * 0.7, verdict * 0.8)
    );
    if (verdict > 0.02) {
      context.fillStyle = node.verdict.hex;
    } else if (glow > 0.25) {
      context.fillStyle = node.glowColor.hex;
    } else {
      context.fillStyle = node.color;
    }
    if (node.token) {
      if (node.fontSize !== font) {
        font = node.fontSize;
        context.font = `500 ${font}px ${MONO}`;
      }
      context.fillText(node.token, node.x, node.y);
    } else {
      context.beginPath();
      context.arc(
        node.x,
        node.y,
        node.radius * (1 + Math.max(glow * 0.8, verdict * 0.6)),
        0,
        Math.PI * 2
      );
      context.fill();
    }
  }
  context.globalAlpha = 1;
};

// The classic lint underline, drawn in from the left as the verdict lands.
const drawSquiggles = () => {
  context.strokeStyle = COLORS.violation.hex;
  context.lineWidth = 1;
  for (const node of state.nodes) {
    const shown = Math.max(node.judge, node.inspect);
    if (!node.token || node.verdict !== COLORS.violation || shown < 0.02) {
      continue;
    }
    const reveal =
      node.inspect > node.judge ? 1 : Math.min(1, (1 - node.judge) * 6);
    const x0 = node.x - node.halfWidth;
    const x1 = x0 + node.halfWidth * 2 * reveal;
    const y = node.y + node.fontSize * 0.62;
    context.globalAlpha = Math.min(1, shown * 1.5) * 0.8;
    context.beginPath();
    context.moveTo(x0, y);
    let up = true;
    for (let x = x0 + SQUIGGLE_STEP; x < x1; x += SQUIGGLE_STEP) {
      context.lineTo(x, y + (up ? -SQUIGGLE_AMPLITUDE : SQUIGGLE_AMPLITUDE));
      up = !up;
    }
    context.stroke();
  }
  context.globalAlpha = 1;
};

const drawLabels = () => {
  context.font = LABEL_FONT;
  context.textBaseline = "middle";
  for (const node of state.nodes) {
    const judged = node.labeled ? Math.min(1, node.judge * 1.6) : 0;
    const alpha = Math.max(judged, node.inspect) * LABEL_ALPHA;
    if (alpha < 0.02) {
      continue;
    }
    const offset = node.halfWidth + LABEL_GAP;
    // Flip to the left side near the right edge so labels stay on screen.
    const flip = node.x + offset + 30 > state.width;
    context.textAlign = flip ? "right" : "left";
    context.globalAlpha = alpha;
    context.fillStyle = node.verdict.hex;
    context.fillText(
      node.label,
      flip ? node.x - offset : node.x + offset,
      node.y + 0.5
    );
  }
  context.globalAlpha = 1;
};

const draw = () => {
  context.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  context.clearRect(0, 0, state.width, state.height);
  drawPointerGlow();
  drawEdges();
  drawPointerLinks();
  drawWaves();
  drawNodes();
  if (!reducedMotion.matches) {
    drawSquiggles();
    drawLabels();
  }
};

const tick = (now) => {
  const dt = state.last ? Math.min(now - state.last, 50) / (1000 / 60) : 1;
  state.last = now;
  state.time += dt * (1000 / 60);
  step(dt);
  draw();
  state.frame = window.requestAnimationFrame(tick);
};

const start = () => {
  if (state.frame === 0 && !document.hidden && !reducedMotion.matches) {
    state.last = 0;
    state.frame = window.requestAnimationFrame(tick);
  }
};

const stop = () => {
  window.cancelAnimationFrame(state.frame);
  state.frame = 0;
};

const settle = () => {
  // Static frame for reduced motion: nodes rest at their home positions.
  for (const node of state.nodes) {
    node.x = node.tx;
    node.y = node.ty;
    node.vx = 0;
    node.vy = 0;
    node.glow = 0;
    node.judge = 0;
    node.inspect = 0;
  }
  state.pointer.active = 0;
  state.hovered = null;
  state.waves = [];
  draw();
};

const init = () => {
  resize();
  if (reducedMotion.matches) {
    syncNodeCount();
    step(0);
    settle();
  } else {
    // Intro: the field bursts out of the hero, springs into place, and the
    // first wave judges everything it crosses.
    const originX = state.width / 2;
    const originY = Math.min(state.height * 0.55, 520);
    syncNodeCount(originX, originY);
    spawnWave(originX, originY);
    start();
  }

  // Token widths depend on the web font; remeasure once it has loaded.
  document.fonts?.ready.then(() => {
    for (const node of state.nodes) {
      measure(node);
    }
  });

  window.addEventListener("resize", () => {
    resize();
    syncNodeCount();
    if (reducedMotion.matches) {
      settle();
    }
  });

  window.addEventListener(
    "scroll",
    () => {
      state.scroll = window.scrollY;
    },
    { passive: true }
  );

  window.addEventListener(
    "pointermove",
    (event) => {
      state.pointer.x = event.clientX;
      state.pointer.y = event.clientY;
      state.pointer.target = 1;
      state.pointer.hover = event.pointerType !== "touch";
    },
    { passive: true }
  );

  window.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0 || reducedMotion.matches) {
        return;
      }
      state.pointer.x = event.clientX;
      state.pointer.y = event.clientY;
      state.pointer.target = 1;
      state.pointer.down = true;
      state.pointer.hover = event.pointerType !== "touch";
      spawnWave(event.clientX, event.clientY);
    },
    { passive: true }
  );

  const release = (event) => {
    state.pointer.down = false;
    if (event.pointerType !== "mouse") {
      state.pointer.target = 0;
    }
  };
  window.addEventListener("pointerup", release, { passive: true });
  window.addEventListener("pointercancel", release, { passive: true });

  document.documentElement.addEventListener("pointerleave", () => {
    state.pointer.target = 0;
    state.pointer.down = false;
  });
  window.addEventListener("blur", () => {
    state.pointer.target = 0;
    state.pointer.down = false;
  });

  window.addEventListener("lint:judge", (event) => {
    const { x, y, verdict } = event.detail ?? {};
    if (!reducedMotion.matches && y > -100 && y < state.height + 100) {
      const color = Object.hasOwn(COLORS, verdict) ? COLORS[verdict] : null;
      spawnWave(x, y, color ?? COLORS.accent, 0.8);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stop();
    } else {
      start();
    }
  });

  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) {
      stop();
      settle();
    } else {
      start();
    }
  });
};

if (canvas && context) {
  init();
}
