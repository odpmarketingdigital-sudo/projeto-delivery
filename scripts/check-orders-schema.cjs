/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const out = [];
function log(...a) { out.push(a.join(" ")); }

const env = {};
const text = fs.readFileSync(path.join(root, ".env.local"), "utf8");
for (const line of text.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

async function main() {
  // 1) test tooling
  try {
    const bins = fs.readdirSync(path.join(root, "node_modules", ".bin"));
    log("test bins:", bins.filter((b) => /vitest|jest|playwright|tsx|ts-node/.test(b)).join(", ") || "NONE");
  } catch (e) { log("bin err", e.message); }
  for (const p of ["vitest", "jest", "@testing-library/react", "playwright", "@playwright/test"]) {
    log(`dep ${p}:`, fs.existsSync(path.join(root, "node_modules", p)) ? "YES" : "no");
  }

  // 2) list all RPCs the API can reach
  const spec = await (await fetch(`${url}/rest/v1/`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/openapi+json" },
  })).json();
  const paths = Object.keys(spec.paths || {});
  log("rest paths:", paths.join(", "));
  const defs = spec.definitions || spec.components?.schemas || {};
  log("order_items required:", JSON.stringify(defs.order_items?.required || []));
  log("order_items desc:", JSON.stringify(defs.order_items?.description || ""));

  // 3) order_items constraints via attempting a probe insert? No - read only.
  // Check RLS: try reading order_items with anon key
  const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (anon) {
    const r = await fetch(`${url}/rest/v1/order_items?select=*&limit=1`, {
      headers: { apikey: anon, Authorization: `Bearer ${anon}` },
    });
    log("anon order_items read:", r.status, (await r.text()).slice(0, 300));
  }

  // 4) count existing orders and their items
  const r2 = await fetch(`${url}/rest/v1/orders?select=id,items,total&limit=5`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const rows = await r2.json();
  log("orders sample:", JSON.stringify(rows).slice(0, 1200));
  const r3 = await fetch(`${url}/rest/v1/order_items?select=*`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const oi = await r3.json();
  log("order_items count:", Array.isArray(oi) ? oi.length : JSON.stringify(oi));

  fs.writeFileSync("/tmp/probe3.txt", out.join("\n"));
}

main().catch((e) => {
  out.push("ERR " + e.message);
  fs.writeFileSync("/tmp/probe3.txt", out.join("\n"));
});
