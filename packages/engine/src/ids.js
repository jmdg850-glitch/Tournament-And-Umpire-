// Fallback id generator for the pure generators when the caller passes no
// `makeId` (the server always passes uuid).
export const defaultId = () => `${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
