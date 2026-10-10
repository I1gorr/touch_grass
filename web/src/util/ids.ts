/** 32 random lowercase hex chars (walk, entry and device ids). */
export function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Stop ids are `<walkId>-<position>`: the same OSM place gets a fresh row in every walk. */
export const stopIdFor = (walkId: string, position: number): string => `${walkId}-${position}`;

export const DEVICE_ID_PATTERN = /^[0-9a-f]{32}$/;
