/**
 * The page.
 *
 * Two data sources and no private backend:
 *
 * - **the chain**, queried directly from the browser with JSON-RPC `call_function` against a
 *   public NEAR node. Nothing we host sits in between.
 * - **local run files**, served read-only by the dev server from `experiments/ebi/results`,
 *   for the pages about a specific experiment run. Those are files in the repo, not a service.
 *
 * Verification is done here, in the page, with the bundled SDK. A chain this page calls valid
 * is valid by the same canonical-form and SHA-256 rule the contract used.
 */

import { receiptHash, verifyChain, genesisHash, sha256Hex } from "./ual.js";

// ---------------------------------------------------------------- tabs

for (const btn of document.querySelectorAll("nav button")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll("nav button")) b.classList.remove("active");
    for (const s of document.querySelectorAll(".tab")) s.classList.remove("active");
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
  });
}

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ---------------------------------------------------------------- chain access

/** One JSON-RPC view call. No key, no signing, no backend. */
async function viewCall(rpcUrl, contractId, method, args) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "ual",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contractId,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error.data?.message ?? JSON.stringify(body.error));
  if (body.result?.error) throw new Error(body.result.error);
  const bytes = body.result.result;
  return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)));
}

async function loadFromChain(rpcUrl, contractId, deskId) {
  const head = await viewCall(rpcUrl, contractId, "get_head", { desk_id: deskId });
  if (!head) throw new Error(`desk "${deskId}" does not exist on ${contractId}`);
  const receipts = [];
  for (let from = 1; from <= head.seq; from += 100) {
    const page = await viewCall(rpcUrl, contractId, "get_receipts", {
      desk_id: deskId,
      from_seq: from,
      limit: 100,
    });
    if (!page.length) break;
    receipts.push(...page);
  }
  return { receipts, head, contractId, deskId };
}

// ---------------------------------------------------------------- explorer

let loaded = null;
let tampered = null;

function renderChain() {
  const source = tampered ?? loaded;
  if (!source) return;
  const { receipts, contractId, deskId, isLocal } = source;

  // Anchor against the desk's genesis, derived in the page from the contract id and desk id.
  // Without the anchor, a run that was internally consistent but rebased onto a different
  // genesis would pass, which is the one thing a hash chain is supposed to catch.
  const expectedGenesis = genesisHash(contractId, deskId);
  const result = verifyChain(receipts, receipts[0]?.seq === 1 ? expectedGenesis : undefined);

  const status = $("chainStatus");
  if (result.valid) {
    status.className = "status good";
    status.innerHTML =
      `chain verifies: ${receipts.length} receipts, every hash recomputed in this page` +
      (receipts[0]?.seq === 1
        ? `<br><span class="hashes">anchored to genesis ${esc(expectedGenesis)}</span>`
        : "");
  } else {
    status.className = "status broken";
    status.innerHTML =
      `<strong>broken at seq ${result.brokenAt}</strong><br>` +
      `<span class="hashes">${esc(result.reason ?? "")}</span>`;
  }

  $("tamperControls").hidden = false;

  const explorerBase = isLocal ? null : "https://testnet.nearblocks.io/address/";
  $("receipts").innerHTML = receipts
    .map((r) => {
      const recomputed = receiptHash(r);
      const ok = recomputed === r.hash;
      const ev = r.evidence;
      const bits = [];
      bits.push(`<span class="seq">#${r.seq}</span>`);
      bits.push(`<span class="kind">${esc(r.kind)}</span>`);
      bits.push(`<span class="verdict-${esc(r.verdict)}">${esc(r.verdict)}</span>`);
      bits.push(`<span class="badge ${r.mode === "paper" ? "paper" : ""}">${esc(r.mode)}</span>`);
      if (ev && ev.attested === false) {
        bits.push('<span class="badge unattested">attested: false</span>');
      }
      if (!ok) bits.push('<span class="bad">HASH MISMATCH</span>');

      const lines = [];
      if (r.reasons?.length) {
        lines.push(`<div class="reasons">${r.reasons.map(esc).join(", ")}</div>`);
      }
      if (r.intent) {
        lines.push(
          `<div class="hashes">intent ${esc(r.intent.side)} ${esc(r.intent.asset)} ` +
            `${esc(r.intent.notionalUsd)} micro-USD on ${esc(r.intent.venue)}` +
            (r.sizeMultiplierBps !== null && r.sizeMultiplierBps !== undefined
              ? ` &middot; size multiplier ${r.sizeMultiplierBps} bps`
              : "") +
            `</div>`,
        );
      }
      if (ev) {
        lines.push(
          `<div class="hashes">k = ${ev.k} &middot; ${ev.items.length} item(s) &middot; ` +
            `groups ${esc(ev.items.map((i) => i.sourceGroup).join(", "))}` +
            (ev.anyBadSig ? ' &middot; <span class="bad">bad signature present</span>' : "") +
            (ev.anyStale ? ' &middot; <span class="warn">stale item present</span>' : "") +
            `</div>`,
        );
      }
      if (r.control) {
        lines.push(
          `<div class="hashes">${esc(r.control.action)} ${esc(r.control.detail)}</div>`,
        );
      }
      lines.push(
        `<div class="hashes">prev ${esc(r.prevHash)}<br>hash ${esc(r.hash)}<br>` +
          `recomputed here ${ok ? '<span class="ok">matches</span>' : `<span class="bad">${esc(recomputed)}</span>`}</div>`,
      );
      if (explorerBase) {
        lines.push(
          `<div class="hashes"><a class="link" target="_blank" rel="noopener" ` +
            `href="${explorerBase}${esc(contractId)}">view the contract on nearblocks</a></div>`,
        );
      }

      return `<div class="receipt${ok ? "" : " broken"}">
        <div class="receipt-head">${bits.join(" ")}</div>
        ${lines.join("")}
      </div>`;
    })
    .join("");
}

