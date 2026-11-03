import { describe, expect, it } from "vitest";
import {
  safeDirectoryLabel,
  safeRelativePath,
  sanitizeSearchQuery,
  sanitizeUiText,
} from "./privacy";

describe("privacy-safe display text", () => {
  it("redacts drive paths and environment paths", () => {
    const message = sanitizeUiText(
      "读取 C:\\Users\\ExampleUser\\AppData\\LocalLow\\xd\\心动小镇\\ScreenCapture 失败",
    );
    expect(message).not.toContain("C:\\Users");
    expect(message).not.toContain("AppData");
    expect(message).toContain("本地路径已隐藏");
  });

  it("only renders a directory basename", () => {
    expect(
      safeDirectoryLabel("C:\\Users\\ExampleUser\\AppData\\LocalLow\\xd\\心动小镇\\ScreenCapture"),
    ).toBe("ScreenCapture");
    expect(safeDirectoryLabel("D:\\Photos\\")).toBe("Photos");
  });

  it("does not present an absolute source path as a relative photo path", () => {
    expect(safeRelativePath("C:\\Users\\ExampleUser\\AppData\\LocalLow\\xd\\ScreenCapture\\Photo\\a.jpg")).toBe(
      "路径已隐藏",
    );
    expect(safeRelativePath("Photo\\nested\\a.jpg")).toBe("Photo/nested/a.jpg");
  });

  it("redacts credentials from status and log messages", () => {
    const message = sanitizeUiText(
      "请求失败 token=test-token-value password=test-password-value Authorization: Bearer abcdefghijklmnop",
    );
    expect(message).not.toContain("test-token-value");
    expect(message).not.toContain("test-password-value");
    expect(message).not.toContain("abcdefghijklmnop");
    expect(message).toContain("凭据已隐藏");
  });

  it("reduces pasted absolute paths to a safe filename query", () => {
    expect(
      sanitizeSearchQuery(
        "C:\\Users\\ExampleUser\\AppData\\LocalLow\\xd\\ScreenCapture\\Photo\\a.jpg",
      ),
    ).toBe("a.jpg");
    expect(sanitizeSearchQuery("\\\\server\\share\\Photo\\b.png")).toBe("b.png");
    expect(sanitizeSearchQuery("/home/example/Pictures/c.jpg")).toBe("c.jpg");
    expect(sanitizeSearchQuery('"C:\\Users\\ExampleUser\\Pictures\\quoted.jpg"')).toBe(
      "quoted.jpg",
    );
    expect(sanitizeSearchQuery("%USERPROFILE%\\Pictures\\profile.png")).toBe("profile.png");
    expect(sanitizeSearchQuery("Photo/nested/a.jpg")).toBe("Photo/nested/a.jpg");
    expect(sanitizeSearchQuery("C:/Users/ExampleUser/Pictures/d.png")).toBe("d.png");
  });
});
