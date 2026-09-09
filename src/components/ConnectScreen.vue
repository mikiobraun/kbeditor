<template>
  <div class="connect">
    <div class="card">
      <h1>kb editor</h1>
      <p class="muted">Open a knowledge base by its URL. You'll sign in through its gateway.</p>
      <form @submit.prevent="submit">
        <input v-model="url" type="url" placeholder="https://kb.example.com" autofocus />
        <button type="submit" :disabled="busy || !url">{{ busy ? 'Connecting…' : 'Connect' }}</button>
      </form>
      <p class="advanced-toggle" @click="showAdvanced = !showAdvanced">
        {{ showAdvanced ? '▾' : '▸' }} advanced
      </p>
      <div v-if="showAdvanced" class="advanced">
        <label>Bearer token (skip OAuth — for local/same-origin testing)</label>
        <textarea v-model="token" rows="3" placeholder="paste a token to bypass the sign-in flow"></textarea>
        <button type="button" @click="$emit('forget-client')">Delete client_id cache</button>
        <p class="muted">Forces a fresh registration on the next connect — use if sign-in fails with “invalid_client” after the gateway was reset.</p>
      </div>
      <div v-if="banner" class="banner" :class="banner.kind">{{ banner.text }}</div>
    </div>
  </div>
</template>

<script>
import { ref } from 'vue';

// The sign-in card. It owns its own fields — the URL, the pasted token, whether
// "advanced" is open — and hands them over on submit, so none of that has to
// live in the app while you are using the editor.
//
// The URL is seeded from, and reported back with, the last one used: the app
// remembers it across reloads, and this screen is where it is edited.
export default {
  name: 'ConnectScreen',
  props: {
    initialUrl: { type: String, default: '' },
    busy: { type: Boolean, default: false },
    banner: { type: Object, default: null },
  },
  emits: ['connect', 'forget-client'],
  setup(props, { emit }) {
    const url = ref(props.initialUrl);
    const token = ref('');
    const showAdvanced = ref(false);

    function submit() {
      if (!url.value.trim()) return;
      emit('connect', { url: url.value.trim(), token: token.value.trim() });
    }

    return { url, token, showAdvanced, submit };
  },
};
</script>
