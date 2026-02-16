import { ref } from "vue";

const ebdUpdatedAt = ref(0);

const bumpEbdUpdatedAt = () => {
  const now = Date.now();
  ebdUpdatedAt.value = now > ebdUpdatedAt.value ? now : ebdUpdatedAt.value + 1;
};

export { ebdUpdatedAt, bumpEbdUpdatedAt };
