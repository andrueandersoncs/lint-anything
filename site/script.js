const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;
const finePointer = window.matchMedia(
  "(hover: hover) and (pointer: fine)"
).matches;

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const judge = (element, verdict) => {
  const rect = element.getBoundingClientRect();
  window.dispatchEvent(
    new CustomEvent("lint:judge", {
      detail: {
        x: rect.left + Math.min(40, rect.width / 2),
        y: rect.top + rect.height / 2,
        verdict,
      },
    })
  );
};

// Navigation
const nav = document.querySelector(".nav");
const menuButton = document.querySelector(".mobile-menu-btn");

const setMenuOpen = (open) => {
  nav?.classList.toggle("is-open", open);
  menuButton?.setAttribute("aria-expanded", String(open));
};

menuButton?.addEventListener("click", () => {
  setMenuOpen(!nav?.classList.contains("is-open"));
});

for (const link of document.querySelectorAll(".mobile-menu a")) {
  link.addEventListener("click", () => setMenuOpen(false));
}

const updateNav = () => {
  nav?.classList.toggle("is-scrolled", window.scrollY > 24);
};
window.addEventListener("scroll", updateNav, { passive: true });
updateNav();

// Syntax highlighting: policy files (YAML frontmatter, shell selectors, and a
// Markdown body), shell, TypeScript, and lint-anything's own output.
const escapeHtml = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const span = (className, text) =>
  `<span class="${className}">${escapeHtml(text)}</span>`;

const JQ_TOKEN =
  /("(?:[^"\\]|\\.)*"?)|(\$\w+)|(\.[\w.[\]]*)|(-?\d+(?:\.\d+)?)|([A-Za-z_]\w*)|(\|)|([{}[\]():,;+-])|(\s+)|(.)/g;
const JQ_BUILTINS = new Set([
  "select",
  "as",
  "length",
  "split",
  "rtrimstr",
  "map",
  "keys",
  "test",
]);

const highlightJq = (program) => {
  let html = "";
  for (const match of program.matchAll(JQ_TOKEN)) {
    const [token, string, variable, path, number, word, pipe, punct] = match;
    if (string) {
      html += span("tk-str", token);
    } else if (variable) {
      html += span("tk-var", token);
    } else if (path) {
      html += escapeHtml(token);
    } else if (number) {
      html += span("tk-num", token);
    } else if (word) {
      html += JQ_BUILTINS.has(word) ? span("tk-cmd", token) : escapeHtml(token);
    } else if (pipe) {
      html += span("tk-op", token);
    } else if (punct) {
      html += span("tk-punct", token);
    } else {
      html += escapeHtml(token);
    }
  }
  return html;
};

const SHELL_TOKEN =
  /('[^']*'?)|("(?:[^"\\]|\\.)*"?)|((?:^|(?<=\s))#[^\n]*)|(\$\w+)|(\|\||&&|>>|[|;>]|\\(?=\n|$))|(\n)|([^\s'"|;>]+)|([ \t]+)/g;
const SHELL_KEYWORDS = new Set(["while", "do", "done", "read", "if", "then", "fi"]);

const highlightShell = (text) => {
  let html = "";
  let expectCommand = true;
  let continued = false;
  let command = "";
  for (const match of text.matchAll(SHELL_TOKEN)) {
    const [token, single, double, comment, variable, operator, newline, word] =
      match;
    if (single) {
      const inner = token.slice(1, token.endsWith("'") && token.length > 1 ? -1 : undefined);
      const closed = token.length > 1 && token.endsWith("'");
      html +=
        command === "jq"
          ? span("tk-str", "'") + highlightJq(inner) + (closed ? span("tk-str", "'") : "")
          : span("tk-str", token);
    } else if (double) {
      html += span("tk-str", token);
    } else if (comment) {
      html += span("tk-comment", token);
    } else if (variable) {
      html += span("tk-var", token);
    } else if (operator) {
      html += span("tk-op", token);
      if (operator === "\\") {
        continued = true;
      } else {
        expectCommand = true;
      }
    } else if (newline) {
      html += token;
      if (!continued) {
        expectCommand = true;
      }
      continued = false;
    } else if (word) {
      if (SHELL_KEYWORDS.has(word)) {
        html += span("tk-kw", token);
        expectCommand = word === "do" || word === "then";
      } else if (expectCommand) {
        html += span("tk-cmd", token);
        command = word;
        expectCommand = false;
      } else if (word.startsWith("-")) {
        html += span("tk-flag", token);
      } else {
        html += escapeHtml(token);
      }
    } else {
      html += escapeHtml(token);
    }
  }
  return html;
};

