const state = {
  conversations: [],
  selectedId: null,
  currentDetail: null,
  roleFilter: "all",
  markdownMode: true,
  pendingFork: null, // { targetStepIdx?: number, messageIndex?: number, role?: string }
  pendingDelete: null, // { conversationId: string, title: string }
};

const els = {
  dataDirLabel: document.getElementById("data-dir-label"),
  refreshBtn: document.getElementById("refresh-btn"),
  searchInput: document.getElementById("search-input"),
  projectSelect: document.getElementById("project-select"),
  conversationList: document.getElementById("conversation-list"),
  emptyState: document.getElementById("empty-state"),
  detailView: document.getElementById("detail-view"),
  detailTitle: document.getElementById("detail-title"),
  detailId: document.getElementById("detail-id"),
  detailStatus: document.getElementById("detail-status"),
  detailProject: document.getElementById("detail-project"),
  detailCounts: document.getElementById("detail-counts"),
  deleteConvBtn: document.getElementById("delete-conv-btn"),
  forkFullBtn: document.getElementById("fork-full-btn"),
  toggleMdBtn: document.getElementById("toggle-md-btn"),
  toastBanner: document.getElementById("toast-banner"),
  artifactsBar: document.getElementById("artifacts-bar"),
  artifactsList: document.getElementById("artifacts-list"),
  messagesContainer: document.getElementById("messages-container"),
  // Fork modal
  forkModal: document.getElementById("fork-modal"),
  modalScopeInfo: document.getElementById("modal-scope-info"),
  forkTitleInput: document.getElementById("fork-title-input"),
  forkCopyBrain: document.getElementById("fork-copy-brain"),
  modalCloseBtn: document.getElementById("modal-close-btn"),
  modalCancelBtn: document.getElementById("modal-cancel-btn"),
  modalConfirmBtn: document.getElementById("modal-confirm-btn"),
  // Delete modal
  deleteModal: document.getElementById("delete-modal"),
  deleteScopeInfo: document.getElementById("delete-scope-info"),
  deleteCloseBtn: document.getElementById("delete-close-btn"),
  deleteCancelBtn: document.getElementById("delete-cancel-btn"),
  deleteConfirmBtn: document.getElementById("delete-confirm-btn"),
};

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Lightweight, safe GitHub-Flavored Markdown renderer for chat messages.
 */
