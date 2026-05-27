/**
 * History — universal undo/redo manager.
 *
 * Both layout mode and mesh mode push actions here.
 * Ctrl+Z / Ctrl+Shift+Z work regardless of which mode is active.
 *
 * Action types:
 *   { type: 'add',       mesh }
 *   { type: 'delete',    mesh }
 *   { type: 'transform', mesh, oldState, newState }
 *   { type: 'mesh-edit', mesh, snapBefore, snapAfter }  ← geometry buffer snapshots
 */
export class History {
  constructor() {
    this._undo = [];
    this._redo = [];
  }

  push(action) {
    this._undo.push(action);
    // Any new action clears the redo branch
    this._redo = [];
  }

  canUndo() { return this._undo.length > 0; }
  canRedo() { return this._redo.length > 0; }

  /**
   * applyUndo / applyRedo delegate the actual work to caller-supplied
   * handler callbacks so this module stays free of scene/renderer deps.
   *
   * handlers = {
   *   onAdd(mesh)        — re-add a mesh that was deleted
   *   onDelete(mesh)     — delete a mesh that was added
   *   onTransform(mesh, state)  — restore position/rotation/scale
   *   onMeshEdit(mesh, snap)    — restore geometry buffer from Float32Array snap
   *   afterAction()      — called after every undo/redo (update UI, etc.)
   * }
   */
  undo(handlers) {
    if (!this._undo.length) return false;
    const action = this._undo.pop();
    this._apply(action, 'undo', handlers);
    this._redo.push(action);
    handlers.afterAction?.();
    return true;
  }

  redo(handlers) {
    if (!this._redo.length) return false;
    const action = this._redo.pop();
    this._apply(action, 'redo', handlers);
    this._undo.push(action);
    handlers.afterAction?.();
    return true;
  }

  _apply(action, direction, handlers) {
    switch (action.type) {
      case 'add':
        // undo add = delete; redo add = re-add
        direction === 'undo' ? handlers.onDelete(action.mesh)
                             : handlers.onAdd(action.mesh);
        break;

      case 'delete':
        // undo delete = re-add; redo delete = delete again
        direction === 'undo' ? handlers.onAdd(action.mesh)
                             : handlers.onDelete(action.mesh);
        break;

      case 'transform':
        // undo/redo swap between oldState and newState
        handlers.onTransform(action.mesh,
          direction === 'undo' ? action.oldState : action.newState);
        break;

      case 'mesh-edit':
        // undo/redo swap between snapBefore and snapAfter
        handlers.onMeshEdit(action.mesh,
          direction === 'undo' ? action.snapBefore : action.snapAfter);
        break;
    }
  }
}
