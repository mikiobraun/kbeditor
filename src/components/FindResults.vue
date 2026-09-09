<template>
  <div class="find-results">
    <div class="find-head">
      <span class="muted">
        {{ results.paths.length }}
        {{ results.paths.length === 1 ? 'file' : 'files' }}
      </span>
      <span class="spacer"></span>
      <button class="ghost" @click="$emit('clear')">Clear</button>
    </div>
    <p v-if="!results.paths.length" class="muted pad">No file matches.</p>
    <div v-for="p in results.paths" :key="p" class="found"
         :class="{ active: p === selectedPath }"
         @click="$emit('open', p)">
      <span class="found-name">{{ pathParts(p).name }}</span>
      <span v-if="pathParts(p).dir" class="found-dir">{{ pathParts(p).dir }}</span>
    </div>
    <p v-if="results.truncated" class="muted pad">More matches than shown.</p>
  </div>
</template>

<script>
import { pathParts } from '../lib/text.js';

// Filename search results, shown in place of the tree. A flat list rather than a
// filtered tree: a folder holding only its matching children would read as a
// folder that contains only those children.
export default {
  name: 'FindResults',
  props: {
    results: { type: Object, required: true },
    selectedPath: { type: String, default: '' },
  },
  emits: ['open', 'clear'],
  setup() {
    return { pathParts };
  },
};
</script>