const YAML_TOKEN =
  /("(?:[^"\\]|\\.)*"?)|(-?\d+(?:\.\d+)?)|([\w-]+)(?=\s*:)|([{}[\],:])|([^\s"{}[\],:]+)|(\s+)/g;

const highlightYamlValue = (text) => {
  let html = "";
  for (const match of text.matchAll(YAML_TOKEN)) {
    const [token, string, number, key, punct] = match;
    if (string) {
      html += span("tk-str", token);
    } else if (number) {
      html += span("tk-num", token);
    } else if (key) {
      html += span("tk-key", token);
    } else if (punct) {
      html += span("tk-punct", token);
    } else {
      html += escapeHtml(token);
    }
  }
  return html;
};

const highlightMarkdown = (line) => {
  const rule = line.match(/^(Rule:)(.*)$/);
  const [prefix, rest] = rule ? [span("tk-rule", rule[1]), rule[2]] : ["", line];
  return (
    prefix +
    rest
      .split(/(`[^`]*`?)/)
      .filter(Boolean)
      .map((part) =>
        part.startsWith("`") ? span("tk-code", part) : span("tk-text", part)
      )
      .join("")
  );
};

const FRONTMATTER_KEY = /^(\s*)("?[\w-]+"?)(:)(.*)$/;

// `mode` is where the text starts: "start" (before the opening ---),
// "front" (inside the frontmatter), or "body".
const highlightPolicy = (text, mode = "start") => {
  const lines = text.split("\n");
  const out = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    index++;
    if (line === "---" && mode !== "body") {
      out.push(span("tk-punct", line));
      mode = mode === "front" ? "body" : "front";
      continue;
    }
    if (mode === "body") {
      out.push(highlightMarkdown(line));
      continue;
    }
    const entry = line.match(FRONTMATTER_KEY);
    if (!entry) {
      out.push(escapeHtml(line));
      continue;
    }
    const [, indent, key, colon, value] = entry;
    const head = indent + span("tk-key", key) + span("tk-punct", colon);
    if (value.trim() === "|") {
      // A block scalar: every following line indented deeper is shell.
      const block = [];
      while (
        index < lines.length &&
        (lines[index].trim() === "" ||
          lines[index].search(/\S/) > indent.length)
      ) {
        block.push(lines[index]);
        index++;
      }
      out.push(head + span("tk-op", value));
      if (block.length > 0) {
        out.push(highlightShell(block.join("\n")));
      }
    } else {
      out.push(head + highlightYamlValue(value));
    }
  }
  return out.join("\n");
};

const TS_TOKEN =
  /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"?)|(-?\d+(?:\.\d+)?)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)|([{}[\]()])|(\s+)|(.)/g;
const TS_KEYWORDS = new Set([
  "import",
  "from",
  "const",
  "await",
  "return",
  "function",
  "yield",
]);

const highlightTs = (text) => {
  let html = "";
  for (const match of text.matchAll(TS_TOKEN)) {
    const [token, comment, string, number, call, word, bracket] = match;
    if (comment) {
      html += span("tk-comment", token);
    } else if (string) {
      html += span("tk-str", token);
    } else if (number) {
      html += span("tk-num", token);
    } else if (call || word) {
      if (TS_KEYWORDS.has(token)) {
        html += span("tk-kw", token);
      } else {
        html += call ? span("tk-cmd", token) : escapeHtml(token);
      }
    } else if (bracket) {
      html += span("tk-punct", token);
    } else {
      html += escapeHtml(token);
    }
  }
  return html;
};

const FINDING = /^(violation|review|pass|inconclusive)(\s+)(\S+)(\s+)(.*)$/;
const SUMMARY = /^(\d+ checks:)(.*)$/;

