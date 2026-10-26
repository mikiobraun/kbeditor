<template>
    <li class="node">
      <div class="row"
           :class="{ dir: node.is_dir, active: !node.is_dir && node.path === selectedPath }"
           @click="onClick">
        <span class="twist">{{ node.is_dir ? (node.expanded ? '▾' : '▸') : '' }}</span>
        <span class="icon">{{ node.is_dir ? '📁' : '📄' }}</span>
        <span class="name">{{ node.name }}</span>
        <span v-if="!node.is_dir && draftPaths.has(node.path)" class="draft-dot"
              title="Unsaved edits" aria-label="Unsaved edits">●</span>
      </div>
      <ul v-if="node.is_dir && node.expanded" class="children">
        <li v-if="node.loading" class="muted pad">…</li>
        <li v-else-if="node.error" class="err pad">{{ node.error }}</li>
        <li v-else-if="node.children && node.children.length === 0" class="muted pad">(empty)</li>
        <tree-node
          v-for="c in node.children"
          :key="c.path"
          :node="c"
          :selected-path="selectedPath"
          @select="$emit('select', $event)" />
      </ul>
    </li>
</template>

<script>
import { inject } from 'vue';
import { makeNode } from '../lib/tree.js';

export default {
  name: 'TreeNode',
  props: { node: Object, selectedPath: String },
  emits: ['select'],
  setup(props, { emit }) {
    const listDir = inject('listDir');
    const draftPaths = inject('draftPaths');

    async function loadChildren(n) {
      n.loading = true;
      n.error = null;
      try {
        n.children = (await listDir(n.path)).map(makeNode);
      } catch (e) {
        n.error = e.message || String(e);
        n.children = [];
      } finally {
        n.loading = false;
      }
    }

    async function onClick() {
      const n = props.node;
      if (!n.is_dir) {
        emit('select', n);
        return;
      }
      n.expanded = !n.expanded;
      if (n.expanded && n.children === null) await loadChildren(n);
    }

    return { onClick, draftPaths };
  },
};
</script>
