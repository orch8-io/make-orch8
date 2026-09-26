// Static validation of the Make app definition. No dependencies: `node --test test/`.
//
// Checks: every file referenced by makecomapp.json exists and parses as JSON;
// each component has the code files Make requires for its type; parameters,
// interfaces and samples are well-formed; RPC / webhook / connection references
// resolve; and every request targets a route that really exists in the Orch8
// engine (engine/orch8-api/src, mounted under /api/v1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
const manifest = readJson("makecomapp.json");
const C = manifest.components;

// Real engine routes this app is allowed to call (method + path relative to /api/v1).
// `/jobs` is the background-jobs API landing in the next engine release.
const ENGINE_ROUTES = new Set([
  "GET /sequences",
  "POST /instances",
  "GET /instances",
  "GET /instances/{}",
  "POST /instances/{}/signals",
  "POST /jobs",
]);
const NEXT_RELEASE_ROUTES = new Set(["POST /jobs"]);

const PARAM_TYPES = new Set([
  "array", "boolean", "buffer", "cert", "collection", "color", "date", "email", "file", "filename",
  "filter", "folder", "hidden", "integer", "json", "number", "password", "path", "pkey", "port",
  "select", "text", "time", "timestamp", "timezone", "uinteger", "url", "uuid", "banner", "any",
]);
const MODULE_TYPES = new Set(["action", "search", "trigger", "instant_trigger", "universal", "responder"]);

function allJsonFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...allJsonFiles(p));
    else if (name.endsWith(".json")) out.push(relative(ROOT, p));
  }
  return out;
}

function requests(comm) {
  if (Array.isArray(comm)) return comm;
  return comm && Object.keys(comm).length ? [comm] : [];
}

function normalizeRoute(method, url) {
  const path = url
    .replace(/^\{\{(connection|parameters)\.baseUrl\}\}\/api\/v1/, "")
    .replace(/\{\{[^}]*\}\}/g, "{}")
    .replace(/\?.*$/, "");
  return `${(method || "GET").toUpperCase()} ${path}`;
}

function checkParams(list, where) {
  assert.ok(Array.isArray(list), `${where}: parameters must be an array`);
  const names = new Set();
  const walk = (params, ctx) => {
    for (const p of params) {
      assert.ok(PARAM_TYPES.has(p.type), `${ctx}: unknown parameter type ${p.type}`);
      if (p.type === "banner") continue;
      assert.ok(typeof p.name === "string" && p.name, `${ctx}: parameter without name`);
      assert.ok(typeof p.label === "string" && p.label, `${ctx}: ${p.name} without label`);
      assert.ok(!names.has(p.name), `${ctx}: duplicate parameter ${p.name}`);
      names.add(p.name);
      if (p.type === "select") {
        const opts = p.options;
        assert.ok(opts, `${ctx}: select ${p.name} without options`);
        if (typeof opts === "string") assert.match(opts, /^rpc:\/\/\w+$/, `${ctx}: bad rpc ref`);
        const store = Array.isArray(opts) ? opts : opts.store;
        if (store) for (const o of store) if (o.nested) walk(o.nested, `${ctx}/${p.name}`);
      }
      if (p.spec) walk(p.spec, `${ctx}/${p.name}`);
    }
  };
  walk(list, where);
  return names;
}

test("every JSON file in the app parses", () => {
  const files = allJsonFiles(ROOT).filter((f) => f !== "package.json");
  assert.ok(files.length > 20);
  for (const f of files) assert.doesNotThrow(() => readJson(f), `${f} is not valid JSON`);
});

