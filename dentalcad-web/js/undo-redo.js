/**
 * undo-redo.js
 * Generic command stack for mesh operations.
 *
 * Commands implement { label, execute(), undo() }.
 * MeshStateCommand snapshots a Float32Array of vertex positions
 * before/after a sculpt/smooth operation for O(n) undo.
 *
 * Usage:
 *   UndoRedo.push(new MeshStateCommand('Sculpt', positionsBefore, positionsAfter, applyFn));
 *   UndoRedo.undo();
 *   UndoRedo.redo();
 */

const UndoRedo = (() => {
  const MAX_STACK = 64;
  let _stack  = [];   // commands in order
  let _cursor = -1;   // index of last executed command
  let _onChange = null;

  // ── Core ──────────────────────────────────────────────────
  function push(command) {
    // Discard any redo history beyond cursor
    if (_cursor < _stack.length - 1) {
      _stack = _stack.slice(0, _cursor + 1);
    }
    _stack.push(command);
    if (_stack.length > MAX_STACK) {
      _stack.shift();
    } else {
      _cursor++;
    }
    command.execute();
    _notify();
  }

  function undo() {
    if (!canUndo()) return false;
    _stack[_cursor].undo();
    _cursor--;
    _notify();
    return _stack[_cursor + 1].label;
  }

  function redo() {
    if (!canRedo()) return false;
    _cursor++;
    _stack[_cursor].execute();
    _notify();
    return _stack[_cursor].label;
  }

  function canUndo() { return _cursor >= 0; }
  function canRedo() { return _cursor < _stack.length - 1; }

  function clear() {
    _stack  = [];
    _cursor = -1;
    _notify();
  }

  function onChange(fn) { _onChange = fn; }

  function _notify() {
    if (_onChange) {
      _onChange({
        canUndo: canUndo(),
        canRedo: canRedo(),
        undoLabel: canUndo() ? _stack[_cursor].label     : null,
        redoLabel: canRedo() ? _stack[_cursor + 1].label : null,
        stackSize: _stack.length,
        cursor: _cursor,
      });
    }
  }

  function getStatus() {
    return {
      canUndo: canUndo(),
      canRedo: canRedo(),
      undoLabel: canUndo() ? _stack[_cursor].label     : null,
      redoLabel: canRedo() ? _stack[_cursor + 1].label : null,
    };
  }

  // ── MeshStateCommand ──────────────────────────────────────
  /**
   * Snapshots Float32Array positions before/after an operation.
   * @param {string}      label
   * @param {Float32Array} before  – positions before change
   * @param {Float32Array} after   – positions after change
   * @param {Function}    applyFn – applyFn(Float32Array) updates the live BufferAttribute
   */
  class MeshStateCommand {
    constructor(label, before, after, applyFn) {
      this.label   = label;
      this._before = before.slice();   // defensive copy
      this._after  = after.slice();
      this._apply  = applyFn;
    }
    execute() { this._apply(this._after);  }
    undo()    { this._apply(this._before); }
  }

  // ── PropertyCommand ───────────────────────────────────────
  /**
   * For non-geometry changes (material, shade, etc.)
   */
  class PropertyCommand {
    constructor(label, prevValue, nextValue, applyFn) {
      this.label  = label;
      this._prev  = prevValue;
      this._next  = nextValue;
      this._apply = applyFn;
    }
    execute() { this._apply(this._next); }
    undo()    { this._apply(this._prev); }
  }

  // ── MarginPointCommand ────────────────────────────────────
  /**
   * For adding/removing a margin line point.
   */
  class MarginPointCommand {
    constructor(label, point, addFn, removeFn) {
      this.label    = label;
      this._point   = point;
      this._add     = addFn;
      this._remove  = removeFn;
    }
    execute() { this._add(this._point);    }
    undo()    { this._remove(this._point); }
  }

  return {
    push, undo, redo,
    canUndo, canRedo,
    clear, onChange, getStatus,
    MeshStateCommand,
    PropertyCommand,
    MarginPointCommand,
  };
})();