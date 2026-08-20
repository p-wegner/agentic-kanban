/**
 * Plugin wire types (#569).
 *
 * `PluginOwner` — which installed plugin a view/loop/script/skill row belongs to — was
 * declared twice: once in the client's `PluginActionPanes.tsx` and once (as an inline
 * object literal, repeated at every projection site) on the server. The server side is
 * now built in ONE place (`services/plugin-enabled.ts`, #552), so the shape belongs
 * here where both halves can import the same declaration.
 */
export interface PluginOwner {
  /** Plugin DB row id — the `:id` segment of the plugin routes. */
  pluginId: string;
  /** The manifest's own slug (`plugin_id`), which keys preferences and unit ids. */
  pluginSlug: string;
  pluginName: string;
}
