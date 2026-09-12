"use client";

import { useSyncExternalStore } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

const STORAGE_KEY = "agentzpro-sidebar";
const CHANGE_EVENT = "agentzpro:sidebar-change";

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  return () => window.removeEventListener(CHANGE_EVENT, callback);
}

function getSnapshot(): boolean {
  return document.documentElement.dataset.sidebar === "collapsed";
}

function getServerSnapshot(): boolean {
  return false;
}

/** Reads the collapsed state written by the blocking script in the root layout. */
function useSidebarCollapsed(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function setCollapsed(collapsed: boolean): void {
  const value = collapsed ? "collapsed" : "expanded";
  document.documentElement.dataset.sidebar = value;
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Ignore storage failures (private browsing, disabled storage, etc.)
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Collapse control: lives inside the sidebar and hides it entirely. */
export function SidebarCollapseButton() {
  const collapsed = useSidebarCollapsed();

  if (collapsed) {
    return null;
  }

  return (
    <button
      type="button"
      className="sidebar-collapse-btn"
      onClick={() => setCollapsed(true)}
      aria-label="Collapse sidebar"
      aria-controls="primary-sidebar"
      aria-expanded
      title="Collapse sidebar"
    >
      <PanelLeftClose size={14} aria-hidden="true" />
    </button>
  );
}

/** The only affordance shown while the sidebar is hidden. */
export function SidebarExpandButton() {
  const collapsed = useSidebarCollapsed();

  if (!collapsed) {
    return null;
  }

  return (
    <button
      type="button"
      className="sidebar-expand-btn"
      onClick={() => setCollapsed(false)}
      aria-label="Expand sidebar"
      aria-controls="primary-sidebar"
      aria-expanded={false}
      title="Expand sidebar"
    >
      <PanelLeftOpen size={17} aria-hidden="true" />
    </button>
  );
}
