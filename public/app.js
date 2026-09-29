// Atlas Policy Assistant page. Streams /api/ask (NDJSON: one "round" event
// per completed round, then "result" or "error") and renders citations as
// buttons that open the cited section's source text.
// Model output is only ever inserted with textContent, never as HTML.

const SAMPLES = [
  { tag: "Current rule", q: "What is the maximum TIV a field underwriter can bind in a Tier 1 coastal county?" },
  { tag: "Historical", q: "Before the November 2025 guideline revision, what was the minimum named-storm deductible for Tier 1 coastal risks?" },
  { tag: "Multi-step", q: "A Tier 1 coastal risk has a $6M TIV and a 5-year-old roof, but the insured can't produce a wind mitigation report. Can the field underwriter bind it?" },
  { tag: "Not in the documents", q: "What is Atlas's per-occurrence limit for professional liability (E&O) coverage?" },
];
const MAX_ROUNDS = 3;

// Same citation grammar as src/agent/citations.ts: [doc-id §2.2],
// [doc §4, §3] (a bare § continues the previous document), [doc §header].
const BRACKET = /\[([^\]]*§[^\]]*)\]/g;
const REF = /(?:([a-z0-9]+(?:-[a-z0-9]+)+)\s+)?§\s*([0-9]+(?:\.[0-9]+)*|header)/gi;

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
};

const form = $("ask-form");
const input = $("question");
const button = $("ask-button");
let running = false;

for (const s of SAMPLES) {
  const b = el("button", { type: "button", class: "sample" }, el("strong", { text: s.tag }), s.q);
  b.addEventListener("click", () => {
    input.value = s.q;
    updateCounter();
    ask(s.q);
  });
  $("samples").append(b);
}

input.addEventListener("input", updateCounter);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});
form.addEventListener("submit", (e) => {
  e.preventDefault();
  ask(input.value.trim());
});

function updateCounter() {
  $("counter").textContent = `${input.value.length} / 500`;
}

function setRunning(on) {
  running = on;
  button.disabled = on;
  button.textContent = on ? "Working…" : "Ask";
  for (const b of document.querySelectorAll(".sample")) b.disabled = on;
}

function setProgress(text) {
  $("progress").hidden = !text;
  $("progress-text").textContent = text ?? "";
}

async function ask(question) {
  if (!question || running) return;
  setRunning(true);
  $("run").hidden = false;
  $("result").hidden = true;
  $("error").hidden = true;
  $("trace").replaceChildren();
  $("trace-box").open = true;
  setProgress("Searching the Atlas documents…");

  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Request failed (${res.status}).`);
    }
    await readEvents(res.body, handleEvent);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  } finally {
    setProgress(null);
    setRunning(false);
  }
}

async function readEvents(stream, onEvent) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}

function handleEvent(event) {
  if (event.type === "round") {
    renderRound(event.round);
    setProgress(
      event.round.round >= MAX_ROUNDS
        ? "Round cap reached. Writing the answer from what was gathered…"
        : "Checking whether the evidence is enough…",
    );
  } else if (event.type === "result") {
    renderResult(event.result);
  } else if (event.type === "error") {
    showError(event.message);
  }
}

function showError(message) {
  $("error").textContent = message;
  $("error").hidden = false;
}

// ---- trace ---------------------------------------------------------------

function renderRound(round) {
  const calls = el("ul");
  for (const call of round.toolCalls) calls.append(renderCall(call));
  $("trace").append(el("li", {}, el("span", { class: "round-label", text: `Round ${round.round}` }), calls));
}

function renderCall(call) {
  const input = call.input ?? {};
  let what;
  if (call.name === "search_knowledge_base") what = `Searched “${input.query ?? ""}”`;
  else if (call.name === "get_document_section") what = `Read ${input.document_id} §${input.section}`;
  else if (call.name === "list_documents") what = "Listed the document catalog";
  else what = call.name;

  const li = el("li", {}, what);
  if (call.error) {
    li.append(" ", el("span", { class: "call-error", text: `(${call.error})` }));
  } else if (call.name === "search_knowledge_base" && call.retrieved.length) {
    const shown = call.retrieved.slice(0, 4).map((r) => `${r.documentId} §${r.section}`).join(", ");
    const more = call.retrieved.length > 4 ? `, +${call.retrieved.length - 4} more` : "";
    li.append(el("span", { class: "hits", text: ` → ${shown}${more}` }));
  }
  return li;
}

// ---- result --------------------------------------------------------------

function renderResult(r) {
  const badges = $("badges");
  badges.replaceChildren();
  if (r.status === "answered") {
    badges.append(el("span", { class: "badge ok", text: "Answered from the documents" }));
    badges.append(
      r.grounded
        ? el("span", { class: "badge ok", text: "Citations verified", title: "Every cited section was retrieved during this run." })
        : el("span", {
            class: "badge bad",
            text: r.citations.length ? "Citation check failed" : "No citations",
            title: "At least one cited section was not retrieved during this run.",
          }),
    );
  } else {
    badges.append(el("span", { class: "badge warn", text: "Not found in the documents" }));
  }
  const rounds = `${r.roundsUsed} of ${MAX_ROUNDS} rounds${r.capReached ? " (cap reached)" : ""}`;
  badges.append(el("span", { class: "badge neutral", text: `${rounds} · ${(r.elapsedMs / 1000).toFixed(1)}s` }));

  const ungrounded = new Set(r.ungroundedCitations.map((c) => `${c.documentId}#${c.section}`));
  const answer = $("answer");
  answer.replaceChildren();
  for (const para of r.answer.split(/\n{2,}/)) {
    if (para.trim()) answer.append(renderParagraph(para, ungrounded));
  }

  // The trace already streamed in, but rebuild it from the final result in
  // case a round event was missed.
  $("trace").replaceChildren();
  for (const round of r.trace) renderRound(round);
  $("trace-box").open = false;
  $("result").hidden = false;
}

