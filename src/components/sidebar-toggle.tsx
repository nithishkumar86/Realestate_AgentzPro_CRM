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

export function SidebarToggle() {
  const collapsed = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  function toggle() {
    const next = !collapsed;
    document.documentElement.dataset.sidebar = next ? "collapsed" : "expanded";
    try {
      localStorage.setItem(STORAGE_KEY, next ? "collapsed" : "expanded");
    } catch {
      // Ignore storage failures (private browsing, disabled storage, etc.)
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }

  return (
    <button
      type="button"
      className="sidebar-collapse-btn"
      onClick={toggle}
      aria-pressed={collapsed}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
    >
      {collapsed ? <PanelLeftOpen size={14} aria-hidden="true" /> : <PanelLeftClose size={14} aria-hidden="true" />}
    </button>
  );
}
