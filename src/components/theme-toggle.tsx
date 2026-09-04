"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

const STORAGE_KEY = "agentzpro-theme";
const CHANGE_EVENT = "agentzpro:theme-change";

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  return () => window.removeEventListener(CHANGE_EVENT, callback);
}

function getSnapshot(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function getServerSnapshot(): "light" | "dark" {
  return "light";
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const isDark = theme === "dark";

  function toggle() {
    const next = isDark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore storage failures (private browsing, disabled storage, etc.)
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }

  return (
    <button
      type="button"
      className="theme-toggle-btn"
      onClick={toggle}
      aria-pressed={isDark}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {isDark ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
      <span className="theme-toggle-btn__label">{isDark ? "Light" : "Dark"}</span>
    </button>
  );
}
