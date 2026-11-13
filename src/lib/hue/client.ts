import https from 'node:https';
import type { HueResource, HueResponse } from './types';

/**
 * Split a bridge address into host and port. The port is optional and defaults to 443.
 *
 * @param address e.g. `192.168.1.2` or `192.168.1.2:8443`
 */
export function parseBridgeAddress(address: string): { host: string; port: number } {
    const trimmed = address.trim();
    const match = /^(.+):(\d{1,5})$/.exec(trimmed);
    // do not split IPv6 addresses like `fe80::1`
    if (match && !match[1].includes(':')) {
        return { host: match[1], port: parseInt(match[2], 10) };
    }
    return { host: trimmed, port: 443 };
}

/** Default timeout for a single REST request */
const REQUEST_TIMEOUT_MS = 10_000;

/** Error thrown for failed requests against the bridge */
export class HueApiError extends Error {
    /**
     * @param message human-readable description
     * @param status HTTP status code, if a response was received
     */
    constructor(
        message: string,
        public readonly status?: number,
    ) {
        super(message);
        this.name = 'HueApiError';
    }
}

interface RawResponse {
    status: number;
    body: string;
}

/**
 * The Hue bridge uses a certificate signed by the Signify CA (or a self-signed one on older bridges),
 * whose CN is the bridge id and not the IP address, so we cannot verify it with the default trust store.
 */
const insecureAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 4 });

/**
 * Perform a single HTTPS request against the bridge
 *
 * @param options request options
 * @param options.address address of the bridge, optionally with port
 * @param options.method HTTP method
 * @param options.path request path
 * @param options.headers additional headers
 * @param options.body JSON body
 */
function request(options: {
    address: string;
    method: 'GET' | 'PUT' | 'POST';
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
}): Promise<RawResponse> {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);

    return new Promise((resolve, reject) => {
        const { host, port } = parseBridgeAddress(options.address);
        const req = https.request(
            {
                host,
                port,
                method: options.method,
                path: options.path,
                agent: insecureAgent,
                headers: {
                    Accept: 'application/json',
                    ...(payload
                        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                        : {}),
                    ...options.headers,
                },
                timeout: REQUEST_TIMEOUT_MS,
            },
            res => {
                const chunks: Buffer[] = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
                res.on('error', reject);
            },
        );

        req.on('timeout', () => req.destroy(new HueApiError(`Request to ${options.path} timed out`)));
        req.on('error', reject);

        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

/**
 * Parse the JSON body of a response
 *
 * @param res raw response
 */
function parseBody(res: RawResponse): any {
    try {
        return res.body ? JSON.parse(res.body) : undefined;
    } catch {
        throw new HueApiError(`Invalid JSON received (HTTP ${res.status})`, res.status);
    }
}

/** Connection options of {@link HueClient} */
export interface HueClientOptions {
    /** IP address or hostname of the bridge, optionally with port */
    address: string;
    /** Application key (formerly called username) */
    appKey: string;
}

/**
 * Minimal client for the Hue CLIP API v2
 */
export class HueClient {
    /**
     * @param options connection options
     */
    constructor(private readonly options: HueClientOptions) {}

    /**
     * Perform an authenticated request and unwrap the v2 response envelope
     *
     * @param method HTTP method
     * @param path path relative to `/clip/v2`
     * @param body optional JSON body
     */
    private async call<T>(method: 'GET' | 'PUT', path: string, body?: unknown): Promise<T[]> {
        const res = await request({
            address: this.options.address,
            method,
            path: `/clip/v2${path}`,
            headers: { 'hue-application-key': this.options.appKey },
            body,
        });

        const parsed = parseBody(res) as HueResponse<T> | undefined;
        const errors = parsed?.errors?.map(e => e.description).filter(Boolean) ?? [];

        if (res.status === 401 || res.status === 403) {
            throw new HueApiError('Unauthorized - please create a new user in the adapter settings', res.status);
        }

        if (res.status < 200 || res.status >= 300) {
            throw new HueApiError(errors.join(', ') || `HTTP ${res.status}`, res.status);
        }

        // 207 Multi-Status: partially applied
        if (errors.length) {
            throw new HueApiError(errors.join(', '), res.status);
        }

        return parsed?.data ?? [];
    }

    /**
     * Get all resources of the bridge in a single request
     */
    getAllResources(): Promise<HueResource[]> {
        return this.call<HueResource>('GET', '/resource');
    }

    /**
     * Update a resource
     *
     * @param rtype resource type, e.g. `light`
     * @param rid id of the resource
     * @param body properties to change
     */
    async updateResource(rtype: string, rid: string, body: Record<string, unknown>): Promise<void> {
        await this.call('PUT', `/resource/${rtype}/${rid}`, body);
    }
}

/** Result of a user creation attempt */
export type CreateUserResult =
    | { success: true; appKey: string; clientKey?: string }
    | { success: false; linkButtonNotPressed: boolean; message: string };

/**
 * Create a new application key on the bridge. The link button of the bridge has to be pressed before.
 *
 * Note: there is no v2 endpoint for this, the v1 endpoint is the official way to obtain a v2 application key.
 *
 * @param address address of the bridge, optionally with port
 * @param deviceType name of the application, shown in the Hue app
 */
export async function createUser(address: string, deviceType: string): Promise<CreateUserResult> {
    const res = await request({
        address,
        method: 'POST',
        path: '/api',
        body: { devicetype: deviceType, generateclientkey: true },
    });

    const parsed = parseBody(res);
    const entry = Array.isArray(parsed) ? parsed[0] : undefined;

    if (entry?.success?.username) {
        return { success: true, appKey: entry.success.username, clientKey: entry.success.clientkey };
    }

    if (entry?.error) {
        // type 101 = link button not pressed
        return {
            success: false,
            linkButtonNotPressed: entry.error.type === 101,
            message: entry.error.description ?? 'Unknown error',
        };
    }

    return { success: false, linkButtonNotPressed: false, message: `Unexpected response (HTTP ${res.status})` };
}
