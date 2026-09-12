// Raising Arrows CRM — frontend (vanilla JS, no build step)

const state = {
  stages: [],
  contacts: [],
  settings: {},
  currentView: "board",
  openContactId: null,
};

function fmtMoney(n) {
  n = Number(n || 0);
  return "₦" + n.toLocaleString("en-NG", { maximumFractionDigits: 0 });
}

function fmtDate(s) {
  if (!s) return "";
  const d = new Date(s + "T00:00:00");
  if (isNaN(d)) return s;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    showAuthScreen();
    throw new Error("unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "request failed");
  return data;
}

// ---------------------------------------------------------------- Auth ----

async function boot() {
  const status = await api("/api/setup-status");
  if (!status.configured) {
    showAuthScreen();
    document.getElementById("setup-form").hidden = false;
    document.getElementById("login-form").hidden = true;
    return;
  }
  try {
    await api("/api/me");
    startApp();
  } catch (e) {
    showAuthScreen();
    document.getElementById("setup-form").hidden = true;
    document.getElementById("login-form").hidden = false;
  }
}

function showAuthScreen() {
  document.getElementById("auth-screen").hidden = false;
  document.getElementById("app").hidden = true;
}

document.getElementById("setup-submit").addEventListener("click", async () => {
  const email = document.getElementById("setup-email").value.trim();
  const password = document.getElementById("setup-password").value;
  const errEl = document.getElementById("setup-error");
  errEl.textContent = "";
  try {
    await api("/api/setup", { method: "POST", body: { email, password } });
    startApp();
  } catch (e) {
    errEl.textContent = e.message;
  }
});

document.getElementById("login-submit").addEventListener("click", async () => {
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";
  try {
    await api("/api/login", { method: "POST", body: { email, password } });
    startApp();
  } catch (e) {
    errEl.textContent = e.message;
  }
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  document.getElementById("app").hidden = true;
  showAuthScreen();
  document.getElementById("login-form").hidden = false;
  document.getElementById("setup-form").hidden = true;
});

async function startApp() {
  document.getElementById("auth-screen").hidden = true;
  document.getElementById("app").hidden = false;
  const me = await api("/api/me");
  document.getElementById("me-email").textContent = me.email;
  const stagesRes = await api("/api/stages");
  state.stages = stagesRes.stages;
  await refreshAll();
  handleHashRoute();
}

// -------------------------------------------------------------- Tabs ----

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});

function setView(view) {
  state.currentView = view;
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  document.getElementById("view-board").hidden = view !== "board";
  document.getElementById("view-dashboard").hidden = view !== "dashboard";
  document.getElementById("view-settings").hidden = view !== "settings";
  if (view === "dashboard") renderDashboard();
  if (view === "settings") renderSettings();
}

async function refreshAll() {
  const [contacts, settings] = await Promise.all([api("/api/contacts"), api("/api/settings")]);
  state.contacts = contacts;
  state.settings = settings;
  renderBoard();
  if (state.currentView === "dashboard") renderDashboard();
}

// -------------------------------------------------------------- Board ----

function renderBoard() {
  const board = document.getElementById("board");
  board.innerHTML = "";
  state.stages.forEach((stage) => {
    const col = document.createElement("div");
    col.className = "column";
    col.dataset.stage = stage.key;

    const contactsInStage = state.contacts.filter((c) => c.stage === stage.key);

    const header = document.createElement("div");
    header.className = "column-header";
    header.innerHTML = `<span>${stage.label}</span><span class="column-count">${contactsInStage.length}</span>`;
    col.appendChild(header);

    const bodyEl = document.createElement("div");
    bodyEl.className = "column-body";
    bodyEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      bodyEl.classList.add("drag-over");
    });
    bodyEl.addEventListener("dragleave", () => bodyEl.classList.remove("drag-over"));
    bodyEl.addEventListener("drop", async (e) => {
      e.preventDefault();
      bodyEl.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/plain");
      if (id) {
        await api(`/api/contacts/${id}`, { method: "PUT", body: { stage: stage.key } });
        await refreshAll();
      }
    });

    contactsInStage.forEach((c) => bodyEl.appendChild(renderCard(c)));
    col.appendChild(bodyEl);
    board.appendChild(col);
  });
}

