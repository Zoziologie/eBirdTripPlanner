<script setup>
import { computed, ref, watch, onMounted, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import { selectedTripId, refreshTrips } from '../state/tripSelection';
import { selectedVisitId } from '../state/visitSelection';
import { bumpEbdUpdatedAt } from '../state/ebdUpdates';
import { db } from '../data/db';
import { cloudConfigured, cloudUser, cloudReady, cloudLibrary, cloudError, cloudBindings, bindCloudTrip, cloudAllowance, cloudRequest } from '../state/cloudTrips';
import { readTripArchive, restoreTripArchive } from '../utils/tripData';
import { encodeTripArchive, decodeTripArchive } from '../utils/tripArchive';
import { buildTripLibrary } from '../utils/tripLibrary';
const props = defineProps({
  localTrips: { type: Array, default: () => [] }, editTimes: { type: Object, default: () => ({}) }, visitCounts: { type: Object, default: () => ({}) },
  addingTrip: { type: Boolean, default: false },
  externalBusy: { type: Boolean, default: false },
  lastLocalEdit: { type: Number, default: 0 }, localVisitCount: { type: Number, default: 0 },
});
const emit = defineEmits(['opened', 'selected']);
const route = useRoute();
const working = ref(false);
const busy = computed(() => working.value || props.externalBusy);
const status = ref('');
const failed = ref(false);
const progress = ref(null);
const current = ref(null);
const showSharing = ref(false);
const shareButton = ref(null);
const sharingDialog = ref(null);
const publicView = ref(false);
const editors = ref('');
const savedEditors = ref([]);
const editorEmails = computed(() => [...new Set(editors.value.split(/[\n,;]+/).map(email => email.trim().toLowerCase()).filter(Boolean))]);
const sharingChanged = computed(() => publicView.value !== Boolean(current.value?.public) || JSON.stringify([...editorEmails.value].sort()) !== JSON.stringify([...savedEditors.value].sort()));
const viewingLinkReady = computed(() => current.value?.public && publicView.value && !sharingChanged.value);
const editingLinkReady = computed(() => savedEditors.value.length > 0 && !sharingChanged.value);
const showCapacity = ref(false);
const requestedSlots = ref(2);
const requestReason = ref('');
let api;
const binding = computed(() => cloudBindings.value[selectedTripId.value]);
const canSave = computed(() => cloudUser.value && binding.value?.editable && binding.value.accountId === cloudUser.value.uid);
const ownsTrip = computed(() => current.value?.ownerUid === cloudUser.value?.uid && Boolean(cloudUser.value));
const changed = computed(() => binding.value && (props.lastLocalEdit !== binding.value.savedLocalEdit || props.localVisitCount !== binding.value.savedVisitCount));
const date = value => value ? new Date(value).toLocaleString() : 'Unknown';
const sharedId = computed(() => typeof route.query.cloud === 'string' ? route.query.cloud : '');
const dateMillis = trip => trip.updatedAt?.toMillis() || 0;
const library = computed(() => buildTripLibrary(props.localTrips, cloudLibrary.value, cloudBindings.value, props.editTimes, props.visitCounts));
const newerInCloud = computed(() => current.value?.revision && current.value.revision !== binding.value?.revision);
const selectTrip = item => {
  emit('selected');
  if (item.localId) {
    selectedTripId.value = item.localId; status.value = ''; failed.value = false;
    if (cloudUser.value && cloudLibrary.value.some(trip => trip.id === item.cloudId)) run(() => api.recordCloudActivity(item.cloudId));
  }
  else run(() => open(item.cloudId));
};
const run = async action => {
  working.value = true; failed.value = false; status.value = ''; progress.value = null;
  try { await action(); } catch (error) { failed.value = true; status.value = error.message; }
  finally { working.value = false; }
};
const remember = (tripId, trip, localEdit, visitCount) => bindCloudTrip(tripId, {
  id: trip.id, revision: trip.revision, ownerUid: trip.ownerUid,
  accountId: cloudUser.value?.uid || '', editable: Boolean(cloudUser.value && (trip.ownerUid === cloudUser.value.uid || trip.editor)),
  savedLocalEdit: localEdit, savedVisitCount: visitCount, savedAt: dateMillis(trip),
});
const open = async (id, reload = false) => {
  const linkedId = Object.keys(cloudBindings.value).find(tripId => cloudBindings.value[tripId].id === id);
  const existing = linkedId && await db.trips.get(linkedId);
  if (existing && !reload) {
    const access = cloudUser.value && await api.getCloudAccess(id).catch(() => null);
    if (access) await api.recordCloudActivity(id);
    await refreshTrips(); selectedTripId.value = linkedId;
    status.value = 'Opened your existing browser copy. Your local edits are kept. Reload from cloud to fetch the latest saved version.';
    return;
  }
  status.value = 'Downloading cloud trip…';
  const trip = await api.getCloudTrip(id);
  if (cloudUser.value) {
    const access = await api.getCloudAccess(id).catch(() => null);
    trip.editor = access?.editorEmails.includes(cloudUser.value.email.toLowerCase()) || false;
    if (access) await api.recordCloudActivity(id);
  }
  const payload = await decodeTripArchive(await api.downloadCloudTrip(trip));
  const tripId = await restoreTripArchive(payload, { asCopy: true, targetTripId: existing ? linkedId : '' });
  remember(tripId, trip, Math.max(Number(payload.trip.updatedAt || 0), Number(payload.ebd?.updatedAt || 0), ...(payload.visits || []).map(visit => Number(visit.updatedAt || 0))), (payload.visits || []).length);
  current.value = trip;
  await refreshTrips(); selectedVisitId.value = ''; selectedTripId.value = tripId;
  bumpEbdUpdatedAt(); emit('opened', tripId);
  status.value = trip.editor || trip.ownerUid === cloudUser.value?.uid
    ? 'Cloud trip opened. Save to cloud updates this same trip for everyone with access.'
    : 'Shared trip opened. Changes stay in your browser; sign in to save your own cloud copy.';
};
const reload = () => {
  if (window.confirm('Replace this browser copy with the latest cloud version? Unsaved local changes will be lost.')) run(() => open(binding.value.id, true));
};
const save = (asCopy = false) => run(async () => {
  const tripId = selectedTripId.value;
  const originalBinding = binding.value;
  const payload = await readTripArchive(tripId);
  status.value = 'Compressing trip…';
  const blob = await encodeTripArchive(payload);
  const localEdit = Math.max(Number(payload.trip.updatedAt || 0), Number(payload.ebd?.updatedAt || 0), ...(payload.visits || []).map(visit => Number(visit.updatedAt || 0)));
  status.value = 'Saving to cloud…';
  const trip = await api.saveCloudTrip(blob, { name: payload.trip.name, localUpdatedAt: localEdit, visitCount: (payload.visits || []).length }, asCopy ? null : originalBinding, value => { progress.value = value === 1 ? null : Math.round(value * 100); if (value === 1) status.value = 'Publishing cloud trip…'; });
  trip.editor = true;
  remember(tripId, trip, localEdit, (payload.visits || []).length);
  if (selectedTripId.value === tripId) current.value = trip;
  status.value = `Saved to cloud (${(blob.size / 1024 / 1024).toFixed(2)} MB).`;
});
const connect = () => run(async () => { await api.signInCloud(); status.value = 'Signed in. This browser will remember your account.'; });
const sharing = () => run(async () => {
  const id = binding.value.id;
  const trip = await api.getCloudTrip(id);
  const access = await api.getCloudAccess(id);
  if (binding.value?.id !== id) return;
  current.value = trip;
  publicView.value = current.value.public;
  savedEditors.value = access.editorEmails;
  editors.value = access.editorEmails.join('\n');
  showSharing.value = true;
});
const updateSharing = () => run(async () => {
  const id = binding.value.id;
  const appliedEditors = [...editorEmails.value];
  await api.setCloudSharing(id, publicView.value, appliedEditors);
  const trip = await api.getCloudTrip(id);
  if (binding.value?.id === id) { current.value = trip; savedEditors.value = appliedEditors; }
  status.value = 'Sharing settings saved.';
});
const copyLink = edit => run(async () => { await navigator.clipboard.writeText(api.cloudShareUrl(binding.value.id, edit)); status.value = 'Link copied.'; });
const remove = () => {
  if (!window.confirm('Delete this cloud trip and stop sharing it? Your browser copy is kept.')) return;
  run(async () => {
    const id = binding.value.id;
    await api.deleteCloudTrip(binding.value);
    cloudBindings.value = Object.fromEntries(Object.entries(cloudBindings.value).filter(([, item]) => item.id !== id));
    localStorage.setItem('firebaseCloudTrips', JSON.stringify(cloudBindings.value));
    current.value = null; showSharing.value = false;
    status.value = 'Cloud trip deleted. Your browser copy is kept, and the cloud slot is available again.';
  });
};
const sharingKeys = event => {
  if (event.key === 'Escape' && !busy.value) showSharing.value = false;
  if (event.key !== 'Tab') return;
  const controls = [...sharingDialog.value.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled])')];
  if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
  else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
};
watch(showSharing, async opened => {
  await nextTick();
  if (opened) sharingDialog.value.querySelector('button').focus();
  else shareButton.value?.focus();
});
watch(selectedTripId, () => { showSharing.value = false; current.value = cloudLibrary.value.find(trip => trip.id === binding.value?.id) || null; });
watch([binding, cloudUser, cloudLibrary], () => {
  if (binding.value) current.value = cloudLibrary.value.find(trip => trip.id === binding.value.id) || current.value;
}, { immediate: true });
let openedSharedId = '';
const openSharedLink = async () => {
  if (!api || !cloudReady.value || !sharedId.value || openedSharedId === sharedId.value || (route.query.edit === '1' && !cloudUser.value)) return;
  openedSharedId = sharedId.value;
  await run(() => open(sharedId.value));
  if (failed.value) openedSharedId = '';
};
watch([sharedId, cloudReady, cloudUser], openSharedLink);
onMounted(async () => {
  if (!cloudConfigured) return;
  api = await import('../utils/firebaseCloud');
  try { await api.initCloud(); await openSharedLink(); } catch (error) { cloudError.value = error.message; }
});
</script>

