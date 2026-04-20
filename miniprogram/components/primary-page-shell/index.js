const { resolveShellSafeTop } = require("../../utils/page-shell-safe-top");

Component({
  data: {
    resolvedSafeTop: 0,
  },
  properties: {
    title: {
      type: String,
      value: "",
    },
    subtitle: {
      type: String,
      value: "",
    },
    managedPageKey: {
      type: String,
      value: "",
    },
    showBack: {
      type: Boolean,
      value: false,
    },
    fallbackTab: {
      type: String,
      value: "pages/index/index",
    },
    fallbackRoute: {
      type: String,
      value: "",
    },
    preferFallback: {
      type: Boolean,
      value: false,
    },
    isHomePage: {
      type: Boolean,
      value: false,
    },
    animateIn: {
      type: Boolean,
      value: false,
    },
    hidden: {
      type: Boolean,
      value: false,
    },
  },
  lifetimes: {
    attached() {
      this.syncSafeTop();
    },
  },
  pageLifetimes: {
    show() {
      this.syncSafeTop();
    },
  },
  methods: {
    syncSafeTop() {
      const nextSafeTop = resolveShellSafeTop();
      if (nextSafeTop === this.data.resolvedSafeTop) {
        return;
      }
      this.setData({ resolvedSafeTop: nextSafeTop });
    },
  },
});
