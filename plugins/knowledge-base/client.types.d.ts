/** Structural subset of the released 0.2.1-rc.2 public classic-script loader. */
declare const window: {
  __ModuleLoader__: {
    load(registration: { id: string; factory: () => { inject: string[]; apply(): void } }): void;
  };
};