<template>
  <div class="row g-4">
    <div class="col-lg-4">
      <section class="card mb-3" aria-label="Trip library">
        <div class="card-body">
          <h2 class="h5 mb-1">Open a trip</h2>
          <p class="text-muted small mb-3">Browser and cloud trips in one place. Opening a linked trip keeps your browser edits.</p>
          <div v-if="library.length" class="trip-library-list d-grid gap-2">
            <button v-for="item in library" :key="item.key" class="trip-library-item btn text-start"
              :class="item.localId === selectedTripId ? 'border-primary bg-primary-subtle' : 'border'"
              :aria-pressed="item.localId === selectedTripId" :disabled="busy || (!item.localId && !cloudReady)" @click="selectTrip(item)">
              <span class="d-flex justify-content-between align-items-start gap-2">
                <strong class="trip-library-name">{{ item.name }}</strong>
                <span v-if="item.localId === selectedTripId" class="badge text-bg-primary">Active</span>
              </span>
              <span class="d-block small mt-1">{{ item.storage }}<span v-if="item.status"> · {{ item.status }}</span></span>
              <span v-if="item.cloudName && item.cloudName !== item.name" class="d-block small text-muted">Linked to: {{ item.cloudName }}</span>
              <span v-if="item.localEditedAt" class="d-block small text-muted mt-1">Browser edit: {{ date(item.localEditedAt) }}</span>
              <span v-if="item.cloudSavedAt" class="d-block small text-muted">Cloud save: {{ date(item.cloudSavedAt) }}</span>
            </button>
          </div>
          <p v-else class="small text-muted">No trips yet. Create or import your first trip below, or sign in to open your cloud trips.</p>
          <slot name="add-trip" :busy="busy" />
        </div>
      </section>
      <section v-if="cloudConfigured" class="card" aria-label="Cloud account">
        <div class="card-body">
          <div class="d-flex justify-content-between align-items-center gap-2 mb-2">
            <h2 class="h6 mb-0">Cloud account</h2>
            <button v-if="!cloudUser" class="btn btn-primary btn-sm" :disabled="busy || !cloudReady" @click="connect">Sign in with Google</button>
          </div>
          <p v-if="cloudUser" class="small mb-1 text-break">{{ cloudUser.email }}</p>
          <p class="small text-muted mb-1">{{ cloudUser ? `Your allowance: ${cloudAllowance} cloud ${cloudAllowance === 1 ? 'trip' : 'trips'}, 50 MB each.` : 'Free: one cloud trip up to 50 MB. No invitation needed.' }}</p>
          <p class="small text-muted mb-2">{{ cloudUser ? 'Sign-in is remembered on this browser.' : 'Sign in to save online and share. Browser trips work without an account.' }}</p>
          <details>
            <summary class="small">Storage policy and account options</summary>
            <p class="small text-muted mt-2">Free cloud storage is offered without a guarantee of long-term retention. Trips not opened by an owner or editor, or saved, for more than six months may be deleted. Keep a downloaded backup of important trips.</p>
            <div v-if="cloudUser">
              <div class="d-flex gap-2 flex-wrap">
                <button class="btn btn-outline-secondary btn-sm" :disabled="busy" @click="showCapacity = !showCapacity">Request more capacity</button>
                <button class="btn btn-link btn-sm" :disabled="busy" @click="run(() => api.signOutCloud())">Sign out</button>
              </div>
              <p v-if="cloudRequest" class="small mt-2 mb-0">Capacity request: {{ cloudRequest.status }}.</p>
              <form v-if="showCapacity" class="mt-2" @submit.prevent="run(async () => { await api.requestCloudCapacity(Number(requestedSlots), requestReason); showCapacity = false; status = 'Request sent for review. Your current allowance stays available.'; })">
                <label class="small" for="capacity-slots">Requested total cloud trips (50 MB each)</label>
                <input id="capacity-slots" v-model="requestedSlots" class="form-control w-auto mb-2" type="number" min="2" max="10" required>
                <label class="small" for="capacity-reason">What do you need the extra space for?</label>
                <textarea id="capacity-reason" v-model="requestReason" class="form-control mb-2" maxlength="1000" rows="2" required />
                <button class="btn btn-primary btn-sm" :disabled="busy">Send request</button>
              </form>
            </div>
          </details>
        </div>
      </section>
    </div>
    <div class="col-lg-8">
      <slot name="new-trip" :busy="busy" />
      <section v-if="selectedTripId && !addingTrip" class="card mb-3" aria-label="Active trip">
        <div class="card-body">
          <slot name="trip-actions" :busy="busy" />
          <div class="border-top pt-3">
            <h3 class="h6">Save and share this trip</h3>
            <p class="small text-muted mb-2">Edits are saved automatically in this browser. Save to cloud to update the online trip and its shared links.</p>
            <template v-if="cloudConfigured">
              <p v-if="binding" class="small mb-2">
                <span v-if="current?.name && current.name !== localTrips.find(trip => trip.id === selectedTripId)?.name" class="d-block">Cloud trip: {{ current.name }}</span>
                <span class="d-block">Last cloud save: {{ date(binding.savedAt) }}</span>
                <strong v-if="newerInCloud" class="text-warning-emphasis">A newer version is in cloud. Reload before saving.</strong>
                <strong v-else>{{ changed ? 'Browser changes waiting to save to cloud.' : 'This browser copy matches your last cloud save.' }}</strong>
                <span v-if="binding && !canSave" class="d-block text-muted">{{ cloudUser ? 'You have viewing access to this copy. Save your own copy to keep changes online.' : 'Sign in with the owner or an invited Google account to save changes to the same cloud trip.' }}</span>
              </p>
              <p v-else class="small mb-2">Browser only. {{ cloudUser ? 'Your first cloud save will link this trip, so later saves update it.' : 'Sign in with Google to save this trip online.' }}</p>
              <div class="d-flex gap-2 flex-wrap">
                <button v-if="cloudUser && (!binding || canSave)" class="btn btn-primary btn-sm" :disabled="busy || newerInCloud" @click="save(false)">{{ binding ? 'Save changes to cloud' : 'Save to cloud' }}</button>
                <button v-if="binding" class="btn btn-outline-secondary btn-sm" :disabled="busy || !cloudReady" @click="reload">Reload from cloud</button>
                <button v-if="binding && ownsTrip" ref="shareButton" class="btn btn-outline-primary btn-sm" :disabled="busy" :aria-expanded="showSharing" @click="showSharing ? showSharing = false : sharing()">Share this trip</button>
                <button v-if="cloudUser && binding && !canSave" class="btn btn-outline-secondary btn-sm" :disabled="busy" @click="save(true)">Save my own cloud copy</button>
              </div>
              <div v-if="binding && cloudUser" class="d-flex gap-3 flex-wrap mt-2">
                <button v-if="canSave" class="btn btn-link btn-sm text-muted p-0" :disabled="busy" @click="save(true)">Save a separate cloud copy</button>
                <button v-if="ownsTrip" class="btn btn-link btn-sm text-danger p-0" :disabled="busy" @click="remove">Delete cloud trip</button>
              </div>
              <div v-if="working && status && !showSharing" class="mt-3">
                <div class="d-flex justify-content-between small mb-1"><span>{{ status }}</span><span v-if="progress !== null">{{ progress }}%</span></div>
                <div class="progress" role="progressbar" :aria-label="status" :aria-valuenow="progress === null ? undefined : progress" aria-valuemin="0" aria-valuemax="100">
                  <div class="progress-bar" :class="{ 'progress-bar-striped progress-bar-animated': progress === null }" :style="{ width: progress === null ? '100%' : `${progress}%` }" />
                </div>
              </div>
              <p v-if="status && !working && !showSharing" class="small mt-2 mb-0" :class="failed ? 'text-danger' : 'text-success'" role="status">{{ status }}</p>

            </template>
            <p v-else class="small text-muted mb-0">Download a backup to keep this trip outside this browser.</p>
          </div>
        </div>
      </section>
      <div v-else-if="!addingTrip" class="card mb-3"><div class="card-body">
        <h2 class="h5">Your next birding trip</h2>
        <ol class="mb-0 text-muted small ps-3">
          <li class="mb-2">Create from the eBird Basic Dataset, import a saved file, or open a cloud trip.</li>
          <li class="mb-2">Add life and region lists to find your target species.</li>
          <li>Use Species Map and Build Trip to plan your visits.</li>
        </ol>
      </div></div>
      <p v-if="sharedId && route.query.edit === '1' && !cloudUser" class="alert alert-info small">Sign in with an invited Google account to edit this cloud trip.</p>
      <p v-if="status && (!selectedTripId || addingTrip)" class="small" :class="failed ? 'text-danger' : 'text-muted'" role="status">{{ status }}</p>
      <p v-if="cloudError" class="alert alert-danger small" role="alert">{{ cloudError }}</p>
      <slot v-if="selectedTripId && !addingTrip" name="trip-details" />
    </div>
  </div>
  <template v-if="showSharing && ownsTrip">
    <div class="modal-backdrop show"></div>
    <div class="modal show d-block" ref="sharingDialog" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="share-trip-heading" @keydown="sharingKeys">
      <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable">
        <div class="modal-content">
          <div class="modal-header">
            <h2 id="share-trip-heading" class="modal-title h5">Share “{{ current.name }}”</h2>
            <button class="btn-close" :disabled="busy" aria-label="Close sharing" @click="showSharing = false" />
          </div>
          <div class="modal-body">
            <p class="small text-muted">Share the trip saved in cloud on {{ date(dateMillis(current)) }}. Life and region lists are included.</p>
            <p v-if="changed" class="small text-warning-emphasis">You have browser changes waiting to save. Shared links show the last cloud save.</p>
            <section class="border rounded p-3 mb-3" aria-labelledby="public-sharing-heading">
              <div class="d-flex justify-content-between align-items-center gap-3 mb-2">
                <h3 id="public-sharing-heading" class="h6 mb-0">Anyone with the link · View only</h3>
                <label class="form-check form-switch mb-0">
                  <input v-model="publicView" type="checkbox" class="form-check-input" role="switch" aria-label="Allow anyone with the link to view" :disabled="busy" />
                </label>
              </div>
              <p class="small text-muted mb-2">No account needed. Visitors can explore the trip; their changes stay in their own browser.</p>
              <p v-if="!publicView" class="small mb-0">Public viewing is off. Enable it to share a viewing link.</p>
              <template v-else>
                <label for="public-trip-link" class="form-label small mb-1">Viewing link</label>
                <div class="input-group input-group-sm">
                  <input id="public-trip-link" class="form-control" :value="api.cloudShareUrl(binding.id)" readonly :disabled="!viewingLinkReady" @focus="$event.target.select()" />
                  <button class="btn btn-outline-primary" :disabled="busy || !viewingLinkReady" @click="copyLink(false)">Copy link</button>
                </div>
              </template>
            </section>
            <section class="border rounded p-3" aria-labelledby="editor-sharing-heading">
              <h3 id="editor-sharing-heading" class="h6">Invited Google accounts · Can edit</h3>
              <p class="small text-muted mb-2">These people can save changes to the same cloud trip. They must sign in with one of the accounts below.</p>
              <label for="cloud-editors" class="form-label small mb-1">Google account emails (up to 10, one per line)</label>
              <textarea id="cloud-editors" v-model="editors" class="form-control form-control-sm mb-2" rows="3" placeholder="name@gmail.com" :disabled="busy" />
              <p v-if="editorEmails.length > 10" class="small text-danger">You can invite up to 10 Google accounts.</p>
              <template v-if="editorEmails.length">
                <label for="editor-trip-link" class="form-label small mb-1">Editing link for invited accounts</label>
                <div class="input-group input-group-sm">
                  <input id="editor-trip-link" class="form-control" :value="api.cloudShareUrl(binding.id, true)" readonly :disabled="!editingLinkReady" @focus="$event.target.select()" />
                  <button class="btn btn-outline-primary" :disabled="busy || !editingLinkReady" @click="copyLink(true)">Copy link</button>
                </div>
              </template>
            </section>
            <p v-if="sharingChanged" class="small text-muted mt-3 mb-0">Save sharing settings before sending a link.</p>
            <p v-if="status" class="small mt-3 mb-0" :class="failed ? 'text-danger' : 'text-success'" role="status">{{ status }}</p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-outline-secondary btn-sm" :disabled="busy" @click="showSharing = false">Done</button>
            <button class="btn btn-primary btn-sm" :disabled="busy || !sharingChanged || editorEmails.length > 10" @click="updateSharing">{{ busy ? 'Saving…' : 'Save sharing settings' }}</button>
          </div>
        </div>
      </div>
    </div>
  </template>

</template>

<style scoped>
.trip-library-list { max-height: 26rem; overflow-y: auto; }
.trip-library-item { color: var(--bs-body-color); }
.trip-library-name { overflow-wrap: anywhere; }
.trip-library-item:hover { background-color: var(--bs-tertiary-bg); }
</style>
