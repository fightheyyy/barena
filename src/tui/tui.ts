import readline from "node:readline";
import { loadTuiState, TuiStateOptions } from "./state";
import { nextView, renderTui, TuiView } from "./render";

export interface StartTuiOptions extends TuiStateOptions {
  snapshot?: boolean;
  color?: boolean;
}

export function startTui(options: StartTuiOptions = {}): void {
  if (options.snapshot || !process.stdin.isTTY || !process.stdout.isTTY) {
    const state = loadTuiState(options);
    console.log(renderTui(state, { color: options.color ?? Boolean(process.stdout.isTTY), width: process.stdout.columns }));
    return;
  }

  let view: TuiView = "overview";
  let selectedIndex = 0;
  let state = loadTuiState(options);

  const render = () => {
    process.stdout.write("\x1b[?25l\x1b[2J\x1b[H");
    process.stdout.write(renderTui(state, { view, selectedIndex, color: true, width: process.stdout.columns }));
  };

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  render();

  const cleanup = () => {
    process.stdin.setRawMode(false);
    process.stdin.removeAllListeners("keypress");
    process.stdout.write("\x1b[?25h\x1b[0m\n");
  };

  process.stdin.on("keypress", (_chunk, key) => {
    if (!key) {
      return;
    }
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      cleanup();
      return;
    }
    if (key.name === "right" || key.name === "tab" || key.name === "l") {
      view = nextView(view, 1);
      selectedIndex = 0;
    } else if (key.name === "left" || key.name === "h") {
      view = nextView(view, -1);
      selectedIndex = 0;
    } else if (key.name === "down" || key.name === "j") {
      selectedIndex += 1;
    } else if (key.name === "up" || key.name === "k") {
      selectedIndex = Math.max(0, selectedIndex - 1);
    } else if (key.name === "r") {
      state = loadTuiState(options);
    }
    render();
  });
}