// Corpus text and answers use Markdown **bold**. Rendered as <strong>
// nodes, not by parsing HTML, so nothing in the text can inject markup.
function appendInline(node, text) {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  parts.forEach((part, i) => node.append(i % 2 ? el("strong", { text: part }) : part));
}

function renderParagraph(text, ungrounded) {
  const p = el("p");
  let last = 0;
  for (const m of text.matchAll(BRACKET)) {
    const refs = parseRefs(m[1]);
    if (!refs.length) continue;
    appendInline(p, text.slice(last, m.index));
    for (const ref of refs) p.append(citeButton(ref, ungrounded.has(`${ref.documentId}#${ref.section}`)));
    last = m.index + m[0].length;
  }
  appendInline(p, text.slice(last));
  return p;
}

function parseRefs(inner) {
  const refs = [];
  let documentId;
  for (const m of inner.matchAll(REF)) {
    documentId = m[1] ?? documentId;
    if (documentId) refs.push({ documentId, section: m[2].toLowerCase() === "header" ? "header" : m[2] });
  }
  return refs;
}

function citeButton(ref, isUngrounded) {
  const label = `${ref.documentId} §${ref.section}`;
  const b = el("button", {
    type: "button",
    class: isUngrounded ? "cite ungrounded" : "cite",
    text: label,
    title: isUngrounded ? "Not retrieved during this run. Click to see what the section says." : "Show the source text",
  });
  b.addEventListener("click", () => openSource(ref));
  return b;
}

// ---- source dialog -------------------------------------------------------

const dialog = $("source");
$("source-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) dialog.close();
});

async function openSource(ref) {
  $("source-id").textContent = `${ref.documentId} §${ref.section}`;
  $("source-title").textContent = "Loading…";
  $("source-meta").replaceChildren();
  $("source-body").replaceChildren();
  if (!dialog.open) dialog.showModal();

  try {
    const params = new URLSearchParams({ document_id: ref.documentId, section: ref.section });
    const res = await fetch(`/api/section?${params}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status}).`);
    renderSource(body.sections);
  } catch (err) {
    $("source-title").textContent = "Couldn't load this section";
    $("source-body").append(el("p", { text: err instanceof Error ? err.message : String(err) }));
  }
}

function renderSource(sections) {
  const doc = sections[0];
  $("source-title").textContent = doc.title;
  const meta = $("source-meta");
  meta.append(`Version ${doc.version} · Effective ${doc.effectiveDate}`);
  meta.append(
    doc.status === "active"
      ? el("span", { class: "badge ok", text: "Active" })
      : el("span", { class: "badge warn", text: doc.supersededBy ? `Superseded by ${doc.supersededBy}` : "Superseded" }),
  );
  const body = $("source-body");
  for (const s of sections) {
    body.append(el("h3", { text: s.section === "header" ? "Document status" : s.headingPath }));
    const content = el("p", { class: "content" });
    appendInline(content, s.content);
    body.append(content);
  }
}
