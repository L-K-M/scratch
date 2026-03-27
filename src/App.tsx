import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import { NotesProvider, useNotes } from "./context/NotesContext";
import { ThemeProvider, useTheme } from "./context/ThemeContext";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { GitProvider } from "./context/GitContext";
import { TooltipProvider, Toaster } from "./components/ui";
import { Sidebar } from "./components/layout/Sidebar";
import { Editor } from "./components/editor/Editor";
import type { Editor as TiptapEditor } from "@tiptap/react";
import { FolderPicker } from "./components/layout/FolderPicker";
import { CommandPalette } from "./components/command-palette/CommandPalette";
import { SettingsPage } from "./components/settings";
import {
  SpinnerIcon,
  ClaudeIcon,
  CodexIcon,
  OpenCodeIcon,
  OllamaIcon,
} from "./components/icons";
import { AiEditModal } from "./components/ai/AiEditModal";
import { AiResponseToast } from "./components/ai/AiResponseToast";
import { KeyboardShortcutsModal } from "./components/shortcuts/KeyboardShortcutsModal";
import { PreviewApp } from "./components/preview/PreviewApp";
import {
  check as checkForUpdate,
  type Update,
} from "@tauri-apps/plugin-updater";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as aiService from "./services/ai";
import type { AiProvider } from "./services/ai";
import * as notesService from "./services/notes";

// Detect preview mode from URL search params
function getWindowMode(): {
  isPreview: boolean;
  previewFile: string | null;
} {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("mode");
  const file = params.get("file");
  return {
    isPreview: mode === "preview" && !!file,
    previewFile: file,
  };
}

type ViewState = "notes" | "settings";

interface ClipboardCapabilities {
  canCut: boolean;
  canCopy: boolean;
  canPaste: boolean;
  canSelectAll: boolean;
}

