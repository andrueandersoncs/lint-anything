---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

## Original Idea

- Use "Decision Models" to check arbitrary rules, in order to enforce "semantic rules" that would be difficult or impossible with traditional static analysis
- These rules are defined as English language prose in markdown files
- The target users are coding agents; they write the rules, run the linter, and address the violations

## User experience is fixed

lint-anything is a CLI; its interface is its user experience. You are FORBIDDEN from changing the user experience without the user's explicit permission. That includes:

- **No arguments, no new CLI flags, no subcommands.** The CLI takes no arguments: a run checks every policy, and each policy's selector decides what it checks (files, derived facts, history, third-party services). Its one flag is `--debug` (user-approved), which prints debugging details to stderr; debugging metadata belongs there rather than in a new flag. Do not add arguments, flags, options, or subcommands, not even "for testing" or "for evals".
- **No new output.** Do not change what the CLI prints (lines, summary, formats) or its exit codes.
- **No new side effects.** Do not make the CLI write files (caches, reports, baselines) or require new environment variables.
- **Eval needs stay in `evals/`.** If an eval needs a helper, a switch, or a measurement hook, build it in `evals/` (scripts, stub layers, programmatic calls to `src/`), never as CLI surface.
- Approval of an idea is not approval of a new flag or command to expose it. If an idea needs new CLI surface, ask first.

## Do the work

Never say "I haven't done ...", "I didn't ...", or anything indicating laziness. Any time you'd feel the urge to write that is an indicator that you still have work to do. Do NOT be lazy. DO THE WORK. I don't want to hear any excuses about "oh I didn't look it up but here's what I think". Just do it.

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

**Do not write unit tests.** Verify changes with `bunx tsc --noEmit` and by running the CLI.

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
