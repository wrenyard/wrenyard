/** Browser asset entry; never imported by sandboxed preloads or native consumers. */

/** Icon URL per theme id, derived from the `src/<id>/assets/` folder structure. */
export const THEME_ICON_URLS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>('./*/assets/icon-256.png', {
      eager: true,
      query: '?url',
      import: 'default',
    }),
  ).map(([path, url]) => [path.split('/')[1], url] as const),
);
