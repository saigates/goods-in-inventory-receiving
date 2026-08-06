// Vite's `?raw` suffix imports a file's contents as a plain string.
// See test/ce1154Golden.spec.ts for usage (golden-file fixtures).
declare module '*?raw' {
  const content: string
  export default content
}
