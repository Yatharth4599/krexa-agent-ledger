/**
 * `pnpm submit`: assemble, validate and print the hackathon submission. Send only on request.
 *
 * SPEC.md 20 and RULES.md both say the same thing about this file: every value in the payload is
 * decided by YK, none is invented here, and nothing leaves the machine without him typing yes.
 * The reason it exists at all is that the submission is a one-shot POST with eleven fields and no
 * second attempt. Corrections go through https://nearhackathon.com/request-changes, so a typo in
 * `nearAddress` is not a thing to discover afterwards.
 *
 * What it does:
 *
 *   1. reads the decided values from `submission.local.json` (gitignored, never committed)
 *   2. checks every constraint HACKATHON.md states, and refuses on the first one that fails
 *   3. generates `requestId` once and keeps it, so a retry cannot become a second application
 *   4. prints the exact bytes that would be sent, with character counts
 *   5. with `--send`, asks for a typed `yes` on the terminal and then POSTs, once
 *
 * Without `--send` it is a dry run and cannot reach the network. That is the default because the
 * default should be the safe one.
 *
 * Usage:
 *   pnpm submit            # validate and print, send nothing
 *   pnpm submit --send     # the same, then ask for confirmation and POST
 */

import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const FIELDS_FILE = join(ROOT, "submission.local.json");
const SENT_FILE = join(ROOT, "submission.sent.json");
const ENDPOINT = "https://nearhackathon.com/api/applications";

/** The 13 track ids from HACKATHON.md's Tracks table, in its order. */
const TRACKS = [
  "defi",
  "thesis",
  "privacy",
  "business",
  "swarms",
  "security",
  "agents",
  "realworld",
  "games",
  "nfts",
  "memecoins",
  "social",
  "open",
] as const;

/** The `size` enum, verbatim. The spaces around the dash are part of the value. */
const SIZES = ["1", "2 - 4", "4 - 6", "6 - 8", "8+"] as const;

const CONSENT_SENTENCE =
  "I agree that the organizers may use these details to review our submission and contact us " +
  "about this hackathon.";

type Fields = {
  projectName?: string;
  leadName?: string;
  email?: string;
  size?: string;
  tracks?: string[];
  nearAddress?: string;
  projectUrl?: string;
  demoUrl?: string;
  idea?: string;
  consent?: boolean;
  requestId?: string;
};

function fail(message: string): never {
  console.error(`\nrefusing to continue: ${message}\n`);
  process.exit(1);
}

function readFields(): Fields {
  if (!existsSync(FIELDS_FILE)) {
    console.error(`
${FIELDS_FILE} does not exist.

Copy the template and fill it in. It is gitignored, so YK's email and payout account never
reach the public repo:

    cp submission.example.json submission.local.json
    $EDITOR submission.local.json

docs/SUBMISSION.md lists which values are already decided and which are still open.
`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(FIELDS_FILE, "utf8")) as Fields;
  } catch (e) {
    fail(`${FIELDS_FILE} is not valid JSON (${String(e)})`);
  }
}

/**
 * Every rule HACKATHON.md states, checked here rather than discovered from a 400.
 *
 * Collected rather than thrown one at a time: someone filling this in at 23:00 should see all
 * the remaining problems in one pass, not one per run.
 */
function problems(f: Fields): string[] {
  const out: string[] = [];
  const str = (name: keyof Fields, min: number, max: number): string | undefined => {
    const v = f[name];
    if (typeof v !== "string" || v.trim() === "") {
      out.push(`${name} is missing. Only YK decides it; it is not generated here.`);
      return undefined;
    }
    if (v.length < min || v.length > max) {
      out.push(`${name} is ${v.length} characters, outside the ${min} to ${max} limit.`);
    }
    return v;
  };

  str("projectName", 2, 80);
  str("leadName", 2, 80);

  const email = str("email", 3, 160);
  // Deliberately loose. The authority on whether an address works is the organizers' mail
  // server, and a clever regex here would only reject something valid.
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    out.push(`email does not look like an address: ${email}`);
  }

  if (!f.size) out.push("size is missing.");
  else if (!SIZES.includes(f.size as (typeof SIZES)[number])) {
    out.push(
      `size is ${JSON.stringify(f.size)}, which is not one of ${SIZES.map((s) => JSON.stringify(s)).join(", ")}. ` +
        "The spaces around the dash are part of the value.",
    );
  }

  if (!Array.isArray(f.tracks) || f.tracks.length === 0) {
    out.push("tracks must list at least one track id.");
  } else {
    for (const t of f.tracks) {
      if (!TRACKS.includes(t as (typeof TRACKS)[number])) {
        out.push(`tracks contains ${JSON.stringify(t)}, which is not a track id. Valid: ${TRACKS.join(", ")}`);
      }
    }
    if (new Set(f.tracks).size !== f.tracks.length) out.push("tracks repeats a track id.");
  }

  const near = str("nearAddress", 2, 64);
  if (near) {
    const named = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(near);
    const implicit = /^[0-9a-f]{64}$/.test(near);
    if (!named && !implicit) out.push(`nearAddress is not a valid NEAR account id: ${near}`);
    if (near !== near.toLowerCase()) out.push("nearAddress must be lowercase.");
    // The prize is paid on mainnet. A testnet account here is the one mistake in this file
    // that would be both easy to make and impossible to fix afterwards.
    if (/\.testnet$/.test(near)) {
      out.push(
        `nearAddress is ${near}, a testnet account. The payout account must be on mainnet, ` +
          "and it is not ual.krexa-ual.testnet or any account this repo uses.",
      );
    }
  }

  for (const name of ["projectUrl", "demoUrl"] as const) {
    const v = str(name, 1, 300);
    if (!v) continue;
    if (!/^https?:\/\//.test(v)) out.push(`${name} must start with http:// or https://: ${v}`);
    try {
      new URL(v);
    } catch {
      out.push(`${name} is not a URL: ${v}`);
    }
  }
  if (f.demoUrl && /^https?:\/\/(x\.com|twitter\.com)\/?$/.test(f.demoUrl)) {
    out.push("demoUrl must be the post itself, not x.com.");
  }

  str("idea", 20, 2000);

  if (f.consent !== true) {
    out.push(
      `consent must be exactly true, and it means this sentence:\n      "${CONSENT_SENTENCE}"`,
    );
  }

  return out;
}

