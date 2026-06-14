"use strict";

const fs = require("node:fs");
const net = require("node:net");
const { spawn } = require("node-pty");
const { SerializeAddon } = require("@xterm/addon-serialize");
const { Terminal: HeadlessTerminal } = require("@xterm/headless");

const COLS = Number(process.env.COLS || "130");
const NVITOP_ROWS = Number(process.env.NVITOP_ROWS || "21");
const BTOP_ROWS = Number(process.env.BTOP_ROWS || "48");
const SNAPSHOT_MS = Number(process.env.SSH_SNAPSHOT_MS || process.env.SNAPSHOT_MS || "500");
const MAX_STDOUT_BUFFER = Number(process.env.SSH_MAX_STDOUT_BUFFER || String(512 * 1024));
const MAX_PANE_BUFFER = Number(process.env.SSH_MAX_PANE_BUFFER || String(1024 * 1024));
const SOCKET_PATH = process.env.SSH_DASHBOARD_SOCKET || "/tmp/gpu-ssh-monitor.sock";
const PANE_CWD = process.env.PANE_CWD || process.env.HOME || process.cwd();
const SERVER_MODE = process.argv.includes("--server");

class TerminalMirror {
  constructor(cols, rows) {
    this.term = new HeadlessTerminal({
      cols,
      rows,
      allowProposedApi: true,
      convertEol: false,
      disableStdin: true,
      logLevel: "off",
      scrollback: 0,
    });
    this.serializeAddon = new SerializeAddon();
    this.term.loadAddon(this.serializeAddon);
    this.bufferedData = "";
    this.flushing = false;
    this.lastSnapshot = this.serializeAddon.serialize({ scrollback: 0 });
  }

  write(data) {
    this.bufferedData += data;
    if (this.bufferedData.length > MAX_PANE_BUFFER) {
      this.bufferedData = this.bufferedData.slice(-MAX_PANE_BUFFER);
    }
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushing || !this.bufferedData) return;
    this.flushing = true;

    const data = this.bufferedData;
    this.bufferedData = "";
    this.term.write(data, () => {
      this.lastSnapshot = this.serializeAddon.serialize({ scrollback: 0 });
      this.flushing = false;
      if (this.bufferedData) setImmediate(() => this.scheduleFlush());
    });
  }

  snapshot() {
    return this.lastSnapshot;
  }
}

function splitArgs(value) {
  return (value || "").split(" ").filter(Boolean);
}

const paneSpecs = {
  nvitop: {
    name: "nvitop",
    command: process.env.NVITOP_CMD || "/usr/bin/nvitop",
    args: splitArgs(process.env.NVITOP_ARGS),
    rows: NVITOP_ROWS,
    env: {},
  },
  btop: {
    name: "btop",
    command: process.env.BTOP_CMD || "/usr/local/bin/btop",
    args: splitArgs(process.env.BTOP_ARGS),
    rows: BTOP_ROWS,
    env: {
      BTOP_NO_UPDATE: "1",
    },
  },
};

const paneSessions = {
  nvitop: {
    spec: paneSpecs.nvitop,
    pty: null,
    mirror: new TerminalMirror(COLS, NVITOP_ROWS),
    exited: null,
  },
  btop: {
    spec: paneSpecs.btop,
    pty: null,
    mirror: new TerminalMirror(COLS, BTOP_ROWS),
    exited: null,
  },
};

