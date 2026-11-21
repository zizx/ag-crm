const DEFAULT_ORG_ID = "org_default";

const state = {
  contacts: [],
  companies: [],
  selectedContactId: null,
  selectedCompanyId: null,
  search: "",
  companySearch: "",
  reviewOnly: false,
  companyReviewOnly: false,
  includeDeleted: false,
  companyIncludeDeleted: false,
  contactSort: "updated_at",
  view: "contacts",
  totalActiveContacts: 0,
  totalActiveCompanies: 0,
  totalDeletedContacts: 0,
  selectedContactIds: new Set(),
  selectedCompanyIds: new Set()
};

const els = {
  contactsView: document.querySelector("#contactsView"),
  companiesView: document.querySelector("#companiesView"),
  navItems: document.querySelectorAll(".nav-item[data-view]"),
  healthStatus: document.querySelector("#healthStatus"),
  healthMeta: document.querySelector("#healthMeta"),
  statusDot: document.querySelector(".status-dot"),
  searchInput: document.querySelector("#searchInput"),
  contactSortSelect: document.querySelector("#contactSortSelect"),
  refreshContacts: document.querySelector("#refreshContacts"),
  reviewFilter: document.querySelector("#reviewFilter"),
  includeDeletedFilter: document.querySelector("#includeDeletedFilter"),
  restoreDeletedContacts: document.querySelector("#restoreDeletedContacts"),
  deleteSelectedContacts: document.querySelector("#deleteSelectedContacts"),
  selectAllContacts: document.querySelector("#selectAllContacts"),
  archivedBanner: document.querySelector("#archivedBanner"),
  contactList: document.querySelector("#contactList"),
  contactCount: document.querySelector("#contactCount"),
  detailPanel: document.querySelector("#detailPanel"),
  companySearchInput: document.querySelector("#companySearchInput"),
  companyReviewFilter: document.querySelector("#companyReviewFilter"),
  companyIncludeDeletedFilter: document.querySelector("#companyIncludeDeletedFilter"),
  refreshCompanies: document.querySelector("#refreshCompanies"),
  companyList: document.querySelector("#companyList"),
  companyCount: document.querySelector("#companyCount"),
  companyDetailPanel: document.querySelector("#companyDetailPanel"),
  contactItemTemplate: document.querySelector("#contactItemTemplate"),
  leadModal: document.querySelector("#leadModal"),
  leadForm: document.querySelector("#leadForm"),
  openLeadForm: document.querySelector("#openLeadForm"),
  closeLeadForm: document.querySelector("#closeLeadForm"),
  cancelLeadForm: document.querySelector("#cancelLeadForm"),
  exportSelectedGhl: document.querySelector("#exportSelectedGhl"),
  ghlModal: document.querySelector("#ghlModal"),
  ghlForm: document.querySelector("#ghlForm"),
  ghlExportCount: document.querySelector("#ghlExportCount"),
  ghlTokenInput: document.querySelector("#ghlTokenInput"),
  ghlLocationInput: document.querySelector("#ghlLocationInput"),
  ghlSaveDefault: document.querySelector("#ghlSaveDefault"),
  ghlResults: document.querySelector("#ghlResults"),
  ghlLocationOptions: document.querySelector("#ghlLocationOptions"),
  ghlSubmit: document.querySelector("#ghlSubmit"),
  closeGhlForm: document.querySelector("#closeGhlForm"),
  cancelGhlForm: document.querySelector("#cancelGhlForm")
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.errors?.join(" ") || body.error || "Request failed.";
    throw new Error(message);
  }
  return body;
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function sourceDomain(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function initials(name = "") {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
  return letters || "?";
}

function formatDate(value) {
  if (!value) return "No date";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  }).format(new Date(value));
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function truncateUrl(url = "", max = 56) {
  if (!url) return "";
  if (url.length <= max) return url;
  return `${url.slice(0, max - 1)}…`;
}

function renderSourceLink(source) {
  if (!source?.url) return "No source";
  const label = truncateUrl(source.url);
  return `<a class="source-link" href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer" title="${escapeHtml(source.url)}">${escapeHtml(label)}</a>`;
}

function renderReviewBadge(contact) {
  const status = contact.data_review_status || "unreviewed";
  if (status === "confirmed" && contact.data_reviewed_at) {
    return `<span class="review-badge confirmed">Reviewed</span>`;
  }
  if (status === "pending") {
    return `<span class="review-badge pending">Review</span>`;
  }
  return `<span class="review-badge unreviewed">Not reviewed</span>`;
}