function dueBadge(dateStr, kind) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((d - today) / 86400000);
  const label = kind === "follow" ? "Follow up" : "Payment due";
  if (diffDays < 0) return `<span class="badge badge-overdue">${label} overdue · ${fmtDate(dateStr)}</span>`;
  if (diffDays <= 2) return `<span class="badge badge-soon">${label} ${fmtDate(dateStr)}</span>`;
  return `<span class="badge badge-ok">${label} ${fmtDate(dateStr)}</span>`;
}

function moveStageOptions(currentStage) {
  return (
    `<option value="">Move to…</option>` +
    state.stages
      .filter((s) => s.key !== currentStage)
      .map((s) => `<option value="${s.key}">${s.label}</option>`)
      .join("")
  );
}

function renderCard(c) {
  const card = document.createElement("div");
  card.className = "card";
  card.draggable = true;
  card.dataset.id = c.id;
  if (state.openContactId === c.id) card.classList.add("highlight");

  card.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", c.id);
  });
  card.addEventListener("click", () => openContactModal(c.id));

  const childrenNames = c.children.map((ch) => ch.name).join(", ");
  let money = "";
  if (c.amount_total > 0) {
    money = `<div class="card-meta">${fmtMoney(c.amount_paid)} / ${fmtMoney(c.amount_total)} paid</div>`;
  }

  card.innerHTML = `
    <div class="card-name">${c.hot ? "🔥" : ""} ${escapeHtml(c.name)}</div>
    <div class="card-meta">${c.phone ? escapeHtml(c.phone) : ""}</div>
    <div class="card-meta">${c.num_children} child${c.num_children === 1 ? "" : "ren"}${childrenNames ? ": " + escapeHtml(childrenNames) : ""}</div>
    ${money}
    ${c.payment_not_recorded ? `<span class="badge badge-overdue">⚠️ Payment not recorded</span>` : ""}
    ${dueBadge(c.follow_up_due, "follow")}
    ${["closed_payment_plan", "closed_personalized"].includes(c.stage) ? dueBadge(c.next_payment_due, "payment") : ""}
    <select class="card-move-select">${moveStageOptions(c.stage)}</select>
  `;

  const moveSelect = card.querySelector(".card-move-select");
  moveSelect.addEventListener("click", (e) => e.stopPropagation());
  moveSelect.addEventListener("mousedown", (e) => e.stopPropagation());
  moveSelect.addEventListener("change", async (e) => {
    e.stopPropagation();
    const newStage = moveSelect.value;
    if (!newStage) return;
    await api(`/api/contacts/${c.id}`, { method: "PUT", body: { stage: newStage } });
    await refreshAll();
  });

  return card;
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s || "";
  return div.innerHTML;
}

document.getElementById("new-contact-btn").addEventListener("click", () => openContactModal(null));

// ------------------------------------------------------------- Modal ----

function stageOptions(selected) {
  return state.stages
    .map((s) => `<option value="${s.key}" ${s.key === selected ? "selected" : ""}>${s.label}</option>`)
    .join("");
}

