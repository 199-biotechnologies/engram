import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadSettings, saveSettings, getAnthropicApiKey } from "../src/settings.js";
import fs from "fs";
import path from "path";
import os from "os";

// The settings module resolves SETTINGS_DIR at import time, so we need to
// know where it's actually looking. Compute the same path it uses.
const SETTINGS_DIR = process.env.ENGRAM_DB_PATH?.replace("~", os.homedir())
  || path.join(os.homedir(), ".engram");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");

let existingContent: string | null = null;

beforeEach(() => {
  // Backup existing settings file if it exists
  try {
    existingContent = fs.readFileSync(SETTINGS_FILE, "utf-8");
  } catch {
    existingContent = null;
  }
  // Remove settings file for clean test
  try { fs.unlinkSync(SETTINGS_FILE); } catch {}
});

afterEach(() => {
  // Restore original settings file
  if (existingContent !== null) {
    fs.writeFileSync(SETTINGS_FILE, existingContent);
  } else {
    try { fs.unlinkSync(SETTINGS_FILE); } catch {}
  }
});

describe("Settings", () => {
  it("loads empty settings when no file exists", () => {
    const settings = loadSettings();
    expect(settings).toEqual({});
  });

  it("saves and loads settings round-trip", () => {
    saveSettings({ anthropic_api_key: "sk-test-roundtrip" });
    const settings = loadSettings();
    expect(settings.anthropic_api_key).toBe("sk-test-roundtrip");
  });

  it("getAnthropicApiKey prefers settings over env var", () => {
    const oldKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-env-key";

    try {
      // No settings file → should fall back to env
      let key = getAnthropicApiKey();
      expect(key).toBe("sk-env-key");

      // With settings file → should prefer settings
      saveSettings({ anthropic_api_key: "sk-settings-key" });
      key = getAnthropicApiKey();
      expect(key).toBe("sk-settings-key");
    } finally {
      if (oldKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = oldKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });
});
