const $ = (selector) => document.querySelector(selector);
let selectedId = null;
let activeConversation = null;
let appSettings = null;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || `Request failed (${response.status})`);
  return data;
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2400);
}

async function refreshConversationList() {
  const items = await api("/api/conversations");
  $("#conversation-list").innerHTML = items.map((item) => `
    <button class="conversation-item ${item.id === selectedId ? "active" : ""}" data-id="${escapeHtml(item.id)}" title="${escapeHtml(item.thesis)}">${escapeHtml(item.thesis)}</button>
  `).join("");
  document.querySelectorAll(".conversation-item").forEach((button) => button.addEventListener("click", () => openConversation(button.dataset.id)));
}

function renderSources(sources) {
  return (sources || []).map((source) => `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.title || source.url)}</a>`).join("");
}

function renderRounds(events) {
  const rounds = new Map();
  for (const event of events) {
    if (!rounds.has(event.round)) rounds.set(event.round, {});
    rounds.get(event.round)[event.role] = event;
  }
  const ordered = [...rounds.entries()].sort((a, b) => b[0] - a[0]);
  $("#rounds").innerHTML = ordered.map(([number, round]) => {
    const verdict = round.judge;
    const pro = round.pro;
    const con = round.con;
    const probability = verdict?.probability;
    const date = verdict?.created_at ? new Date(verdict.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
    let details = "";
    if (pro || con) {
      details = `<button class="details-toggle" type="button">View research reports <span>＋</span></button>
        <div class="details-content hidden">
          <article class="agent-report"><div class="agent-heading pro">↗ &nbsp; PRO RESEARCHER</div><div class="report-text">${escapeHtml(pro?.content || "Waiting for report…")}</div><div class="source-links">${renderSources(pro?.sources)}</div></article>
          <article class="agent-report"><div class="agent-heading con">⌁ &nbsp; OPPOSITION RESEARCHER</div><div class="report-text">${escapeHtml(con?.content || "Waiting for report…")}</div><div class="source-links">${renderSources(con?.sources)}</div></article>
        </div>`;
    }
    return `<article class="round-card">
      <div class="round-top"><span class="round-label">ROUND ${number} <span style="color:#b2b7b1">/</span> JEV VERDICT</span><time class="round-date">${escapeHtml(date)}</time></div>
      ${verdict ? `<div class="verdict"><div class="verdict-icon">◎</div><div><div class="verdict-title">Thesis probability</div><div class="verdict-question">${escapeHtml(verdict.content.split("\n\n")[0])}</div></div><div class="probability">${Math.round(probability * 100)}%<small>LIKELY TRUE<br><span class="false-prob">${Math.round((1 - probability) * 100)}% LIKELY FALSE</span></small></div></div>` : `<div class="verdict"><div class="verdict-icon">◎</div><div><div class="verdict-title">Jev verdict unavailable</div><div class="verdict-question">${escapeHtml(round.system?.content || "This round did not produce a verdict.")}</div></div><div></div></div>`}
      ${details}
    </article>`;
  }).join("");
  document.querySelectorAll(".details-toggle").forEach((button) => button.addEventListener("click", () => {
    const body = button.nextElementSibling;
    const hidden = body.classList.toggle("hidden");
    button.innerHTML = `View research reports <span>${hidden ? "＋" : "−"}</span>`;
  }));
}

async function openConversation(id) {
  selectedId = id;
  const data = await api(`/api/conversations/${encodeURIComponent(id)}`);
  activeConversation = data;
  const convo = data.conversation;
  $("#welcome").classList.add("hidden");
  $("#workspace").classList.remove("hidden");
  $("#thread-thesis").textContent = convo.thesis;
  $("#crumb-title").textContent = convo.thesis.length > 38 ? `${convo.thesis.slice(0, 38)}…` : convo.thesis;
  $("#thread-status").textContent = convo.status.toUpperCase();
  $("#thread-status").classList.toggle("running", convo.status === "running");
  $("#activity").classList.toggle("hidden", convo.status !== "running");
  $("#activity-title").textContent = `Round ${convo.round} in progress`;
  $("#activity-copy").textContent = convo.phase || "Both researchers are gathering evidence before Jev scores the thesis.";
  $("#empty-round").classList.toggle("hidden", data.events.length > 0 || convo.status === "running");
  const latestError = convo.status === "error" ? [...data.events].reverse().find((event) => event.role === "system") : null;
  $("#error-banner").textContent = latestError?.content || "";
  $("#error-banner").classList.toggle("hidden", !latestError);
  renderRounds(data.events);
  const max = appSettings?.max_rounds || 3;
  const threshold = appSettings?.stop_confidence_percent || 80;
  const latestVerdict = [...data.events].filter((event) => event.role === "judge" && Number.isFinite(event.probability)).sort((a, b) => b.round - a.round)[0];
  const latestConfidenceValue = latestVerdict ? Math.max(latestVerdict.probability, 1 - latestVerdict.probability) * 100 : 0;
  const latestConfidence = Math.round(latestConfidenceValue);
  const confidenceReached = latestConfidenceValue >= threshold;
  $("#round-count").textContent = `${convo.round} / ${max} rounds`;
  $("#round-cap").innerHTML = `ROUND CAP <b>${max}</b>`;
  $("#run-round").disabled = convo.status === "running" || convo.round >= max;
  $("#run-round").innerHTML = convo.round >= max ? "Round cap reached" : convo.status === "running" ? "Researching…" : confidenceReached ? `Run another round anyway <span>→</span>` : `Run next round <span>→</span>`;
  $("#round-guidance").textContent = convo.status === "running"
    ? `Auto-running until Jev reaches ${threshold}% confidence in either answer or the round cap.`
    : convo.round >= max
      ? "Stopped: maximum rounds reached. You can raise the cap in settings."
      : confidenceReached
        ? `Stopped: Jev reached ${latestConfidence}% confidence (target ${threshold}%). You can run another round manually.`
        : `Rounds auto-run until Jev reaches ${threshold}% confidence in either answer or the round cap.`;
  $("#source-list").innerHTML = data.supplied_sources.map((source) => `<span class="source-chip" title="${escapeHtml(source.url)}">↗ ${escapeHtml(source.title)}</span>`).join("");
  await refreshConversationList();
}

async function startRound() {
  if (!selectedId) return;
  $("#error-banner").classList.add("hidden");
  try {
    await api(`/api/conversations/${encodeURIComponent(selectedId)}/round`, { method: "POST" });
    await openConversation(selectedId);
  } catch (error) {
    toast(error.message);
  }
}

async function createThesis(thesis) {
  const created = await api("/api/conversations", { method: "POST", body: JSON.stringify({ thesis }) });
  selectedId = created.id;
  await openConversation(selectedId);
  await startRound();
}

async function openSettings() {
  if (!appSettings) appSettings = await api("/api/settings");
  const form = $("#settings-form");
  for (const [key, value] of Object.entries(appSettings)) {
    const field = form.elements.namedItem(key);
    if (field) field.value = value;
  }
  $("#settings-saved").textContent = "";
  $("#settings-dialog").showModal();
}

$("#thesis-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const thesis = $("#thesis-input").value.trim();
  if (!thesis) return;
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try { await createThesis(thesis); }
  catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

$("#new-chat").addEventListener("click", () => {
  selectedId = null;
  activeConversation = null;
  $("#welcome").classList.remove("hidden");
  $("#workspace").classList.add("hidden");
  $("#crumb-title").textContent = "New thesis";
  $("#thesis-input").focus();
  refreshConversationList();
});

$(".suggestion").addEventListener("click", () => {
  $("#thesis-input").value = "Company X will double revenue in 3 years.";
  $("#thesis-input").focus();
});

$("#run-round").addEventListener("click", startRound);

$("#add-source").addEventListener("click", async () => {
  const input = $("#source-input");
  const url = input.value.trim();
  if (!selectedId || !url) return;
  const button = $("#add-source");
  button.disabled = true;
  try {
    const source = await api(`/api/conversations/${encodeURIComponent(selectedId)}/sources`, { method: "POST", body: JSON.stringify({ url }) });
    input.value = "";
    toast(`Added: ${source.title}`);
    await openConversation(selectedId);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

$("#source-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); $("#add-source").click(); }
});

$("#open-settings").addEventListener("click", openSettings);
$("#settings-icon").addEventListener("click", openSettings);
$("#close-settings").addEventListener("click", () => $("#settings-dialog").close());

$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const body = Object.fromEntries(form.entries());
  body.max_rounds = Number(body.max_rounds);
  body.stop_confidence_percent = Number(body.stop_confidence_percent);
  const button = event.currentTarget.querySelector(".save-button");
  button.disabled = true;
  try {
    appSettings = await api("/api/settings", { method: "PUT", body: JSON.stringify(body) });
    $("#settings-saved").textContent = "Saved";
    if (selectedId) await openConversation(selectedId);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

async function init() {
  try {
    appSettings = await api("/api/settings");
    await refreshConversationList();
    const existing = await api("/api/conversations");
    if (existing.length) await openConversation(existing[0].id);
  } catch (error) { toast(error.message); }
  setInterval(async () => {
    if (!selectedId) return;
    try {
      const current = await api(`/api/conversations/${encodeURIComponent(selectedId)}`);
      if (current.conversation.status !== activeConversation?.conversation.status || current.conversation.phase !== activeConversation?.conversation.phase || current.events.length !== activeConversation?.events.length) {
        await openConversation(selectedId);
      }
    } catch {}
  }, 1800);
}

init();