function renderMarkdown(rawText) {
  if (!rawText) return "";
  const codeBlocks = [];

  // 1. Extract fenced code blocks first
  let text = String(rawText).replace(
    /```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g,
    (_, lang, code) => {
      const idx = codeBlocks.length;
      const langLabel = escapeHtml(lang || "code");
      codeBlocks.push(
        `<pre class="code-block"><div class="code-block-header"><span>${langLabel}</span></div><code>${escapeHtml(
          code.replace(/\n$/, "")
        )}</code></pre>`
      );
      return `\u0000CODEBLOCK_${idx}\u0000`;
    }
  );

  // 2. Escape HTML in remaining text
  text = escapeHtml(text);

  // 3. Format inline elements helper
  const formatInline = (line) => {
    const inlineCodes = [];
    let s = line.replace(/`([^`\n]+)`/g, (_, c) => {
      const i = inlineCodes.length;
      inlineCodes.push(`<code class="inline-code">${c}</code>`);
      return `\u0000INLINECODE_${i}\u0000`;
    });

    // Links: [label](url)
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const cleanUrl = url.trim();
      if (cleanUrl.startsWith("file://")) {
        return `<span class="file-link-chip" title="${cleanUrl}">📄 ${label}</span>`;
      }
      if (cleanUrl.startsWith("http://") || cleanUrl.startsWith("https://")) {
        return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      }
      return `<span class="file-link-chip">${label}</span>`;
    });

    // Bold, Italic, Strikethrough
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,!?:;)]|$)/g, "$1<em>$2</em>");

    // Restore inline code
    s = s.replace(/\u0000INLINECODE_(\d+)\u0000/g, (_, idx) => inlineCodes[Number(idx)]);
    return s;
  };

  // 4. Process block structures line by line
  const lines = text.split(/\r?\n/);
  const out = [];
  let inUl = false;
  let inOl = false;
  let inBlockquote = false;
  let tableRows = [];

  const flushListsAndQuotes = () => {
    if (inUl) {
      out.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      out.push("</ol>");
      inOl = false;
    }
    if (inBlockquote) {
      out.push("</blockquote>");
      inBlockquote = false;
    }
  };

  const flushTable = () => {
    if (tableRows.length === 0) return;
    if (tableRows.length >= 2 && /^\|?[\s:-]+\|/.test(tableRows[1])) {
      const parseCells = (row) =>
        row
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => formatInline(c.trim()));
      const headers = parseCells(tableRows[0]);
      const bodyRows = tableRows.slice(2).map(parseCells);
      out.push(
        `<table><thead><tr>${headers
          .map((h) => `<th>${h}</th>`)
          .join("")}</tr></thead><tbody>${bodyRows
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`
      );
    } else {
      for (const r of tableRows) {
        out.push(`<p>${formatInline(r)}</p>`);
      }
    }
    tableRows = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // Codeblock placeholder
    if (/^\u0000CODEBLOCK_\d+\u0000$/.test(trimmed)) {
      flushListsAndQuotes();
      flushTable();
      out.push(trimmed);
      continue;
    }

    // Table row detection
    if (trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 2) {
      flushListsAndQuotes();
      tableRows.push(trimmed);
      continue;
    } else if (tableRows.length > 0) {
      flushTable();
    }

    if (!trimmed) {
      flushListsAndQuotes();
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushListsAndQuotes();
      out.push("<hr />");
      continue;
    }

    // Headings
    const hMatch = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (hMatch) {
      flushListsAndQuotes();
      const level = hMatch[1].length;
      out.push(`<h${level}>${formatInline(hMatch[2])}</h${level}>`);
      continue;
    }

    // Blockquote
    if (trimmed.startsWith("&gt;")) {
      if (inUl || inOl) flushListsAndQuotes();
      if (!inBlockquote) {
        out.push("<blockquote>");
        inBlockquote = true;
      }
      const qContent = trimmed.replace(/^&gt;\s?/, "");
      out.push(`<p>${formatInline(qContent)}</p>`);
      continue;
    } else if (inBlockquote) {
      out.push("</blockquote>");
      inBlockquote = false;
    }

    // Unordered list
    const ulMatch = rawLine.match(/^\s*[-*+]\s+(.*)$/);
    if (ulMatch) {
      if (inOl) {
        out.push("</ol>");
        inOl = false;
      }
      if (!inUl) {
        out.push("<ul>");
        inUl = true;
      }
      out.push(`<li>${formatInline(ulMatch[1])}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = rawLine.match(/^\s*\d+\.\s+(.*)$/);
    if (olMatch) {
      if (inUl) {
        out.push("</ul>");
        inUl = false;
      }
      if (!inOl) {
        out.push("<ol>");
        inOl = true;
      }
      out.push(`<li>${formatInline(olMatch[1])}</li>`);
      continue;
    }

    flushListsAndQuotes();
    out.push(`<p>${formatInline(rawLine)}</p>`);
  }

  flushListsAndQuotes();
  flushTable();

  let html = out.join("\n");
  html = html.replace(
    /\u0000CODEBLOCK_(\d+)\u0000/g,
    (_, idx) => codeBlocks[Number(idx)]
  );
  return html;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

async function loadAppInfo() {
  const res = await fetch("/api/info");
  if (res.ok) {
    const info = await res.json();
    els.dataDirLabel.textContent = info.rootDir;
    els.dataDirLabel.title = info.rootDir;
  }
}

async function loadConversations() {
  const search = els.searchInput.value.trim();
  const project = els.projectSelect.value;
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (project) params.set("project", project);

  const res = await fetch(`/api/conversations?${params.toString()}`);
  const data = await res.json();
  state.conversations = data.conversations || [];

  populateProjectFilter(state.conversations);
  renderConversationList();
}

function populateProjectFilter(list) {
  const currentVal = els.projectSelect.value;
  const projects = Array.from(
    new Set(list.map((c) => c.projectId).filter(Boolean))
  ).sort();

  if (els.projectSelect.options.length <= 1 && projects.length > 0) {
    for (const p of projects) {
      const opt = document.createElement("option");
      opt.value = p;
      opt.textContent = p;
      els.projectSelect.appendChild(opt);
    }
    els.projectSelect.value = currentVal;
  }
}

function renderConversationList() {
  if (state.conversations.length === 0) {
    els.conversationList.innerHTML = `<div class="empty-hint">No conversations found.</div>`;
    return;
  }

  els.conversationList.innerHTML = state.conversations
    .map((c) => {
      const isActive = c.conversationId === state.selectedId ? "active" : "";
      const isRunning = c.status.includes("RUNNING");
      return `
        <div class="conv-item ${isActive}" data-id="${escapeHtml(c.conversationId)}">
          <div class="conv-item-top">
            <div class="conv-item-title">${escapeHtml(c.title)}</div>
            <button
              class="conv-delete-mini"
              data-del-id="${escapeHtml(c.conversationId)}"
              data-del-title="${escapeHtml(c.title)}"
              title="Delete this conversation"
            >🗑️</button>
          </div>
          <div class="conv-item-meta">
            <span>${c.stepCount} steps · ${escapeHtml(c.projectId || "default")}</span>
            <span>${isRunning ? "🟢 Running" : formatDate(c.lastModifiedTime)}</span>
          </div>
        </div>
      `;
    })
    .join("");

  for (const item of els.conversationList.querySelectorAll(".conv-item")) {
    item.addEventListener("click", (e) => {
      const delBtn = e.target.closest(".conv-delete-mini");
      if (delBtn) {
        e.stopPropagation();
        openDeleteModal(
          delBtn.getAttribute("data-del-id"),
          delBtn.getAttribute("data-del-title")
        );
        return;
      }
      selectConversation(item.getAttribute("data-id"));
    });
  }
}

async function selectConversation(id) {
  state.selectedId = id;
  renderConversationList();
  els.toastBanner.classList.add("hidden");

  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
  if (!res.ok) {
    alert("Failed to load conversation details.");
    return;
  }

  state.currentDetail = await res.json();
  renderConversationDetail();
}

function renderConversationDetail() {
  const d = state.currentDetail;
  if (!d) return;

  els.emptyState.classList.add("hidden");
  els.detailView.classList.remove("hidden");

  els.detailTitle.textContent = d.summary.title;
  els.detailId.textContent = d.summary.conversationId;
  const isRunning = d.summary.status.includes("RUNNING");
  els.detailStatus.textContent = isRunning ? "RUNNING" : "IDLE";
  els.detailStatus.className = `status-badge ${
    isRunning ? "status-running" : "status-idle"
  }`;
  els.detailProject.textContent = `📁 ${d.summary.projectId || "outside-of-project"}`;
  els.detailCounts.textContent = `💬 ${d.messages.length} messages (${d.totalSteps} steps)`;

  // Artifacts bar
  if (d.artifacts && d.artifacts.length > 0) {
    els.artifactsBar.classList.remove("hidden");
    els.artifactsList.innerHTML = d.artifacts
      .map(
        (a) =>
          `<span class="artifact-chip" title="${a.sizeBytes} bytes">${escapeHtml(
            a.relativePath
          )}</span>`
      )
      .join("");
  } else {
    els.artifactsBar.classList.add("hidden");
  }

  renderMessages();
}

function renderMessages() {
  const d = state.currentDetail;
  if (!d) return;

  const filtered = d.messages.filter((m) => {
    if (state.roleFilter === "all") return true;
    return m.role === state.roleFilter;
  });

  if (filtered.length === 0) {
    els.messagesContainer.innerHTML = `<div class="empty-hint">No messages match the current filter.</div>`;
    return;
  }

  els.messagesContainer.innerHTML = filtered
    .map((m) => {
      const isUser = m.role === "user";
      const roleLabel = isUser ? "👤 USER" : "🤖 ANTIGRAVITY (AGENT)";
      const roleClass = isUser ? "role-user" : "role-agent";
      const cardClass = isUser ? "msg-user" : "msg-agent";

      const stepRangeText =
        m.startStepIdx === m.endStepIdx
          ? `step #${m.endStepIdx}`
          : `steps #${m.startStepIdx} → #${m.endStepIdx} (${m.intermediateStepCount} steps)`;

      const thinkingHtml =
        m.thinkingBlocks && m.thinkingBlocks.length > 0
          ? `<details class="msg-details">
              <summary>💭 Internal Thinking (${m.thinkingBlocks.length} block${
                m.thinkingBlocks.length > 1 ? "s" : ""
              })</summary>
              <div class="details-content">${escapeHtml(
                m.thinkingBlocks.join("\n\n---\n\n")
              )}</div>
            </details>`
          : "";

      const toolsHtml =
        m.toolCalls && m.toolCalls.length > 0
          ? `<details class="msg-details">
              <summary>🛠️ Tool Calls (${m.toolCalls.length} call${
                m.toolCalls.length > 1 ? "s" : ""
              })</summary>
              <div class="details-content">${m.toolCalls
                .map(
                  (tc) =>
                    `<div class="tool-call-item"><strong>${escapeHtml(
                      tc.toolName
                    )}</strong> <code>${escapeHtml(tc.argsPreview)}</code></div>`
                )
                .join("")}</div>
            </details>`
          : "";

      const bodyText =
        m.content ||
        (m.toolCalls?.length
          ? `*(Agent executed ${m.toolCalls.length} tool call${
              m.toolCalls.length > 1 ? "s" : ""
            } without visible text)*`
          : "*(No text content)*");

      const renderedBody = state.markdownMode
        ? renderMarkdown(bodyText)
        : escapeHtml(bodyText);

      const bodyModeClass = state.markdownMode ? "markdown-body" : "raw-mode";

      return `
        <article class="msg-card ${cardClass}">
          <div class="msg-header">
            <div class="msg-header-left">
              <span class="role-badge ${roleClass}">#${m.messageIndex + 1} · ${roleLabel}</span>
              <span class="step-range-pill">${stepRangeText}</span>
            </div>
            <button
              class="btn btn-secondary btn-sm fork-msg-btn"
              data-msg-idx="${m.messageIndex}"
              data-end-step="${m.endStepIdx}"
              data-role="${m.role}"
            >
              ⑂ Fork from Message #${m.messageIndex + 1}
            </button>
          </div>
          <div class="msg-body ${bodyModeClass}">${renderedBody}</div>
          ${thinkingHtml}
          ${toolsHtml}
        </article>
      `;
    })
    .join("");

  for (const btn of els.messagesContainer.querySelectorAll(".fork-msg-btn")) {
    btn.addEventListener("click", () => {
      const msgIdx = Number(btn.getAttribute("data-msg-idx"));
      const endStep = Number(btn.getAttribute("data-end-step"));
      const role = btn.getAttribute("data-role");
      openForkModal({
        targetStepIdx: endStep,
        messageIndex: msgIdx,
        role,
      });
    });
  }
}

