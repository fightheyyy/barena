import { appendNdjson } from "../utils/fs";
import {
  BoundaryObservedFrom,
  BoundaryTraceEvent,
  BoundaryTraceEventKind,
} from "./types";

export function boundaryEvent(input: {
  runId: string;
  caseId: string;
  attemptId: string;
  component: string;
  observedFrom: BoundaryObservedFrom;
  kind: BoundaryTraceEventKind;
  message: string;
  data?: Record<string, unknown>;
}): BoundaryTraceEvent {
  return {
    timestamp: new Date().toISOString(),
    run_id: input.runId,
    case_id: input.caseId,
    attempt_id: input.attemptId,
    kind: input.kind,
    message: input.message,
    provenance: {
      recorded_by: "barena",
      layer: "boundary",
      observed_from: input.observedFrom,
      component: input.component,
    },
    data: input.data,
  };
}

export function writeBoundaryEvents(tracePath: string, events: BoundaryTraceEvent[]): void {
  if (events.length) {
    appendNdjson(tracePath, events);
  }
}

