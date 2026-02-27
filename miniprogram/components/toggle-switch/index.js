Component({
  properties: {
    enabled: {
      type: Boolean,
      value: false,
    },
  },
  methods: {
    onTap() {
      this.triggerEvent("change", { value: !this.properties.enabled });
    },
  },
});

