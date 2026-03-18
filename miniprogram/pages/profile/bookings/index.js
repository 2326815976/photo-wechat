const { getSession, dbQuery, extractSessionUser } = require("../../../services/photo-api");

function parseDateTimeUTC8(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw}T00:00:00+08:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(raw)) {
    const parsed = new Date(`${raw.replace(" ", "T")}+08:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatDateSlashUTC8(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = pad2(shifted.getUTCMonth() + 1);
  const d = pad2(shifted.getUTCDate());
  return `${y}/${m}/${d}`;
}

function formatDate(dateStr) {
  const date = parseDateTimeUTC8(dateStr);
  if (!date) return "";
  return formatDateSlashUTC8(date);
}

function getTodayUTC8() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const STATUS_CONFIG = {
  pending: { label: "待确认", emoji: "⏳" },
  confirmed: { label: "已确认", emoji: "✓" },
  in_progress: { label: "进行中", emoji: "📸" },
  finished: { label: "已完成", emoji: "✨" },
  cancelled: { label: "已取消", emoji: "✕" },
};

Page({
  data: {
    safeTop: 0,
    serviceMissing: false,
    hideAudit: false,

    loading: true,
    currentUserId: "",
    bookings: [],

    cancelingId: "",
    deletingId: "",
    showDeleteConfirmId: "",

    actionNoticeType: "",
    actionNoticeMessage: "",
  },

  async onLoad() {
    this._profileBookingsBootstrapped = false;
    this._lastSeenAppEnterSeq = 0;
    const blocked = await this.syncAuditAccess();
    if (blocked) {
      return;
    }

    const app = getApp();
    const globalData = app && app.globalData ? app.globalData : {};
    const safeTop = Number(globalData.statusBarHeight || 0);
    const serviceMissing = !String(globalData.cloudRunService || "").trim();
    this.setData({ safeTop, serviceMissing });

    if (!serviceMissing) {
      this.loadBookings();
    } else {
      this.setData({ loading: false });
    }
  },

  async onShow() {
    const app = typeof getApp === "function" ? getApp() : null;
    const appEnterSeq = Math.max(0, Number(app && app.globalData ? app.globalData.appEnterSeq : 0));
    const lastSeenAppEnterSeq = Math.max(0, Number(this._lastSeenAppEnterSeq || 0));
    const hasNewAppEntry = appEnterSeq > lastSeenAppEnterSeq;
    this._lastSeenAppEnterSeq = Math.max(appEnterSeq, lastSeenAppEnterSeq);
    const blocked = await this.syncAuditAccess();
    if (blocked) {
      return;
    }

    if (!this.data.serviceMissing) {
      if (hasNewAppEntry && this._profileBookingsBootstrapped && !this.data.loading) {
        return;
      }
      this.loadBookings();
    }
  },

  onHide() {
    this.clearActionNoticeTimer();
  },

  onUnload() {
    this.clearActionNoticeTimer();
  },

  noop() {},

  async syncAuditAccess() {
    const app = typeof getApp === "function" ? getApp() : null;
    if (app && typeof app.ensureAuditConfig === "function") {
      try {
        await app.ensureAuditConfig();
      } catch (error) {
        // ignore
      }
    }

    const hideAudit = Boolean(app && app.globalData && app.globalData.hideAudit);
    this.setData({ hideAudit });
    if (!hideAudit) {
      return false;
    }

    this.setData({
      loading: false,
      bookings: [],
    });
    wx.switchTab({ url: "/pages/profile/index" });
    return true;
  },

  clearActionNoticeTimer() {
    if (this._actionNoticeTimer) {
      clearTimeout(this._actionNoticeTimer);
      this._actionNoticeTimer = null;
    }
  },

  showActionNotice(message, type) {
    this.clearActionNoticeTimer();
    this.setData({
      actionNoticeType: String(type || "error"),
      actionNoticeMessage: String(message || ""),
    });
    this._actionNoticeTimer = setTimeout(() => {
      this.setData({
        actionNoticeType: "",
        actionNoticeMessage: "",
      });
      this._actionNoticeTimer = null;
    }, 3000);
  },

  async ensureUserId() {
    const cached = String(this.data.currentUserId || "").trim();
    if (cached) return cached;

    try {
      const session = await getSession();
      const user = extractSessionUser(session);
      const userId = String((user && user.id) || "").trim();
      if (userId) {
        this.setData({ currentUserId: userId });
      }
      return userId;
    } catch (error) {
      return "";
    }
  },

  canCancelBooking(booking) {
    if (!booking) return false;
    const status = String(booking.status || "");
    const bookingDate = String(booking.booking_date || "");
    const today = getTodayUTC8();
    return bookingDate > today && (status === "pending" || status === "confirmed");
  },

  canDeleteBooking(booking) {
    if (!booking) return false;
    const status = String(booking.status || "");
    return status === "cancelled" || status === "finished";
  },

  async fetchBookingSnapshot(id, userId) {
    const ownerId = String(userId || "").trim();
    const filters = [{ column: "id", operator: "eq", value: id }];
    if (ownerId) {
      filters.push({ column: "user_id", operator: "eq", value: ownerId });
    }

    const r = await dbQuery({
      table: "bookings",
      action: "select",
      columns: "id,booking_date,status",
      filters,
      maybeSingle: true,
    });

    if (r && r.error) {
      return {
        data: null,
        error: { message: String(r.error.message || "查询失败") },
      };
    }

    return {
      data: r ? r.data : null,
      error: null,
    };
  },

  async loadBookings() {
    this.setData({ loading: true });
    try {
      const session = await getSession();
      const user = extractSessionUser(session);
      if (!user || !user.id) {
        this.setData({ loading: false, currentUserId: "", bookings: [] });
        return;
      }
      const currentUserId = String(user.id);

      const r = await dbQuery({
        table: "bookings",
        action: "select",
        columns: "id,type_id,booking_date,location,city_name,phone,wechat,notes,status,created_at",
        filters: [{ column: "user_id", operator: "eq", value: currentUserId }],
        orders: [{ column: "created_at", ascending: false }],
        limit: 200,
      });
      if (r && r.error) {
        this.setData({ loading: false, currentUserId, bookings: [] });
        this.showActionNotice(`加载预约记录失败：${String(r.error.message || "请稍后重试")}`, "error");
        return;
      }

      const rows = r && Array.isArray(r.data) ? r.data : [];
      const typeIds = Array.from(
        new Set(rows.map((x) => Number(x.type_id || 0)).filter((x) => x))
      );

      let typeMap = {};
      if (typeIds.length > 0) {
        try {
          const tr = await dbQuery({
            table: "booking_types",
            action: "select",
            columns: "id,name",
            filters: [{ column: "id", operator: "in", value: typeIds }],
            limit: 200,
          });
          const types = tr && Array.isArray(tr.data) ? tr.data : [];
          types.forEach((t) => {
            typeMap[String(t.id)] = String(t.name || "");
          });
        } catch (e2) {
          // ignore
        }
      }

      const today = getTodayUTC8();
      const bookings = rows.map((b) => {
        const status = String(b.status || "pending");
        const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
        const bookingDate = String(b.booking_date || "");
        const canCancel = bookingDate > today && (status === "pending" || status === "confirmed");
        const canDelete = status === "cancelled" || status === "finished";

        return Object.assign({}, b, {
          created_at_text: formatDate(b.created_at),
          type_name: typeMap[String(b.type_id)] || "未知",
          status_label: cfg.label,
          status_emoji: cfg.emoji,
          can_cancel: Boolean(canCancel),
          can_delete: Boolean(canDelete),
        });
      });

      this.setData({ loading: false, currentUserId, bookings });
    } catch (e) {
      this.setData({ loading: false, currentUserId: "", bookings: [] });
    } finally {
      this._profileBookingsBootstrapped = true;
    }
  },

  async onCancel(e) {
    if (this.data.cancelingId) return;
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;

    const booking = (this.data.bookings || []).find((b) => String(b.id) === id);
    if (!booking || !this.canCancelBooking(booking)) {
      this.showActionNotice("该预约当前不可取消，请刷新后重试", "error");
      return;
    }

    this.setData({ cancelingId: id });
    try {
      const userId = await this.ensureUserId();
      if (!userId) {
        this.showActionNotice("登录状态已失效，请重新登录后重试", "error");
        return;
      }
      const today = getTodayUTC8();
      const updated = await dbQuery({
        table: "bookings",
        action: "update",
        values: { status: "cancelled" },
        filters: [
          { column: "id", operator: "eq", value: id },
          { column: "user_id", operator: "eq", value: userId },
          { column: "status", operator: "in", value: ["pending", "confirmed"] },
          { column: "booking_date", operator: "gt", value: today },
        ],
        selectAfterWrite: true,
        maybeSingle: true,
        columns: "id,booking_date,status",
      });

      if (updated && updated.error) {
        this.showActionNotice(`取消预约失败：${String(updated.error.message || "请稍后重试")}`, "error");
        return;
      }

      if (!updated || !updated.data) {
        const latest = await this.fetchBookingSnapshot(id, userId);
        if (latest.error) {
          this.showActionNotice("取消结果校验失败，请刷新后确认", "error");
          await this.loadBookings();
          return;
        }
        if (!latest.data) {
          this.showActionNotice("该预约不存在或已无权限操作", "error");
          await this.loadBookings();
          return;
        }
        if (!this.canCancelBooking(latest.data)) {
          this.showActionNotice("预约状态已变化，无法取消，请刷新后重试", "error");
          await this.loadBookings();
          return;
        }

        this.showActionNotice("预约状态已变化，取消失败，请刷新后重试", "error");
        await this.loadBookings();
        return;
      }

      this.showActionNotice("预约已取消", "success");
      await this.loadBookings();
    } catch (e2) {
      this.showActionNotice("取消失败，请稍后重试", "error");
    } finally {
      this.setData({ cancelingId: "" });
    }
  },

  openDeleteConfirm(e) {
    const id =
      e && e.currentTarget && e.currentTarget.dataset
        ? String(e.currentTarget.dataset.id || "")
        : "";
    if (!id) return;
    this.setData({ showDeleteConfirmId: id });
  },

  closeDeleteConfirm() {
    this.setData({ showDeleteConfirmId: "" });
  },

  async confirmDelete() {
    if (this.data.deletingId) return;
    const id = String(this.data.showDeleteConfirmId || "");
    if (!id) return;

    const booking = (this.data.bookings || []).find((b) => String(b.id) === id);
    if (!booking || !this.canDeleteBooking(booking)) {
      this.closeDeleteConfirm();
      this.showActionNotice("该预约当前不可删除，请刷新后重试", "error");
      return;
    }

    this.setData({ deletingId: id });
    try {
      const userId = await this.ensureUserId();
      if (!userId) {
        this.closeDeleteConfirm();
        this.showActionNotice("登录状态已失效，请重新登录后重试", "error");
        return;
      }
      const deleted = await dbQuery({
        table: "bookings",
        action: "delete",
        filters: [
          { column: "id", operator: "eq", value: id },
          { column: "user_id", operator: "eq", value: userId },
          { column: "status", operator: "in", value: ["cancelled", "finished"] },
        ],
        selectAfterWrite: true,
        maybeSingle: true,
        columns: "id,booking_date,status",
      });
      this.closeDeleteConfirm();
      if (deleted && deleted.error) {
        this.showActionNotice(`删除预约失败：${String(deleted.error.message || "请稍后重试")}`, "error");
        return;
      }

      if (!deleted || !deleted.data) {
        const latest = await this.fetchBookingSnapshot(id, userId);
        if (latest.error) {
          this.showActionNotice("删除结果校验失败，请刷新后确认", "error");
          await this.loadBookings();
          return;
        }

        if (!latest.data) {
          this.showActionNotice("预约记录已不存在", "success");
          await this.loadBookings();
          return;
        }

        if (!this.canDeleteBooking(latest.data)) {
          this.showActionNotice("预约状态已变化，无法删除，请刷新后重试", "error");
          await this.loadBookings();
          return;
        }

        this.showActionNotice("预约状态已变化，删除失败，请刷新后重试", "error");
        await this.loadBookings();
        return;
      }

      this.showActionNotice("预约记录已删除", "success");
      await this.loadBookings();
    } catch (e2) {
      this.showActionNotice("删除失败，请稍后重试", "error");
    } finally {
      this.setData({ deletingId: "" });
    }
  },
});
