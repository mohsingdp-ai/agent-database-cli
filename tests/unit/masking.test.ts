import { describe, expect, it } from "vitest";
import { maskSecret } from "../../src/utils/masking.js";

describe("masking", () => {
  it("脱敏 URL 中的密码", () => {
    expect(maskSecret("mysql://user:password@localhost:3306/app")).toBe("mysql://user:****@localhost:3306/app");
  });

  it("脱敏查询参数中的敏感字段", () => {
    expect(maskSecret("password=abc token=def secret=ghi")).toBe("password=**** token=**** secret=****");
  });
});
