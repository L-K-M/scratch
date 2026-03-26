import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { Editor, type PreviewModeData } from "../editor/Editor";
import * as filesService from "../../services/files";

interface PreviewAppProps {
  filePath: string;
}

export function PreviewApp({ filePath }: PreviewAppProps) {
  const [content, setContent] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [modified, setModified] = useState(0);
  const [hasExternalChanges, setHasExternalChanges] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [focusMode, setFocusMode] = useState(false);
  const recentlySavedRef = useRef(false);

  const menuEnabledActions = useMemo(() => {
    const hasCurrentNote = content !== null;
    return {
      "reload-note": true,
      "find-in-note": hasCurrentNote,
      "add-link": hasCurrentNote,
      "toggle-focus-mode": hasCurrentNote,
      "toggle-source-mode": hasCurrentNote,
      "open-copy-export": hasCurrentNote,
      "copy-markdown": hasCurrentNote,
      "copy-plain-text": hasCurrentNote,
      "copy-html": hasCurrentNote,
      "print-pdf": hasCurrentNote,
      "export-markdown": hasCurrentNote,
    };
  }, [content]);

  useEffect(() => {
    invoke("update_menu_state", {
      menuState: { enabledActions: menuEnabledActions },
    }).catch((error) => {
      console.error("Failed to update menu state:", error);
    });
  }, [menuEnabledActions]);

  useEffect(() => {
    const handleWindowFocus = () => {
      invoke("update_menu_state", {
        menuState: { enabledActions: menuEnabledActions },
      }).catch((error) => {
        console.error("Failed to update menu state:", error);
      });
    };

    window.addEventListener("focus", handleWindowFocus);
    return () => window.removeEventListener("focus", handleWindowFocus);
  }, [menuEnabledActions]);

  // Load file on mount
  useEffect(() => {
    filesService
      .readFileDirect(filePath)
      .then((result) => {
        setContent(result.content);
        setTitle(result.title);
        setModified(result.modified);
      })
      .catch((error) => {
        console.error("Failed to load file:", error);
        toast.error(`Failed to load file: ${error}`);
      });
  }, [filePath]);

  // Listen for window focus to detect external changes
  useEffect(() => {
    const handleFocus = async () => {
      if (recentlySavedRef.current) {
        recentlySavedRef.current = false;
        return;
      }
      try {
        const result = await filesService.readFileDirect(filePath);
        if (result.modified !== modified && content !== null) {
          setHasExternalChanges(true);
        }
      } catch {
        // File may have been deleted
      }
    };

    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [filePath, modified, content]);

  const save = useCallback(
    async (newContent: string) => {
      try {
        const result = await filesService.saveFileDirect(filePath, newContent);
        recentlySavedRef.current = true;
        setModified(result.modified);
        setTitle(result.title);
        setHasExternalChanges(false);
      } catch (error) {
        console.error("Failed to save file:", error);
        toast.error(`Failed to save: ${error}`);
      }
    },
    [filePath],
  );

  const reload = useCallback(async () => {
    try {
      const result = await filesService.readFileDirect(filePath);
      setContent(result.content);
      setTitle(result.title);
      setModified(result.modified);
      setHasExternalChanges(false);
      setReloadVersion((v) => v + 1);
    } catch (error) {
      console.error("Failed to reload file:", error);
      toast.error(`Failed to reload: ${error}`);
    }
  }, [filePath]);

  // Listen for preview-file-change events
  useEffect(() => {
    const unlisten = listen<string>("preview-file-change", () => {
      setHasExternalChanges(true);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Handle native menu actions when a preview window is focused
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const emitEditorAction = (name: string) => {
      window.dispatchEvent(new CustomEvent(name));
    };

    listen<string>("menu-action", async (event) => {
      switch (event.payload) {
        case "reload-note": {
          await reload();
          return;
        }
        case "toggle-focus-mode": {
          setFocusMode((prev) => !prev);
          return;
        }
        case "toggle-source-mode": {
          window.dispatchEvent(new CustomEvent("toggle-source-mode"));
          return;
        }
        case "find-in-note": {
          emitEditorAction("menu-find-in-note");
          return;
        }
        case "add-link": {
          emitEditorAction("menu-add-link");
          return;
        }
        case "open-copy-export": {
          emitEditorAction("menu-open-copy-export");
          return;
        }
        case "copy-markdown": {
          emitEditorAction("menu-copy-markdown");
          return;
        }
        case "copy-plain-text": {
          emitEditorAction("menu-copy-plain-text");
          return;
        }
        case "copy-html": {
          emitEditorAction("menu-copy-html");
          return;
        }
        case "print-pdf": {
          emitEditorAction("menu-print-pdf");
          return;
        }
        case "export-markdown": {
          emitEditorAction("menu-export-markdown");
          return;
        }
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((error) => {
        console.error("Failed to subscribe to menu-action events:", error);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [reload]);

  // Keyboard shortcuts for preview mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const modKey = e.metaKey || e.ctrlKey;

      // Cmd+Shift+Enter: Toggle focus mode
      if (modKey && e.shiftKey && e.key === "Enter") {
        e.preventDefault();
        setFocusMode((prev) => !prev);
        return;
      }

      // Cmd+Shift+M: Toggle markdown source mode
      if (modKey && e.shiftKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("toggle-source-mode"));
        return;
      }

      // Cmd+R: Reload file from disk
      if (modKey && e.key === "r") {
        e.preventDefault();
        reload();
        return;
      }

      // Escape: Exit focus mode
      if (e.key === "Escape" && focusMode) {
        e.preventDefault();
        setFocusMode(false);
        return;
      }

      // Trap Tab to prevent focus leaving editor (only when editor is focused)
      if (e.key === "Tab") {
        const active = document.activeElement;
        const editorEl = document.querySelector(".ProseMirror");
        if (editorEl && editorEl.contains(active)) {
          e.preventDefault();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [focusMode, reload]);

  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);

  const handleSaveToFolder = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setIsSaving(true);
    try {
      await filesService.importFileToFolder(filePath);
      // Backend emits select-note + focuses main window; close this preview
      await getCurrentWindow().close();
    } catch (error) {
      console.error("Failed to save to folder:", error);
      toast.error(`Failed to save to folder: ${error}`);
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }, [filePath]);

  const previewData: PreviewModeData = {
    content,
    title,
    filePath,
    modified,
    hasExternalChanges,
    reloadVersion,
    save,
    reload,
  };

  return (
    <div className="h-screen flex flex-col bg-bg text-text">
      <Editor
        focusMode={focusMode}
        previewMode={previewData}
        onSaveToFolder={handleSaveToFolder}
        saveToFolderDisabled={isSaving}
      />
    </div>
  );
}
