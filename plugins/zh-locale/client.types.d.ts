/** Structural subset of the packed 0.2.0-rc.2 public client interfaces. */
interface DshLocaleContext {
  locale: { setLocale(id: string): void };
}

interface DshLocalePlugin {
  inject: string[];
  apply(ctx: DshLocaleContext): void;
}

/** The public classic-script registration facade, not a native bridge. */
declare const window: {
  __ModuleLoader__: {
    load(registration: { id: string; factory: () => DshLocalePlugin }): void;
  };
};
