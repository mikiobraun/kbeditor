<template>
  <div class="results">
    <div class="results-head">
      <span>
        <strong>{{ results.count }}</strong>
        {{ results.count === 1 ? 'match' : 'matches' }} for “{{ results.term }}”
      </span>
      <span class="spacer"></span>
      <button class="ghost" @click="$emit('clear')">Clear</button>
    </div>
    <p v-if="!results.groups.length" class="empty muted">Nothing found.</p>
    <div v-for="g in results.groups" :key="g.path" class="result-file">
      <div class="result-path">{{ g.path }}</div>
      <div v-for="m in g.lines" :key="m.line" class="result-line" @click="$emit('open', g.path)">
        <span class="result-lineno">{{ m.line }}</span>
        <span class="result-text"><template
          v-for="(p, i) in matchParts(m.text, results.term)" :key="i"><mark
            v-if="p.hit">{{ p.t }}</mark><template v-else>{{ p.t }}</template></template></span>
      </div>
    </div>
    <p v-if="results.truncated" class="muted pad">
      Stopped at {{ results.count }} matches — there are more.
    </p>
  </div>
</template>

<script>
import { matchParts } from '../lib/text.js';

// Content search results: a pure view of what the search returned, with two
// events out. It owns nothing, so it needs nothing injected.
//
// The hits are marked by splitting each line into parts and rendering <mark>
// elements — never by building HTML, since these strings come from note content.
export default {
  name: 'SearchResults',
  props: { results: { type: Object, required: true } },
  emits: ['open', 'clear'],
  setup() {
    return { matchParts };
  },
};
</script>