function openForkModal(forkSpec) {
  const d = state.currentDetail;
  if (!d) return;

  state.pendingFork = forkSpec;
  const baseTitle = d.summary.title;

  if (forkSpec.targetStepIdx === undefined) {
    els.modalScopeInfo.innerHTML = `
      <div><strong>Mode:</strong> Full Conversation Fork</div>
      <div><strong>Retained History:</strong> All ${d.messages.length} messages (${d.totalSteps} steps)</div>
    `;
    els.forkTitleInput.value = `[Fork] ${baseTitle}`;
  } else {
    const msgNum = forkSpec.messageIndex + 1;
    const roleName =
      forkSpec.role === "user" ? "User Message" : "Agent Response";
    els.modalScopeInfo.innerHTML = `
      <div><strong>Mode:</strong> Fork at <strong>Message #${msgNum} (${roleName})</strong></div>
      <div><strong>Retained History:</strong> Message #1 through Message #${msgNum} (cleanly snapshotted up to <code>step #${forkSpec.targetStepIdx}</code>, truncating subsequent messages)</div>
    `;
    els.forkTitleInput.value = `[Fork Msg #${msgNum}] ${baseTitle}`;
  }

  els.forkModal.classList.remove("hidden");
  els.forkTitleInput.focus();
  els.forkTitleInput.select();
}