$("load").addEventListener("click", async () => {
  const status = $("chainStatus");
  status.className = "status busy";
  status.textContent = "querying the chain...";
  try {
    loaded = await loadFromChain($("network").value, $("contractId").value.trim(), $("deskId").value.trim());
    loaded.isLocal = $("network").value.includes("localhost");
    tampered = null;
    renderChain();
  } catch (e) {
    status.className = "status broken";
    status.textContent = String(e.message ?? e);
  }
});

$("loadLocal").addEventListener("click", async () => {
  const status = $("chainStatus");
  status.className = "status busy";
  status.textContent = "reading the local run...";
  try {
    const runs = await (await fetch("/data/runs")).json();
    if (!runs.length) throw new Error("no local runs found. Try: pnpm runtime:sim");
    const runId = runs[runs.length - 1];
    const deskId = $("deskId").value.trim();
    const receipts = await (await fetch(`/data/runs/${runId}/${deskId}.receipts.jsonl`))
      .text()
      .then((t) => t.split("\n").filter(Boolean).map((l) => JSON.parse(l)));
    // A local sandbox run used a throwaway contract account, and the run records it, so the
    // genesis anchor is derived from the receipts' own desk rather than from the input box.
    const meta = await (await fetch(`/data/runs/${runId}/run.json`)).json();
    loaded = {
      receipts,
      contractId: meta.contractId ?? "ual.test.near",
      deskId,
      isLocal: true,
    };
    tampered = null;
    renderChain();
  } catch (e) {
    status.className = "status broken";
    status.textContent = String(e.message ?? e);
  }
});

$("tamper").addEventListener("click", () => {
  if (!loaded) return;
  // Change one field on one receipt and nothing else, which is the whole demonstration: the
  // chain notices without being told where to look.
  const receipts = loaded.receipts.map((r) => ({ ...r }));
  const i = Math.min(3, receipts.length - 1);
  if (i < 0) return;
  receipts[i] = { ...receipts[i], equityUsd: "99999999999" };
  tampered = { ...loaded, receipts };
  renderChain();
});
$("untamper").addEventListener("click", () => {
  tampered = null;
  renderChain();
});

// ---------------------------------------------------------------- leaderboard

