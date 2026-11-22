// Eval selector pipe step: attaches a compact computed `file role` evidence line to every item based on its
// file's path, exports, and top-level structure, so rules with module-role exemptions (wiring/factory,
// utility toolbox, DTO/config, test file) don't false-alarm on single-function slices.
import { Effect } from "effect"
import { runStep } from "./step.ts"

const cache = new Map<string, Promise<string>>()

const analyzeFile = async (path: string): Promise<string> => {
  const source = await Bun.file(path).text().catch(() => "")
  if (source === "") return ""
  const lower = path.toLowerCase()
  const lines = source.split("\n")
  const hints: Array<string> = []
  if (/(?:^|\/)(?:tests?|__tests__|spec)\/|(?:\.|_)(?:test|spec)\.[a-z]+$|^test_/.test(lower)) {
    hints.push("test file")
  }
  if (/(?:^|\/)(?:cmd|cli|bin|main|app|server|setup|bootstrap|wiring|di|container|factory|provider|client)(?:[_./-]|$)/.test(lower)) {
    hints.push("entry/wiring/factory path")
  }
  if (/(?:^|\/)(?:utils?|helpers?|common|shared|lib|tools|misc)(?:[_./-]|$)/.test(lower)) {
    hints.push("utility/toolbox path")
  }
  if (/(?:^|\/)(?:types?|models?|schemas?|dto|config|options?|constants?|errors?)(?:[_./-]|$)/.test(lower)) {
    hints.push("types/DTO/config path")
  }
  const exportsCount = lines.filter((l) =>
    /^(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|type|interface|enum)\b|func\s+(?:\([^)]+\)\s+)?[A-Z]|type\s+[A-Z]|var\s+[A-Z]|const\s+[A-Z]|def\s+[a-zA-Z]|class\s+[a-zA-Z])/.test(l)
  ).length
  const totalLines = lines.length
  const parts = [
    `${path} (${totalLines} lines, ~${exportsCount} top-level decls)`,
    ...(hints.length > 0 ? [`role hints: ${hints.join(", ")}`] : [])
  ]
  return parts.join("; ")
}

const roleOf = (path: string) => {
  let promise = cache.get(path)
  if (promise === undefined) {
    promise = analyzeFile(path)
    cache.set(path, promise)
  }
  return promise
}

await runStep("file-role", (items) =>
  Effect.promise(async () =>
    Promise.all(items.map(async (item) => {
      if (item.path === undefined) return item
      const role = await roleOf(item.path)
      if (role === "") return item
      return {
        ...item,
        evidence: [["file role", role] as const, ...item.evidence]
      }
    }))
  )
)