const highlightOutputLine = (line) => {
  if (line.startsWith("$ ")) {
    return span("o-prompt", "$") + " " + highlightShell(line.slice(2));
  }
  const finding = line.match(FINDING);
  if (finding) {
    const [, verdict, gap1, probability, gap2, rest] = finding;
    const parts = rest.split("  ");
    // A `limit` finding without a path has an empty location column.
    const [location, policy, ...reason] =
      parts.length === 2 ? ["", ...parts] : parts;
    return [
      span(`v-${verdict}`, verdict) + gap1 + span("o-prob", probability) + gap2,
      [
        location && span("o-loc", location),
        span("o-policy", policy ?? ""),
        span("o-reason", reason.join("  ")),
      ]
        .filter(Boolean)
        .join("  "),
    ].join("");
  }
  const summary = line.match(SUMMARY);
  if (summary) {
    return (
      span("o-summary", summary[1]) +
      summary[2].replace(
        /(\d+) (violation|review|inconclusive|pass)/g,
        (_, count, verdict) => `<span class="v-${verdict}">${count} ${verdict}</span>`
      )
    );
  }
  return span(line.startsWith("total") ? "o-summary" : "o-table", line);
};

const highlightOutput = (text) =>
  text
    .split("\n")
    .map((line) => `<span class="o-line">${highlightOutputLine(line)}</span>`)
    .join("");

const HIGHLIGHTERS = {
  policy: (text) => highlightPolicy(text),
  frontmatter: (text) => highlightPolicy(text, "front"),
  body: (text) => highlightPolicy(text, "body"),
  shell: highlightShell,
  ts: highlightTs,
  output: highlightOutput,
};

for (const code of document.querySelectorAll("code[data-highlight]")) {
  const highlighter = HIGHLIGHTERS[code.dataset.highlight];
  if (highlighter) {
    code.innerHTML = highlighter(code.textContent);
  }
}

// Copy buttons
const COPY_ICON =
  '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
const CHECK_ICON =
  '<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

for (const block of document.querySelectorAll(".code-block")) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy-btn";
  button.setAttribute("aria-label", "Copy code");
  button.innerHTML = COPY_ICON;
  block.append(button);

  button.addEventListener("click", async () => {
    const code = block.querySelector("code")?.textContent ?? "";
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      return;
    }
    button.innerHTML = CHECK_ICON;
    button.classList.add("is-copied");
    button.setAttribute("aria-label", "Copied");
    setTimeout(() => {
      button.innerHTML = COPY_ICON;
      button.classList.remove("is-copied");
      button.setAttribute("aria-label", "Copy code");
    }, 1600);
  });
}

// Scroll reveal with a stagger inside each group
const revealables = [...document.querySelectorAll(".reveal")];
for (const element of revealables) {
  const siblings = [...(element.parentElement?.children ?? [])].filter(
    (sibling) => sibling.classList.contains("reveal")
  );
  const index = Math.min(siblings.indexOf(element), 5);
  element.style.setProperty("--reveal-delay", `${index * 70}ms`);
}

const onReveal = new Map();
const revealed = (element) => {
  element.classList.add("is-visible");
  onReveal.get(element)?.();
};

if (prefersReducedMotion || !("IntersectionObserver" in window)) {
  for (const element of revealables) {
    element.classList.add("is-visible");
  }
} else {
  const revealObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          revealed(entry.target);
          revealObserver.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
  );
  for (const element of revealables) {
    revealObserver.observe(element);
  }
}

// Pointer-driven effects: card spotlight and tilting panels
const visible = new Set();
const visibilityObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      visible.add(entry.target);
    } else {
      visible.delete(entry.target);
    }
  }
});

const spotlights = [...document.querySelectorAll(".spotlight")];
const tilts = [...document.querySelectorAll(".tilt")];

const updateSpotlight = (element, x, y) => {
  const rect = element.getBoundingClientRect();
  element.style.setProperty("--mx", `${x - rect.left}px`);
  element.style.setProperty("--my", `${y - rect.top}px`);
};