function sanitizeSnapshot(snapshot) {
  return snapshot
    .replace(/\x1b\[\?(?:1|47|66|1000|1002|1003|1005|1006|1015|1048|1049)[hl]/g, "")
    .replace(/\x1b\[H/g, "");
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function snapshotTime(snapshot) {
  return stripAnsi(snapshot).match(/\b\d{2}:\d{2}:\d{2}\b/)?.[0] || null;
}

function spawnPane(session) {
  const spec = session.spec;
  const env = {
    ...process.env,
    ...spec.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: process.env.LANG || "C.UTF-8",
    COLUMNS: String(COLS),
    LINES: String(spec.rows),
    PTY_COLS: String(COLS),
    PTY_ROWS: String(spec.rows),
  };

  const pty = spawn(
    "/bin/sh",
    ["-lc", 'stty cols "$PTY_COLS" rows "$PTY_ROWS"; exec "$@"', "pty-launch", spec.command, ...spec.args],
    {
      name: "xterm-256color",
      cols: COLS,
      rows: spec.rows,
      cwd: PANE_CWD,
      env,
    },
  );

  session.pty = pty;
  session.mirror = new TerminalMirror(COLS, spec.rows);
  session.exited = null;

  pty.onData((data) => session.mirror.write(data));
  pty.onExit(({ exitCode, signal }) => {
    session.exited = { exitCode, signal };
  });
}

function ensurePane(name) {
  const session = paneSessions[name];
  if (!session.pty) spawnPane(session);
  return session;
}

let isWritingFrame = false;
let lastRenderedAt = 0;
const clients = new Set();
let dashboardServer = null;

function writeFrame() {
  if (isWritingFrame) return;
  if (clients.size === 0) return;
  isWritingFrame = true;

  try {
    const nvitopSnapshot = sanitizeSnapshot(paneSessions.nvitop.mirror.snapshot());
    let btopSnapshot = sanitizeSnapshot(paneSessions.btop.mirror.snapshot());
    const nvitopTime = snapshotTime(nvitopSnapshot);
    const btopTime = snapshotTime(btopSnapshot);
    const now = Date.now();

    if (nvitopTime && btopTime && nvitopTime !== btopTime) {
      btopSnapshot = btopSnapshot.replace(btopTime, nvitopTime);
    }

    writeDiffFrame(nvitopSnapshot, btopSnapshot);
    lastRenderedAt = now;
  } finally {
    isWritingFrame = false;
  }
}

function snapshotLines(snapshot, rows) {
  const lines = snapshot.replace(/\r/g, "").split("\n");
  while (lines.length < rows) lines.push("");
  return lines.slice(0, rows);
}

function writeDiffFrame(nvitopSnapshot, btopSnapshot) {
  const nextFrameLines = [
    ...snapshotLines(nvitopSnapshot, NVITOP_ROWS),
    ...snapshotLines(btopSnapshot, BTOP_ROWS),
  ];

  for (const client of clients) {
    writeDiffFrameToClient(client, nextFrameLines);
  }
}

function writeDiffFrameToClient(client, nextFrameLines) {
  if (client.stream.destroyed) {
    clients.delete(client);
    return;
  }
  if (client.stream.writableLength > MAX_STDOUT_BUFFER) return;

  let output = "";
  for (let index = 0; index < nextFrameLines.length; index += 1) {
    const line = nextFrameLines[index];
    if (line === client.previousFrameLines[index]) continue;
    output += `\x1b[${index + 1};1H\x1b[2K${line}\x1b[0m`;
  }

  client.previousFrameLines = nextFrameLines;
  if (output) client.stream.write(output);
}

function shutdown() {
  if (snapshotTimer) clearInterval(snapshotTimer);

  for (const session of Object.values(paneSessions)) {
    if (!session.pty) continue;
    try {
      session.pty.kill("SIGTERM");
    } catch {
      // already gone
    }
  }

  for (const client of clients) {
    client.stream.write("\x1b[?25h\x1b[?1049l");
    client.stream.end();
  }
  clients.clear();
  if (dashboardServer) dashboardServer.close();
  if (SERVER_MODE) {
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      // already gone
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    shutdown();
    setTimeout(() => process.kill(process.pid, "SIGKILL"), 100);
  });
}

process.stdout.on("error", () => {
  shutdown();
  process.exit(0);
});

ensurePane("nvitop");
ensurePane("btop");

function addClient(stream) {
  const client = {
    stream,
    previousFrameLines: [],
  };
  clients.add(client);

  stream.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
  stream.on("error", () => clients.delete(client));
  stream.on("close", () => clients.delete(client));
  writeFrame();
}

if (SERVER_MODE) {
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {
    // no stale socket
  }

  dashboardServer = net.createServer((socket) => addClient(socket));
  dashboardServer.listen(SOCKET_PATH, () => {
    fs.chmodSync(SOCKET_PATH, 0o600);
    process.stderr.write(`dashboard socket listening at ${SOCKET_PATH}\n`);
  });
} else {
  addClient(process.stdout);
}

const snapshotTimer = SNAPSHOT_MS > 0 ? setInterval(writeFrame, SNAPSHOT_MS) : null;
