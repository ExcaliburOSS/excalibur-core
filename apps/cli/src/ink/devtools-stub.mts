// Stub for `react-devtools-core`, which Ink imports only when the DEV env is
// set. Aliased in at bundle time so the self-contained ESM Ink bundle never
// needs the real (dev-only) dependency.
export default {};
export const connectToDevTools = (): void => {};
