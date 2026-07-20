---
name: dialogue-graph
description: Build, validate, and serialize directed dialogue graphs from branching narrative scripts. Use when parsing node headers, dialogue lines, choices, loops, and terminal transitions into structured JSON.
---

# Dialogue Graph

Represent a branching dialogue as two collections:

- `nodes`: objects with `id`, `text`, `speaker`, and `type` (`line` or `choice`).
- `edges`: objects with `from`, `to`, and `text`.

Parsing procedure:

1. Treat every `[NodeId]` header as the start of one node block.
2. A block containing numbered options is a `choice` node. Preserve each option's visible text on its edge.
3. A block containing `Speaker: text -> Target` is a `line` node. Preserve the speaker and text, and emit one transition edge.
4. Remove an optional leading bracketed action tag such as `[Observe]` only when deriving presentation text; never remove it from the source before determining the target.
5. Preserve loops. Do not unfold or duplicate nodes when an edge returns to an earlier node.
6. Validate that every edge source exists, every non-terminal target exists, node IDs are unique, and every declared node is reachable from the first node.
7. Serialize deterministically so the same input produces the same node and edge ordering.

Terminal targets such as `End` may be represented as external targets when the input does not declare a corresponding node block.
