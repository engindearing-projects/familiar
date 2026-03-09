// useFileActivity — combines gateway tool events + fs.watch() into unified file activity map.
import { useState, useEffect, useRef, useCallback } from "react";
import { watch } from "fs";
import { relative } from "path";
import { summarize } from "../lib/tree-builder.js";

const DEBOUNCE_MS = 200;
const RENDER_THROTTLE_MS = 100;
const COLLAPSE_DELAY_MS = 500;

// Patterns to ignore from fs.watch events
const IGNORE_RE = /(?:^|[/\\])(?:\.git|node_modules|\.next|\.turbo|dist|\.cache|__pycache__)[/\\]?|\.swp$|\.swo$|~$/;

/**
 * @typedef {Object} FileActivityEntry
 * @property {string} path - Relative path from watchRoot
 * @property {"active"|"done"} status
 * @property {string|null} toolName - Gateway tool that touched this file
 * @property {number} timestamp - Last activity time
 */

/**
 * Tracks file activity from two sources: gateway tool events and fs.watch.
 *
 * @param {{ busy: boolean, toolEvents: Array, watchRoot: string }} params
 * @returns {{ files: FileActivityEntry[], summary: { totalFiles: number, directories: string[] }, isCollapsed: boolean }}
 */
export function useFileActivity({ busy, toolEvents, watchRoot }) {
  const [files, setFiles] = useState([]);
  const [isCollapsed, setIsCollapsed] = useState(true);

  const filesRef = useRef(new Map());
  const watcherRef = useRef(null);
  const debounceRef = useRef(null);
  const throttleRef = useRef(null);
  const collapseRef = useRef(null);
  const prevBusyRef = useRef(false);

  // Flush current map to state (throttled)
  const flushToState = useCallback(() => {
    if (throttleRef.current) return;
    const entries = [...filesRef.current.values()];
    setFiles(entries);
    throttleRef.current = setTimeout(() => {
      throttleRef.current = null;
      // Flush latest after throttle
      setFiles([...filesRef.current.values()]);
    }, RENDER_THROTTLE_MS);
  }, []);

  // Add or update a file entry
  const upsertFile = useCallback((relPath, toolName) => {
    if (!relPath || IGNORE_RE.test(relPath)) return;
    const existing = filesRef.current.get(relPath);
    filesRef.current.set(relPath, {
      path: relPath,
      status: "active",
      toolName: toolName || existing?.toolName || null,
      timestamp: Date.now(),
    });
  }, []);

  // Handle busy transitions
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = busy;

    if (busy && !wasBusy) {
      // Starting — clear map, open watcher, un-collapse
      filesRef.current.clear();
      setFiles([]);
      setIsCollapsed(false);
      if (collapseRef.current) {
        clearTimeout(collapseRef.current);
        collapseRef.current = null;
      }

      // Start fs.watch
      try {
        watcherRef.current = watch(watchRoot, { recursive: true }, (eventType, filename) => {
          if (!filename || IGNORE_RE.test(filename)) return;
          // Debounce rapid fs events
          if (debounceRef.current) clearTimeout(debounceRef.current);
          debounceRef.current = setTimeout(() => {
            debounceRef.current = null;
            upsertFile(filename, null);
            flushToState();
          }, DEBOUNCE_MS);
        });
      } catch {
        // fs.watch failed (permissions, missing dir) — work purely from gateway events
        watcherRef.current = null;
      }
    }

    if (!busy && wasBusy) {
      // Stopping — close watcher, mark all active→done, delay then collapse
      if (watcherRef.current) {
        watcherRef.current.close();
        watcherRef.current = null;
      }
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }

      // Mark all entries done
      for (const [key, entry] of filesRef.current) {
        if (entry.status === "active") {
          filesRef.current.set(key, { ...entry, status: "done" });
        }
      }
      setFiles([...filesRef.current.values()]);

      // Collapse after delay
      collapseRef.current = setTimeout(() => {
        collapseRef.current = null;
        setIsCollapsed(true);
      }, COLLAPSE_DELAY_MS);
    }
  }, [busy, watchRoot, upsertFile, flushToState]);

  // Process gateway tool events — annotate files with tool names
  useEffect(() => {
    if (!toolEvents || toolEvents.length === 0) return;

    let changed = false;
    for (const evt of toolEvents) {
      if (evt.filePath) {
        // Make path relative to watchRoot
        let rel = evt.filePath;
        try {
          rel = relative(watchRoot, evt.filePath);
        } catch {
          // keep as-is
        }
        // Skip absolute paths that aren't under watchRoot
        if (rel.startsWith("..") || rel.startsWith("/")) continue;
        upsertFile(rel, evt.toolName);
        changed = true;
      }
    }
    if (changed) flushToState();
  }, [toolEvents, watchRoot, upsertFile, flushToState]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (watcherRef.current) watcherRef.current.close();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (throttleRef.current) clearTimeout(throttleRef.current);
      if (collapseRef.current) clearTimeout(collapseRef.current);
    };
  }, []);

  const summary = filesRef.current.size > 0 ? summarize([...filesRef.current.values()]) : { totalFiles: 0, directories: [] };

  return { files, summary, isCollapsed };
}
