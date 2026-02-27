Component({
  properties: {
    value: Number,
    options: {
      type: Array,
      value: []
    },
    placeholder: {
      type: String,
      value: "请选择约拍类型..."
    },
  },

  data: {
    isOpen: false,
    selectedLabel: "",
    isBtnPressed: false,
  },

  observers: {
    "value, options": function () {
      this.syncSelectedLabel();
    }
  },

  lifetimes: {
    attached() {
      this.syncSelectedLabel();
    }
  },

  methods: {
    syncSelectedLabel() {
      const value = Number(this.properties.value || 0);
      const options = Array.isArray(this.properties.options) ? this.properties.options : [];
      const selected = options.find((x) => Number(x.value) === value);
      const selectedLabel = selected
        ? `${selected.emoji ? `${selected.emoji} ` : ""}${selected.label || ""}`
        : "";
      this.setData({ selectedLabel });
    },

    toggleOpen() {
      this.setData({ isOpen: !this.data.isOpen });
    },

    onBtnTouchStart() {
      this.setData({ isBtnPressed: true });
    },

    onBtnTouchEnd() {
      if (!this.data.isBtnPressed) return;
      this.setData({ isBtnPressed: false });
    },

    close() {
      this.setData({ isOpen: false, isBtnPressed: false });
    },

    onSelect(e) {
      const value = Number(e.currentTarget.dataset.value || 0);
      this.setData({ isOpen: false, isBtnPressed: false });
      this.triggerEvent('change', { value });
    }
  }
});
