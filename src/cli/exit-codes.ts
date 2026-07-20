import type { StaticScanReport } from "../domain/types";
import type { ReleaseDecision } from "../runs/type-guards";

export const EXIT_SUCCESS = 0 as const;
export const EXIT_HELD = 1 as const;
export const EXIT_REJECTED = 2 as const;
export const EXIT_ERROR = 3 as const;

export type CliExitCode =
  | typeof EXIT_SUCCESS
  | typeof EXIT_HELD
  | typeof EXIT_REJECTED
  | typeof EXIT_ERROR;

export function exitCodeForDecision(decision: ReleaseDecision): CliExitCode {
  if (decision === "cleared") return EXIT_SUCCESS;
  if (decision === "held") return EXIT_HELD;
  return EXIT_REJECTED;
}

export function exitCodeForScan(decision: StaticScanReport["decision"]): CliExitCode {
  if (decision === "pass") return EXIT_SUCCESS;
  if (decision === "unsafe") return EXIT_REJECTED;
  return EXIT_HELD;
}

export function exitCodeForReadiness(status: "ready" | "blocked"): CliExitCode {
  return status === "ready" ? EXIT_SUCCESS : EXIT_HELD;
}
