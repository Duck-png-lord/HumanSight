const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const net = require("node:net");
const fs = require("node:fs");

let serverProcess = null;
let mainWindow = null;

function portIsOpen(port) {
  return new Promise(resolve => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function findAvailablePort() {
  for (let port = 3100; port < 3200; port++) {
    if (!(await portIsOpen(port))) return port;
  }
  throw new Error("No available local port.");
}

function startServer(port) {
  const serverFile = path.join(process.resourcesPath, "app", "app.js");
  const dataRoot = path.join(app.getPath("userData"), "data");

  fs.mkdirSync(path.join(dataRoot, "person"), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "not-person"), { recursive: true });

  serverProcess = spawn(process.execPath, [serverFile], {
    cwd: path.dirname(serverFile),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATA_DIR: dataRoot,
      ELECTRON_RUN_AS_NODE: "1"
    },
    stdio: "inherit",
    windowsHide: true
  });

  serverProcess.on("error", error => {
    console.error("Could not start app server:", error);
  });
}

async function waitForServer(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await portIsOpen(port)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error("App server failed to start.");
}

async function createWindow() {
  const port = await findAvailablePort();
  startServer(port);
  await waitForServer(port);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 850,
    minWidth: 800,
    minHeight: 600,
    title: "Image Trainer",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

app.whenReady().then(async () => {
  try {
    await createWindow();
  } catch (error) {
    console.error(error);
    app.quit();
  }

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      try {
        await createWindow();
      } catch (error) {
        console.error(error);
        app.quit();
      }
    }
  });
});

app.on("before-quit", () => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
