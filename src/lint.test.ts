import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Clef, RequestTooLarge } from "./clef.ts"
import { classify, lint } from "./lint.ts"
import { parsePolicy } from "./policy.ts"

describe("classify", () => {
  test.each([
    [{ applies: 0.1, violates: 0.55 }, "pass"],
    [{ applies: 0.69, violates: 0.9 }, "inconclusive"],
    [{ applies: 0.7, violates: 0.56 }, "review"],
    [{ applies: 0.7, violates: 0.7 }, "violation"]
  ] as const)("%o is %s at threshold 0.7", (judgment, verdict) => {
    expect(classify(judgment, 0.7)).toBe(verdict)
  })
})

describe("parsePolicy", () => {
  test("rejects a policy without globs", async () => {
    const error = await Effect.runPromise(Effect.flip(parsePolicy("no-globs", "---\nglobs: []\n---\n# Rule\n")))
    expect(error.message).toBe("no-globs: frontmatter needs non-empty globs")
  })
})

describe("lint", () => {
  const policy = (name: string, glob: string) =>
    Effect.runPromise(parsePolicy(name, `---\nglobs: ["${glob}"]\n---\n# ${name}\n`))

  test("judges only matching policies and keeps going past oversized requests", async () => {
    const clef = Layer.succeed(Clef, Clef.of({
      judge: (file) =>
        file.path === "big.ts"
          ? Effect.fail(new RequestTooLarge({ bytes: 70_000 }))
          : Effect.succeed({ applies: 1, violates: 0.9 })
    }))
    const files = [{ path: "a.ts", source: "debugger" }, { path: "big.ts", source: "" }, { path: "a.md", source: "" }]
    const findings = await Effect.runPromise(
      lint(files, [await policy("ts-only", "*.ts")], 0.7).pipe(Effect.provide(clef))
    )
    expect(findings.map(({ path, verdict }) => [path, verdict])).toEqual([
      ["a.ts", "violation"],
      ["big.ts", "inconclusive"]
    ])
  })
})
