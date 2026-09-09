// The file tree's node shape. Not pure — a node is reactive, because the tree
// mutates it in place as folders load and expand — but small enough to belong
// with the other listing helpers rather than inside a component.

import { reactive } from 'vue';

// Turn a REST listing entry into a reactive tree node.
export function makeNode(entry) {
  return reactive({
    name: entry.name,
    path: entry.path,
    is_dir: entry.is_dir,
    size: entry.size,
    expanded: false,
    loading: false,
    error: null,
    children: null, // null = not yet loaded
  });
}