function AppContent() {
  const {
    notesFolder,
    isLoading,
    createNote,
    duplicateNote,
    notes,
    selectedNoteId,
    selectNote,
    searchQuery,
    searchResults,
    reloadCurrentNote,
    currentNote,
    syncNotesFolder,
  } = useNotes();
  const { interfaceZoom, setInterfaceZoom, reloadSettings } = useTheme();
  const interfaceZoomRef = useRef(interfaceZoom);
  interfaceZoomRef.current = interfaceZoom;
  const currentNoteRef = useRef(currentNote);
  currentNoteRef.current = currentNote;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [view, setView] = useState<ViewState>("notes");
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [restoreUiStateEnabled, setRestoreUiStateEnabled] = useState(false);
  const [uiStateInitialized, setUiStateInitialized] = useState(false);
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [aiEditing, setAiEditing] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [aiProvider, setAiProvider] = useState<AiProvider>("claude");
  const [clipboardCapabilities, setClipboardCapabilities] =
    useState<ClipboardCapabilities>({
      canCut: false,
      canCopy: false,
      canPaste: false,
      canSelectAll: false,
    });
  const editorRef = useRef<TiptapEditor | null>(null);
  const persistUiStateTimeoutRef = useRef<number | null>(null);
  const initializedFolderRef = useRef<string | null>(null);

  // Listen for set-notes-folder event from CLI (scratch .)
  // Placed here in AppContent where both NotesContext and ThemeContext are available
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<string>("set-notes-folder", async (event) => {
      await syncNotesFolder(event.payload);
      await reloadSettings();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [syncNotesFolder, reloadSettings]);

  // Re-run UI state initialization when notes folder changes
  useEffect(() => {
    if (initializedFolderRef.current === notesFolder) return;
    initializedFolderRef.current = notesFolder;
    setRestoreUiStateEnabled(false);
    setUiStateInitialized(false);
  }, [notesFolder]);

  // Restore UI state once notes are loaded
  useEffect(() => {
    if (isLoading || !notesFolder || uiStateInitialized) return;

    let cancelled = false;

    const restoreUiState = async () => {
      try {
        const settings = await notesService.getSettings();
        if (cancelled) return;

        const shouldRestoreOnLaunch =
          await notesService.shouldRestoreUiStateOnLaunch();
        if (cancelled) return;

        const enabled = settings.restoreUiState === true;
        setRestoreUiStateEnabled(enabled);

        if (!shouldRestoreOnLaunch || !enabled || !settings.uiState) return;

        if (typeof settings.uiState.sidebarVisible === "boolean") {
          setSidebarVisible(settings.uiState.sidebarVisible);
        }

        const savedFocusMode = settings.uiState.focusMode === true;
        let restoredSelectedNote = false;

        const savedNoteId = settings.uiState.selectedNoteId;
        if (typeof savedNoteId === "string") {
          const notesList = await notesService.listNotes();
          if (cancelled) return;

          if (notesList.some((note) => note.id === savedNoteId)) {
            try {
              await selectNote(savedNoteId);
              restoredSelectedNote = true;
            } catch (error) {
              console.error("Failed to restore selected note:", error);
            }
          }
        }

        setFocusMode(savedFocusMode && restoredSelectedNote);
      } catch (error) {
        console.error("Failed to restore UI state:", error);
        setRestoreUiStateEnabled(false);
      } finally {
        if (!cancelled) {
          setUiStateInitialized(true);
        }
      }
    };

    restoreUiState();

    return () => {
      cancelled = true;
    };
  }, [isLoading, notesFolder, selectNote, uiStateInitialized]);

  // React to settings toggle changes made from General settings
  useEffect(() => {
    const handleSettingChange = (event: Event) => {
      const customEvent = event as CustomEvent<boolean>;
      setRestoreUiStateEnabled(customEvent.detail === true);
    };

    window.addEventListener(
      "ui-state-restore-setting-changed",
      handleSettingChange,
    );

    return () => {
      window.removeEventListener(
        "ui-state-restore-setting-changed",
        handleSettingChange,
      );
    };
  }, []);

  // Persist selected note + sidebar + focus mode when restoration is enabled
  useEffect(() => {
    if (!uiStateInitialized || !restoreUiStateEnabled || !notesFolder) return;

    if (persistUiStateTimeoutRef.current) {
      clearTimeout(persistUiStateTimeoutRef.current);
    }

    persistUiStateTimeoutRef.current = window.setTimeout(() => {
      notesService
        .updateUiState(selectedNoteId, sidebarVisible, focusMode, notesFolder)
        .catch((error) => {
          console.error("Failed to persist UI state:", error);
        });
    }, 200);

    return () => {
      if (persistUiStateTimeoutRef.current) {
        clearTimeout(persistUiStateTimeoutRef.current);
        persistUiStateTimeoutRef.current = null;
      }
    };
  }, [
    uiStateInitialized,
    restoreUiStateEnabled,
    notesFolder,
    selectedNoteId,
    sidebarVisible,
    focusMode,
  ]);

  const toggleSidebar = useCallback(() => {
    setSidebarVisible((prev) => !prev);
  }, []);

  const toggleFocusMode = useCallback(() => {
    setFocusMode((prev) => {
      // Don't enter focus mode without a selected note
      if (!prev && !selectedNoteId) return prev;
      if (prev) {
        // Exiting focus mode — always restore sidebar
        setSidebarVisible(true);
      }
      return !prev;
    });
  }, [selectedNoteId]);

  const toggleSettings = useCallback(() => {
    setView((prev) => (prev === "settings" ? "notes" : "settings"));
  }, []);

  const closeSettings = useCallback(() => {
    setView("notes");
  }, []);

  const computeClipboardCapabilities = useCallback((): ClipboardCapabilities => {
    const activeElement = document.activeElement;
    const selection = window.getSelection();

    const hasDocumentSelection = Boolean(
      selection && !selection.isCollapsed && selection.toString().length > 0,
    );

    const isTextControl =
      activeElement instanceof HTMLInputElement ||
      activeElement instanceof HTMLTextAreaElement;

    const hasInputSelection =
      isTextControl &&
      activeElement.selectionStart !== null &&
      activeElement.selectionEnd !== null &&
      activeElement.selectionEnd > activeElement.selectionStart;

    const isInputSelectable =
      isTextControl &&
      !activeElement.disabled &&
      (activeElement instanceof HTMLTextAreaElement ||
        ![
          "button",
          "checkbox",
          "color",
          "file",
          "hidden",
          "image",
          "radio",
          "range",
          "reset",
          "submit",
        ].includes(activeElement.type));

    const isInputEditable =
      isInputSelectable &&
      !activeElement.readOnly &&
      !activeElement.disabled;

    const htmlActive = activeElement as HTMLElement | null;
    const isContentEditableTarget = Boolean(
      htmlActive &&
        (htmlActive.isContentEditable ||
          htmlActive.closest("[contenteditable='true'], .ProseMirror")),
    );

    const canCut =
      (isInputEditable && hasInputSelection) ||
      (isContentEditableTarget && hasDocumentSelection);
    const canCopy = hasInputSelection || hasDocumentSelection;
    const canPaste = isInputEditable || isContentEditableTarget;
    const canSelectAll = isInputSelectable || isContentEditableTarget;

    return { canCut, canCopy, canPaste, canSelectAll };
  }, []);

  useEffect(() => {
    const updateClipboardCapabilities = () => {
      const next = computeClipboardCapabilities();
      setClipboardCapabilities((prev) =>
        prev.canCut === next.canCut &&
        prev.canCopy === next.canCopy &&
        prev.canPaste === next.canPaste &&
        prev.canSelectAll === next.canSelectAll
          ? prev
          : next,
      );
    };

    updateClipboardCapabilities();

    document.addEventListener("selectionchange", updateClipboardCapabilities);
    document.addEventListener("focusin", updateClipboardCapabilities);
    document.addEventListener("keyup", updateClipboardCapabilities);
    document.addEventListener("mouseup", updateClipboardCapabilities);
    window.addEventListener("focus", updateClipboardCapabilities);

    return () => {
      document.removeEventListener("selectionchange", updateClipboardCapabilities);
      document.removeEventListener("focusin", updateClipboardCapabilities);
      document.removeEventListener("keyup", updateClipboardCapabilities);
      document.removeEventListener("mouseup", updateClipboardCapabilities);
      window.removeEventListener("focus", updateClipboardCapabilities);
    };
  }, [computeClipboardCapabilities]);

  const runEditCommand = useCallback(
    (command: "cut" | "copy" | "paste" | "selectAll") => {
      const activeElement = document.activeElement as HTMLElement | null;
      activeElement?.focus();

      try {
        document.execCommand(command);
      } catch (error) {
        console.error(`Failed to run ${command}:`, error);
      }
    },
    [],
  );

  const menuEnabledActions = useMemo(() => {
    const hasNotesFolder = Boolean(notesFolder);
    const isNotesView = view === "notes";
    const hasSelectedNote = Boolean(
      selectedNoteId && notes.some((note) => note.id === selectedNoteId),
    );
    const hasCurrentNote = Boolean(currentNote);
    const hasEditorActions = isNotesView && hasCurrentNote;
    const canZoomIn = interfaceZoom < 1.5;
    const canZoomOut = interfaceZoom > 0.7;
    const canZoomReset = Math.abs(interfaceZoom - 1) > 0.001;

    return {
      "check-for-updates": true,
      "open-settings": hasNotesFolder,
      "new-note": hasNotesFolder,
      "new-folder": hasNotesFolder,
      "duplicate-note": hasSelectedNote,
      "delete-note": hasSelectedNote,
      "reload-note": hasSelectedNote,
      "open-notes-folder": hasNotesFolder,
      "search-notes": hasNotesFolder,
      "command-palette": hasNotesFolder,
      "toggle-sidebar": hasNotesFolder && isNotesView,
      "zoom-in": canZoomIn,
      "zoom-out": canZoomOut,
      "zoom-reset": canZoomReset,
      "settings-tab-general": hasNotesFolder,
      "settings-tab-editor": hasNotesFolder,
      "settings-tab-shortcuts": hasNotesFolder,
      "settings-tab-about": hasNotesFolder,
      "find-in-note": hasEditorActions,
      "add-link": hasEditorActions,
      "toggle-focus-mode": hasSelectedNote && isNotesView,
      "toggle-source-mode": hasEditorActions,
      "copy-export-menu": hasSelectedNote,
      "copy-markdown": hasEditorActions,
      "copy-plain-text": hasEditorActions,
      "copy-html": hasEditorActions,
      "print-pdf": hasEditorActions,
      "export-markdown": hasEditorActions,
      "edit-cut": clipboardCapabilities.canCut,
      "edit-copy": clipboardCapabilities.canCopy,
      "edit-paste": clipboardCapabilities.canPaste,
      "edit-select-all": clipboardCapabilities.canSelectAll,
    };
  }, [
    clipboardCapabilities,
    currentNote?.id,
    interfaceZoom,
    notes,
    notesFolder,
    selectedNoteId,
    view,
  ]);

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

  // Handle menu actions from native macOS menu
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const openSettingsTab = (
      tab: "general" | "editor" | "shortcuts" | "about",
    ) => {
      setView("settings");
      requestAnimationFrame(() => {
        window.dispatchEvent(
          new CustomEvent("settings-tab-select", { detail: tab }),
        );
      });
    };

    const emitEditorAction = (name: string) => {
      window.dispatchEvent(new CustomEvent(name));
    };

    listen<string>("menu-action", async (event) => {
      const action = event.payload;

      switch (action) {
        case "check-for-updates": {
          const result = await showUpdateToast();
          if (result === "no-update") {
            toast.success("You're on the latest version!");
          } else if (result === "error") {
            toast.error("Could not check for updates. Try again later.");
          }
          return;
        }
        case "open-settings": {
          setView("settings");
          return;
        }
        case "settings-tab-general": {
          openSettingsTab("general");
          return;
        }
        case "settings-tab-editor": {
          openSettingsTab("editor");
          return;
        }
        case "settings-tab-shortcuts": {
          openSettingsTab("shortcuts");
          return;
        }
        case "settings-tab-about": {
          openSettingsTab("about");
          return;
        }
        case "new-note": {
          setView("notes");
          createNote();
          return;
        }
        case "new-folder": {
          setView("notes");
          requestAnimationFrame(() => {
            window.dispatchEvent(new CustomEvent("create-new-folder"));
          });
          return;
        }
        case "duplicate-note": {
          setView("notes");
          if (selectedNoteId) {
            await duplicateNote(selectedNoteId);
          }
          return;
        }
        case "delete-note": {
          setView("notes");
          if (selectedNoteId) {
            window.dispatchEvent(
              new CustomEvent("request-delete-note", { detail: selectedNoteId }),
            );
          }
          return;
        }
        case "reload-note": {
          setView("notes");
          await reloadCurrentNote();
          return;
        }
        case "open-notes-folder": {
          if (!notesFolder) return;
          try {
            await invoke("open_in_file_manager", { path: notesFolder });
          } catch (error) {
            console.error("Failed to open notes folder:", error);
            toast.error("Failed to open notes folder");
          }
          return;
        }
        case "search-notes": {
          setView("notes");
          requestAnimationFrame(() => {
            setSidebarVisible(true);
            window.dispatchEvent(new CustomEvent("open-sidebar-search"));
          });
          return;
        }
        case "command-palette": {
          setView("notes");
          setPaletteOpen(true);
          return;
        }
        case "toggle-sidebar": {
          setView("notes");
          toggleSidebar();
          return;
        }
        case "toggle-focus-mode": {
          setView("notes");
          toggleFocusMode();
          return;
        }
        case "toggle-source-mode": {
          setView("notes");
          window.dispatchEvent(new CustomEvent("toggle-source-mode"));
          return;
        }
        case "find-in-note": {
          setView("notes");
          emitEditorAction("menu-find-in-note");
          return;
        }
        case "add-link": {
          setView("notes");
          emitEditorAction("menu-add-link");
          return;
        }
        case "copy-markdown": {
          setView("notes");
          emitEditorAction("menu-copy-markdown");
          return;
        }
        case "copy-plain-text": {
          setView("notes");
          emitEditorAction("menu-copy-plain-text");
          return;
        }
        case "copy-html": {
          setView("notes");
          emitEditorAction("menu-copy-html");
          return;
        }
        case "print-pdf": {
          setView("notes");
          emitEditorAction("menu-print-pdf");
          return;
        }
        case "export-markdown": {
          setView("notes");
          emitEditorAction("menu-export-markdown");
          return;
        }
        case "edit-cut": {
          runEditCommand("cut");
          return;
        }
        case "edit-copy": {
          runEditCommand("copy");
          return;
        }
        case "edit-paste": {
          runEditCommand("paste");
          return;
        }
        case "edit-select-all": {
          runEditCommand("selectAll");
          return;
        }
        case "zoom-in": {
          setInterfaceZoom((prev) => prev + 0.05);
          const newZoom =
            Math.round(Math.min(interfaceZoomRef.current + 0.05, 1.5) * 20) /
            20;
          toast(`Zoom ${Math.round(newZoom * 100)}%`, {
            id: "zoom",
            duration: 1500,
          });
          return;
        }
        case "zoom-out": {
          setInterfaceZoom((prev) => prev - 0.05);
          const newZoom =
            Math.round(Math.max(interfaceZoomRef.current - 0.05, 0.7) * 20) /
            20;
          toast(`Zoom ${Math.round(newZoom * 100)}%`, {
            id: "zoom",
            duration: 1500,
          });
          return;
        }
        case "zoom-reset": {
          setInterfaceZoom(1.0);
          toast("Zoom 100%", { id: "zoom", duration: 1500 });
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
  }, [
    createNote,
    duplicateNote,
    notesFolder,
    reloadCurrentNote,
    selectedNoteId,
    setInterfaceZoom,
    toggleFocusMode,
    toggleSidebar,
    runEditCommand,
  ]);

  // Go back to command palette from AI modal
  const handleBackToPalette = useCallback(() => {
    setAiModalOpen(false);
    setPaletteOpen(true);
  }, []);

  // AI Edit handler
  const handleAiEdit = useCallback(
    async (prompt: string, ollamaModel?: string) => {
      if (!currentNote) {
        toast.error("No note selected");
        return;
      }

      setAiEditing(true);

      try {
        let result: aiService.AiExecutionResult;
        if (aiProvider === "codex") {
          result = await aiService.executeCodexEdit(currentNote.path, prompt);
        } else if (aiProvider === "opencode") {
          result = await aiService.executeOpenCodeEdit(currentNote.path, prompt);
        } else if (aiProvider === "ollama") {
          result = await aiService.executeOllamaEdit(
            currentNote.path,
            prompt,
            ollamaModel || "qwen3:8b",
          );
        } else {
          result = await aiService.executeClaudeEdit(currentNote.path, prompt);
        }

        // Reload the current note from disk
        await reloadCurrentNote();

        // Show results
        if (result.success) {
          // Close modal after success
          setAiModalOpen(false);

          // Show success toast with provider response
          toast(
            <AiResponseToast output={result.output} provider={aiProvider} />,
            {
              duration: Infinity,
              closeButton: true,
              className: "!min-w-[450px] !max-w-[600px]",
            },
          );
        } else {
          toast.error(
            <div className="space-y-1">
              <div className="font-medium">AI Edit Failed</div>
              <div className="text-xs">{result.error || "Unknown error"}</div>
            </div>,
            { duration: Infinity, closeButton: true },
          );
        }
      } catch (error) {
        console.error("[AI] Error:", error);
        toast.error(
          `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        );
      } finally {
        setAiEditing(false);
      }
    },
    [aiProvider, currentNote, reloadCurrentNote],
  );

  // Memoize display items to prevent unnecessary recalculations
  const displayItems = useMemo(() => {
    return searchQuery.trim() ? searchResults : notes;
  }, [searchQuery, searchResults, notes]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInEditor = !!target.closest(".ProseMirror");
      const isInInput =
        target.tagName === "INPUT" || target.tagName === "TEXTAREA";
      const isEditorEmpty =
        isInEditor && currentNoteRef.current?.content.trim() === "";

      // Cmd+, - Toggle settings (always works, even in settings)
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        toggleSettings();
        return;
      }

      // Cmd+= or Cmd++ - Zoom in (works everywhere, including settings)
      if ((e.metaKey || e.ctrlKey) && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        setInterfaceZoom((prev) => prev + 0.05);
        const newZoom = Math.round(Math.min(interfaceZoomRef.current + 0.05, 1.5) * 20) / 20;
        toast(`Zoom ${Math.round(newZoom * 100)}%`, { id: "zoom", duration: 1500 });
        return;
      }

      // Cmd+- - Zoom out (works everywhere, including settings)
      if ((e.metaKey || e.ctrlKey) && (e.key === "-" || e.key === "_")) {
        e.preventDefault();
        setInterfaceZoom((prev) => prev - 0.05);
        const newZoom = Math.round(Math.max(interfaceZoomRef.current - 0.05, 0.7) * 20) / 20;
        toast(`Zoom ${Math.round(newZoom * 100)}%`, { id: "zoom", duration: 1500 });
        return;
      }

      // Cmd+0 - Reset zoom (works everywhere, including settings)
      if ((e.metaKey || e.ctrlKey) && e.key === "0") {
        e.preventDefault();
        setInterfaceZoom(1.0);
        toast("Zoom 100%", { id: "zoom", duration: 1500 });
        return;
      }

      // Block all other shortcuts when in settings view
      if (view === "settings") {
        return;
      }

      // Cmd+Shift+Enter - Toggle focus mode
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "Enter") {
        e.preventDefault();
        toggleFocusMode();
        return;
      }

      // Cmd+Shift+M - Toggle markdown source mode
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "m"
      ) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("toggle-source-mode"));
        return;
      }

      // Escape exits focus mode when not in editor
      if (e.key === "Escape" && focusMode && !isInEditor) {
        e.preventDefault();
        toggleFocusMode();
        return;
      }

      // Let dialogs handle their own keyboard events (Tab, Enter, etc.)
      if (target.closest("[role='dialog'], [role='alertdialog']")) {
        return;
      }

      // Trap Tab/Shift+Tab in notes view only - prevent focus navigation
      // TipTap handles indentation internally before event bubbles up
      if (e.key === "Tab") {
        e.preventDefault();
        return;
      }

      // Cmd+P - Open command palette
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "p") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }

      // Cmd+Shift+P - Print
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("print-note"));
        return;
      }

      // Cmd+/ - Open keyboard shortcuts
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      // Cmd/Ctrl+Shift+F - Open sidebar search
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "f"
      ) {
        e.preventDefault();
        setSidebarVisible(true);
        window.dispatchEvent(new CustomEvent("open-sidebar-search"));
        return;
      }

      // Cmd+\ - Toggle sidebar
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // Cmd+N - New note
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        createNote();
        return;
      }

      // Delete current note (note list focused, or editor on empty note)
      if (
        selectedNoteId &&
        !isInInput &&
        (e.key === "Delete" ||
          (e.key === "Backspace" && (e.metaKey || e.ctrlKey))) &&
        (!isInEditor || isEditorEmpty)
      ) {
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent("request-delete-note", { detail: selectedNoteId }),
        );
        return;
      }

      // Cmd+D - Duplicate current note
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "d" &&
        !isInEditor &&
        !isInInput &&
        selectedNoteId
      ) {
        e.preventDefault();
        duplicateNote(selectedNoteId);
        return;
      }

      // Cmd+R - Reload current note (pull external changes)
      if ((e.metaKey || e.ctrlKey) && e.key === "r") {
        e.preventDefault();
        reloadCurrentNote();
        return;
      }

      // Arrow keys for note navigation
      // Skip if folder tree view is handling its own navigation
      const isInFolderTree = !!(e.target as HTMLElement).closest("[data-folder-tree]");
      if (
        displayItems.length > 0 &&
        (e.key === "ArrowDown" || e.key === "ArrowUp") &&
        ((!isInEditor && !isInInput) || isEditorEmpty) &&
        !isInFolderTree
      ) {
        e.preventDefault();
        const currentIndex = displayItems.findIndex(
          (n) => n.id === selectedNoteId,
        );
        let newIndex: number;

        if (e.key === "ArrowDown") {
          newIndex =
            currentIndex < displayItems.length - 1 ? currentIndex + 1 : 0;
        } else {
          newIndex =
            currentIndex > 0 ? currentIndex - 1 : displayItems.length - 1;
        }

        selectNote(displayItems[newIndex].id);
        window.dispatchEvent(new CustomEvent("focus-note-list"));
        return;
      }

      // Enter to focus editor
      if (e.key === "Enter" && selectedNoteId && !isInEditor && !isInInput) {
        e.preventDefault();
        const editor = document.querySelector(".ProseMirror") as HTMLElement;
        if (editor) {
          editor.focus();
        }
        return;
      }

      // Escape to blur editor and go back to note list
      if (e.key === "Escape" && isInEditor) {
        e.preventDefault();
        (target as HTMLElement).blur();
        // Focus the note list for keyboard navigation
        window.dispatchEvent(new CustomEvent("focus-note-list"));
        return;
      }
    };

    // Disable right-click context menu except in editor
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Allow context menu in editor (prose class), inputs, and note list sidebar
      const isInEditor =
        target.closest(".prose") || target.closest(".ProseMirror");
      const isInput =
        target.tagName === "INPUT" || target.tagName === "TEXTAREA";
      const isInNoteList = target.closest("[data-note-list]");
      if (!isInEditor && !isInput && !isInNoteList) {
        e.preventDefault();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("contextmenu", handleContextMenu);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("contextmenu", handleContextMenu);
    };
  }, [
    createNote,
    duplicateNote,
    displayItems,
    reloadCurrentNote,
    selectedNoteId,
    selectNote,
    toggleSettings,
    toggleSidebar,
    toggleFocusMode,
    focusMode,
    view,
    setInterfaceZoom,
  ]);

  const handleClosePalette = useCallback(() => {
    setPaletteOpen(false);
    editorRef.current?.commands.focus();
  }, []);

  if (isLoading) {
    return (
      <div className="h-full min-h-0 flex items-center justify-center bg-bg-secondary">
        <div className="text-text-muted/70 text-sm flex items-center gap-1.5 font-medium">
          <SpinnerIcon className="w-4.5 h-4.5 stroke-[1.5] animate-spin" />
          Initializing Scratch...
        </div>
      </div>
    );
  }

  if (!notesFolder) {
    return <FolderPicker />;
  }

  return (
    <>
      <div className="h-full min-h-0 flex bg-bg text-text overflow-hidden">
        {view === "settings" ? (
          <SettingsPage onBack={closeSettings} />
        ) : (
          <>
            <div
              data-sidebar
              className={`transition-all duration-500 ease-out overflow-hidden ${!sidebarVisible || focusMode ? "opacity-0 -translate-x-4 w-0 pointer-events-none" : "opacity-100 translate-x-0 w-64"}`}
            >
              <Sidebar onOpenSettings={toggleSettings} />
            </div>
            <Editor
              onToggleSidebar={toggleSidebar}
              sidebarVisible={sidebarVisible}
              focusMode={focusMode}
              onEditorReady={(editor) => {
                editorRef.current = editor;
              }}
            />
          </>
        )}
      </div>

      {/* Shared backdrop for command palette and AI modal */}
      {(paletteOpen || aiModalOpen) && (
        <div
          className="fixed inset-0 bg-text/50 backdrop-blur-sm z-40 animate-fade-in"
          onClick={() => {
            if (paletteOpen) handleClosePalette();
            if (aiModalOpen) setAiModalOpen(false);
          }}
        />
      )}

      <KeyboardShortcutsModal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={handleClosePalette}
        onOpenSettings={toggleSettings}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onOpenAiModal={(provider) => {
          setAiProvider(provider);
          setAiModalOpen(true);
        }}
        focusMode={focusMode}
        onToggleFocusMode={toggleFocusMode}
        editorRef={editorRef}
      />
      <AiEditModal
        open={aiModalOpen}
        provider={aiProvider}
        onBack={handleBackToPalette}
        onExecute={handleAiEdit}
        isExecuting={aiEditing}
      />

      {/* AI Editing Overlay */}
      {aiEditing && (
        <div className="fixed inset-0 bg-bg/50 backdrop-blur-sm z-50 flex items-center justify-center">
          <div className="flex items-center gap-2">
            {aiProvider === "codex" ? (
              <CodexIcon className="w-4.5 h-4.5 fill-text-muted animate-spin-slow" />
            ) : aiProvider === "opencode" ? (
              <OpenCodeIcon className="w-4.5 h-4.5 fill-text-muted animate-pulse-gentle" />
            ) : aiProvider === "ollama" ? (
              <OllamaIcon className="w-4.5 h-4.5 fill-text-muted animate-bounce-gentle" />
            ) : (
              <ClaudeIcon className="w-4.5 h-4.5 fill-text-muted animate-spin-slow" />
            )}
            <div className="text-sm font-medium text-text">
              {aiProvider === "codex"
                ? "Codex is editing your note..."
                : aiProvider === "opencode"
                  ? "OpenCode is editing your note..."
                : aiProvider === "ollama"
                  ? "Ollama is editing your note..."
                  : "Claude is editing your note..."}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Shared update check — used by startup and manual "Check for Updates"
async function showUpdateToast(): Promise<"update" | "no-update" | "error"> {
  try {
    const update = await checkForUpdate();
    if (update) {
      toast(<UpdateToast update={update} toastId="update-toast" />, {
        id: "update-toast",
        duration: Infinity,
        closeButton: true,
      });
      return "update";
    }
    return "no-update";
  } catch (err) {
    // Network errors and 404s (no release published yet) are not real failures
    const msg = String(err);
    if (
      msg.includes("404") ||
      msg.includes("network") ||
      msg.includes("Could not fetch")
    ) {
      return "no-update";
    }
    console.error("Update check failed:", err);
    return "error";
  }
}

export { showUpdateToast };

function UpdateToast({
  update,
  toastId,
}: {
  update: Update;
  toastId: string | number;
}) {
  const [installing, setInstalling] = useState(false);

  const handleUpdate = async () => {
    setInstalling(true);
    try {
      await update.downloadAndInstall();
      toast.dismiss(toastId);
      toast.success("Update installed! Restart Scratch to apply.", {
        duration: Infinity,
        closeButton: true,
      });
    } catch (err) {
      console.error("Update failed:", err);
      toast.error("Update failed. Please try again later.");
      setInstalling(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="font-medium text-sm">
        Update Available: v{update.version}
      </div>
      {update.body && (
        <div className="text-xs text-text-muted line-clamp-3">
          {update.body}
        </div>
      )}
      <button
        onClick={handleUpdate}
        disabled={installing}
        className="self-start mt-1 text-xs font-medium px-3 py-1.5 rounded-md bg-text text-bg hover:opacity-90 disabled:opacity-50 transition-opacity"
      >
        {installing ? "Installing..." : "Update Now"}
      </button>
    </div>
  );
}

function App() {
  const { isPreview, previewFile } = useMemo(getWindowMode, []);

  // Cmd/Ctrl+W — close window (works in both preview and folder mode)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "w") {
        e.preventDefault();
        getCurrentWindow().close().catch(console.error);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Add platform class for OS-specific styling (e.g., keyboard shortcuts)
  useEffect(() => {
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
    document.documentElement.classList.add(
      isMac ? "platform-mac" : "platform-other",
    );
  }, []);

  // Check for app updates on startup (folder mode only)
  useEffect(() => {
    if (isPreview) return;
    const timer = setTimeout(() => showUpdateToast(), 3000);
    return () => clearTimeout(timer);
  }, [isPreview]);

  // Preview mode: lightweight editor without sidebar, search, git
  if (isPreview && previewFile) {
    return (
      <ThemeProvider>
        <Toaster />
        <TooltipProvider>
          <PreviewApp filePath={decodeURIComponent(previewFile)} />
        </TooltipProvider>
      </ThemeProvider>
    );
  }

  // Folder mode: full app with sidebar, search, git, etc.
  return (
    <ThemeProvider>
      <Toaster />
      <TooltipProvider>
        <NotesProvider>
          <GitProvider>
            <AppContent />
          </GitProvider>
        </NotesProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}

export default App;
