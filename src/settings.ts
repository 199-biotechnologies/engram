/**
 * Settings management for Engram
 * Stores configuration in ~/.engram/settings.json
 */

import fs from "fs";
import path from "path";
import os from "os";

export interface EngramSettings {
  anthropic_api_key?: string;
  // Future settings can be added here
}

const SETTINGS_DIR = process.env.ENGRAM_DB_PATH?.replace("~", os.homedir())
  || path.join(os.homedir(), ".engram");
const SETTINGS_FILE = path.join(SETTINGS_DIR, "settings.json");

/**
 * Load settings from file
 */
export function loadSettings(): EngramSettings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.error("[Engram] Failed to load settings:", error);
  }
  return {};
}

/**
 * Save settings to file
 */
export function saveSettings(settings: EngramSettings): void {
  try {
    // Ensure directory exists
    if (!fs.existsSync(SETTINGS_DIR)) {
      fs.mkdirSync(SETTINGS_DIR, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (error) {
    console.error("[Engram] Failed to save settings:", error);
    throw error;
  }
}

/**
 * Get the Anthropic API key from settings or environment
 * Priority: settings file > environment variable
 */
export function getAnthropicApiKey(): string | undefined {
  const settings = loadSettings();
  return settings.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
}

/**
 * Set the Anthropic API key in settings
 */
export function setAnthropicApiKey(apiKey: string): void {
  const settings = loadSettings();
  settings.anthropic_api_key = apiKey;
  saveSettings(settings);
}

/**
 * Check if API key is configured (either in settings or env)
 */
export function hasAnthropicApiKey(): boolean {
  return !!getAnthropicApiKey();
}