function renderCaptureWarnings(contact) {
  const warnings = contact.capture_metadata?.validation_warnings || [];
  if (!warnings.length) return "";
  const summary = warnings.join(" · ");
  return `<p class="capture-warnings" title="${escapeHtml(summary)}">${escapeHtml(summary)}</p>`;
}

function renderFileList(files = []) {
  if (!files.length) return '<p class="timeline-meta">No attachments yet.</p>';
  return files
    .map(
      (file) =>
        `<div class="timeline-item"><strong>${escapeHtml(file.filename || "Attachment")}</strong><p>${escapeHtml(file.kind || "file")}${file.size_bytes ? ` · ${Math.round(file.size_bytes / 1024)} KB` : ""}</p><a href="/api/files/${escapeHtml(file.id)}/download" target="_blank" rel="noreferrer">Open PDF</a></div>`
    )
    .join("");
}

function toast(message, type = "info") {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), 3200);
}

async function checkHealth() {
  try {
    const result = await api("/api/health");
    els.healthStatus.textContent = "API online";
    state.totalActiveContacts = result.counts.people ?? result.counts.contacts ?? 0;
    state.totalActiveCompanies = result.counts.company_profiles || 0;
    state.totalDeletedContacts = result.counts.contacts_deleted || 0;
    const peopleLabel = `${state.totalActiveContacts} people`;
    const companiesLabel = state.totalActiveCompanies ? ` · ${state.totalActiveCompanies} companies` : "";
    const archivedLabel = state.totalDeletedContacts > 0 ? ` · ${state.totalDeletedContacts} archived` : "";
    els.healthMeta.textContent = `${peopleLabel}${companiesLabel}${archivedLabel}`;
    els.statusDot.classList.add("ok");
  } catch {
    els.healthStatus.textContent = "API offline";
    els.healthMeta.textContent = "Start npm run dev";
    els.statusDot.classList.remove("ok");
  }
}

let dedupeRan = false;

async function maybeDedupeContacts() {
  try {
    const result = await api("/api/contacts/dedupe", {
      method: "POST",
      body: JSON.stringify({ org_id: DEFAULT_ORG_ID, actor_type: "human" })
    });
    if ((result.merged || 0) > 0) {
      toast(`Merged ${result.merged} duplicate contact${result.merged === 1 ? "" : "s"}.`);
      await checkHealth();
    }
    dedupeRan = true;
    return result;
  } catch {
    dedupeRan = true;
    return { merged: 0 };
  }
}

async function loadContacts() {
  if (!dedupeRan) {
    await maybeDedupeContacts();
  }
  const params = new URLSearchParams();
  params.set("record_kind", "person");
  if (state.search) params.set("q", state.search);
  if (state.reviewOnly) params.set("review_status", "pending");
  if (state.includeDeleted) params.set("include_deleted", "1");
  if (state.contactSort) params.set("sort_by", state.contactSort);
  const result = await api(`/api/contacts?${params.toString()}`);
  state.contacts = result.contacts;
  if (state.selectedContactId && !state.contacts.some((contact) => contact.id === state.selectedContactId)) {
    state.selectedContactId = null;
  }
  renderContacts();
  renderArchivedBanner();
  if (state.view === "contacts") {
    if (state.selectedContactId) {
      await loadContactDetail(state.selectedContactId, els.detailPanel, "person");
    } else {
      renderEmptyDetail(els.detailPanel, "person");
    }
  }
}

async function loadCompanies() {
  if (!dedupeRan) {
    await maybeDedupeContacts();
  }
  const params = new URLSearchParams();
  params.set("record_kind", "company");
  if (state.companySearch) params.set("q", state.companySearch);
  if (state.companyReviewOnly) params.set("review_status", "pending");
  if (state.companyIncludeDeleted) params.set("include_deleted", "1");
  const result = await api(`/api/contacts?${params.toString()}`);
  state.companies = result.contacts;
  if (state.selectedCompanyId && !state.companies.some((company) => company.id === state.selectedCompanyId)) {
    state.selectedCompanyId = null;
  }
  renderCompanies();
  if (state.view === "companies") {
    if (state.selectedCompanyId) {
      await loadContactDetail(state.selectedCompanyId, els.companyDetailPanel, "company");
    } else {
      renderEmptyDetail(els.companyDetailPanel, "company");
    }
  }
}

async function loadActiveView() {
  if (state.view === "companies") {
    await loadCompanies();
    return;
  }
  if (state.view === "contacts") {
    await loadContacts();
  }
}

