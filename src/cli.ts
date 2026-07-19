#!/usr/bin/env node
import { EXIT_ERROR } from "./cli/exit-codes";
import { runCli } from "./cli/main";

void runCli(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`barena: ${message}`);
    process.exitCode = EXIT_ERROR;
  }
);