const updateTilt = (element, x, y) => {
  const rect = element.getBoundingClientRect();
  const nx = (x - (rect.left + rect.width / 2)) / (window.innerWidth / 2);
  const ny = (y - (rect.top + rect.height / 2)) / (window.innerHeight / 2);
  const clamp = (value) => Math.max(-1, Math.min(1, value));
  const inside =
    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  element.style.setProperty("--ry", `${clamp(nx) * 5}deg`);
  element.style.setProperty("--rx", `${clamp(ny) * -4}deg`);
  element.style.setProperty("--sx", `${((x - rect.left) / rect.width) * 100}%`);
  element.style.setProperty("--sy", `${((y - rect.top) / rect.height) * 100}%`);
  element.style.setProperty("--sheen", inside ? "1" : "0");
};

const resetPointerEffects = () => {
  for (const element of tilts) {
    element.style.setProperty("--rx", "0deg");
    element.style.setProperty("--ry", "0deg");
    element.style.setProperty("--sheen", "0");
  }
};

if (finePointer && !prefersReducedMotion) {
  for (const element of [...spotlights, ...tilts]) {
    visibilityObserver.observe(element);
  }

  let pointerX = 0;
  let pointerY = 0;
  let scheduled = false;

  const applyPointerEffects = () => {
    scheduled = false;
    for (const element of visible) {
      if (element.classList.contains("spotlight")) {
        updateSpotlight(element, pointerX, pointerY);
      }
      if (element.classList.contains("tilt")) {
        updateTilt(element, pointerX, pointerY);
      }
    }
  };

  window.addEventListener(
    "pointermove",
    (event) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (!scheduled) {
        scheduled = true;
        window.requestAnimationFrame(applyPointerEffects);
      }
    },
    { passive: true }
  );
  document.documentElement.addEventListener(
    "pointerleave",
    resetPointerEffects
  );
}

// Hero: type a policy, run lint-anything, print what it printed. Every policy
// and every line of output is from a real run against Clef on a demo project.
const HERO_RUNS = [
  {
    file: ".lint-anything/rules/todo-has-issue.md",
    policy: `---
select: |
  rg --json -w 'TODO|FIXME' -g '*.ts' |
    jq -c 'select(.type == "match") | .data |
      {id: "\\(.path.text):\\(.line_number)", path: .path.text,
       lines: [.line_number, .line_number],
       text: "comment in \\(.path.text):\\n\\(.lines.text)"}'
criteria:
  "true": "The comment has no tracking issue."
  "false": "The comment references a tracking issue, or isn't a TODO or FIXME."
---
Each question shows one comment. Decide whether it breaks the rule below.

Rule: every \`TODO\` or \`FIXME\` comment must reference a tracking issue, written as \`#123\`, \`ABC-123\`, or a full issue URL.`,
    output: `violation     0.95   src/billing.ts:3-3  todo-has-issue  The comment has no tracking issue.
violation     0.97   src/currency.ts:3-3  todo-has-issue  The comment has no tracking issue.
violation     0.94   src/report.ts:6-6  todo-has-issue  The comment has no tracking issue.
4 checks: 3 violation, 0 review, 0 inconclusive, 1 pass`,
  },
  {
    file: ".lint-anything/rules/no-flag-parameters.md",
    policy: `---
select: |
  ast-grep scan --json=stream --inline-rules \\
    '{id: fn, language: TypeScript, rule: {kind: function_declaration}}' src |
    jq -c '{id: "\\(.file):\\(.range.start.line + 1)", path: .file,
      lines: [.range.start.line + 1, .range.end.line + 1],
      text: "function in \\(.file):\\n\\(.text)"}'
criteria:
  "true": "The function takes a boolean that switches it between different jobs."
  "false": "The function has no such parameter, or its booleans are plain data."
---
Each question shows one function. Decide whether it breaks the rule below.

Rule: don't use a boolean parameter to make one function do two different jobs. Split it into separate functions, or replace the boolean with a named option. A boolean that is simply data being stored or forwarded is fine.`,
    output: `violation     0.91   src/billing.ts:4-12  no-flag-parameters  The function takes a boolean that switches it between different jobs.
violation     0.76   src/currency.ts:12-17  no-flag-parameters  The function takes a boolean that switches it between different jobs.
violation     0.96   src/report.ts:7-14  no-flag-parameters  The function takes a boolean that switches it between different jobs.
6 checks: 3 violation, 0 review, 0 inconclusive, 3 pass`,
  },
  {
    file: ".lint-anything/rules/errors-say-what-to-do.md",
    policy: `---
select: |
  rg --json -U 'new Error\\([^)]*\\)' -g '*.ts' |
    jq -c 'select(.type == "match") | .data |
      (.lines.text | rtrimstr("\\n") | split("\\n") | length) as $n |
      {id: "\\(.path.text):\\(.line_number)", path: .path.text,
       lines: [.line_number, .line_number + $n - 1],
       text: "error in \\(.path.text):\\n\\(.lines.text)"}'
criteria:
  "true": "The message doesn't say what went wrong or what to do about it."
  "false": "The message says what went wrong and what to do next."
---
Each question shows one error message a user can see. Decide whether it breaks the rule below.

Rule: an error message names what went wrong, with the value involved, and tells the reader what to do next.`,
    output: `violation     0.91   src/billing.ts:6-6  errors-say-what-to-do  The message doesn't say what went wrong or what to do about it.
violation     0.87   src/currency.ts:7-7  errors-say-what-to-do  The message doesn't say what went wrong or what to do about it.
violation     0.98   src/report.ts:18-18  errors-say-what-to-do  The message doesn't say what went wrong or what to do about it.
4 checks: 3 violation, 0 review, 0 inconclusive, 1 pass`,
  },
  {
    file: ".lint-anything/rules/commits-say-why.md",
    policy: `---
select: |
  git log -n 20 --format=%h | while read -r hash; do
    git log -1 --format=%B "$hash" |
      jq -Rsc --arg id "$hash" '{id: $id, text: ("commit message:\\n" + .)}'
  done
criteria:
  "true": "The commit message doesn't say why."
  "false": "The commit message explains why the change was made."
---
Each question shows one commit message. Decide whether it breaks the rule below.

Rule: a commit message says why the change was made, not only what changed.`,
    output: `violation     0.82   49554c5  commits-say-why  The commit message doesn't say why.
violation     0.95   4c19fe8  commits-say-why  The commit message doesn't say why.
violation     0.97   76b76a5  commits-say-why  The commit message doesn't say why.
violation     0.96   a8e0ffc  commits-say-why  The commit message doesn't say why.
5 checks: 4 violation, 0 review, 0 inconclusive, 1 pass`,
  },
];

