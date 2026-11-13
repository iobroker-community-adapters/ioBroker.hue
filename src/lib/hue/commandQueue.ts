/** A PUT request to a single resource */
export interface ResourceCommand {
    /** Resource type, e.g. `light` */
    rtype: string;
    /** Resource id */
    rid: string;
    /** Properties to change */
    body: Record<string, unknown>;
}

/** Function which actually sends a command to the bridge */
export type CommandSender = (command: ResourceCommand) => Promise<void>;

interface PendingCommand extends ResourceCommand {
    waiters: { resolve: () => void; reject: (err: unknown) => void }[];
}

/**
 * Minimum time between two requests per lane.
 * The bridge handles roughly 10 light commands per second, but only one grouped_light command per second.
 */
const LANE_INTERVAL_MS: Record<string, number> = {
    grouped_light: 1_000,
    default: 100,
};

/** Retries when the bridge is overloaded (HTTP 429/503) */
const MAX_RETRIES = 3;

/**
 * Deep merge `source` into `target` (later values win)
 *
 * @param target object to merge into (mutated)
 * @param source object to merge
 */
export function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
    for (const [key, value] of Object.entries(source)) {
        if (
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            target[key] &&
            typeof target[key] === 'object' &&
            !Array.isArray(target[key])
        ) {
            deepMerge(target[key], value);
        } else {
            target[key] = value;
        }
    }
    return target;
}

/**
 * Rate limited queue for commands to the bridge.
 * Commands to the same resource which are waiting in the queue are merged into a single request.
 */
export class CommandQueue {
    private readonly lanes = new Map<string, PendingCommand[]>();
    private readonly running = new Set<string>();
    private stopped = false;

    /**
     * @param send function which sends the command
     * @param delay function to wait, should be cancelled on adapter unload
     */
    constructor(
        private readonly send: CommandSender,
        private readonly delay: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)),
    ) {}

    /**
     * Add a command to the queue
     *
     * @param command the command to send
     * @returns resolves when the (possibly merged) command has been sent successfully
     */
    enqueue(command: ResourceCommand): Promise<void> {
        const laneName = command.rtype in LANE_INTERVAL_MS ? command.rtype : 'default';
        let lane = this.lanes.get(laneName);
        if (!lane) {
            lane = [];
            this.lanes.set(laneName, lane);
        }

        const promise = new Promise<void>((resolve, reject) => {
            const existing = lane.find(entry => entry.rtype === command.rtype && entry.rid === command.rid);
            if (existing) {
                deepMerge(existing.body, structuredClone(command.body));
                existing.waiters.push({ resolve, reject });
            } else {
                lane.push({ ...command, body: structuredClone(command.body), waiters: [{ resolve, reject }] });
            }
        });

        void this.process(laneName);
        return promise;
    }

    /** Reject all pending commands and stop processing */
    stop(): void {
        this.stopped = true;
        for (const lane of this.lanes.values()) {
            for (const entry of lane.splice(0)) {
                entry.waiters.forEach(w => w.reject(new Error('Adapter is stopping')));
            }
        }
    }

    /**
     * Work through a lane
     *
     * @param laneName name of the lane
     */
    private async process(laneName: string): Promise<void> {
        if (this.running.has(laneName)) {
            return;
        }
        this.running.add(laneName);

        const lane = this.lanes.get(laneName)!;
        const interval = LANE_INTERVAL_MS[laneName] ?? LANE_INTERVAL_MS.default;

        try {
            while (lane.length && !this.stopped) {
                const entry = lane.shift()!;

                try {
                    await this.sendWithRetry(entry);
                    entry.waiters.forEach(w => w.resolve());
                } catch (e) {
                    entry.waiters.forEach(w => w.reject(e));
                }

                await this.delay(interval);
            }
        } finally {
            this.running.delete(laneName);
        }
    }

    /**
     * Send a command, retry if the bridge is overloaded
     *
     * @param command the command to send
     */
    private async sendWithRetry(command: ResourceCommand): Promise<void> {
        for (let attempt = 0; ; attempt++) {
            try {
                await this.send({ rtype: command.rtype, rid: command.rid, body: command.body });
                return;
            } catch (e: any) {
                const overloaded = e?.status === 429 || e?.status === 503;
                if (!overloaded || attempt >= MAX_RETRIES || this.stopped) {
                    throw e;
                }
                await this.delay(1_000 * (attempt + 1));
            }
        }
    }
}