function renderArchivedBanner() {
  if (!els.archivedBanner) return;
  if (state.totalDeletedContacts > 0 && !state.includeDeleted) {
    els.archivedBanner.className = "archived-banner";
    els.archivedBanner.innerHTML = `
      <strong>${state.totalDeletedContacts} archived lead${state.totalDeletedContacts === 1 ? "" : "s"} hidden.</strong>
      These were removed from the list but are still in your database.
      <button class="link-button" type="button" id="archivedBannerRestore">Restore all archived</button>
      or
      <button class="link-button" type="button" id="archivedBannerShow">show archived in list</button>.
    `;
    els.archivedBanner.querySelector("#archivedBannerRestore")?.addEventListener("click", () => {
      restoreArchivedContacts().catch((error) => toast(error.message, "error"));
    });
    els.archivedBanner.querySelector("#archivedBannerShow")?.addEventListener("click", () => {
      state.includeDeleted = true;
      els.includeDeletedFilter.checked = true;
      loadContacts().catch((error) => toast(error.message, "error"));
    });
    return;
  }
  els.archivedBanner.className = "archived-banner hidden";
  els.archivedBanner.textContent = "";
}

async function restoreArchivedContacts() {
  const count = state.totalDeletedContacts;
  if (!count) {
    toast("No archived contacts to restore.");
    return;
  }
  const confirmed = window.confirm(
    `Restore ${count} archived contact${count === 1 ? "" : "s"} back to the main list?\n\nThey were archived, not permanently erased.`
  );
  if (!confirmed) return;
  const result = await api("/api/contacts/restore-deleted", {
    method: "POST",
    body: JSON.stringify({ org_id: DEFAULT_ORG_ID, actor_type: "human", scope: "all" })
  });
  toast(`Restored ${result.restored || 0} archived contacts.`);
  state.includeDeleted = false;
  els.includeDeletedFilter.checked = false;
  await checkHealth();
  await loadActiveView();
}

function updateBulkDeleteControls(kind = "person") {
  if (kind !== "person" || !els.deleteSelectedContacts) return;
  const selected = state.selectedContactIds;
  els.deleteSelectedContacts.disabled = selected.size === 0;
  els.deleteSelectedContacts.textContent = selected.size ? `Delete selected (${selected.size})` : "Delete selected";
  if (els.exportSelectedGhl) {
    els.exportSelectedGhl.disabled = selected.size === 0;
    els.exportSelectedGhl.textContent = selected.size
      ? `Export to GoHighLevel (${selected.size})`
      : "Export to GoHighLevel";
  }
  if (els.selectAllContacts) {
    const activeIds = state.contacts.filter((r) => !r.deleted_at).map((r) => r.id);
    els.selectAllContacts.checked = activeIds.length > 0 && activeIds.every((id) => selected.has(id));
    els.selectAllContacts.indeterminate =
      selected.size > 0 && activeIds.some((id) => selected.has(id)) && !els.selectAllContacts.checked;
  }
}

async function deleteSelectedRecords(kind = "person") {
  const selected = kind === "company" ? state.selectedCompanyIds : state.selectedContactIds;
  const ids = [...selected];
  if (!ids.length) return;
  const label = kind === "company" ? "companies" : "people";
  if (
    !window.confirm(
      `Archive ${ids.length} selected ${label}?\n\nThey are hidden from lists but can be restored later.`
    )
  ) {
    return;
  }
  const result = await api("/api/contacts/bulk-delete", {
    method: "POST",
    body: JSON.stringify({
      org_id: DEFAULT_ORG_ID,
      actor_type: "human",
      contact_ids: ids
    })
  });
  if (kind === "company") state.selectedCompanyIds.clear();
  else state.selectedContactIds.clear();
  toast(`Archived ${result.deleted || 0} selected ${label}.`);
  await checkHealth();
  await loadActiveView();
}

