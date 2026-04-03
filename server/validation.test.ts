import { describe, test, expect } from "bun:test";
import {
  validateProjectName,
  validateRequirements,
  validateTechStack,
  validateDevEnv,
  validateTestMethod,
  validateSessionInput,
} from "./validation";

describe("validateProjectName", () => {
  test("returns true for valid project name", () => {
    expect(validateProjectName("My Project")).toBe(true);
  });

  test("returns true for project name at minimum length", () => {
    expect(validateProjectName("abc")).toBe(true);
  });

  test("returns true for project name at maximum length", () => {
    expect(validateProjectName("a".repeat(100))).toBe(true);
  });

  test("returns error for null input", () => {
    expect(validateProjectName(null)).toBe("Project name is required");
  });

  test("returns error for undefined input", () => {
    expect(validateProjectName(undefined)).toBe("Project name is required");
  });

  test("returns error for non-string input", () => {
    expect(validateProjectName(123)).toBe("Project name must be a string");
  });

  test("returns error for empty string", () => {
    expect(validateProjectName("")).toBe("Project name cannot be empty or whitespace-only");
  });

  test("returns error for whitespace-only string", () => {
    expect(validateProjectName("   ")).toBe("Project name cannot be empty or whitespace-only");
  });

  test("returns error for name too short", () => {
    expect(validateProjectName("ab")).toBe("Project name must be at least 3 characters");
  });

  test("returns error for name too long", () => {
    expect(validateProjectName("a".repeat(101))).toBe("Project name must be at most 100 characters");
  });
});

describe("validateRequirements", () => {
  test("returns true for valid requirements", () => {
    expect(validateRequirements("These are valid requirements for the project")).toBe(true);
  });

  test("returns true for requirements at minimum length", () => {
    expect(validateRequirements("0123456789")).toBe(true);
  });

  test("returns error for null input", () => {
    expect(validateRequirements(null)).toBe("Requirements is required");
  });

  test("returns error for undefined input", () => {
    expect(validateRequirements(undefined)).toBe("Requirements is required");
  });

  test("returns error for non-string input", () => {
    expect(validateRequirements(123)).toBe("Requirements must be a string");
  });

  test("returns error for empty string", () => {
    expect(validateRequirements("")).toBe("Requirements cannot be empty or whitespace-only");
  });

  test("returns error for whitespace-only string", () => {
    expect(validateRequirements("   ")).toBe("Requirements cannot be empty or whitespace-only");
  });

  test("returns error for requirements too short", () => {
    expect(validateRequirements("short")).toBe("Requirements must be at least 10 characters");
  });
});

describe("validateTechStack", () => {
  test("returns true for valid tech stack", () => {
    expect(validateTechStack("TypeScript, React, Node.js")).toBe(true);
  });

  test("returns true for empty tech stack (required check)", () => {
    expect(validateTechStack("")).toBe("Tech stack cannot be empty or whitespace-only");
  });

  test("returns error for null input", () => {
    expect(validateTechStack(null)).toBe("Tech stack is required");
  });

  test("returns error for undefined input", () => {
    expect(validateTechStack(undefined)).toBe("Tech stack is required");
  });

  test("returns error for non-string input", () => {
    expect(validateTechStack(123)).toBe("Tech stack must be a string");
  });

  test("returns error for whitespace-only string", () => {
    expect(validateTechStack("   ")).toBe("Tech stack cannot be empty or whitespace-only");
  });

  test("returns error for tech stack too long", () => {
    expect(validateTechStack("a".repeat(201))).toBe("Tech stack must be at most 200 characters");
  });

  test("returns true for tech stack at maximum length", () => {
    expect(validateTechStack("a".repeat(200))).toBe(true);
  });
});

describe("validateDevEnv", () => {
  test("returns true for undefined (optional field)", () => {
    expect(validateDevEnv(undefined)).toBe(true);
  });

  test("returns true for null (optional field)", () => {
    expect(validateDevEnv(null)).toBe(true);
  });

  test("returns true for valid dev env", () => {
    expect(validateDevEnv("VS Code, Docker, PostgreSQL")).toBe(true);
  });

  test("returns true for empty string", () => {
    expect(validateDevEnv("")).toBe(true);
  });

  test("returns error for non-string input", () => {
    expect(validateDevEnv(123)).toBe("Dev environment must be a string");
  });

  test("returns error for dev env too long", () => {
    expect(validateDevEnv("a".repeat(201))).toBe("Dev environment must be at most 200 characters");
  });

  test("returns true for dev env at maximum length", () => {
    expect(validateDevEnv("a".repeat(200))).toBe(true);
  });
});

describe("validateTestMethod", () => {
  test("returns true for undefined (optional field)", () => {
    expect(validateTestMethod(undefined)).toBe(true);
  });

  test("returns true for null (optional field)", () => {
    expect(validateTestMethod(null)).toBe(true);
  });

  test("returns true for valid test method", () => {
    expect(validateTestMethod("Jest, React Testing Library")).toBe(true);
  });

  test("returns true for empty string", () => {
    expect(validateTestMethod("")).toBe(true);
  });

  test("returns error for non-string input", () => {
    expect(validateTestMethod(123)).toBe("Test method must be a string");
  });

  test("returns error for test method too long", () => {
    expect(validateTestMethod("a".repeat(201))).toBe("Test method must be at most 200 characters");
  });

  test("returns true for test method at maximum length", () => {
    expect(validateTestMethod("a".repeat(200))).toBe(true);
  });
});

describe("validateSessionInput", () => {
  test("returns valid for complete valid input", () => {
    const result = validateSessionInput({
      projectName: "My Project",
      requirements: "Build a web application with React",
      techStack: "TypeScript, React, Node.js",
      devEnv: "VS Code, Docker",
      testMethod: "Jest",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("returns valid for minimal valid input (required fields only)", () => {
    const result = validateSessionInput({
      projectName: "My Project",
      requirements: "Build a web application with React",
      techStack: "TypeScript, React, Node.js",
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("returns errors for missing all required fields", () => {
    const result = validateSessionInput({
      projectName: null,
      requirements: null,
      techStack: null,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Project name is required");
    expect(result.errors).toContain("Requirements is required");
    expect(result.errors).toContain("Tech stack is required");
    expect(result.errors).toHaveLength(3);
  });

  test("returns errors for invalid project name", () => {
    const result = validateSessionInput({
      projectName: "ab",
      requirements: "Valid requirements here",
      techStack: "TypeScript",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Project name must be at least 3 characters");
  });

  test("returns multiple errors for multiple invalid fields", () => {
    const result = validateSessionInput({
      projectName: "",
      requirements: "short",
      techStack: "",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Project name cannot be empty or whitespace-only");
    expect(result.errors).toContain("Requirements must be at least 10 characters");
    expect(result.errors).toContain("Tech stack cannot be empty or whitespace-only");
    expect(result.errors).toHaveLength(3);
  });

  test("trims whitespace before validation", () => {
    const result = validateSessionInput({
      projectName: "   ",
      requirements: "   ",
      techStack: "   ",
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Project name cannot be empty or whitespace-only");
    expect(result.errors).toContain("Requirements cannot be empty or whitespace-only");
    expect(result.errors).toContain("Tech stack cannot be empty or whitespace-only");
  });
});
