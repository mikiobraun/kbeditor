<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal">
      <header class="modal-head">
        <h2>{{ title }}</h2>
        <button class="ghost" @click="$emit('close')" aria-label="Close">✕</button>
      </header>
      <div class="modal-body">
        <slot />
      </div>
    </div>
  </div>
</template>

<script>
// The shell every dialog shares: backdrop, title bar, close button, and a
// click-outside that closes. Three dialogs were carrying their own copy of this
// markup, which is three places to fix when the shell changes.
export default {
  name: 'ModalDialog',
  props: { title: { type: String, required: true } },
  emits: ['close'],
};
</script>