/**
 * One requestId per application, generated once and then read back.
 *
 * If this were generated per invocation, a timeout plus a retry could register twice, and
 * HACKATHON.md allows one submission per project. Persisting it makes a retry idempotent from
 * the organizers' side.
 */
function requestId(f: Fields): string {
  if (f.requestId) return f.requestId;
  const id = randomUUID();
  writeFileSync(FIELDS_FILE, JSON.stringify({ ...f, requestId: id }, null, 2) + "\n");
  console.log(`generated requestId ${id} and wrote it to submission.local.json (kept for retries)`);
  return id;
}

async function main(): Promise<void> {
  const send = process.argv.includes("--send");
  const f = readFields();

  const bad = problems(f);
  if (bad.length > 0) {
    console.error(`\n${bad.length} field problem${bad.length === 1 ? "" : "s"}:\n`);
    for (const p of bad) console.error(`  - ${p}`);
    console.error("\nFix submission.local.json and run again. Nothing was sent.\n");
    process.exit(1);
  }

  // Exactly the eleven fields HACKATHON.md names, in its order. It says "do not add other
  // fields", so the payload is built explicitly rather than spread from the file: anything
  // extra in submission.local.json stays local.
  const payload = {
    requestId: requestId(f),
    projectName: f.projectName,
    leadName: f.leadName,
    email: f.email,
    size: f.size,
    tracks: f.tracks,
    nearAddress: f.nearAddress,
    projectUrl: f.projectUrl,
    demoUrl: f.demoUrl,
    idea: f.idea,
    consent: true,
  };
  const body = JSON.stringify(payload);

  console.log("\n==================== payload ====================\n");
  console.log(JSON.stringify(payload, null, 2));
  console.log("\n==================== counts =====================\n");
  console.log(`  projectName  ${payload.projectName!.length} / 80`);
  console.log(`  leadName     ${payload.leadName!.length} / 80`);
  console.log(`  email        ${payload.email!.length} / 160`);
  console.log(`  idea         ${payload.idea!.length} / 2000 (minimum 20)`);
  console.log(`  projectUrl   ${payload.projectUrl!.length} / 300`);
  console.log(`  demoUrl      ${payload.demoUrl!.length} / 300`);
  console.log(`  tracks       ${payload.tracks!.join(", ")}`);
  console.log(`  nearAddress  ${payload.nearAddress} (mainnet, for the payout)`);
  console.log(`  bytes        ${Buffer.byteLength(body)}`);
  console.log(`\n  POST ${ENDPOINT}`);

  if (existsSync(SENT_FILE)) {
    console.log(`
Already submitted. ${SENT_FILE} records the response, and HACKATHON.md allows one submission
per project. Corrections go through https://nearhackathon.com/request-changes, not a second POST.
`);
    process.exit(0);
  }

  if (!send) {
    console.log(`
Dry run. Nothing was sent and this command cannot reach the network without --send.

Read the payload above, then:   pnpm submit --send
`);
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`
This sends the application above, once. ${payload.projectUrl} must already be public and the
X post at ${payload.demoUrl} must already be up.
`);
  const answer = (await rl.question('Type exactly "yes" to send: ')).trim();
  rl.close();
  if (answer !== "yes") {
    console.log("\nnot sent.\n");
    return;
  }

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const text = await res.text();
  console.log(`\nHTTP ${res.status} ${res.statusText}\n${text}\n`);

  if (res.ok) {
    // Local, gitignored, and the only record that a POST happened. It holds YK's email and
    // payout account, which is why it is not committed.
    writeFileSync(
      SENT_FILE,
      JSON.stringify({ sentAt: new Date().toISOString(), status: res.status, payload, response: text }, null, 2) + "\n",
    );
    console.log(`Submitted. Recorded in ${SENT_FILE} (gitignored).

Do not run this again. Corrections: https://nearhackathon.com/request-changes
`);
  } else {
    console.log(`Not accepted, and nothing was recorded as sent. The requestId is unchanged, so
fixing the field and running again is the same application rather than a second one.
`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\n${String(e)}\n\nNothing was sent.\n`);
  process.exit(1);
});
