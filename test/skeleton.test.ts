import { describe, expect, it } from "bun:test"
import { SANDBOX_ERROR_CODES } from "../src/types"

describe("skeleton", () => {
  it("exports the platform-unsupported error code", () => {
    expect(SANDBOX_ERROR_CODES.platformUnsupported).toBe("sandbox_platform_unsupported")
  })
})
