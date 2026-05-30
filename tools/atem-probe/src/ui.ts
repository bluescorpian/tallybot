/**
 * The probe's dashboard, served as one self-contained HTML document (inline CSS + JS,
 * no build step, no assets) so it bundles into the single .exe with zero extra wiring.
 *
 * It talks to the server over two tiny endpoints: a Server-Sent-Events stream
 * (`/events`) that pushes live `state` snapshots and `log` lines, and a few POSTs for
 * connect / disconnect / scan. The embedded script deliberately avoids template
 * literals so this whole file can stay a single backtick-delimited string.
 */

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>TallyBot · ATEM Probe</title>
<style>
  :root {
    --bg: #0e1116; --panel: #161b22; --panel-2: #1c232d; --edge: #2a313c;
    --ink: #e6edf3; --muted: #8b949e; --live: #ff3b30; --preview: #34c759;
    --idle: #3a3f47; --amber: #ffb020; --blue: #4aa3ff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  }
  header {
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    padding: 14px 20px; background: var(--panel); border-bottom: 1px solid var(--edge);
  }
  header h1 { font-size: 16px; margin: 0; font-weight: 650; letter-spacing: .2px; }
  header h1 small { color: var(--muted); font-weight: 400; margin-left: 8px; }
  .pill {
    font-size: 12px; font-weight: 700; letter-spacing: .6px; padding: 5px 12px;
    border-radius: 999px; background: var(--idle); color: #fff; white-space: nowrap;
  }
  .pill.connected { background: var(--preview); color: #06250f; }
  .pill.connecting { background: var(--amber); color: #3a2600; animation: pulse 1s ease-in-out infinite; }
  .pill.disconnected { background: var(--idle); color: var(--muted); }
  @keyframes pulse { 50% { opacity: .45; } }
  #heartbeat {
    width: 10px; height: 10px; border-radius: 50%; background: #30363d;
    transition: background .08s ease, box-shadow .08s ease;
  }
  #heartbeat.beat { background: var(--blue); box-shadow: 0 0 10px var(--blue); }
  #product { color: var(--muted); font-size: 13px; margin-left: auto; }
  main { padding: 20px; display: grid; gap: 18px; max-width: 1100px; margin: 0 auto; }
  .bar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  input[type=text] {
    background: var(--panel-2); border: 1px solid var(--edge); color: var(--ink);
    padding: 9px 12px; border-radius: 8px; font-size: 14px; width: 200px; font-family: ui-monospace, monospace;
  }
  button {
    background: var(--panel-2); border: 1px solid var(--edge); color: var(--ink);
    padding: 9px 14px; border-radius: 8px; font-size: 13px; cursor: pointer; font-weight: 550;
  }
  button:hover { background: #232b36; }
  button.primary { background: var(--blue); border-color: var(--blue); color: #04203f; }
  button.primary:hover { filter: brightness(1.08); }
  button:disabled { opacity: .5; cursor: default; }
  #scanResults { display: flex; gap: 8px; flex-wrap: wrap; }
  #scanResults button { font-family: ui-monospace, monospace; }
  .tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .tile {
    border-radius: 12px; padding: 18px 20px; border: 1px solid var(--edge);
    background: var(--panel); min-height: 96px; display: flex; flex-direction: column; justify-content: center;
  }
  .tile .lbl { font-size: 11px; letter-spacing: 1.5px; font-weight: 700; text-transform: uppercase; opacity: .85; }
  .tile .val { font-size: 30px; font-weight: 700; margin-top: 6px; }
  .tile .sub { color: var(--muted); font-size: 13px; }
  .tile.program { background: linear-gradient(180deg, #2a0f0e, var(--panel)); border-color: #5a1c19; }
  .tile.program .lbl { color: var(--live); }
  .tile.preview { background: linear-gradient(180deg, #0e2616, var(--panel)); border-color: #1c5232; }
  .tile.preview .lbl { color: var(--preview); }
  .tile.off { opacity: .55; }
  h2 { font-size: 12px; letter-spacing: 1px; text-transform: uppercase; color: var(--muted); margin: 0 0 4px; }
  #inputs { display: flex; gap: 10px; flex-wrap: wrap; }
  .chip {
    border-radius: 10px; padding: 10px 14px; min-width: 90px; border: 1px solid var(--edge);
    background: var(--panel); transition: all .12s ease;
  }
  .chip .id { font-size: 11px; color: var(--muted); }
  .chip .name { font-weight: 600; }
  .chip.live { background: var(--live); border-color: var(--live); color: #fff; box-shadow: 0 0 16px rgba(255,59,48,.4); }
  .chip.live .id { color: rgba(255,255,255,.8); }
  .chip.preview { background: var(--preview); border-color: var(--preview); color: #05230f; }
  .chip.preview .id { color: rgba(0,0,0,.55); }
  .empty { color: var(--muted); font-style: italic; }
  .console-head { display: flex; align-items: center; gap: 12px; }
  .console-head .spacer { margin-left: auto; }
  select {
    background: var(--panel-2); border: 1px solid var(--edge); color: var(--ink);
    padding: 7px 10px; border-radius: 8px; font-size: 12px;
  }
  #log {
    background: #0a0d11; border: 1px solid var(--edge); border-radius: 10px; padding: 12px;
    height: 320px; overflow-y: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; line-height: 1.55;
  }
  #log .row { white-space: pre-wrap; word-break: break-word; }
  #log .ts { color: #586069; }
  #log .lvl-info { color: var(--blue); }
  #log .lvl-warn { color: var(--amber); }
  #log .lvl-error { color: var(--live); }
  #log .lvl-debug { color: #6e7681; }
  .hint { color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>TallyBot <small>ATEM Probe</small></h1>
  <span id="status" class="pill disconnected">DISCONNECTED</span>
  <div id="heartbeat" title="flashes on every state update from the ATEM"></div>
  <span id="product">no switcher</span>
</header>

<main>
  <section class="bar">
    <input id="ip" type="text" placeholder="ATEM IP (e.g. 192.168.10.240)" autocomplete="off" spellcheck="false" />
    <button id="connect" class="primary">Connect</button>
    <button id="disconnect">Disconnect</button>
    <button id="scan">Scan network</button>
    <span class="hint" id="scanHint"></span>
  </section>
  <section id="scanResults"></section>

  <section class="tiles">
    <div class="tile program off" id="programTile">
      <div class="lbl">Program · on air</div>
      <div class="val" id="programVal">—</div>
      <div class="sub" id="programSub">waiting for connection</div>
    </div>
    <div class="tile preview off" id="previewTile">
      <div class="lbl">Preview · next</div>
      <div class="val" id="previewVal">—</div>
      <div class="sub" id="previewSub">waiting for connection</div>
    </div>
  </section>

  <section>
    <h2>Inputs</h2>
    <div id="inputs"><span class="empty">No inputs reported yet.</span></div>
  </section>

  <section>
    <div class="console-head">
      <h2>System log · under the hood</h2>
      <span class="spacer"></span>
      <select id="filter">
        <option value="all">all levels</option>
        <option value="info">info+</option>
        <option value="warn">warnings+</option>
        <option value="error">errors only</option>
      </select>
      <button id="clear">Clear view</button>
      <a href="/log" download><button>Download log file</button></a>
    </div>
    <div id="log"></div>
  </section>
</main>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var ipInput = $("ip"), statusEl = $("status"), heartbeatEl = $("heartbeat"), productEl = $("product");
  var logEl = $("log"), filterEl = $("filter"), scanResultsEl = $("scanResults"), scanHintEl = $("scanHint");
  var connectBtn = $("connect"), disconnectBtn = $("disconnect"), scanBtn = $("scan");

  var LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
  var allRows = [];

  fetch("/config").then(function (r) { return r.json(); }).then(function (c) {
    if (c && c.lastIp && !ipInput.value) ipInput.value = c.lastIp;
  }).catch(function () {});

  function post(path, body) {
    return fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    });
  }

  connectBtn.onclick = function () {
    var ip = ipInput.value.trim();
    if (!ip) { ipInput.focus(); return; }
    post("/connect", { ip: ip });
  };
  ipInput.addEventListener("keydown", function (e) { if (e.key === "Enter") connectBtn.click(); });
  disconnectBtn.onclick = function () { post("/disconnect"); };
  $("clear").onclick = function () { allRows = []; logEl.innerHTML = ""; };
  filterEl.onchange = function () { rerenderLog(); };

  scanBtn.onclick = function () {
    scanBtn.disabled = true;
    scanHintEl.textContent = "scanning the local network — this can take ~20s…";
    scanResultsEl.innerHTML = "";
    post("/scan").then(function (r) { return r.json(); }).then(function (res) {
      scanBtn.disabled = false;
      var found = (res && res.found) || [];
      if (!found.length) { scanHintEl.textContent = "no ATEM switchers found on the local subnet."; return; }
      scanHintEl.textContent = "found " + found.length + " — click to connect:";
      found.forEach(function (f) {
        var b = document.createElement("button");
        b.textContent = f.ip + (f.product ? " · " + f.product : "");
        b.onclick = function () { ipInput.value = f.ip; post("/connect", { ip: f.ip }); };
        scanResultsEl.appendChild(b);
      });
    }).catch(function () { scanBtn.disabled = false; scanHintEl.textContent = "scan failed."; });
  };

  function setTile(prefix, inputId, byId, kind) {
    var tile = $(prefix + "Tile"), val = $(prefix + "Val"), sub = $(prefix + "Sub");
    if (inputId === null || inputId === undefined) {
      tile.classList.add("off"); val.textContent = "—"; sub.textContent = "—"; return;
    }
    tile.classList.remove("off");
    var inp = byId[inputId];
    val.textContent = inp ? inp.label : ("Input " + inputId);
    sub.textContent = "input " + inputId;
  }

  function renderInputs(inputs, programInput, previewInput) {
    var host = $("inputs");
    if (!inputs || !inputs.length) { host.innerHTML = '<span class="empty">No inputs reported yet.</span>'; return; }
    host.innerHTML = "";
    inputs.forEach(function (i) {
      var cls = "chip";
      if (i.id === programInput) cls += " live";
      else if (i.id === previewInput) cls += " preview";
      var el = document.createElement("div");
      el.className = cls;
      var id = document.createElement("div"); id.className = "id"; id.textContent = "IN " + i.id;
      var name = document.createElement("div"); name.className = "name"; name.textContent = i.label;
      el.appendChild(id); el.appendChild(name); host.appendChild(el);
    });
  }

  function renderState(s) {
    var conn = s.connection;
    statusEl.className = "pill " + conn;
    statusEl.textContent = conn === "connected" ? "CONNECTED" : conn === "connecting" ? "CONNECTING…" : "DISCONNECTED";
    connectBtn.disabled = conn === "connecting";

    heartbeatEl.classList.add("beat");
    setTimeout(function () { heartbeatEl.classList.remove("beat"); }, 180);

    productEl.textContent = (s.product || "ATEM") + (s.ip ? "  ·  " + s.ip : "");

    var byId = {};
    (s.inputs || []).forEach(function (i) { byId[i.id] = i; });
    setTile("program", s.programInput, byId);
    setTile("preview", s.previewInput, byId);
    renderInputs(s.inputs, s.programInput, s.previewInput);
  }

  function fmtRow(line) {
    var d = new Date(line.ts);
    var t = d.toTimeString().slice(0, 8);
    var row = document.createElement("div");
    row.className = "row lvl-" + line.level;
    row.dataset.level = line.level;
    var ts = document.createElement("span"); ts.className = "ts"; ts.textContent = t + " ";
    row.appendChild(ts);
    row.appendChild(document.createTextNode("[" + line.level.toUpperCase() + "] " + line.msg));
    return row;
  }

  function passesFilter(level) {
    var f = filterEl.value;
    if (f === "all") return true;
    return LEVELS[level] <= LEVELS[f];
  }

  function rerenderLog() {
    logEl.innerHTML = "";
    allRows.forEach(function (line) { if (passesFilter(line.level)) logEl.appendChild(fmtRow(line)); });
    logEl.scrollTop = logEl.scrollHeight;
  }

  function appendLog(line) {
    allRows.push(line);
    if (allRows.length > 2000) allRows.shift();
    if (passesFilter(line.level)) {
      var atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
      logEl.appendChild(fmtRow(line));
      if (atBottom) logEl.scrollTop = logEl.scrollHeight;
    }
  }

  var es = new EventSource("/events");
  es.addEventListener("state", function (e) { renderState(JSON.parse(e.data)); });
  es.addEventListener("log", function (e) { appendLog(JSON.parse(e.data)); });
})();
</script>
</body>
</html>`;
