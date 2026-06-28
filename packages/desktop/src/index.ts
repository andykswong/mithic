export type {
  Rect, WindowState, MithicWindow, WindowContext, AppDescriptor, OpenOptions,
} from './types.ts';

export { clampToBounds, cascadePlacement, DEFAULT_MIN_SIZE } from './geometry.ts';
export type { Bounds } from './geometry.ts';

export { AppRegistry, appDescriptorFromManifest, manifestCapabilities } from './app-registry.ts';
export type { AppManifest, AppDescriptorExtras } from './app-registry.ts';

export { loadLayout, saveLayout, LAYOUT_PATH } from './persistence.ts';
export type { SavedLayout } from './persistence.ts';

export { renderTextEditor, mountTextEditor } from './apps/text-editor.ts';
export type { EditorFs, EditorDeps, EditorHandle } from './apps/text-editor.ts';

export { createFileManagerModel, renderFileManager, mountFileManager } from './apps/file-manager.ts';
export type { Entry, PathSegment, FileManagerFs, FileManagerDeps, FileManagerModel, FileManagerHandle } from './apps/file-manager.ts';

export { createWindowFrame, applyGeometry, applyState, setWindowTitle } from './window.ts';
export type { WindowFrameElements, CreateWindowOptions } from './window.ts';

export { makeDraggable, makeResizable, installShieldStyle, SHIELD_CLASS } from './drag.ts';
export type { DragOptions, ResizeOptions } from './drag.ts';

export { WindowManager } from './window-manager.ts';
export type { WindowManagerOptions, WmKernel } from './window-manager.ts';
