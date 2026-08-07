import type { RedactionPattern } from "./types"
import { debugLog } from "./debug"

export interface RedactionResult {
  output: string
  maskedCount: number
}

export class Redactor {
  private readonly compiled: { name: string; regex: RegExp; replacement: string }[]

  constructor(patterns: RedactionPattern[]) {
    this.compiled = patterns
      .map((p) => {
        try {
          return {
            name: p.name,
            regex: new RegExp(p.pattern, "g"),
            replacement: p.replacement ?? `[REDACTED:${p.name}]`,
          }
        } catch (e) {
          debugLog("redactor:invalid_pattern", `${p.name}: ${(e as Error).message}`)
          return null
        }
      })
      .filter((v): v is { name: string; regex: RegExp; replacement: string } => v !== null)
  }

  apply(text: string): RedactionResult {
    let result = text
    let maskedCount = 0
    for (const { name, regex, replacement } of this.compiled) {
      const matches = result.match(regex)
      if (matches && matches.length > 0) {
        result = result.replace(regex, replacement)
        maskedCount += matches.length
        debugLog("redactor:masked", `${name}: ${matches.length} match(es)`)
      }
    }
    return { output: result, maskedCount }
  }
}
