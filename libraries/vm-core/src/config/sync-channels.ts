// ============================================================================
// sync-channels.ts — the host→guest sync channel registry. Single definition
// site: spec.sync keys + defaults (schema.ts), the create form's flat field
// names + defaults (store.ts/service.ts), env kills, and the cli's channel
// list all derive from this table. Adding a channel = one row here.
// ============================================================================

export interface SyncChannelDef {
    /** spec.sync key — also the `vm sync` cli name. */
    id: string;
    /** Flat CreateForm field the checkbox binds to. */
    formKey: string;
    /** Per-channel env kill — "0" disables regardless of the spec flag. */
    env: string;
    /** Legacy env kill still honored (pre-registry names). */
    legacyEnv?: string;
    /** spec.sync + create-form default. */
    def: boolean;
    /** Pushes host credentials/identity/trust into the guest — default-off. */
    credential?: boolean;
    /** One-line description for cli / UI. */
    label: string;
}

export const SYNC_CHANNELS = [
    { id: "theme",         formKey: "syncTheme",        env: "CRUISER_SYNC_THEME",         legacyEnv: "CRUISER_THEME_SYNC", def: true,  label: "dark/light hint via the xdg portal" },
    { id: "accentColor",   formKey: "syncAccent",       env: "CRUISER_SYNC_ACCENT",        def: true,  label: "portal accent color" },
    { id: "contrast",      formKey: "syncContrast",     env: "CRUISER_SYNC_CONTRAST",      def: true,  label: "portal high-contrast preference" },
    { id: "timezone",      formKey: "syncTimezone",     env: "CRUISER_SYNC_TIMEZONE",      def: true,  label: "host timezone" },
    { id: "locale",        formKey: "syncLocale",       env: "CRUISER_SYNC_LOCALE",        def: true,  label: "host LANG" },
    { id: "keyboard",      formKey: "syncKeyboard",     env: "CRUISER_SYNC_KEYBOARD",      def: true,  label: "host keymap" },
    { id: "monitors",      formKey: "syncMonitors",     env: "CRUISER_SYNC_MONITORS",      def: true,  label: "host monitor topology" },
    { id: "scale",         formKey: "syncScale",        env: "CRUISER_SYNC_SCALE",         def: true,  label: "host display scale + font DPI" },
    { id: "hostWallpaper", formKey: "syncHostWallpaper", env: "CRUISER_SYNC_HOST_WALLPAPER", def: true,  label: "host wallpaper as composite source" },
    { id: "shares",        formKey: "syncShares",       env: "CRUISER_SYNC_SHARES",        def: true,  label: "guest fstab/mount reconcile for spec.shares" },
    // ── default-off: these move host identity, trust, or credentials ──
    { id: "gitIdentity",   formKey: "syncGit",          env: "CRUISER_SYNC_GIT",           def: false, credential: true, label: "~/.gitconfig user.name/email" },
    { id: "proxy",         formKey: "syncProxy",        env: "CRUISER_SYNC_PROXY",         def: false, credential: true, label: "host proxy config" },
    { id: "caCerts",       formKey: "syncCa",           env: "CRUISER_SYNC_CA_CERTS",      def: false, credential: true, label: "host custom CA roots" },
    { id: "sshAgent",      formKey: "syncAgent",        env: "CRUISER_SYNC_SSH_AGENT",     def: false, credential: true, label: "ssh -R forward of the host agent socket" },
] as const;

// Shape validation — `as const` keeps the literal ids; this line checks
// every row still satisfies the def interface.
const _shape: readonly SyncChannelDef[] = SYNC_CHANNELS;

export type SyncId = (typeof SYNC_CHANNELS)[number]["id"];
export type SyncFormKey = (typeof SYNC_CHANNELS)[number]["formKey"];
export type SyncChannel = (typeof SYNC_CHANNELS)[number];

/** Ordered channel ids (display order: provision/session/cli `vm sync`). */
export const SYNC_IDS: readonly SyncId[] = SYNC_CHANNELS.map((c) => c.id);

export function syncChannel(id: SyncId): SyncChannel {
    return SYNC_CHANNELS.find((c) => c.id === id)!;
}

/** Default values for the flat create-form sync fields. */
export function syncFormDefaults(): { [K in SyncFormKey]: boolean } {
    return Object.fromEntries(SYNC_CHANNELS.map((c) => [c.formKey, c.def])) as { [K in SyncFormKey]: boolean };
}
