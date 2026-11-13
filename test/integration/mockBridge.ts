import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ServerResponse } from 'node:http';
import type { HueResource } from '../../src/lib/hue/types';

/** A request received by the mock bridge */
export interface RecordedRequest {
    /** HTTP method */
    method: string;
    /** Request path */
    path: string;
    /** Parsed JSON body */
    body: any;
}

/**
 * Minimal simulation of a Hue bridge: REST API, event stream and user creation
 */
export class MockBridge {
    /** All requests except the event stream */
    readonly requests: RecordedRequest[] = [];
    /** Whether the link button is "pressed" */
    linkButtonPressed = false;

    private readonly server: https.Server;
    private readonly streams = new Set<ServerResponse>();
    private eventCounter = 0;

    /**
     * @param resources resources served by the bridge
     * @param appKey the valid application key
     */
    constructor(
        private resources: HueResource[],
        private readonly appKey: string,
    ) {
        this.server = https.createServer(
            {
                key: fs.readFileSync(path.join(__dirname, 'test-key.pem')),
                cert: fs.readFileSync(path.join(__dirname, 'test-cert.pem')),
            },
            (req, res) => {
                let raw = '';
                req.on('data', chunk => (raw += chunk));
                req.on('end', () => this.handle(req.method!, req.url!, req.headers, raw, res));
            },
        );
    }

    /** Start listening on a random port of localhost and return the address */
    async start(): Promise<string> {
        await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
        return `127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    }

    /** Stop the server */
    async stop(): Promise<void> {
        for (const stream of this.streams) {
            stream.destroy();
        }
        await new Promise<void>(resolve => this.server.close(() => resolve()));
    }

    /** Close all event streams, e.g. to simulate a reboot of the bridge */
    dropStreams(): void {
        for (const stream of this.streams) {
            stream.destroy();
        }
        this.streams.clear();
    }

    /** Number of currently connected event streams */
    get connectedStreams(): number {
        return this.streams.size;
    }

    /**
     * Send events to all connected event streams
     *
     * @param type event type
     * @param data changed resources
     */
    emit(type: 'update' | 'add' | 'delete', data: HueResource[]): void {
        const id = `${Date.now()}:${this.eventCounter++}`;
        const payload = JSON.stringify([{ id, creationtime: new Date().toISOString(), type, data }]);
        for (const stream of this.streams) {
            stream.write(`id: ${id}\ndata: ${payload}\n\n`);
        }
    }

    /**
     * Replace the resources (e.g. to simulate a deleted device)
     *
     * @param resources the new resources
     */
    setResources(resources: HueResource[]): void {
        this.resources = resources;
    }

    private handle(
        method: string,
        url: string,
        headers: Record<string, unknown>,
        raw: string,
        res: ServerResponse,
    ): void {
        const body = raw ? JSON.parse(raw) : undefined;

        if (method === 'POST' && url === '/api') {
            this.requests.push({ method, path: url, body });
            const answer = this.linkButtonPressed
                ? [{ success: { username: this.appKey, clientkey: 'CLIENTKEY' } }]
                : [{ error: { type: 101, address: '', description: 'link button not pressed' } }];
            return this.json(res, 200, answer);
        }

        if (headers['hue-application-key'] !== this.appKey) {
            return this.json(res, 403, { errors: [{ description: 'unauthorized user' }], data: [] });
        }

        if (method === 'GET' && url === '/eventstream/clip/v2') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            res.write(': hi\n\n');
            this.streams.add(res);
            res.on('close', () => this.streams.delete(res));
            return;
        }

        this.requests.push({ method, path: url, body });

        if (method === 'GET' && url === '/clip/v2/resource') {
            return this.json(res, 200, { errors: [], data: this.resources });
        }

        const match = /^\/clip\/v2\/resource\/([a-z_]+)\/([\w-]+)$/.exec(url);
        if (method === 'PUT' && match) {
            const [, rtype, rid] = match;
            if (!this.resources.some(r => r.id === rid && r.type === rtype)) {
                return this.json(res, 404, { errors: [{ description: 'Not found' }], data: [] });
            }

            this.json(res, 200, { errors: [], data: [{ rid, rtype }] });

            // a real bridge reports the changes via the event stream
            const { dynamics: _dynamics, alert: _alert, recall: _recall, ...changes } = body;
            if (Object.keys(changes).length) {
                setTimeout(() => this.emit('update', [{ id: rid, type: rtype, ...changes }]), 20);
            }
            return;
        }

        this.json(res, 404, { errors: [{ description: `Unknown endpoint ${method} ${url}` }], data: [] });
    }

    private json(res: ServerResponse, status: number, data: unknown): void {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }
}
