# ADR-003: Manually drawn edge routes

**Date:** 2026-10-31

## Context

Edges are drawn as automatic curves between fixed handles. Users want to shape an edge's path themselves, e.g. to route a back edge around other nodes. Like node positions ([ADR-002](002-node-positions.md)), Mermaid has no syntax for this, so the route must be stored outside the diagram code.

## Decision

- **Model:** an edge route is a list of **waypoints** (absolute canvas coordinates) between source and target. No waypoints = the automatic curve. A routed edge is drawn as a polyline with rounded corners and **floats**: it leaves the node's outline towards the first/last waypoint instead of the fixed handle.
- **Storage:** in the hidden layout block from ADR-002, after the node lines, one line per routed edge:

```
%% D->A 372 -69 235 -69
```

- **Key:** `<from>-><to>`, and `<from>-><to>#2`, `#3`, … for further edges between the same nodes, counted in source order. Edge IDs from the parser (`statement:link:from:to`) are not used, because they change whenever a statement is added or removed above the edge.
- Orphaned routes are pruned on save, like orphaned positions. Auto-layout resets all routes.

## Consequences

- Same guarantees as node positions: one file, clean code, the file stays valid Mermaid, and other renderers ignore the routes.
- Waypoints are absolute. Moving one endpoint leaves the bends where they are (like draw.io). Moving both endpoints together moves the bends along.
- Renaming a node ID in code loses its routes (same as ADR-002, S4).
- With parallel edges between the same nodes, deleting the first one hands its `#2` route to the next. Accepted, because it's rare and easy to fix.
- Builds before this ADR count route lines as unreadable and drop them on save.
