// Vite's `import.meta.glob`, declared for this package's standalone typecheck.
// Bundled consumers (Desktop) get the full signature from `vite/client`.
interface ImportMeta {
  glob<T>(
    pattern: string,
    options: { eager: true; query: string; import: 'default' },
  ): Record<string, T>;
}
