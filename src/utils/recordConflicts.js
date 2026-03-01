export const confirmOverwriteOrReload = async (label, reload) => {
  const overwrite = window.confirm(
    `${label} was modified in another tab. Press OK to overwrite with this tab's changes, or Cancel to reload the latest data.`,
  );
  if (overwrite) return true;
  await reload();
  return false;
};

export const hasNewerStoredRecord = (localUpdatedAt, currentUpdatedAt) =>
  Number(currentUpdatedAt ?? 0) > Number(localUpdatedAt ?? 0);

export const resolveRecordConflict = async ({
  label,
  localUpdatedAt,
  currentUpdatedAt,
  reload,
  promptOnConflict = true,
}) => {
  if (!hasNewerStoredRecord(localUpdatedAt, currentUpdatedAt)) {
    return true;
  }
  if (promptOnConflict === false) {
    await reload();
    return false;
  }
  return confirmOverwriteOrReload(label, reload);
};

export const withUpdatedAt = (updates) => ({
  ...updates,
  updatedAt: updates?.updatedAt ?? Date.now(),
});
