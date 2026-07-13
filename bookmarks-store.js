// Global, persisted bookmark tree (Chrome-style folders + bookmarks) shared across every
// window. One BookmarksStore per activation, backed by VS Code globalState so the tree
// survives reloads and is identical in all windows. The in-page bookmarks bar (injected by
// the session layer) reads it via getTree(); Phase 2's Settings UI mutates it. All mutations
// persist to globalState immediately so a crash never loses an edit.

const crypto = require('crypto');

// globalState key the whole tree lives under.
const STORAGE_KEY = 'steersman.bookmarks';

// Separate globalState key holding the global "show bookmarks bar" flag. Kept independent of
// the tree so toggling visibility never touches (or risks corrupting) the stored bookmarks.
const BAR_ENABLED_KEY = 'steersman.bookmarksBarEnabled';

// Seed used only when nothing is stored yet, so the bar shows content immediately for
// testing. Titles are the human names; ids are stamped in freshly (see _seedTree).
const SEED = [
  { type: 'bookmark', title: 'Google', url: 'https://www.google.com' },
  { type: 'bookmark', title: 'YouTube', url: 'https://www.youtube.com' },
  { type: 'bookmark', title: 'GitHub', url: 'https://github.com' },
  {
    type: 'folder',
    name: 'Dev',
    children: [
      { type: 'bookmark', title: 'MDN', url: 'https://developer.mozilla.org' },
      { type: 'bookmark', title: 'Stack Overflow', url: 'https://stackoverflow.com' },
    ],
  },
];

class BookmarksStore {
  // globalState: a VS Code Memento (context.globalState). Loads the stored tree, or seeds
  // and persists a sensible default when nothing valid is stored.
  constructor(globalState) {
    this._globalState = globalState;
    this._root = this._load();
  }

  // Load + validate the stored tree; fall back to the seed (and persist it) on absent or
  // corrupt data so a bad stored value can never leave us without a usable bar.
  _load() {
    let stored;
    try {
      stored = this._globalState && this._globalState.get(STORAGE_KEY);
    } catch {
      stored = null;
    }
    if (this._isValidRoot(stored)) return stored;
    const seeded = this._seedTree();
    this._root = seeded;
    this._persist();
    return seeded;
  }

  // A stored value is usable only if it is a root object with a children array.
  _isValidRoot(v) {
    return !!v && typeof v === 'object' && Array.isArray(v.children);
  }

  // Build a fresh seed tree, stamping a new id on every node.
  _seedTree() {
    const stamp = (nodes) =>
      nodes.map((n) => {
        if (n.type === 'folder') {
          return { id: crypto.randomUUID(), type: 'folder', name: n.name, children: stamp(n.children || []) };
        }
        return { id: crypto.randomUUID(), type: 'bookmark', title: n.title, url: n.url, favicon: null };
      });
    return { children: stamp(SEED) };
  }

  // Write the current tree back to globalState (fire-and-forget; the return is a Thenable).
  _persist() {
    try {
      return this._globalState && this._globalState.update(STORAGE_KEY, this._root);
    } catch {
      return undefined;
    }
  }

  // The root object { children:[...] }, safe to serialize and send over the wire.
  getTree() {
    return this._root;
  }

  // Total number of BOOKMARK nodes in the tree, counting those nested inside folders too
  // (folders themselves are not counted). Used to gate the bar off when there are none.
  countBookmarks(node = this._root) {
    let n = 0;
    for (const child of (node && node.children) || []) {
      if (child.type === 'folder') n += this.countBookmarks(child);
      else n += 1;
    }
    return n;
  }

  // The global "show bookmarks bar" flag. Two rules layered on the stored value:
  //   1. With ZERO bookmarks the bar is always off — there is nothing to show, so an empty tree
  //      reads false regardless of any stored flag. This one gate cleanly covers a fresh/empty
  //      install, a delete-to-empty, AND a legacy install that stored `true` while empty, with no
  //      separate write needed on the last removal.
  //   2. Otherwise the stored flag wins, and its UNSET default is now FALSE (was true): a
  //      non-empty tree stays off until the 0→≥1 auto-enable (PanelController._mutateBookmarks)
  //      or a manual toggle turns it on.
  // Independent of tree mutation; never throws on a bad/absent stored value.
  getBarEnabled() {
    if (this.countBookmarks() === 0) return false;
    let stored;
    try {
      stored = this._globalState && this._globalState.get(BAR_ENABLED_KEY);
    } catch {
      stored = undefined;
    }
    return stored === undefined ? false : !!stored;
  }