const COMMAND = "bunx lint-anything";
const CARET = '<span class="caret"></span>';
const VERDICTS = ["violation", "review", "inconclusive", "pass"];

const heroFile = document.querySelector("[data-hero-file]");
const heroPolicy = document.querySelector("[data-hero-policy]");
const heroTerminal = document.querySelector("[data-hero-terminal]");
const heroMeter = document.querySelector("[data-hero-meter]");
const heroExit = document.querySelector("[data-hero-exit]");
const hero = document.querySelector(".hero");

const countsOf = (output) => {
  const summary = output.split("\n").at(-1) ?? "";
  return Object.fromEntries(
    VERDICTS.map((verdict) => [
      verdict,
      Number(summary.match(new RegExp(`(\\d+) ${verdict}`))?.[1] ?? 0),
    ])
  );
};

const setMeter = (counts) => {
  for (const verdict of VERDICTS) {
    heroMeter
      ?.querySelector(`.is-${verdict}`)
      ?.style.setProperty("--n", String(counts[verdict]));
  }
  if (heroExit) {
    heroExit.textContent = `exit ${counts.violation > 0 ? 1 : 0}`;
  }
};

const promptLine = (typed, caret) =>
  `<span class="o-line">${span("o-prompt", "$")} ${highlightShell(typed)}${caret ? CARET : ""}</span>`;

// Reserve the tallest frame's height so the page never jumps between runs.
const lockHeroHeight = () => {
  if (!heroPolicy || !heroTerminal) {
    return;
  }
  const policyPre = heroPolicy.closest("pre");
  const terminalPre = heroTerminal.closest("pre");
  const saved = [heroPolicy.innerHTML, heroTerminal.innerHTML];
  policyPre.style.minHeight = "";
  terminalPre.style.minHeight = "";
  let policyHeight = 0;
  let terminalHeight = 0;
  for (const run of HERO_RUNS) {
    heroPolicy.innerHTML = highlightPolicy(run.policy);
    heroTerminal.innerHTML =
      promptLine(COMMAND, false) + highlightOutput(run.output);
    policyHeight = Math.max(policyHeight, policyPre.offsetHeight);
    terminalHeight = Math.max(terminalHeight, terminalPre.offsetHeight);
  }
  [heroPolicy.innerHTML, heroTerminal.innerHTML] = saved;
  policyPre.style.minHeight = `${policyHeight}px`;
  terminalPre.style.minHeight = `${terminalHeight}px`;
};

