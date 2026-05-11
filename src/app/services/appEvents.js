/*
 * Copyright 2026 The Ray Optics Simulation authors and contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Centralized app-level DOM event names and helpers.
 *
 * This intentionally preserves the existing DOM event transport so legacy
 * call sites can be migrated gradually without changing behavior.
 */
export const APP_EVENT_NAMES = Object.freeze({
  APPLY_VISUAL_NEW_MODULE: 'applyVisualNewModule',
  CLEAR_VISUAL_EDITOR_SELECTION: 'clearVisualEditorSelection',
  IMPORT_SHAPES_OPEN: 'importShapes:open',
  OPEN_VISUAL_CREATE_MODULE: 'openVisualCreateModule',
  OPEN_VISUAL_MODULE_EDITOR: 'openVisualModuleEditor',
  SELECT_VISUAL_MODULE_TAB: 'selectVisualModuleTab',
  SELECT_VISUAL_SCENE_TAB: 'selectVisualSceneTab'
});

function emitAppEvent(eventName, detail) {
  document.dispatchEvent(new CustomEvent(eventName, { detail }));
}

function onAppEvent(eventName, handler) {
  const listener = (event) => handler(event.detail || {}, event);
  document.addEventListener(eventName, listener);
  return () => {
    document.removeEventListener(eventName, listener);
  };
}

/**
 * @typedef {Object} ImportShapesOpenPayload
 * @property {Object} result
 * @property {string} fileName
 */

/**
 * @typedef {Object} VisualModulePayload
 * @property {string} moduleName
 */

export const appEvents = {
  /**
   * @param {ImportShapesOpenPayload} payload
   */
  emitImportShapesOpen(payload) {
    emitAppEvent(APP_EVENT_NAMES.IMPORT_SHAPES_OPEN, payload);
  },

  /**
   * @param {(payload: ImportShapesOpenPayload, event: CustomEvent) => void} handler
   * @returns {() => void}
   */
  onImportShapesOpen(handler) {
    return onAppEvent(APP_EVENT_NAMES.IMPORT_SHAPES_OPEN, handler);
  },

  /**
   * @param {VisualModulePayload} payload
   */
  emitOpenVisualModuleEditor(payload) {
    emitAppEvent(APP_EVENT_NAMES.OPEN_VISUAL_MODULE_EDITOR, payload);
  },

  /**
   * @param {(payload: VisualModulePayload, event: CustomEvent) => void} handler
   * @returns {() => void}
   */
  onOpenVisualModuleEditor(handler) {
    return onAppEvent(APP_EVENT_NAMES.OPEN_VISUAL_MODULE_EDITOR, handler);
  },

  /**
   * @param {VisualModulePayload} payload
   */
  emitOpenVisualCreateModule(payload) {
    emitAppEvent(APP_EVENT_NAMES.OPEN_VISUAL_CREATE_MODULE, payload);
  },

  /**
   * @param {(payload: VisualModulePayload, event: CustomEvent) => void} handler
   * @returns {() => void}
   */
  onOpenVisualCreateModule(handler) {
    return onAppEvent(APP_EVENT_NAMES.OPEN_VISUAL_CREATE_MODULE, handler);
  },

  /**
   * @param {VisualModulePayload} payload
   */
  emitSelectVisualModuleTab(payload) {
    emitAppEvent(APP_EVENT_NAMES.SELECT_VISUAL_MODULE_TAB, payload);
  },

  /**
   * @param {(payload: VisualModulePayload, event: CustomEvent) => void} handler
   * @returns {() => void}
   */
  onSelectVisualModuleTab(handler) {
    return onAppEvent(APP_EVENT_NAMES.SELECT_VISUAL_MODULE_TAB, handler);
  },

  emitSelectVisualSceneTab() {
    emitAppEvent(APP_EVENT_NAMES.SELECT_VISUAL_SCENE_TAB);
  },

  /**
   * @param {(payload: Object, event: CustomEvent) => void} handler
   * @returns {() => void}
   */
  onSelectVisualSceneTab(handler) {
    return onAppEvent(APP_EVENT_NAMES.SELECT_VISUAL_SCENE_TAB, handler);
  },

  /**
   * @param {VisualModulePayload} payload
   */
  emitApplyVisualNewModule(payload) {
    emitAppEvent(APP_EVENT_NAMES.APPLY_VISUAL_NEW_MODULE, payload);
  },

  /**
   * @param {(payload: VisualModulePayload, event: CustomEvent) => void} handler
   * @returns {() => void}
   */
  onApplyVisualNewModule(handler) {
    return onAppEvent(APP_EVENT_NAMES.APPLY_VISUAL_NEW_MODULE, handler);
  },

  emitClearVisualEditorSelection() {
    emitAppEvent(APP_EVENT_NAMES.CLEAR_VISUAL_EDITOR_SELECTION);
  },

  /**
   * @param {(payload: Object, event: CustomEvent) => void} handler
   * @returns {() => void}
   */
  onClearVisualEditorSelection(handler) {
    return onAppEvent(APP_EVENT_NAMES.CLEAR_VISUAL_EDITOR_SELECTION, handler);
  }
};
