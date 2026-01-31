import { ref, watch } from "vue";

const selectedVisitId = ref(localStorage.getItem("selectedVisitId") || "");

watch(selectedVisitId, (value) => {
  if (value) {
    localStorage.setItem("selectedVisitId", value);
  } else {
    localStorage.removeItem("selectedVisitId");
  }
});

export { selectedVisitId };
