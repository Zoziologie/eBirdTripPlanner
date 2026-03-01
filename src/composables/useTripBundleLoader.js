import { ref } from "vue";
import { fetchTripBundle } from "../utils/tripData";

export const useTripBundleLoader = (defaultOptions = {}) => {
  const isLoadingTripBundle = ref(false);
  let requestId = 0;

  const resetTripBundleLoader = () => {
    requestId += 1;
    isLoadingTripBundle.value = false;
  };

  const loadTripBundle = async (tripId, options = {}) => {
    const currentRequestId = ++requestId;
    isLoadingTripBundle.value = Boolean(tripId);

    try {
      const bundle = await fetchTripBundle(tripId, {
        ...defaultOptions,
        ...options,
      });
      return {
        bundle,
        isCurrent: currentRequestId === requestId,
      };
    } finally {
      if (currentRequestId === requestId) {
        isLoadingTripBundle.value = false;
      }
    }
  };

  return {
    isLoadingTripBundle,
    loadTripBundle,
    resetTripBundleLoader,
  };
};