let heroVisible = true;
let resumeHero = null;

const waitForHero = () =>
  heroVisible && !document.hidden
    ? Promise.resolve()
    : new Promise((resolve) => {
        resumeHero = resolve;
      });

const wakeHero = () => {
  if (heroVisible && !document.hidden && resumeHero) {
    resumeHero();
    resumeHero = null;
  }
};

const typePolicy = async (policy) => {
  const bodyStart = policy.indexOf("\n---", 1);
  let index = 0;
  while (index < policy.length) {
    const lineEnd = policy.indexOf("\n", index);
    // Frontmatter streams in fast; the rule itself types at reading speed.
    index = Math.min(policy.length, index + (index > bodyStart ? 2 : 4));
    // Indentation appears at once.
    while (policy[index] === " " && policy[index - 1] === " ") {
      index++;
    }
    heroPolicy.innerHTML = highlightPolicy(policy.slice(0, index)) + CARET;
    await sleep(lineEnd !== -1 && index > lineEnd ? 70 : 12);
  }
  heroPolicy.innerHTML = highlightPolicy(policy);
};

const runCommand = async (output) => {
  for (let index = 0; index <= COMMAND.length; index++) {
    heroTerminal.innerHTML = promptLine(COMMAND.slice(0, index), true);
    await sleep(index === 0 ? 300 : 28 + Math.random() * 40);
  }
  heroTerminal.innerHTML = promptLine(COMMAND, false);
  await sleep(650);
  await waitForHero();
  for (const line of output.split("\n")) {
    heroTerminal.insertAdjacentHTML("beforeend", highlightOutput(line));
    const element = heroTerminal.lastElementChild;
    element.classList.add("is-new");
    const verdict = line.match(FINDING)?.[1];
    if (verdict) {
      judge(element, verdict);
    } else if (countsOf(line).pass > 0) {
      judge(element, "pass");
    }
    await sleep(verdict ? 260 : 120);
  }
};

const playRun = async (run) => {
  heroPolicy.style.opacity = "0";
  heroMeter?.classList.add("is-pending");
  await sleep(320);
  await waitForHero();
  heroFile.textContent = run.file;
  heroTerminal.innerHTML = promptLine("", true);
  heroPolicy.style.opacity = "1";
  await typePolicy(run.policy);
  await sleep(350);
  await waitForHero();
  await runCommand(run.output);
  setMeter(countsOf(run.output));
  heroMeter?.classList.remove("is-pending");
  heroExit?.classList.remove("is-flash");
  heroExit?.getBoundingClientRect();
  heroExit?.classList.add("is-flash");
};

const runHero = async () => {
  for (const element of [heroPolicy.closest("pre"), heroTerminal.closest("pre")]) {
    element.setAttribute("aria-hidden", "true");
  }
  let index = 0;
  await sleep(3200);
  for (;;) {
    index = (index + 1) % HERO_RUNS.length;
    await playRun(HERO_RUNS[index]);
    await sleep(4200);
  }
};

if (heroFile && heroPolicy && heroTerminal) {
  lockHeroHeight();
  document.fonts?.ready.then(lockHeroHeight);
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(lockHeroHeight, 200);
  });
  if (!prefersReducedMotion) {
    if (hero) {
      new IntersectionObserver((entries) => {
        heroVisible = entries.some((entry) => entry.isIntersecting);
        wakeHero();
      }).observe(hero);
    }
    document.addEventListener("visibilitychange", wakeHero);
    runHero();
  }
}

// Anatomy: hovering a note or a part of the file lights up both; until the
// visitor does, the parts take turns.
const anatomy = document.querySelector("[data-anatomy]");