function openContactModal(id) {
  state.openContactId = id;
  const contact = id ? state.contacts.find((c) => c.id === id) : null;
  const c = contact || {
    id: null,
    name: "",
    email: "",
    phone: "",
    stage: "new_inquiry",
    hot: 0,
    program_type: "regular",
    amount_total: 0,
    amount_paid: 0,
    personalized_months: "",
    installments_total: Number(state.settings.installments_total_default) || 3,
    installments_paid: 0,
    follow_up_due: "",
    next_payment_due: "",
    notes: "",
    closed_lost_reason: "",
    children: [],
  };

  const modal = document.getElementById("contact-modal");
  modal.innerHTML = `
    <h2>${id ? "Edit contact" : "New inquiry"}</h2>

    <div class="form-row">
      <label>Full name</label>
      <input type="text" id="f-name" value="${escapeHtml(c.name)}">
    </div>
    <div class="form-grid">
      <div class="form-row">
        <label>Email</label>
        <input type="email" id="f-email" value="${escapeHtml(c.email || "")}">
      </div>
      <div class="form-row">
        <label>Phone</label>
        <input type="text" id="f-phone" value="${escapeHtml(c.phone || "")}">
      </div>
    </div>
    <div class="form-grid">
      <div class="form-row">
        <label>Stage</label>
        <select id="f-stage">${stageOptions(c.stage)}</select>
      </div>
      <div class="form-row">
        <label>&nbsp;</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--ink);">
          <input type="checkbox" id="f-hot" style="width:auto;" ${c.hot ? "checked" : ""}> Hot 🔥
        </label>
      </div>
    </div>

    <div class="section-title">Children</div>
    <div class="children-list" id="children-list"></div>
    <button class="btn btn-small" id="add-child-btn" type="button">+ Add child</button>

    <div class="section-title">Program &amp; pricing</div>
    <div class="form-grid">
      <div class="form-row">
        <label>Program type</label>
        <select id="f-program-type">
          <option value="regular" ${c.program_type === "regular" ? "selected" : ""}>RAFA (3-month program)</option>
          <option value="personalized" ${c.program_type === "personalized" ? "selected" : ""}>Personalized coaching</option>
        </select>
      </div>
      <div class="form-row" id="months-row" style="${c.program_type === "personalized" ? "" : "display:none"}">
        <label>Number of months</label>
        <input type="number" id="f-months" value="${c.personalized_months || ""}">
      </div>
    </div>

    <div id="regular-pricing-block" style="${c.program_type === "regular" ? "" : "display:none"}">
      <p style="font-size:12px;color:var(--ink-soft);margin:-6px 0 10px;">
        RAFA is ${fmtMoney(state.settings.price_per_child)} per child — the total
        below is calculated automatically from the children listed above. Paying
        the full amount at once moves this card to Closed – Paid in Full;
        paying part of it moves it to Closed – Payment Plan.
      </p>
      <div class="form-row">
        <label>Total amount owed (₦)</label>
        <input type="text" id="computed-total-display" readonly>
      </div>
    </div>
    <div id="personalized-pricing-block" style="${c.program_type === "personalized" ? "" : "display:none"}">
      <p style="font-size:12px;color:var(--ink-soft);margin:-6px 0 10px;">
        Priced by hand — enter the total you agreed on. Recording the first
        payment moves this card to Closed – Personalized Coaching automatically;
        payments are tracked roughly every 30 days after that.
      </p>
      <div class="form-row">
        <label>Total amount agreed (₦)</label>
        <input type="number" id="f-amount-total" value="${c.amount_total ?? 0}">
      </div>
    </div>

    <div class="amount-summary">
      ${c.payment_not_recorded ? `<p style="color:var(--danger);font-weight:600;margin:0 0 8px;">⚠️ No payment has been recorded yet — please enter what they've paid.</p>` : ""}
      ${c.stage === "closed_paid_full" ? `
      <div>Paid in full: <b>${fmtMoney(c.amount_total)}</b></div>
      ` : `
      <div>
        Paid so far: <b>${fmtMoney(c.amount_paid)}</b> &nbsp;·&nbsp;
        Remaining: <b>${fmtMoney((c.amount_total || 0) - (c.amount_paid || 0))}</b>
        ${id ? `<button class="btn btn-small" id="record-payment-btn" type="button" style="float:right;">Record payment</button>` : ""}
      </div>
      ${id ? `
      <div id="record-payment-form" hidden style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
        <div class="form-row">
          <label>Amount received (₦)</label>
          <input type="number" id="f-payment-amount" placeholder="e.g. 30000">
        </div>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:10px;">
          <input type="checkbox" id="f-advance-installment" style="width:auto;" checked>
          Set next payment due ${state.settings.installment_gap_days || 30} days from today
        </label>
        <button class="btn btn-primary btn-small" id="confirm-payment-btn" type="button">Add payment</button>
        <button class="btn btn-small" id="cancel-payment-btn" type="button">Cancel</button>
      </div>` : ""}
      `}
    </div>

    <div class="section-title">Dates</div>
    <div class="form-grid">
      <div class="form-row" id="followup-row" style="${c.stage === "closed_payment_plan" ? "display:none" : ""}">
        <label>Follow-up due</label>
        <input type="date" id="f-followup" value="${c.follow_up_due || ""}">
      </div>
      <div class="form-row" id="next-payment-row" style="${["closed_payment_plan", "closed_personalized"].includes(c.stage) ? "" : "display:none"}">
        <label>Next payment due</label>
        <input type="date" id="f-next-payment" value="${c.next_payment_due || ""}">
      </div>
    </div>
    <p id="payment-plan-note" style="font-size:12px;color:var(--ink-soft);margin:-8px 0 10px;${c.stage === "closed_payment_plan" ? "" : "display:none"}">
      No follow-up needed once someone is on a payment plan — we track the next payment date instead.
    </p>

    <div class="form-row" id="lost-reason-row" style="${c.stage === "closed_lost" ? "" : "display:none"}">
      <label>Reason lost</label>
      <input type="text" id="f-lost-reason" value="${escapeHtml(c.closed_lost_reason || "")}">
    </div>

    <div class="form-row">
      <label>Notes</label>
      <textarea id="f-notes" rows="3">${escapeHtml(c.notes || "")}</textarea>
    </div>

    <div class="modal-actions">
      <div>${id ? `<button class="btn btn-danger" id="delete-contact-btn" type="button">Delete</button>` : ""}</div>
      <div class="modal-actions-right">
        <button class="btn" id="cancel-modal-btn" type="button">Cancel</button>
        <button class="btn btn-primary" id="save-contact-btn" type="button">Save</button>
      </div>
    </div>
  `;

  function updateComputedTotal() {
    const display = document.getElementById("computed-total-display");
    if (!display) return;
    const n = collectChildNames().map((s) => s.trim()).filter(Boolean).length;
    const price = Number(state.settings.price_per_child) || 0;
    display.value = `${fmtMoney(n * price)}  (${n} × ${fmtMoney(price)})`;
  }

  renderChildrenRows(c.children.map((ch) => ch.name), updateComputedTotal);
  document.getElementById("children-list").addEventListener("input", updateComputedTotal);
  updateComputedTotal();

  document.getElementById("add-child-btn").addEventListener("click", () => {
    const names = collectChildNames();
    names.push("");
    renderChildrenRows(names, updateComputedTotal);
    updateComputedTotal();
  });

  document.getElementById("f-program-type").addEventListener("change", (e) => {
    const isPersonalized = e.target.value === "personalized";
    document.getElementById("months-row").style.display = isPersonalized ? "" : "none";
    document.getElementById("regular-pricing-block").style.display = isPersonalized ? "none" : "";
    document.getElementById("personalized-pricing-block").style.display = isPersonalized ? "" : "none";
  });
  document.getElementById("f-stage").addEventListener("change", (e) => {
    const stage = e.target.value;
    const needsNextPayment = ["closed_payment_plan", "closed_personalized"].includes(stage);
    document.getElementById("next-payment-row").style.display = needsNextPayment ? "" : "none";
    document.getElementById("lost-reason-row").style.display = stage === "closed_lost" ? "" : "none";
    document.getElementById("followup-row").style.display = stage === "closed_payment_plan" ? "none" : "";
    document.getElementById("payment-plan-note").style.display = stage === "closed_payment_plan" ? "" : "none";
  });

  document.getElementById("cancel-modal-btn").addEventListener("click", closeModal);
  document.getElementById("save-contact-btn").addEventListener("click", () => saveContact(id));

  const delBtn = document.getElementById("delete-contact-btn");
  if (delBtn) {
    delBtn.addEventListener("click", async () => {
      if (delBtn.dataset.armed === "1") {
        await api(`/api/contacts/${id}`, { method: "DELETE" });
        closeModal();
        await refreshAll();
      } else {
        delBtn.dataset.armed = "1";
        delBtn.textContent = "Click again to confirm delete";
      }
    });
  }

  const payBtn = document.getElementById("record-payment-btn");
  if (payBtn) {
    payBtn.addEventListener("click", () => {
      document.getElementById("record-payment-form").hidden = false;
      payBtn.hidden = true;
      document.getElementById("f-payment-amount").focus();
    });
  }
  const cancelPayBtn = document.getElementById("cancel-payment-btn");
  if (cancelPayBtn) {
    cancelPayBtn.addEventListener("click", () => {
      document.getElementById("record-payment-form").hidden = true;
      payBtn.hidden = false;
    });
  }
  const confirmPayBtn = document.getElementById("confirm-payment-btn");
  if (confirmPayBtn) {
    confirmPayBtn.addEventListener("click", async () => {
      const errEl = document.getElementById("f-payment-amount");
      const n = Number(errEl.value);
      if (!n || n <= 0) {
        errEl.style.borderColor = "var(--danger)";
        errEl.focus();
        return;
      }
      const advanceEl = document.getElementById("f-advance-installment");
      const advance = advanceEl ? advanceEl.checked : false;
      await api(`/api/contacts/${id}/payment`, { method: "POST", body: { amount: n, advance_installment: advance } });
      await refreshAll();
      openContactModal(id);
    });
  }

  document.getElementById("modal-backdrop").hidden = false;
}

function renderChildrenRows(names, onChange) {
  const list = document.getElementById("children-list");
  list.innerHTML = "";
  names.forEach((name, i) => {
    const row = document.createElement("div");
    row.className = "child-row";
    row.innerHTML = `
      <input type="text" data-idx="${i}" class="child-name-input" placeholder="Child's name" value="${escapeHtml(name)}">
      <button class="btn btn-small btn-danger" type="button" data-remove="${i}">✕</button>
    `;
    list.appendChild(row);
  });
  list.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.remove);
      const names2 = collectChildNames();
      names2.splice(idx, 1);
      renderChildrenRows(names2, onChange);
      if (onChange) onChange();
    });
  });
}

function collectChildNames() {
  return Array.from(document.querySelectorAll(".child-name-input")).map((i) => i.value);
}

function closeModal() {
  document.getElementById("modal-backdrop").hidden = true;
  state.openContactId = null;
  if (location.hash.startsWith("#contact=")) history.replaceState(null, "", location.pathname);
}

document.getElementById("modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "modal-backdrop") closeModal();
});

async function saveContact(id) {
  const children = collectChildNames()
    .map((n) => n.trim())
    .filter(Boolean)
    .map((name) => ({ name }));

  const body = {
    name: document.getElementById("f-name").value.trim(),
    email: document.getElementById("f-email").value.trim(),
    phone: document.getElementById("f-phone").value.trim(),
    stage: document.getElementById("f-stage").value,
    hot: document.getElementById("f-hot").checked,
    program_type: document.getElementById("f-program-type").value,
    personalized_months: document.getElementById("f-months").value || null,
    amount_total: document.getElementById("f-amount-total").value || 0,
    follow_up_due: document.getElementById("f-followup").value || null,
    next_payment_due: document.getElementById("f-next-payment").value || null,
    closed_lost_reason: document.getElementById("f-lost-reason").value.trim(),
    notes: document.getElementById("f-notes").value.trim(),
    children,
  };

  if (!body.name) {
    alert("Name is required");
    return;
  }

  if (id) {
    await api(`/api/contacts/${id}`, { method: "PUT", body });
  } else {
    await api("/api/contacts", { method: "POST", body });
  }
  closeModal();
  await refreshAll();
}

// --------------------------------------------------------- Dashboard ----

function toggleCard(id) {
  const el = document.getElementById(id);
  el.hidden = !el.hidden;
}

function renderDashboard() {
  api("/api/dashboard").then((d) => {
    const kpiRow = document.getElementById("kpi-row");
    kpiRow.innerHTML = `
      <div class="kpi kpi-clickable" id="kpi-received"><div class="kpi-value">${fmtMoney(d.total_received)}</div><div class="kpi-label">Total received &mdash; click for who</div></div>
      <div class="kpi kpi-clickable" id="kpi-outstanding"><div class="kpi-value">${fmtMoney(d.total_outstanding)}</div><div class="kpi-label">Outstanding / pending &mdash; click for who</div></div>
      <div class="kpi"><div class="kpi-value">${d.follow_ups_due.length}</div><div class="kpi-label">Follow-ups due</div></div>
      <div class="kpi"><div class="kpi-value">${d.payments_due.length}</div><div class="kpi-label">Payments due</div></div>
      <div class="kpi"><div class="kpi-value">${d.unrecorded_payments.length}</div><div class="kpi-label">Payments not recorded</div></div>
      <div class="kpi"><div class="kpi-value">${d.total_contacts}</div><div class="kpi-label">Total contacts</div></div>
    `;

    document.getElementById("kpi-received").addEventListener("click", () => {
      toggleCard("received-payments-card");
    });
    document.getElementById("kpi-outstanding").addEventListener("click", () => {
      toggleCard("outstanding-payments-card");
    });

    const oEl = document.getElementById("outstanding-payments");
    oEl.innerHTML = "";
    if (d.outstanding_payments.length === 0) {
      oEl.innerHTML = `<div class="due-empty">Nobody has an outstanding balance.</div>`;
    }
    d.outstanding_payments.forEach((item) => {
      const row = document.createElement("div");
      row.className = "due-list-item";
      row.innerHTML = `<span>${escapeHtml(item.name)}</span><span>${fmtMoney(item.amount_remaining)} owed</span>`;
      row.addEventListener("click", () => goToContact(item.id));
      oEl.appendChild(row);
    });

    const rEl = document.getElementById("received-payments");
    rEl.innerHTML = "";
    if (d.received_payments.length === 0) {
      rEl.innerHTML = `<div class="due-empty">No payments received yet.</div>`;
    }
    d.received_payments.forEach((item) => {
      const row = document.createElement("div");
      row.className = "due-list-item";
      row.innerHTML = `<span>${escapeHtml(item.name)}</span><span>${fmtMoney(item.amount_paid)} paid</span>`;
      row.addEventListener("click", () => goToContact(item.id));
      rEl.appendChild(row);
    });

    const fEl = document.getElementById("followups-due");
    fEl.innerHTML = "";
    if (d.follow_ups_due.length === 0) {
      fEl.innerHTML = `<div class="due-empty">Nothing due — you're all caught up.</div>`;
    }
    d.follow_ups_due.forEach((item) => {
      const row = document.createElement("div");
      row.className = "due-list-item";
      row.innerHTML = `<span>${item.overdue ? "⚠️ " : ""}${escapeHtml(item.name)}</span><span>${fmtDate(item.follow_up_due)}</span>`;
      row.addEventListener("click", () => goToContact(item.id));
      fEl.appendChild(row);
    });

    const pEl = document.getElementById("payments-due");
    pEl.innerHTML = "";
    if (d.payments_due.length === 0) {
      pEl.innerHTML = `<div class="due-empty">No payments due soon.</div>`;
    }
    d.payments_due.forEach((item) => {
      const row = document.createElement("div");
      row.className = "due-list-item";
      row.innerHTML = `<span>${item.overdue ? "⚠️ " : ""}${escapeHtml(item.name)} — ${fmtMoney(item.amount_remaining)} left</span><span>${fmtDate(item.next_payment_due)}</span>`;
      row.addEventListener("click", () => goToContact(item.id));
      pEl.appendChild(row);
    });

    const uEl = document.getElementById("unrecorded-payments");
    uEl.innerHTML = "";
    if (d.unrecorded_payments.length === 0) {
      uEl.innerHTML = `<div class="due-empty">Nothing flagged.</div>`;
    }
    d.unrecorded_payments.forEach((item) => {
      const row = document.createElement("div");
      row.className = "due-list-item";
      row.innerHTML = `<span>⚠️ ${escapeHtml(item.name)}</span><span>${escapeHtml(item.phone || "")}</span>`;
      row.addEventListener("click", () => goToContact(item.id));
      uEl.appendChild(row);
    });

    const sb = document.getElementById("stage-breakdown");
    sb.innerHTML = "";
    state.stages.forEach((s) => {
      const chip = document.createElement("div");
      chip.className = "stage-chip";
      chip.innerHTML = `<b>${d.stage_counts[s.key] || 0}</b>${s.label}`;
      sb.appendChild(chip);
    });
  });
}

