#!/usr/bin/env node
/**
 * Dump ALL JSON returned by a Schneider-style meter to Desktop.
 * Also extracts any {name,value,(units),(timestamp)} found anywhere.
 *
 * Creds: user "0", pass "0"
 * Host : https://192.168.1.134
 *
 * Usage:
 *   npm init -y
 *   npm i playwright
 *   npx playwright install chromium
 *   node dump_meter_api.cjs
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const HOST = "192.168.0.135";
const STARTS = [
  "/web/resources/monitoring.html",
  "/web/resources/instReadings.html",
  "/web/resources/trendingAndForecasting.html",
  "/web/resources/ieee519.html",
  "/web/resources/ieee519Summary.html",
  "/web/resources/powerQualitySummary.html",
  "/web/resources/inputsOutputs.html",
  "/web/resources/waveforms.html"
];

const USER_INFO_FILE = process.argv[2] || "last_otp_response.json";
const LOOP_INTERVAL_MS = 60 * 1000; // wait 60 s between runs

function getUserIdFromFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`User info JSON not found: ${filePath}`);
    return null;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const userId = parsed?.data?.user_id ?? null;

    if (userId == null) {
      console.error(`No data.user_id found in JSON file: ${filePath}`);
      return null;
    }

    return userId;
  } catch (err) {
    console.error(`Failed to read/parse user info JSON at ${filePath}: ${err.message}`);
    return null;
  }
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function safeName(s) {
  return s
    .replace(/^https?:\/\//, "")
    .replace(/[?&#%:"*<>|]/g, "_")
    .replace(/\/+/g, "__");
}

function writeJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

function pushIfRegisterLike(arr, obj) {
  // Accept a wide variety of shapes
  // Required: name-ish & value-ish
  const name =
    obj?.name ?? obj?.label ?? obj?.regname ?? obj?.Register ?? obj?.N ?? null;
  // Allow 0, strings, numbers
  const hasValueKey = ("value" in (obj || {})) || ("Value" in (obj || {}));
  const value = hasValueKey ? (obj.value ?? obj.Value) : undefined;

  if (name != null && value !== undefined) {
    const units = obj.units ?? obj.Units ?? null;
    const timestamp = obj.timestamp ?? obj.time ?? obj.Time ?? null;
    arr.push({ name, value, units, timestamp });
  }
}

function walkForRegisters(obj, out) {
  if (Array.isArray(obj)) {
    for (const item of obj) walkForRegisters(item, out);
    return;
  }
  if (obj && typeof obj === "object") {
    pushIfRegisterLike(out, obj);
    for (const v of Object.values(obj)) walkForRegisters(v, out);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function collectMeterTuples(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const tuples = [];

  for (const row of rows) {
    const meterSystemId = row?.meter_system_id ?? null;
    const host = row?.ip_address ?? null;
    const username = row?.username ?? null;
    const password = row?.password ?? null;

    if (meterSystemId == null || !host || !username || !password) {
      continue;
    }

    tuples.push({ meterSystemId, host, username, password });
  }

  return tuples;
}

async function fetchMeterSystems(userId) {
  const apiUrl = `https://lema.website:8000/api/meter_systems?user_id=${userId ?? ""}`;
  console.error(`\nGET ${apiUrl}`);

  const res = await fetch(apiUrl);
  if (!res.ok) {
    throw new Error(`meter_systems request failed with status ${res.status}`);
  }

  return res.json();
}

async function scrapeMeterSystem(target, userId, runIndex) {
  console.error(`\n--- Run #${runIndex} / meter_system_id=${target.meterSystemId} / host=${target.host} ---`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    // Try HTTP Basic first; page may still present a form login, which we handle.
    httpCredentials: { username: target.username, password: target.password }
  });
  const page = await ctx.newPage();

  const captured = [];
  page.on("response", async (res) => {
    try {
      const url = res.url();
      if (!url.startsWith(`http://${target.host}/api/`)) return;
      const status = res.status();
      const ct = res.headers()["content-type"] || "";
      const when = new Date().toISOString().replace(/[:.]/g, "-");
      let body;
      let json = null;

      if (ct.includes("application/json")) {
        json = await res.json();
        body = JSON.stringify(json, null, 2);
      } else {
        const text = await res.text();
        // Some firmwares send text/plain with JSON text
        try { json = JSON.parse(text); body = JSON.stringify(json, null, 2); }
        catch { body = text; }
      }
    } catch (e) {
      // ignore per-response failures
    }
  });

  // Helper: try to click through accordions to trigger loads
  async function expandAccordions() {
    const headers = await page.$$('h3[role="tab"]');
    for (const h of headers) {
      try {
        const sel = await h.getAttribute("aria-selected");
        if (sel !== "true") {
          await h.click();
          await page.waitForLoadState("networkidle", { timeout: 7000 }).catch(() => {});
        }
      } catch {}
    }
  }

  // Visit each start page, try to log in if needed, trigger loads
  for (const pathStart of STARTS) {
    const capturedAtStart = captured.length;
    const url = `http://${target.host}${pathStart}`;
    console.error(`Navigating: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    console.error(`Page loaded`);

    // If a form-login appears, fill it
    const userSel = await page.$('input[type="text"], input[name*="user" i], input[name*="login" i]');
    const passSel = await page.$('input[type="password"], input[name*="pass" i]');
    if (userSel && passSel) {
      try {
        await userSel.fill(target.username);
        await passSel.fill(target.password);
        const submit = await page.$('button[type="submit"], input[type="submit"]');
        if (submit) {
          await Promise.all([
            page.waitForLoadState("networkidle", { timeout: 15000 }),
            submit.click()
          ]);
        } else {
          await Promise.all([
            page.waitForLoadState("networkidle", { timeout: 15000 }),
            passSel.press("Enter")
          ]);
        }
      } catch {}
    }
    try {
        const apiRes = await ctx.request.post(
          `http://${target.host}/api/registerValues/getRegisterValues`,
          { data: { names: ["Vln avg"] } }
        );
        const vlnData = await apiRes.json();
        console.error(`meter_system_id=${target.meterSystemId} raw Vln avg response:`, JSON.stringify(vlnData, null, 2));
        const results = Array.isArray(vlnData?.result) ? vlnData.result : [];
        if (results.length === 0) {
          console.error(`meter_system_id=${target.meterSystemId} Vln avg: no results returned.`);
        } else {
          console.error(`meter_system_id=${target.meterSystemId} Vln avg:`);
          for (const r of results) {
            const units = r.units ? ` ${r.units}` : "";
            console.error(`  ${r.label ?? r.name ?? "Vln avg"}: ${r.value}${units}`);

            try {
              const postRes = await fetch("https://lema.website:8000/api/readings/", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  meter_system_id: target.meterSystemId,
                  timestamp: new Date().toISOString(),
                  value: r.value
                })
              });

              if (!postRes.ok) {
                const errText = await postRes.text();
                console.error(`  -> POST readings failed (${postRes.status}): ${errText}`);
              } else {
                console.error("  -> Posted to readings API OK");
              }
            } catch (postErr) {
              console.error(`  -> POST readings error: ${postErr.message}`);
            }
          }
        }
      } catch (err) {
        console.error(`meter_system_id=${target.meterSystemId} Vln avg fetch failed: ${err.message}`);
      }
  }

  await browser.close();

  // Build a lightweight index
  const index = captured.map(({ url, status, ct, file }) => ({ url, status, content_type: ct, file }));

  // Try to pull register-like pairs from all captured JSON
  const extracted = [];
  for (const c of captured) {
    if (!c.json) continue;
    walkForRegisters(c.json, extracted);
  }

  // de-dupe by name+timestamp+value string
  const uniq = [];
  const seen = new Set();
  for (const r of extracted) {
    const key = `${r.name}|${r.timestamp ?? ""}|${String(r.value)}`;
    if (!seen.has(key)) { seen.add(key); uniq.push(r); }
  }


  // Also print a compact summary to stdout
  const summary = {
    device: {
      brand: "Schneider",
      model: "ION9000",
      host: target.host,
      meter_system_id: target.meterSystemId
    },
    user_id: userId,
    meta: {
      fetched_at_utc: new Date().toISOString(),
      files_saved: "Nowhere",
      user_info_file: USER_INFO_FILE
    },
    api_calls_captured: index.length,
    extracted_registers_count: uniq.length
  };

  console.log(JSON.stringify(summary, null, 2));
}

(async () => {
  const userId = getUserIdFromFile(USER_INFO_FILE);
  console.error(`Using user_id: ${userId ?? "(not found)"}`);

  let runIndex = 0;
  while (true) {
    runIndex++;
    let tuples = [];
    try {
      const meterSystems = await fetchMeterSystems(userId);
      tuples = collectMeterTuples(meterSystems);
      console.error(`Collected ${tuples.length} valid meter tuple(s) from meter_systems response.`);
    } catch (err) {
      console.error("Failed to fetch meter systems:", err.message);
    }

    if (tuples.length === 0) {
      console.error("No valid tuples with meter_system_id, ip_address, username, password. Skipping scrape this cycle.");
    } else {
      for (const tuple of tuples) {
        try {
          await scrapeMeterSystem(tuple, userId, runIndex);
        } catch (err) {
          console.error(`Scrape failed for meter_system_id=${tuple.meterSystemId}:`, err.message);
        }
      }
    }

    console.error(`\nWaiting ${LOOP_INTERVAL_MS / 1000}s before next run... (Ctrl+C to stop)`);
    await sleep(LOOP_INTERVAL_MS);
  }
})().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