async function renderLeaderboard(mode) {
  const body = $("leaderboardBody");
  body.innerHTML = '<div class="empty">reading desks from the chain...</div>';
  const rpcUrl = $("network").value;
  const contractId = $("contractId").value.trim();
  try {
    const deskIds = await viewCall(rpcUrl, contractId, "list_desks", { from_index: 0, limit: 50 });
    if (!deskIds.length) {
      body.innerHTML = '<div class="empty">no desks on this contract yet</div>';
      return;
    }
    const rows = [];
    for (const deskId of deskIds) {
      const desk = await viewCall(rpcUrl, contractId, "get_desk", { desk_id: deskId });
      if (!desk || desk.mode !== mode) continue;
      const head = await viewCall(rpcUrl, contractId, "get_head", { desk_id: deskId });
      rows.push({ deskId, desk, head });
    }
    if (!rows.length) {
      body.innerHTML = `<div class="empty">no desks in ${esc(mode)} mode.` +
        (mode === "live" ? " This build is paper only, so that is expected." : "") +
        `</div>`;
      return;
    }
    body.innerHTML = `<table>
      <tr><th>desk</th><th>owner</th><th>mode</th><th>receipts</th><th>kill switch</th>
          <th>open positions</th><th>skill verdict</th><th>days to significance</th></tr>
      ${rows
        .map(
          ({ deskId, desk, head }) => `<tr>
        <td class="mono">${esc(deskId)}</td>
        <td class="mono">${esc(desk.owner)}</td>
        <td><span class="badge paper">${esc(desk.mode)}</span></td>
        <td class="mono">${head?.seq ?? 0}</td>
        <td>${desk.killSwitch ? '<span class="bad">engaged</span>' : '<span class="dim">clear</span>'}</td>
        <td class="mono">${desk.openPositions?.length ?? 0}</td>
        <td class="warn">CANT_TELL_YET</td>
        <td class="mono">not reachable at this rate</td>
      </tr>`,
        )
        .join("")}
    </table>
    <p>
      Every verdict reads <code>CANT_TELL_YET</code> because it is true. SPEC.md 5.2 needs
      30 days of marks before a return-to-drawdown figure means anything, and this build has
      days. A ranking here would imply skill nobody has demonstrated.
    </p>`;
  } catch (e) {
    body.innerHTML = `<div class="status broken">${esc(e.message ?? e)}</div>`;
  }
}

for (const btn of document.querySelectorAll(".modeTab")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll(".modeTab")) b.classList.remove("active");
    btn.classList.add("active");
    renderLeaderboard(btn.dataset.mode);
  });
}

// ---------------------------------------------------------------- EBI results

/** Minimal markdown: enough for the generated RESULTS.md, nothing more. */
function renderMarkdown(md) {
  const lines = md.split("\n");
  const out = [];
  let inTable = false;
  let inCode = false;
  for (const raw of lines) {
    const line = raw;
    if (line.startsWith("```")) {
      out.push(inCode ? "</pre>" : "<pre>");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(esc(line));
      continue;
    }
    if (line.startsWith("|")) {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.every((c) => /^-+$/.test(c))) continue;
      if (!inTable) {
        out.push("<table>");
        inTable = true;
        out.push(`<tr>${cells.map((c) => `<th>${inline(c)}</th>`).join("")}</tr>`);
      } else {
        out.push(`<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`);
      }
      continue;
    }
    if (inTable) {
      out.push("</table>");
      inTable = false;
    }
    if (line.startsWith("### ")) out.push(`<h3>${inline(line.slice(4))}</h3>`);
    else if (line.startsWith("## ")) out.push(`<h2>${inline(line.slice(3))}</h2>`);
    else if (line.startsWith("# ")) out.push(`<h1>${inline(line.slice(2))}</h1>`);
    else if (line.startsWith("> ")) out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
    else if (line.startsWith("- ")) out.push(`<li>${inline(line.slice(2))}</li>`);
    else if (line.trim() === "") out.push("");
    else out.push(`<p>${inline(line)}</p>`);
  }
  if (inTable) out.push("</table>");
  if (inCode) out.push("</pre>");
  return out.join("\n");
}
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="link" href="$2">$1</a>');
}

