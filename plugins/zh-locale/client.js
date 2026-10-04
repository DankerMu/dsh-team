// @ts-check
/** Classic-script client artifact: no bundler, dependencies, or native bridge. */
window.__ModuleLoader__.load({
  id: '@dsh-team/zh-locale',
  factory: () => ({
    inject: ['locale'],
    apply(ctx) {
      ctx.locale.setLocale('zh');
    },
  }),
});