  // Persist the "show bookmarks bar" flag, coercing to a plain boolean. Fire-and-forget (the
  // return is a Thenable); swallows storage errors so a bad Memento can never throw.
  setBarEnabled(value) {
    try {
      return this._globalState && this._globalState.update(BAR_ENABLED_KEY, !!value);
    } catch {
      return undefined;
    }
  }

  // Depth-first search for a node by id, returning { node, parent, index } where parent is
  // the containing folder/root and index is the node's position in parent.children. Returns
  // null for a missing/invalid id — callers use this to stay throw-free on bad ids.
  _find(id, node = this._root, parent = null) {
    const children = (node && node.children) || [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.id === id) return { node: child, parent: node, index: i };
      if (child.type === 'folder') {
        const hit = this._find(id, child, node);
        if (hit) return hit;
      }
    }
    return null;
  }

  // Resolve the folder that should receive a new/moved node. null or 'root' means the top
  // level (the bar); any other id must name a folder, else null.
  _resolveParent(parentId) {
    if (parentId == null || parentId === 'root') return this._root;
    const hit = this._find(parentId);
    if (hit && hit.node.type === 'folder') return hit.node;
    return null;
  }

  // Add a bookmark under folder parentId (or the root when parentId is null/'root').
  // Returns the created node, or null when parentId names a non-folder/unknown node.
  addBookmark(parentId, { title, url } = {}) {
    const parent = this._resolveParent(parentId);
    if (!parent) return null;
    const node = { id: crypto.randomUUID(), type: 'bookmark', title: title || url || '', url: url || '', favicon: null };
    parent.children.push(node);
    this._persist();
    return node;
  }

  // Add an empty folder under parentId (or the root). Returns the created folder, or null
  // when parentId names a non-folder/unknown node.
  addFolder(parentId, name) {
    const parent = this._resolveParent(parentId);
    if (!parent) return null;
    // Folders may exist only at the root level — reject nesting a folder inside another folder.
    if (parent !== this._root) return null;
    const node = { id: crypto.randomUUID(), type: 'folder', name: name || '', children: [] };
    parent.children.push(node);
    this._persist();
    return node;
  }

  // Remove a node (and its whole subtree) from anywhere in the tree. Returns true when a
  // node was removed, false for an unknown id.
  remove(id) {
    const hit = this._find(id);
    if (!hit) return false;
    hit.parent.children.splice(hit.index, 1);
    this._persist();
    return true;
  }

  // Rename a folder (sets name) or a bookmark (sets title). Returns true on success, false
  // for an unknown id.
  rename(id, name) {
    const hit = this._find(id);
    if (!hit) return false;
    if (hit.node.type === 'folder') hit.node.name = name || '';
    else hit.node.title = name || '';
    this._persist();
    return true;
  }

  // Patch a node's own fields (e.g. url/title/favicon/name). id/type/children are protected
  // so a patch can't corrupt the tree structure. Returns the updated node, or null for an
  // unknown id.
  update(id, fields) {
    const hit = this._find(id);
    if (!hit) return null;
    const { id: _i, type: _t, children: _c, ...safe } = fields || {};
    Object.assign(hit.node, safe);
    this._persist();
    return hit.node;
  }

  // Relocate a node into folder newParentId (or the root) at position index (appended when
  // index is omitted or out of range). Guards against moving a folder into itself or one of
  // its own descendants (no cycles). Returns true on success, false otherwise.
  move(id, newParentId, index) {
    const hit = this._find(id);
    if (!hit) return false;
    const parent = this._resolveParent(newParentId);
    if (!parent) return false;
    // Reject a folder move into itself or a descendant (that would detach a subtree/cycle).
    if (hit.node.type === 'folder' && (parent === hit.node || this._isDescendant(parent, hit.node))) return false;
    // Folders may exist only at the root level — reject moving a folder into another folder.
    if (hit.node.type === 'folder' && parent !== this._root) return false;

    hit.parent.children.splice(hit.index, 1);
    // Recompute the insertion point on the target: removing from the same parent above the
    // target index shifts everything down by one.
    let at = typeof index === 'number' ? index : parent.children.length;
    if (hit.parent === parent && typeof index === 'number' && hit.index < index) at -= 1;
    if (at < 0) at = 0;
    if (at > parent.children.length) at = parent.children.length;
    parent.children.splice(at, 0, hit.node);
    this._persist();
    return true;
  }

  // True when candidate is (transitively) inside folder — used by move() to forbid cycles.
  _isDescendant(candidate, folder) {
    for (const child of folder.children || []) {
      if (child === candidate) return true;
      if (child.type === 'folder' && this._isDescendant(candidate, child)) return true;
    }
    return false;
  }
}

module.exports = { BookmarksStore };