if (anatomy) {
  const targets = [...anatomy.querySelectorAll("[data-part]")];
  const names = ["select", "criteria", "body"];
  let autoplay = 0;
  let step = 0;

  const setActive = (name) => {
    anatomy.classList.toggle("has-active", Boolean(name));
    for (const target of targets) {
      target.classList.toggle("is-active", target.dataset.part === name);
    }
  };

  const startAutoplay = () => {
    if (prefersReducedMotion || autoplay) {
      return;
    }
    autoplay = setInterval(() => {
      setActive(names[step % names.length]);
      step++;
    }, 2600);
  };

  const stopAutoplay = () => {
    clearInterval(autoplay);
    autoplay = 0;
  };

  for (const target of targets) {
    const activate = () => {
      stopAutoplay();
      setActive(target.dataset.part);
    };
    target.addEventListener("pointerenter", activate);
    target.addEventListener("focus", activate);
    target.addEventListener("blur", () => setActive(null));
  }
  anatomy.addEventListener("pointerleave", () => {
    setActive(null);
    startAutoplay();
  });

  new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) {
      startAutoplay();
    } else {
      stopAutoplay();
    }
  }).observe(anatomy);
}

// Verdict scale: stack the points so none overlap, and name the one in focus.
const scale = document.querySelector("[data-scale]");

if (scale) {
  const track = scale.querySelector("[data-scale-track]");
  const readout = scale.querySelector("[data-scale-readout]");
  const dots = [...track.querySelectorAll(".scale-dot")];
  const probability = (dot) => Number(dot.style.getPropertyValue("--p"));

  dots.forEach((dot, index) => {
    dot.style.setProperty("--i", String(index));
    dot.setAttribute("aria-label", dot.dataset.label);
  });

  const stack = () => {
    const width = track.clientWidth;
    const size = dots[0]?.offsetWidth ?? 14;
    const rows = [];
    for (const dot of [...dots].sort((a, b) => probability(a) - probability(b))) {
      const x = probability(dot) * width;
      let row = rows.findIndex((last) => x - last >= size + 2);
      if (row === -1) {
        row = rows.length;
        rows.push(x);
      } else {
        rows[row] = x;
      }
      dot.style.setProperty("--row", String(row));
    }
    track.style.setProperty("--rows", String(Math.max(rows.length, 1)));
  };

  const show = (dot) => {
    const verdict = dot.classList.contains("is-pass") ? "pass" : "violation";
    readout.innerHTML = `${span(`v-${verdict}`, verdict)}  ${escapeHtml(dot.dataset.label)}`;
    for (const other of dots) {
      other.classList.toggle("is-active", other === dot);
    }
  };

  for (const dot of dots) {
    dot.addEventListener("pointerenter", () => show(dot));
    dot.addEventListener("focus", () => show(dot));
    dot.addEventListener("click", () => {
      show(dot);
      judge(dot, dot.classList.contains("is-pass") ? "pass" : "violation");
    });
  }

  stack();
  window.addEventListener("resize", stack);
}

// Count the eval numbers up when they scroll into view.
const formatCount = (element, value) => {
  const decimals = Number(element.dataset.decimals ?? 0);
  const number =
    element.dataset.group === undefined
      ? value.toFixed(decimals)
      : Math.round(value).toLocaleString("en-US");
  return `${element.dataset.prefix ?? ""}${number}${element.dataset.suffix ?? ""}`;
};

const countUp = async (element) => {
  const target = Number(element.dataset.count);
  const start = performance.now();
  const duration = 1400;
  for (;;) {
    const t = Math.min(1, (performance.now() - start) / duration);
    element.textContent = formatCount(element, target * (1 - (1 - t) ** 3));
    if (t === 1) {
      return;
    }
    await new Promise((resolve) => {
      requestAnimationFrame(resolve);
    });
  }
};

if (!prefersReducedMotion) {
  for (const container of document.querySelectorAll(".stat-card, .evals-detail")) {
    const counters = [...container.querySelectorAll("[data-count]")];
    for (const counter of counters) {
      counter.textContent = formatCount(counter, 0);
    }
    onReveal.set(container, () => {
      for (const counter of counters) {
        countUp(counter);
      }
    });
  }
}
