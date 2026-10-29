import { EventEmitter } from "node:events";

// In-process fan-out of "these runs changed" to open dashboards. A multi-node
// deployment would put Postgres LISTEN/NOTIFY behind the same interface.
export type LiveEvent = { projectId: string; runIds: string[] };

export class LiveHub {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(event: LiveEvent) {
    if (event.runIds.length) this.emitter.emit("runs", event);
  }

  subscribe(projectId: string, listener: (runIds: string[]) => void) {
    const handler = (event: LiveEvent) => {
      if (event.projectId === projectId) listener(event.runIds);
    };
    this.emitter.on("runs", handler);
    return () => this.emitter.off("runs", handler);
  }
}
