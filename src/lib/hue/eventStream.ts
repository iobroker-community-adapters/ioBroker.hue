import https from 'node:https';
import type { ClientRequest } from 'node:http';
import { EventEmitter } from 'node:events';
import { parseBridgeAddress } from './client';
import type { HueEvent } from './types';

/** Timeout for establishing the connection, an idle stream afterwards is normal */
const CONNECT_TIMEOUT_MS = 15_000;
/** Maximum delay between reconnection attempts */
const MAX_RECONNECT_DELAY_MS = 30_000;
/** Protect against unbounded growth if the bridge sends garbage without frame separators */
const MAX_BUFFER_SIZE = 1024 * 1024;

/** A single frame of a server-sent event stream */
export interface ServerSentEvent {
    /** Event id */
    id?: string;
    /** Payload */
    data?: string;
}

/**
 * Parse a chunk of an SSE stream
 *
 * @param text buffered text including the new chunk
 * @returns parsed events and the incomplete remainder which has to be kept for the next chunk
 */
export function parseServerSentEvents(text: string): { events: ServerSentEvent[]; rest: string } {
    const separator = /\r\n\r\n|\n\n|\r\r/;
    const events: ServerSentEvent[] = [];
    let rest = text;
    let match: RegExpExecArray | null;

    while ((match = separator.exec(rest)) !== null) {
        const frame = rest.slice(0, match.index);
        rest = rest.slice(match.index + match[0].length);

        const event: ServerSentEvent = {};
        const data: string[] = [];

        for (const line of frame.split(/\r\n|\n|\r/)) {
            // empty lines and comments (keep-alive)
            if (!line || line.startsWith(':')) {
                continue;
            }

            const colon = line.indexOf(':');
            const field = colon === -1 ? line : line.slice(0, colon);
            let value = colon === -1 ? '' : line.slice(colon + 1);
            if (value.startsWith(' ')) {
                value = value.slice(1);
            }

            if (field === 'data') {
                data.push(value);
            } else if (field === 'id') {
                event.id = value;
            }
        }

        if (data.length) {
            event.data = data.join('\n');
        }

        if (event.id || event.data) {
            events.push(event);
        }
    }

    return { events, rest };
}

/** Events emitted by {@link HueEventStream} */
export interface EventStreamEvents {
    /** Connection established, `reconnect` is true if it was established before */
    connected: [reconnect: boolean];
    /** Connection lost, a reconnect is scheduled */
    disconnected: [reason: string, retryInMs: number];
    /** Events received from the bridge */
    events: [events: HueEvent[]];
}

/**
 * Connection to the event stream of the bridge with automatic reconnect
 */
export class HueEventStream extends EventEmitter<EventStreamEvents> {
    private request?: ClientRequest;
    private retryTimer?: NodeJS.Timeout;
    private attempt = 0;
    private active = false;
    private hasBeenConnected = false;

    /**
     * @param address address of the bridge, optionally with port
     * @param appKey application key
     */
    constructor(
        private readonly address: string,
        private readonly appKey: string,
    ) {
        super();
    }

    /** Open the stream, does nothing if it is already running */
    start(): void {
        if (this.active) {
            return;
        }
        this.active = true;
        this.connect();
    }

    /** Close the stream and stop reconnecting */
    stop(): void {
        this.active = false;
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        this.request?.destroy();
        this.request = undefined;
    }

    private connect(): void {
        if (!this.active) {
            return;
        }

        const { host, port } = parseBridgeAddress(this.address);
        const req = https.request({
            host,
            port,
            path: '/eventstream/clip/v2',
            method: 'GET',
            headers: {
                Accept: 'text/event-stream',
                'Cache-Control': 'no-cache',
                'hue-application-key': this.appKey,
            },
            agent: false,
            rejectUnauthorized: false,
        });
        this.request = req;

        req.setTimeout(CONNECT_TIMEOUT_MS, () => req.destroy(new Error('Bridge did not answer')));

        req.on('response', res => {
            if (res.statusCode !== 200) {
                res.resume();
                this.reconnect(`Bridge rejected the event stream (HTTP ${res.statusCode})`);
                return;
            }

            req.setTimeout(0);
            res.socket?.setKeepAlive(true, 30_000);
            res.setEncoding('utf8');

            this.attempt = 0;
            const isReconnect = this.hasBeenConnected;
            this.hasBeenConnected = true;
            this.emit('connected', isReconnect);

            let buffer = '';
            res.on('data', (chunk: string) => {
                const parsed = parseServerSentEvents(buffer + chunk);
                buffer = parsed.rest.length > MAX_BUFFER_SIZE ? '' : parsed.rest;

                const messages: HueEvent[] = [];
                for (const event of parsed.events) {
                    if (!event.data) {
                        continue;
                    }
                    try {
                        messages.push(...(JSON.parse(event.data) as HueEvent[]));
                    } catch {
                        // ignore malformed frames
                    }
                }

                if (messages.length) {
                    this.emit('events', messages);
                }
            });

            res.on('end', () => this.reconnect('Bridge closed the event stream'));
            res.on('error', err => this.reconnect(err.message));
        });

        req.on('error', err => this.reconnect(err.message));
        req.end();
    }

    /**
     * Schedule a reconnect with exponential backoff
     *
     * @param reason why the connection was lost
     */
    private reconnect(reason: string): void {
        if (!this.active || this.retryTimer) {
            return;
        }

        this.request?.destroy();
        this.request = undefined;

        const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** this.attempt);
        this.attempt++;

        this.emit('disconnected', reason, delay);

        this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            this.connect();
        }, delay);
    }
}
