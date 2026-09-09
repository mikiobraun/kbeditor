import { ref, provide } from 'vue';
import { makeNode } from '../lib/tree.js';
import { visibleEntries } from '../lib/text.js';

// The file tree: what has been listed, what is expanded, and how to find a path
// in it.
//
// Listing is lazy — a folder fetches its children the first time it is opened —
// so the tree is a partial view of the vault that grows as you use it. That is
// why `revealPath` exists: opening a note from a search hit or a link has to be
// able to walk the tree into existence along the way.
//
// `listDir` is provided rather than passed down, because TreeNode is recursive
// and prop-drilling it through every level would be noise.
export function useTree({ client }) {
  const roots = ref([]);

  const listDir = async (path) => visibleEntries(await client.value.list(path));
  provide('listDir', listDir);

  async function loadRoots() {
    roots.value = [];
    roots.value = (await listDir('')).map(makeNode);
  }

  // Re-list the folders that are currently open, reusing the existing node
  // objects for paths that are still there so expansion state survives.
  // Collapsed folders are left alone — they re-list when next expanded.
  async function refreshNodes(current, path) {
    const byPath = new Map(current.map((n) => [n.path, n]));
    const next = (await listDir(path)).map((e) => {
      const old = byPath.get(e.path);
      if (!old || old.is_dir !== e.is_dir) return makeNode(e);
      old.size = e.size;
      return old;
    });
    for (const n of next) {
      if (n.is_dir && n.expanded && n.children) n.children = await refreshNodes(n.children, n.path);
    }
    return next;
  }

  async function refreshTree() {
    roots.value = await refreshNodes(roots.value, '');
  }

  // Walk to a path, expanding and loading each folder on the way, so a file
  // opened from elsewhere is highlighted in the tree instead of appearing with
  // nothing selected around it. Null if any segment is gone.
  async function revealPath(path) {
    const segments = String(path).split('/');
    let list = roots.value;
    let node = null;
    for (let i = 0; i < segments.length; i++) {
      const sub = segments.slice(0, i + 1).join('/');
      node = list.find((n) => n.path === sub);
      if (!node) return null;
      if (i === segments.length - 1) break;
      if (!node.is_dir) return null;
      if (node.children === null) node.children = (await listDir(node.path)).map(makeNode);
      node.expanded = true;
      list = node.children;
    }
    return node && !node.is_dir ? node : null;
  }

  function findNode(path, list = roots.value) {
    for (const n of list) {
      if (n.path === path) return n;
      if (n.children) {
        const hit = findNode(path, n.children);
        if (hit) return hit;
      }
    }
    return null;
  }

  return { roots, listDir, loadRoots, refreshTree, revealPath, findNode };
}
