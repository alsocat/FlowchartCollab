# Flowchart

A collaborative flowchart tool for teams to map out system workflows on a shared canvas.

## Features

- **Shared canvas** — everyone on the local network sees the same flowchart in real time via WebSockets
- **Production / Dev workflow** — production is read-only; switch to Dev to make changes, then get approvals before pushing to production
- **Approval gate** — configurable number of unique users (by IP) must approve before Dev changes can replace production
- **Visual diff** — existing items stay green, new additions are yellow, removals turn red and move to a graveyard section
- **Grid snapping** — bubbles snap to a grid for clean layouts
- **Connection waypoints** — click empty grid points while connecting to route arrows through custom paths
- **Export** — save the current view as a PNG scaled to fit the flowchart
- **Pan & zoom** — scroll to zoom, drag to pan

## Setup

```
npm install
npm start
```

The server runs on port 3000 by default. Open `http://localhost:3000` from any machine on your network.

## Configuration

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `APPROVALS_REQUIRED` | `1` | Number of unique user approvals needed to push Dev to Production |

Example:

```
APPROVALS_REQUIRED=3 PORT=8080 npm start
```

## Usage

- **Production tab** — view-only; shows the current approved workflow
- **Dev tab** — click to switch (auto-creates a copy of production if one doesn't exist); add, move, rename, delete bubbles and connections here
- **Add Bubble** — places a new bubble at the center of your view
- **Connect** — click a source bubble, optionally click empty grid spots to add waypoints, then click a destination bubble
- **Delete** — click a bubble or connection to remove it
- **Double-click** a bubble to rename it
- **Right-click** during connection to undo the last waypoint
- **Escape** to cancel current mode

## Data

State is persisted to `data/state.json` (auto-created, gitignored).