function goToContact(id) {
  setView("board");
  document.querySelector('.tab-btn[data-view="board"]').classList.add("active");
  document.querySelector('.tab-btn[data-view="dashboard"]').classList.remove("active");
  state.openContactId = id;
  renderBoard();
  openContactModal(id);
}

// -------------------------------------------------------------- Settings ----

function renderSettings() {
  document.getElementById("s-price-per-child").value = state.settings.price_per_child || 50000;
  document.getElementById("s-followup-window").value = state.settings.follow_up_window_days || 2;
  document.getElementById("s-payment-window").value = state.settings.payment_due_window_days || 2;
  document.getElementById("s-installments").value = state.settings.installments_total_default || 3;
  document.getElementById("s-installment-gap").value = state.settings.installment_gap_days || 30;
}

document.getElementById("save-settings-btn").addEventListener("click", async () => {
  const body = {
    price_per_child: document.getElementById("s-price-per-child").value,
    follow_up_window_days: document.getElementById("s-followup-window").value,
    payment_due_window_days: document.getElementById("s-payment-window").value,
    installments_total_default: document.getElementById("s-installments").value,
    installment_gap_days: document.getElementById("s-installment-gap").value,
  };
  await api("/api/settings", { method: "PUT", body });
  state.settings = { ...state.settings, ...body };
  document.getElementById("settings-msg").style.color = "var(--ok)";
  document.getElementById("settings-msg").textContent = "Saved.";
  setTimeout(() => (document.getElementById("settings-msg").textContent = ""), 2000);
});

// ----------------------------------------------------------------- Hash ----

function handleHashRoute() {
  const m = location.hash.match(/#contact=(\d+)/);
  if (m) goToContact(Number(m[1]));
}
window.addEventListener("hashchange", handleHashRoute);

boot();