test("makecomapp.json references existing files only", () => {
  const refs = [...Object.values(manifest.generalCodeFiles)];
  for (const group of Object.values(C))
    for (const comp of Object.values(group)) refs.push(...Object.values(comp.codeFiles || {}));
  for (const r of refs) assert.ok(existsSync(join(ROOT, r)), `missing ${r}`);
  // and no orphan component files
  const referenced = new Set(refs);
  for (const f of allJsonFiles(ROOT))
    if (/^(modules|rpcs|webhooks|connections|general)\//.test(f)) assert.ok(referenced.has(f), `orphan file ${f}`);
});

test("base injects auth headers, error handling and log sanitization", () => {
  const base = readJson(manifest.generalCodeFiles.base);
  assert.equal(base.baseUrl, "{{connection.baseUrl}}/api/v1");
  assert.equal(base.headers["x-api-key"], "{{connection.apiKey}}");
  assert.equal(base.headers["x-tenant-id"], "{{connection.tenantId}}");
  assert.ok(base.response.error.message.includes("statusCode"));
  assert.ok(base.log.sanitize.includes("request.headers.x-api-key"));
});

test("connection validates credentials against a real endpoint", () => {
  const conn = C.connection.orch8;
  assert.equal(conn.connectionType, "basic");
  const names = checkParams(readJson(conn.codeFiles.params), "connection");
  for (const n of ["baseUrl", "apiKey", "tenantId"]) assert.ok(names.has(n), `connection param ${n}`);
  const params = readJson(conn.codeFiles.params);
  assert.equal(params.find((p) => p.name === "apiKey").type, "password");
  const comm = readJson(conn.codeFiles.communication);
  assert.equal(normalizeRoute(comm.method, comm.url), "GET /sequences");
  assert.equal(comm.headers["x-api-key"], "{{parameters.apiKey}}");
  assert.ok(comm.log.sanitize.includes("request.headers.x-api-key"));
});

test("modules have the code files and directives their type requires", () => {
  const rpcNames = new Set(Object.keys(C.rpc));
  for (const [name, m] of Object.entries(C.module)) {
    assert.ok(MODULE_TYPES.has(m.moduleType), `${name}: moduleType`);
    assert.ok(m.label && m.description, `${name}: label/description`);
    for (const k of ["communication", "staticParams", "mappableParams", "interface", "samples"])
      assert.ok(m.codeFiles[k], `${name}: missing ${k}`);
    const stat = readJson(m.codeFiles.staticParams);
    const mapp = readJson(m.codeFiles.mappableParams);
    checkParams([...stat, ...mapp], name);
    const iface = readJson(m.codeFiles.interface);
    assert.ok(Array.isArray(iface) && iface.length, `${name}: interface`);
    const samples = readJson(m.codeFiles.samples);
    for (const key of Object.keys(samples))
      assert.ok(iface.some((f) => f.name === key), `${name}: sample key ${key} not in interface`);
    for (const p of [...stat, ...mapp])
      if (typeof p.options === "string") assert.ok(rpcNames.has(p.options.slice(6)), `${name}: unknown ${p.options}`);

    const comm = readJson(m.codeFiles.communication);
    if (m.moduleType === "instant_trigger") {
      assert.ok(m.webhook && C.webhook[m.webhook], `${name}: webhook ref`);
      assert.equal(m.connection, null, `${name}: not-attached webhook needs no connection`);
      assert.ok(stat.some((p) => p.type === "banner"), `${name}: attach instructions banner`);
      continue;
    }
    assert.equal(m.connection, "orch8", `${name}: connection`);
    const reqs = requests(comm);
    assert.ok(reqs.length, `${name}: communication`);
    if (reqs.length > 1) for (const r of reqs) assert.ok(r.condition, `${name}: multi-request needs conditions`);
    if (m.moduleType === "trigger") {
      assert.ok(m.codeFiles.epoch, `${name}: epoch`);
      assert.equal(mapp.length, 0, `${name}: triggers only take static params`);
      const t = comm.response.trigger;
      assert.ok(t && t.id && ["id", "date"].includes(t.type) && ["asc", "desc", "unordered"].includes(t.order), `${name}: trigger directive`);
      if (t.type === "date") assert.ok(t.date, `${name}: trigger.date`);
      assert.ok(comm.response.iterate, `${name}: iterate`);
      const epoch = readJson(m.codeFiles.epoch);
      assert.deepEqual(Object.keys(epoch.response.output).sort(), ["date", "label"]);
    }
    if (m.moduleType === "search") assert.ok(comm.response.iterate, `${name}: search must iterate`);
    if (m.moduleType === "action") assert.ok(m.actionCrud, `${name}: actionCrud`);
  }
});

test("every request targets a real engine route", () => {
  const seen = [];
  const collect = (comm, who) => {
    for (const r of requests(comm)) {
      assert.ok(r.url, `${who}: request without url`);
      assert.ok(!/^https?:/.test(r.url) || r.url.startsWith("{{"), `${who}: hard-coded host`);
      const route = normalizeRoute(r.method, r.url);
      assert.ok(ENGINE_ROUTES.has(route), `${who}: ${route} is not an engine route`);
      seen.push([who, route]);
    }
  };
  for (const [n, m] of Object.entries(C.module)) if (m.moduleType !== "instant_trigger") collect(readJson(m.codeFiles.communication), n);
  for (const [n, r] of Object.entries(C.rpc)) collect(readJson(r.codeFiles.communication), `rpc ${n}`);
  // Only enqueueJob may depend on the next-release Jobs API, and it must say so.
  for (const [who, route] of seen) {
    if (!NEXT_RELEASE_ROUTES.has(route)) continue;
    assert.equal(who, "enqueueJob");
    assert.match(C.module.enqueueJob.description, /newer than the current release/);
  }
});

test("signal bodies use the engine's SignalType wire format", () => {
  const send = readJson(C.module.sendSignal.codeFiles.communication);
  assert.equal(send[0].body.signal_type, "{{parameters.signalType}}");
  assert.deepEqual(send[1].body.signal_type, { custom: "{{parameters.customSignal}}" });
  const opts = readJson(C.module.sendSignal.codeFiles.mappableParams).find((p) => p.name === "signalType").options.store;
  assert.deepEqual(opts.map((o) => o.value), ["pause", "resume", "cancel", "update_context", "custom"]);
  const approve = readJson(C.module.resolveApproval.codeFiles.communication);
  assert.deepEqual(approve.body.signal_type, { custom: "human_input:{{parameters.blockId}}" });
  assert.equal(approve.body.payload.value, "{{parameters.value}}");
});

test("start instance sends PascalCase priorities (engine Priority has no serde rename)", () => {
  const p = readJson(C.module.startInstance.codeFiles.mappableParams).find((x) => x.name === "priority");
  assert.deepEqual(p.options.map((o) => o.value), ["Low", "Normal", "High", "Critical"]);
  const body = readJson(C.module.startInstance.codeFiles.communication).body;
  assert.equal(body.tenant_id, "{{connection.tenantId}}");
  assert.ok(body.sequence_id && body.namespace && body.context);
});

test("rpc and webhook are well-formed", () => {
  const rpc = readJson(C.rpc.listSequences.codeFiles.communication);
  assert.equal(rpc.response.iterate, "{{body.items}}");
  assert.deepEqual(Object.keys(rpc.response.output).sort(), ["label", "value"]);
  const wh = C.webhook.orch8Events;
  assert.equal(wh.webhookType, "web");
  assert.ok(!wh.codeFiles.attach, "engine has no subscribe API; webhook must not be attached");
  const whComm = readJson(wh.codeFiles.communication);
  for (const k of ["event_type", "instance_id", "timestamp", "data"]) assert.ok(whComm.output[k], `webhook output ${k}`);
  checkParams(readJson(wh.codeFiles.params), "webhook");
});

test("groups list every module exactly once", () => {
  const groups = readJson(manifest.generalCodeFiles.groups);
  const listed = groups.flatMap((g) => g.modules);
  assert.deepEqual([...listed].sort(), Object.keys(C.module).sort());
});