async function loadEbi() {
  const body = $("ebiBody");
  try {
    const md = await (await fetch("/data/results-md")).text();
    body.innerHTML = renderMarkdown(md);
  } catch {
    body.innerHTML =
      '<div class="empty">docs/RESULTS.md not found. Generate it with: pnpm ebi:report</div>';
  }
}

// ---------------------------------------------------------------- attack replay

let replayData = null;

async function loadReplayRuns() {
  try {
    const runs = await (await fetch("/data/runs")).json();
    $("replayRun").innerHTML = runs.map((r) => `<option>${esc(r)}</option>`).join("");
    if (runs.length) await loadReplayRun(runs[runs.length - 1]);
  } catch {
    $("replayBody").innerHTML =
      '<div class="empty">no local runs. Generate one with: pnpm runtime:sim</div>';
  }
}

async function loadReplayRun(runId) {
  const rows = await (await fetch(`/data/runs/${runId}/decisions.jsonl`))
    .text()
    .then((t) => t.split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  replayData = { runId, rows };
  const cases = [...new Set(rows.map((r) => r.attack).filter(Boolean))].sort();
  $("replayCase").innerHTML = cases.length
    ? cases.map((c) => `<option>${esc(c)}</option>`).join("")
    : '<option value="">no attacked points in this run</option>';
  renderReplay();
}

function renderReplay() {
  const body = $("replayBody");
  if (!replayData) return;
  const caseId = $("replayCase").value;
  const rows = replayData.rows.filter((r) => r.attack === caseId);
  if (!rows.length) {
    body.innerHTML = '<div class="empty">nothing to show for this case</div>';
    return;
  }
  const point = rows[0].point;
  body.innerHTML = `
    <div class="status">
      <span class="badge attack">SYNTHETIC ATTACK</span>
      <strong>${esc(caseId)}</strong> injected at ${esc(point)}<br>
      <span class="hashes">
        Written by us, not taken from arXiv 2610.26438, which released no templates.
        Each desk below saw the identical evidence set.
      </span>
    </div>
    <div class="desk-col">
      ${rows
        .map((r) => {
          const opened = r.verdict === "APPROVED" && String(r.action).startsWith("OPEN");
          return `<div class="receipt${opened ? " broken" : ""}">
          <div class="receipt-head">
            <span class="kind">${esc(r.deskId)}</span>
            <span class="verdict-${esc(r.verdict ?? "NA")}">${esc(r.verdict ?? "HOLD")}</span>
            ${opened ? '<span class="bad">opened in the attacker\'s direction</span>' : '<span class="ok">did not open</span>'}
          </div>
          <div class="hashes">action ${esc(r.action)}</div>
          <div class="hashes">would have done without the attack: ${esc(r.priorAction ?? "?")}</div>
          ${r.verifierK !== null && r.verifierK !== undefined ? `<div class="hashes">verifier k = ${r.verifierK}</div>` : ""}
          ${r.reasons?.length ? `<div class="reasons">${r.reasons.map(esc).join(", ")}</div>` : ""}
          ${
            r.verifierExplanation
              ? `<details><summary>what the verifier decided and why</summary><pre>${r.verifierExplanation.map(esc).join("\n")}</pre></details>`
              : ""
          }
          <div class="hashes">decisionHash ${esc(String(r.decisionHash ?? "").slice(0, 32))}...</div>
        </div>`;
        })
        .join("")}
    </div>
    <p>
      A desk that did not open is not necessarily defended: check whether it submitted any
      intents at all in this run. The results page names desks that never traded.
    </p>`;
}

$("replayRun").addEventListener("change", (e) => loadReplayRun(e.target.value));
$("replayCase").addEventListener("change", renderReplay);

// ---------------------------------------------------------------- boot

renderLeaderboard("paper");
loadEbi();
loadReplayRuns();
// Self-check: the bundled hashing must agree with the known digest of the empty string, or
// every verdict on this page is meaningless.
if (sha256Hex("") !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") {
  document.body.insertAdjacentHTML(
    "afterbegin",
    '<div class="status broken">The bundled SHA-256 is wrong. Nothing on this page can be trusted.</div>',
  );
}