function closeForkModal() {
  els.forkModal.classList.add("hidden");
  state.pendingFork = null;
}

async function confirmFork() {
  const d = state.currentDetail;
  if (!d || !state.pendingFork) return;

  els.modalConfirmBtn.disabled = true;
  els.modalConfirmBtn.textContent = "Forking...";

  try {
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(d.summary.conversationId)}/fork`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetStepIdx: state.pendingFork.targetStepIdx,
          newTitle: els.forkTitleInput.value.trim(),
          copyBrain: els.forkCopyBrain.checked,
        }),
      }
    );

    const result = await res.json();
    if (!res.ok) {
      throw new Error(result.error || "Unknown error while forking");
    }

    closeForkModal();
    await loadConversations();

    els.toastBanner.classList.remove("hidden");
    els.toastBanner.innerHTML = `
      <div>
        ✅ Fork created: <strong>${escapeHtml(result.title)}</strong>
        (ID: <code>${escapeHtml(result.newConversationId)}</code> · ${result.keptStepCount} steps · ${result.copiedArtifactCount} artifacts)
      </div>
      <button id="open-forked-btn" class="btn btn-secondary btn-sm">Open Forked Conversation</button>
    `;

    document.getElementById("open-forked-btn")?.addEventListener("click", () => {
      selectConversation(result.newConversationId);
    });
  } catch (err) {
    alert(`Fork failed: ${err.message}`);
  } finally {
    els.modalConfirmBtn.disabled = false;
    els.modalConfirmBtn.textContent = "⑂ Confirm Fork";
  }
}

function openDeleteModal(conversationId, title) {
  state.pendingDelete = { conversationId, title };
  els.deleteScopeInfo.innerHTML = `
    <div><strong>Title:</strong> ${escapeHtml(title)}</div>
    <div><strong>Conversation ID:</strong> <code>${escapeHtml(conversationId)}</code></div>
  `;
  els.deleteModal.classList.remove("hidden");
}

function closeDeleteModal() {
  els.deleteModal.classList.add("hidden");
  state.pendingDelete = null;
}

async function confirmDelete() {
  if (!state.pendingDelete) return;
  const { conversationId } = state.pendingDelete;

  els.deleteConfirmBtn.disabled = true;
  els.deleteConfirmBtn.textContent = "Deleting...";

  try {
    const res = await fetch(
      `/api/conversations/${encodeURIComponent(conversationId)}`,
      { method: "DELETE" }
    );
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Failed to delete conversation");
    }

    closeDeleteModal();

    if (state.selectedId === conversationId) {
      state.selectedId = null;
      state.currentDetail = null;
      els.detailView.classList.add("hidden");
      els.emptyState.classList.remove("hidden");
    }

    await loadConversations();
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  } finally {
    els.deleteConfirmBtn.disabled = false;
    els.deleteConfirmBtn.textContent = "🗑️ Delete Permanently";
  }
}

// Event Listeners
els.refreshBtn.addEventListener("click", loadConversations);
els.searchInput.addEventListener("input", loadConversations);
els.projectSelect.addEventListener("change", loadConversations);

els.forkFullBtn.addEventListener("click", () => {
  openForkModal({ targetStepIdx: undefined });
});

els.deleteConvBtn.addEventListener("click", () => {
  if (state.currentDetail) {
    openDeleteModal(
      state.currentDetail.summary.conversationId,
      state.currentDetail.summary.title
    );
  }
});

els.toggleMdBtn.addEventListener("click", () => {
  state.markdownMode = !state.markdownMode;
  els.toggleMdBtn.textContent = state.markdownMode
    ? "📝 View: Markdown"
    : "📄 View: Raw Text";
  renderMessages();
});

els.detailId.addEventListener("click", () => {
  if (state.currentDetail) {
    navigator.clipboard.writeText(state.currentDetail.summary.conversationId);
    const old = els.detailId.textContent;
    els.detailId.textContent = "Copied ID!";
    setTimeout(() => {
      els.detailId.textContent = old;
    }, 1200);
  }
});

for (const tab of document.querySelectorAll(".tab-btn")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab-btn")) {
      t.classList.remove("active");
    }
    tab.classList.add("active");
    state.roleFilter = tab.getAttribute("data-role") || "all";
    renderMessages();
  });
}

els.modalCloseBtn.addEventListener("click", closeForkModal);
els.modalCancelBtn.addEventListener("click", closeForkModal);
els.modalConfirmBtn.addEventListener("click", confirmFork);

els.deleteCloseBtn.addEventListener("click", closeDeleteModal);
els.deleteCancelBtn.addEventListener("click", closeDeleteModal);
els.deleteConfirmBtn.addEventListener("click", confirmDelete);

// Init
loadAppInfo();
loadConversations();
