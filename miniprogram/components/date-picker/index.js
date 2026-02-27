function pad2(n) {
  return String(n).padStart(2, "0");
}

const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;

function formatDateUTC8(date) {
  const shifted = new Date(date.getTime() + UTC8_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

function parseDateUTC8(dateStr) {
  const raw = String(dateStr || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [y, m, d] = raw.split("-").map((x) => Number(x));
  const date = new Date(Date.UTC(y, m - 1, d) - UTC8_OFFSET_MS);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function getTodayUTC8() {
  return formatDateUTC8(new Date());
}

function getDateAfterDaysUTC8(days) {
  const shifted = new Date(Date.now() + UTC8_OFFSET_MS);
  shifted.setUTCDate(shifted.getUTCDate() + Number(days || 0));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

function formatDateDisplayCN(dateStr) {
  const raw = String(dateStr || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const [yearText, monthText, dayText] = raw.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!year || !month || !day) return raw;
  return `${year}年${month}月${day}日`;
}

Component({
  properties: {
    value: {
      type: String,
      value: "",
    },
    minDate: {
      type: String,
      value: "",
    },
    maxDate: {
      type: String,
      value: "",
    },
    blockedDates: {
      type: Array,
      value: [],
    },
    placeholder: {
      type: String,
      value: "请选择日期",
    },
  },

  data: {
    isOpen: false,
    currentYear: 0,
    currentMonth: 0,
    weekDays: ["日", "一", "二", "三", "四", "五", "六"],
    days: [],
    displayText: "",
    displayPressed: false,
    pressedDayIndex: -1,
  },

  lifetimes: {
    attached() {
      const selected = parseDateUTC8(this.properties.value) || parseDateUTC8(getTodayUTC8()) || new Date();
      this.setData({
        currentYear: selected.getUTCFullYear(),
        currentMonth: selected.getUTCMonth() + 1,
      });
      this.refreshDisplayText();
      this.buildCalendar();
    },
  },

  observers: {
    value() {
      this.refreshDisplayText();
      if (!this.data.isOpen) {
        this.buildCalendar();
      }
    },
    blockedDates() {
      if (this.data.isOpen) {
        this.buildCalendar();
      }
    },
  },

  methods: {
    noop() {},

    onDisplayTouchStart() {
      this.setData({ displayPressed: true });
    },

    onDisplayTouchEnd() {
      if (!this.data.displayPressed) return;
      this.setData({ displayPressed: false });
    },

    onDayTouchStart(e) {
      const index =
        e && e.currentTarget && e.currentTarget.dataset
          ? Number(e.currentTarget.dataset.index)
          : -1;
      if (index < 0) return;
      this.setData({ pressedDayIndex: index });
    },

    onDayTouchEnd() {
      if (this.data.pressedDayIndex < 0) return;
      this.setData({ pressedDayIndex: -1 });
    },

    refreshDisplayText() {
      const value = String(this.properties.value || "");
      if (!value) {
        this.setData({ displayText: "" });
        return;
      }

      const date = parseDateUTC8(value);
      if (!date) {
        this.setData({ displayText: value });
        return;
      }

      const text = formatDateDisplayCN(formatDateUTC8(date));
      this.setData({ displayText: text });
    },

    getMinDate() {
      return this.properties.minDate || getDateAfterDaysUTC8(0);
    },

    getMaxDate() {
      return this.properties.maxDate || getDateAfterDaysUTC8(30);
    },

    isSelectable(dateStr, inMonth) {
      if (!inMonth) return false;
      const minDate = this.getMinDate();
      const maxDate = this.getMaxDate();
      if (dateStr < minDate || dateStr > maxDate) return false;
      if ((this.properties.blockedDates || []).includes(dateStr)) return false;
      return true;
    },

    buildCalendar() {
      const year = Number(this.data.currentYear);
      const month = Number(this.data.currentMonth);
      if (!year || !month) return;

      const first = new Date(Date.UTC(year, month - 1, 1));
      const start = new Date(first);
      start.setUTCDate(first.getUTCDate() - first.getUTCDay());

      const fifthWeekLastDate = new Date(start);
      fifthWeekLastDate.setUTCDate(start.getUTCDate() + 34);
      const totalCells = fifthWeekLastDate.getUTCMonth() === month - 1 ? 42 : 35;

      const days = [];
      for (let i = 0; i < totalCells; i += 1) {
        const d = new Date(start);
        d.setUTCDate(start.getUTCDate() + i);
        const dateStr = formatDateUTC8(d);
        const inMonth = d.getUTCMonth() === month - 1;
        const blocked = (this.properties.blockedDates || []).includes(dateStr);
        const selected = String(this.properties.value || "") === dateStr;
        const selectable = this.isSelectable(dateStr, inMonth);
        days.push({
          dateStr,
          day: d.getUTCDate(),
          inMonth,
          blocked,
          selected,
          selectable,
        });
      }

      this.setData({ days });
    },

    openPanel() {
      const selected = parseDateUTC8(this.properties.value) || parseDateUTC8(getTodayUTC8()) || new Date();
      this.setData({
        isOpen: true,
        displayPressed: false,
        currentYear: selected.getUTCFullYear(),
        currentMonth: selected.getUTCMonth() + 1,
      });
      this.buildCalendar();
    },

    closePanel() {
      this.setData({ isOpen: false, displayPressed: false, pressedDayIndex: -1 });
    },

    shiftMonth(offset) {
      let year = Number(this.data.currentYear);
      let month = Number(this.data.currentMonth) + offset;
      if (month < 1) {
        month = 12;
        year -= 1;
      } else if (month > 12) {
        month = 1;
        year += 1;
      }
      this.setData({ currentYear: year, currentMonth: month });
      this.buildCalendar();
    },

    prevMonth() {
      this.shiftMonth(-1);
    },

    nextMonth() {
      this.shiftMonth(1);
    },

    onSelectDay(e) {
      const index =
        e && e.currentTarget && e.currentTarget.dataset
          ? Number(e.currentTarget.dataset.index)
          : -1;
      if (index < 0 || index >= this.data.days.length) return;

      const day = this.data.days[index];
      if (!day) return;

      if (day.blocked) {
        wx.showToast({ title: "该日期不可预约", icon: "none" });
        return;
      }

      if (!day.selectable) return;

      this.triggerEvent("change", { value: day.dateStr });
      this.setData({ isOpen: false, pressedDayIndex: -1 });
    },
  },
});