async function openGhlExportModal() {
  const ids = [...state.selectedContactIds];
  if (!ids.length) {
    toast("Select contacts to export first.");
    return;
  }
  els.ghlResults.className = "ghl-results hidden";
  els.ghlResults.innerHTML = "";
  els.ghlTokenInput.value = "";
  els.ghlExportCount.textContent = `${ids.length} selected contact${ids.length === 1 ? "" : "s"} will be pushed to GoHighLevel as upserts (matched by email/phone).`;
  els.ghlModal.showModal();
  try {
    const settings = await api("/api/integrations/gohighlevel");
    els.ghlTokenInput.placeholder = settings.configured
      ? `Saved token ${settings.token_preview} — leave blank to keep it`
      : "pit-…";
    if (!els.ghlLocationInput.value) {
      els.ghlLocationInput.value = settings.default_location_id || "";
    }
    if (els.ghlLocationOptions) {
      els.ghlLocationOptions.innerHTML = (settings.locations || [])
        .map((location) => `<option value="${location.id}">${location.label || location.id}</option>`)
        .join("");
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

async function submitGhlExport(event) {
  event.preventDefault();
  const ids = [...state.selectedContactIds];
  if (!ids.length) {
    toast("No contacts selected.");
    els.ghlModal.close();
    return;
  }
  const token = els.ghlTokenInput.value.trim();
  const locationId = els.ghlLocationInput.value.trim();
  if (!locationId) {
    toast("Enter the GoHighLevel sub-account (location) ID.", "error");
    return;
  }
  els.ghlSubmit.disabled = true;
  els.ghlSubmit.textContent = "Exporting…";
  try {
    const settingsPayload = {};
    if (token) settingsPayload.private_integration_token = token;
    if (els.ghlSaveDefault.checked) settingsPayload.default_location_id = locationId;
    if (Object.keys(settingsPayload).length) {
      await api("/api/integrations/gohighlevel", { method: "POST", body: JSON.stringify(settingsPayload) });
    }

    const result = await api("/api/integrations/gohighlevel/push", {
      method: "POST",
      body: JSON.stringify({ org_id: DEFAULT_ORG_ID, contact_ids: ids, location_id: locationId })
    });

    const summary = result.summary || {};
    const rows = (result.results || [])
      .map((row) => {
        const label = row.name || row.contact_id;
        const detail = row.status === "failed" || row.status === "skipped" ? ` — ${row.error || ""}` : "";
        return `<li class="ghl-result ${row.status}"><span>${label}</span><span>${row.status}${detail}</span></li>`;
      })
      .join("");
    els.ghlResults.className = "ghl-results";
    els.ghlResults.innerHTML = `
      <strong>Pushed ${summary.pushed || 0} · Skipped ${summary.skipped || 0} · Failed ${summary.failed || 0}</strong>
      <ul>${rows}</ul>
    `;
    toast(`GoHighLevel: ${summary.pushed || 0} pushed, ${summary.skipped || 0} skipped, ${summary.failed || 0} failed.`);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    els.ghlSubmit.disabled = false;
    els.ghlSubmit.textContent = "Export";
  }
}

function renderRecordList({
  records,
  listEl,
  countEl,
  selectedId,
  totalActive,
  searchActive,
  reviewOnly,
  includeDeleted,
  kind,
  onSelect,
  selectionSet,
  onToggleSelect
}) {
  listEl.innerHTML = "";
  const visibleActive = records.filter((record) => !record.deleted_at).length;
  const visibleArchived = records.filter((record) => record.deleted_at).length;
  if (includeDeleted && visibleArchived > 0) {
    countEl.textContent = `${visibleActive} active · ${visibleArchived} archived`;
  } else if (searchActive || reviewOnly) {
    countEl.textContent = totalActive > visibleActive ? `${visibleActive} of ${totalActive}` : String(visibleActive);
  } else {
    countEl.textContent = String(totalActive || visibleActive);
  }
  if (!records.length) {
    listEl.innerHTML =
      kind === "company"
        ? '<div class="empty-state"><h3>No company profiles yet</h3><p>Business and firm pages captured by the extension appear here.</p></div>'
        : '<div class="empty-state"><h3>No people yet</h3><p>Add a person manually or capture from the browser extension.</p></div>';
    return;
  }

  for (const record of records) {
    const node = els.contactItemTemplate.content.firstElementChild.cloneNode(true);
    const itemButton = node.querySelector(".contact-item");
    const checkbox = node.querySelector(".contact-select");
    node.dataset.contactId = record.id;
    itemButton.classList.toggle("active", record.id === selectedId);
    itemButton.classList.toggle("archived", Boolean(record.deleted_at));
    itemButton.classList.toggle("company-item", kind === "company");
    if (checkbox && selectionSet) {
      checkbox.checked = selectionSet.has(record.id);
      checkbox.disabled = Boolean(record.deleted_at);
      checkbox.addEventListener("click", (event) => event.stopPropagation());
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectionSet.add(record.id);
        else selectionSet.delete(record.id);
        onToggleSelect?.();
      });
    }
    itemButton.querySelector(".contact-avatar").textContent = initials(record.name);
    itemButton.querySelector(".contact-name").textContent =
      record.name || record.emails[0] || record.phones[0] || (kind === "company" ? "Unnamed company" : "Unnamed person");
    itemButton.querySelector(".contact-meta").textContent =
      kind === "company"
        ? [record.company?.name, record.address, record.phones[0], record.website].filter(Boolean).join(" · ")
        : [record.company?.name, record.city, record.title, record.emails[0], record.phones[0]].filter(Boolean).join(" · ");
    itemButton.querySelector(".contact-tags").innerHTML = [
      record.deleted_at ? `<span class="tag archived-tag">Archived</span>` : "",
      kind === "company" ? `<span class="tag company-tag">Company</span>` : "",
      record.data_review_status === "pending"
        ? `<span class="tag review-tag" title="Needs manual review">Review</span>`
        : record.data_review_status === "confirmed" && record.data_reviewed_at
          ? `<span class="tag review-tag confirmed-tag">Reviewed</span>`
          : "",
      ...record.tags.slice(0, 2).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    ]
      .filter(Boolean)
      .join("");
    itemButton.addEventListener("click", () => onSelect(record.id));
    listEl.append(node);
  }
  onToggleSelect?.();
}

function renderContacts() {
  renderRecordList({
    records: state.contacts,
    listEl: els.contactList,
    countEl: els.contactCount,
    selectedId: state.selectedContactId,
    totalActive: state.totalActiveContacts,
    searchActive: Boolean(state.search),
    reviewOnly: state.reviewOnly,
    includeDeleted: state.includeDeleted,
    kind: "person",
    selectionSet: state.selectedContactIds,
    onToggleSelect: () => updateBulkDeleteControls("person"),
    onSelect: (contactId) => {
      state.selectedContactId = contactId;
      renderContacts();
      loadContactDetail(contactId, els.detailPanel, "person").catch((error) => toast(error.message, "error"));
    }
  });
}

function renderCompanies() {
  renderRecordList({
    records: state.companies,
    listEl: els.companyList,
    countEl: els.companyCount,
    selectedId: state.selectedCompanyId,
    totalActive: state.totalActiveCompanies,
    searchActive: Boolean(state.companySearch),
    reviewOnly: state.companyReviewOnly,
    includeDeleted: state.companyIncludeDeleted,
    kind: "company",
    onSelect: (companyId) => {
      state.selectedCompanyId = companyId;
      renderCompanies();
      loadContactDetail(companyId, els.companyDetailPanel, "company").catch((error) => toast(error.message, "error"));
    }
  });
}

function renderEmptyDetail(panel, kind = "person") {
  panel.innerHTML =
    kind === "company"
      ? `
    <div class="empty-state">
      <h3>Select a company</h3>
      <p>Company and firm profiles captured by the extension appear here, separate from people.</p>
    </div>
  `
      : `
    <div class="empty-state">
      <h3>Select a person</h3>
      <p>Open a lead to review notes, tasks, tags, source, and activity.</p>
    </div>
  `;
}

async function loadContactDetail(contactId, panel = els.detailPanel, kind = "person") {
  const result = await api(`/api/contacts/${contactId}`);
  renderContactDetail(result.contact, panel, kind);
}

function renderContactDetail(contact, panel = els.detailPanel, kind = "person") {
  const isCompany = kind === "company" || contact.record_kind === "company";
  const sourceLabel = renderSourceLink(contact.source);
  const reviewBadge = renderReviewBadge(contact);
  const warnings = renderCaptureWarnings(contact);
  const fileItems = renderFileList(contact.files || []);
  const noteItems = contact.notes.length
    ? contact.notes.map((note) => `<div class="timeline-item"><p>${escapeHtml(note.body)}</p><span class="timeline-meta">${formatDate(note.created_at)} · ${escapeHtml(note.created_by_actor_type)}</span></div>`).join("")
    : '<p class="timeline-meta">No notes yet.</p>';
  const taskItems = contact.tasks.length
    ? contact.tasks.map((task) => `<div class="timeline-item"><strong>${escapeHtml(task.title)}</strong><p>${escapeHtml(task.description || "")}</p><span class="timeline-meta">${formatDate(task.due_at)} · ${escapeHtml(task.status || "open")}</span></div>`).join("")
    : '<p class="timeline-meta">No tasks yet.</p>';
  const activityItems = contact.activities.length
    ? contact.activities.map((activity) => `<div class="timeline-item"><strong>${escapeHtml(activity.title)}</strong><p>${escapeHtml(activity.body || "")}</p><span class="timeline-meta">${formatDate(activity.occurred_at || activity.created_at)} · ${escapeHtml(activity.created_by_actor_type)}</span></div>`).join("")
    : '<p class="timeline-meta">No activity yet.</p>';

  panel.innerHTML = `
    <div class="detail-content">
      <div class="profile-block">
        <div class="profile-title">
          <div>
            <p class="eyebrow">${isCompany ? "Company profile" : escapeHtml(contact.created_by_actor_type)} · ${reviewBadge}</p>
            <h3>${escapeHtml(contact.name || (isCompany ? "Unnamed company" : "Unnamed person"))}</h3>
            <p class="contact-meta">${escapeHtml(
              isCompany
                ? [contact.company?.name, contact.address].filter(Boolean).join(" · ") || "No company details"
                : [contact.title, contact.company?.name].filter(Boolean).join(" · ") || "No company details"
            )}</p>
            ${warnings}
          </div>
          <div class="tag-row">
            ${isCompany ? `<span class="tag company-tag">Company profile</span>` : ""}
            ${contact.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
          </div>
        </div>
        <div class="review-actions">
          ${
            contact.data_review_status === "pending"
              ? `<button class="secondary-button review-confirm-button" type="button" data-action="confirm-review">Confirm reviewed</button>`
              : contact.data_review_status === "confirmed" && contact.data_reviewed_at
                ? `<button class="secondary-button" type="button" data-action="mark-pending">Mark needs review</button>`
                : `<button class="secondary-button review-confirm-button" type="button" data-action="confirm-review">Confirm reviewed</button>`
          }
        </div>
        <div class="field-grid">
          <div class="field"><span class="field-label">Email</span><span>${escapeHtml(contact.emails.join(", ") || "None")}</span></div>
          <div class="field"><span class="field-label">Phone</span><span>${escapeHtml(contact.phones.join(", ") || "None")}</span></div>
          <div class="field"><span class="field-label">City</span><span>${escapeHtml(contact.city || "None")}</span></div>
          <div class="field"><span class="field-label">Website</span><span>${contact.website ? `<a href="${escapeHtml(contact.website)}" target="_blank" rel="noreferrer">${escapeHtml(contact.website)}</a>` : "None"}</span></div>
          <div class="field"><span class="field-label">Address</span><span>${escapeHtml(contact.address || "None")}</span></div>
          <div class="field"><span class="field-label">Source</span><span>${sourceLabel}</span></div>
          <div class="field"><span class="field-label">Captured</span><span>${formatDate(contact.created_at)}</span></div>
        </div>
      </div>

      <div class="section-block">
        <div class="section-title"><h4>Attachments</h4></div>
        <div class="timeline">${fileItems}</div>
      </div>

      <div class="section-block">
        <div class="section-title"><h4>${isCompany ? "Edit Company Profile" : "Edit Contact"}</h4></div>
        <form class="edit-form" data-action="edit-contact">
          <div class="form-grid compact">
            <label>
              ${isCompany ? "Company name" : "Name"}
              <input name="name" value="${escapeHtml(contact.name || "")}" />
            </label>
            <label>
              ${isCompany ? "Branch / legal entity" : "Company"}
              <input name="company_name" value="${escapeHtml(contact.company?.name || "")}" />
            </label>
            ${isCompany ? "" : `<label>
              Title
              <input name="title" value="${escapeHtml(contact.title || "")}" />
            </label>`}
            <label>
              Email
              <input name="emails" value="${escapeHtml(contact.emails.join(", "))}" />
            </label>
            <label>
              Phone
              <input name="phones" value="${escapeHtml(contact.phones.join(", "))}" />
            </label>
            <label>
              City
              <input name="city" value="${escapeHtml(contact.city || "")}" />
            </label>
            <label>
              Website
              <input name="website" type="url" value="${escapeHtml(contact.website || "")}" />
            </label>
            <label>
              Address
              <input name="address" value="${escapeHtml(contact.address || "")}" />
            </label>
            <label>
              Tags
              <input name="tags" value="${escapeHtml(contact.tags.join(", "))}" />
            </label>
            <label class="wide">
              Source URL
              <input name="source_url" value="${escapeHtml(contact.source?.url || "")}" />
            </label>
          </div>
          <button class="secondary-button" type="submit">Save Changes</button>
        </form>
      </div>

      <div class="section-block">
        <div class="section-title"><h4>Add Note</h4></div>
        <form class="quick-form" data-action="note">
          <textarea name="body" rows="3" placeholder="Write a note"></textarea>
          <button class="secondary-button" type="submit">Save Note</button>
        </form>
      </div>

      <div class="section-block">
        <div class="section-title"><h4>Add Task</h4></div>
        <form class="quick-form inline" data-action="task">
          <input name="title" placeholder="Follow up" />
          <input name="due_at" type="date" />
          <button class="secondary-button" type="submit">Save Task</button>
        </form>
      </div>

      <div class="section-block">
        <div class="section-title"><h4>Notes</h4></div>
        <div class="timeline">${noteItems}</div>
      </div>

      <div class="section-block">
        <div class="section-title"><h4>Tasks</h4></div>
        <div class="timeline">${taskItems}</div>
      </div>

      <div class="section-block">
        <div class="section-title"><h4>Activity</h4></div>
        <div class="timeline">${activityItems}</div>
      </div>
    </div>
  `;

  const confirmReviewButton = panel.querySelector('[data-action="confirm-review"]');
  if (confirmReviewButton) {
    confirmReviewButton.addEventListener("click", async () => {
      await api(`/api/contacts/${contact.id}/review`, {
        method: "POST",
        body: JSON.stringify({
          org_id: DEFAULT_ORG_ID,
          actor_type: "human",
          status: "confirmed",
          note: "Confirmed from CRM UI."
        })
      });
      toast(isCompany ? "Company marked as reviewed." : "Contact marked as reviewed.");
      await loadActiveView();
    });
  }

  const markPendingButton = panel.querySelector('[data-action="mark-pending"]');
  if (markPendingButton) {
    markPendingButton.addEventListener("click", async () => {
      await api(`/api/contacts/${contact.id}/review`, {
        method: "POST",
        body: JSON.stringify({
          org_id: DEFAULT_ORG_ID,
          actor_type: "human",
          status: "pending",
          note: "Marked for review from CRM UI."
        })
      });
      toast(isCompany ? "Company marked as needs review." : "Contact marked as needs review.");
      await loadActiveView();
    });
  }

  panel.querySelector('[data-action="edit-contact"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const sourceUrl = String(form.get("source_url") || "").trim();
    await api(`/api/contacts/${contact.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        org_id: DEFAULT_ORG_ID,
        actor_type: "human",
        source: sourceUrl
          ? {
              url: sourceUrl,
              domain: sourceDomain(sourceUrl),
              platform: sourceDomain(sourceUrl),
              captured_at: contact.source?.captured_at || new Date().toISOString()
            }
          : undefined,
        contact: {
          name: form.get("name"),
          company_name: form.get("company_name"),
          title: form.get("title"),
          city: form.get("city"),
          emails: splitList(form.get("emails")),
          phones: splitList(form.get("phones")),
          website: form.get("website"),
          address: form.get("address"),
          tags: splitList(form.get("tags"))
        }
      })
    });
    toast(isCompany ? "Company updated." : "Contact updated.");
    await loadActiveView();
    await loadContactDetail(contact.id, panel, kind);
  });

  panel.querySelector('[data-action="note"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api("/api/notes", {
      method: "POST",
      body: JSON.stringify({
        org_id: DEFAULT_ORG_ID,
        actor_type: "human",
        contact_id: contact.id,
        body: form.get("body")
      })
    });
    toast("Note saved.");
    await loadContactDetail(contact.id, panel, kind);
  });

  panel.querySelector('[data-action="task"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        org_id: DEFAULT_ORG_ID,
        actor_type: "human",
        contact_id: contact.id,
        title: form.get("title"),
        due_at: form.get("due_at"),
        status: "open"
      })
    });
    toast("Task saved.");
    await loadContactDetail(contact.id, panel, kind);
  });
}

async function saveLead(event) {
  event.preventDefault();
  const form = new FormData(els.leadForm);
  const sourceUrl = String(form.get("source_url") || "").trim();
  const payload = {
    org_id: DEFAULT_ORG_ID,
    actor_type: "human",
    source: sourceUrl ? { url: sourceUrl, domain: sourceDomain(sourceUrl), platform: sourceDomain(sourceUrl) } : undefined,
    contact: {
      name: form.get("name"),
      company_name: form.get("company_name"),
      title: form.get("title"),
      city: form.get("city"),
      emails: splitList(form.get("email")),
      phones: splitList(form.get("phone")),
      website: form.get("website"),
      address: form.get("address"),
      tags: splitList(form.get("tags")),
      note: form.get("note"),
      record_kind: "person"
    }
  };
  const result = await api("/api/contacts/upsert", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  els.leadModal.close();
  els.leadForm.reset();
  state.selectedContactId = result.contact_id;
  toast(result.status === "created" ? "Person created." : "Person updated.");
  await checkHealth();
  await loadContacts();
}

function setView(view) {
  state.view = view;
  els.contactsView.classList.toggle("hidden", view !== "contacts");
  els.companiesView.classList.toggle("hidden", view !== "companies");
  for (const button of els.navItems) {
    button.classList.toggle("active", button.dataset.view === view);
  }
  if (view === "contacts") {
    loadContacts().catch((error) => toast(error.message, "error"));
  }
  if (view === "companies") {
    loadCompanies().catch((error) => toast(error.message, "error"));
  }
}

function bindEvents() {
  for (const button of els.navItems) {
    button.addEventListener("click", () => setView(button.dataset.view));
  }
  els.openLeadForm.addEventListener("click", () => els.leadModal.showModal());
  els.closeLeadForm.addEventListener("click", () => els.leadModal.close());
  els.cancelLeadForm.addEventListener("click", () => els.leadModal.close());
  els.leadForm.addEventListener("submit", (event) => saveLead(event).catch((error) => toast(error.message, "error")));
  els.reviewFilter.addEventListener("change", () => {
    state.reviewOnly = els.reviewFilter.checked;
    loadContacts().catch((error) => toast(error.message, "error"));
  });
  els.contactSortSelect?.addEventListener("change", () => {
    state.contactSort = els.contactSortSelect.value || "updated_at";
    loadContacts().catch((error) => toast(error.message, "error"));
  });
  els.includeDeletedFilter.addEventListener("change", () => {
    state.includeDeleted = els.includeDeletedFilter.checked;
    loadContacts().catch((error) => toast(error.message, "error"));
  });
  els.restoreDeletedContacts.addEventListener("click", () => {
    restoreArchivedContacts().catch((error) => toast(error.message, "error"));
  });
  els.deleteSelectedContacts?.addEventListener("click", () => {
    deleteSelectedRecords("person").catch((error) => toast(error.message, "error"));
  });
  els.exportSelectedGhl?.addEventListener("click", () => {
    openGhlExportModal().catch((error) => toast(error.message, "error"));
  });
  els.ghlForm?.addEventListener("submit", (event) => {
    submitGhlExport(event).catch((error) => toast(error.message, "error"));
  });
  els.closeGhlForm?.addEventListener("click", () => els.ghlModal.close());
  els.cancelGhlForm?.addEventListener("click", () => els.ghlModal.close());
  els.selectAllContacts?.addEventListener("change", () => {
    const active = state.contacts.filter((record) => !record.deleted_at);
    state.selectedContactIds.clear();
    if (els.selectAllContacts.checked) {
      for (const record of active) state.selectedContactIds.add(record.id);
    }
    renderContacts();
  });
  els.refreshContacts.addEventListener("click", async () => {
    dedupeRan = false;
    await checkHealth();
    await loadContacts().catch((error) => toast(error.message, "error"));
  });
  els.refreshCompanies.addEventListener("click", async () => {
    dedupeRan = false;
    await checkHealth();
    await loadCompanies().catch((error) => toast(error.message, "error"));
  });
  els.companyReviewFilter.addEventListener("change", () => {
    state.companyReviewOnly = els.companyReviewFilter.checked;
    loadCompanies().catch((error) => toast(error.message, "error"));
  });
  els.companyIncludeDeletedFilter.addEventListener("change", () => {
    state.companyIncludeDeleted = els.companyIncludeDeletedFilter.checked;
    loadCompanies().catch((error) => toast(error.message, "error"));
  });
  els.companySearchInput.addEventListener("input", () => {
    state.companySearch = els.companySearchInput.value;
    window.clearTimeout(els.companySearchInput._timer);
    els.companySearchInput._timer = window.setTimeout(() => {
      loadCompanies().catch((error) => toast(error.message, "error"));
    }, 180);
  });
  els.searchInput.addEventListener("input", () => {
    state.search = els.searchInput.value;
    window.clearTimeout(els.searchInput._timer);
    els.searchInput._timer = window.setTimeout(() => {
      loadContacts().catch((error) => toast(error.message, "error"));
    }, 180);
  });
}

bindEvents();
checkHealth()
  .then(() => loadContacts())
  .catch((error) => toast(error.message, "error"));

const initialView = new URLSearchParams(window.location.search).get("view");
if (initialView === "companies") {
  setView("companies");
}
