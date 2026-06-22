export type {
  Rect, WindowState, MithicWindow, WindowContext, AppDescriptor, OpenOptions,
} from './types.ts';

export { clampToBounds, cascadePlacement, DEFAULT_MIN_SIZE } from './geometry.ts';
export type { Bounds } from './geometry.ts';

export { AppRegistry } from './app-registry.ts';

export { loadLayout, saveLayout, LAYOUT_PATH } from './persistence.ts';
export type { SavedLayout } from './persistence.ts';

export { renderTextEditor, mountTextEditor } from './apps/text-editor.ts';
export type { EditorFs, EditorDeps, EditorHandle } from './apps/text-editor.ts';

export { createFileManagerModel, renderFileManager, mountFileManager } from './apps/file-manager.ts';
export type { Entry, FileManagerFs, FileManagerDeps, FileManagerModel, FileManagerHandle } from './apps/file-manager.ts';
